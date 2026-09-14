/** Pure quote selection. No requests, storage, prediction generation or clock mutation. */
export type ResultPool = 'HAD' | 'HHAD';
export interface OddsTriplet { odds1: number; oddsX: number; odds2: number }
export interface QuoteMatchInput {
  id?: string;
  kickoffTime?: string;
  eventVersion?: string;
  homeTeamName?: string;
  awayTeamName?: string;
  odds?: unknown;
  oddsSource?: string;
  oddsUpdatedAt?: string;
  handicapOdds?: unknown;
  handicapLine?: string | number;
  handicapOddsSource?: string;
  handicapOddsUpdatedAt?: string;
  externalSignals?: unknown;
}
export interface ResolvedQuote {
  pool: ResultPool;
  odds: OddsTriplet;
  handicap?: string;
  source?: string;
  updatedAt?: string;
  provenance: 'official' | 'reference';
  freshness: 'fresh' | 'stale' | 'unknown';
  candidateId: string;
}
export interface QuoteResolutionOptions {
  nowMs?: number;
  /** Explicit replay boundary. A quote observed after this instant cannot be selected. */
  asOf?: string;
  maxAgeMs?: number;
  preferFresh?: boolean;
  requireFresh?: boolean;
  prematchOnly?: boolean;
  officialOnly?: boolean;
  expectedHandicap?: string | number;
}

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as RecordValue : {};
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const present = (value: unknown) => value !== undefined && value !== null && value !== '';

export function normalizeQuoteOdds(value: unknown): OddsTriplet | null {
  const item = record(value);
  const numbers = ['odds1', 'oddsX', 'odds2'].map(key => {
    const raw = item[key];
    if (typeof raw !== 'number' && (typeof raw !== 'string' || !/^\d+(?:\.\d+)?$/.test(raw.trim()))) return NaN;
    return Number(raw);
  });
  if (!numbers.every(number => Number.isFinite(number) && number > 1)) return null;
  return { odds1: numbers[0], oddsX: numbers[1], odds2: numbers[2] };
}

/** HHAD is an integer result handicap, not an Asian quarter-goal market. */
export function parseResultHandicap(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const raw = String(value).trim().replace(/\uFF0B/g, '+').replace(/[\uFF0D\u2212]/g, '-');
  if (!/^[+-]?\d+(?:\.0+)?$/.test(raw)) return null;
  const number = Number(raw);
  return Number.isSafeInteger(number) ? (number === 0 ? 0 : number) : null;
}

/** Reject naive datetimes and Date.parse's silent invalid-calendar rollover. */
export function quoteInstant(value: unknown): number | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value !== 'string') return null;
  const parts = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts) return null;
  const [, year, month, day, hour, minute, second = '0', fraction = '', zone] = parts;
  const y = Number(year), m = Number(month), d = Number(day);
  const wall = new Date(0);
  wall.setUTCFullYear(y, m - 1, d);
  wall.setUTCHours(Number(hour), Number(minute), Number(second), Number(fraction.padEnd(3, '0')));
  if (m < 1 || m > 12 || d < 1 || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59
    || wall.getUTCFullYear() !== y || wall.getUTCMonth() !== m - 1 || wall.getUTCDate() !== d) return null;
  const offsetHours = zone === 'Z' ? 0 : Number(zone.slice(1, 3));
  const offsetMinutes = zone === 'Z' ? 0 : Number(zone.slice(4, 6));
  if (offsetHours > 23 || offsetMinutes > 59) return null;
  const offset = (offsetHours * 60 + offsetMinutes) * (zone[0] === '-' ? -1 : 1);
  return wall.getTime() - offset * 60_000;
}

export function isOfficialQuoteSource(source: unknown, pool: ResultPool): boolean {
  const normalized = text(source)?.toLowerCase();
  const prefix = `sporttery:${pool.toLowerCase()}`;
  return normalized === prefix || Boolean(normalized?.startsWith(prefix + ':'));
}

function identityConflict(match: QuoteMatchInput, contexts: RecordValue[]): boolean {
  const kickoff = quoteInstant(match.kickoffTime);
  const event = quoteInstant(match.eventVersion ?? match.kickoffTime);
  return contexts.some(context => {
    if (present(context.siteMatchId) && context.siteMatchId !== match.id) return true;
    for (const name of ['homeTeamName', 'awayTeamName'] as const) {
      if (present(context[name]) && present(match[name]) && context[name] !== match[name]) return true;
    }
    for (const name of ['kickoffTime', 'kickoffUtc', 'eventVersion'] as const) {
      if (!present(context[name])) continue;
      const instant = quoteInstant(context[name]);
      const expected = name === 'eventVersion' ? event : kickoff;
      if (instant === null || (expected !== null && instant !== expected)) return true;
    }
    // Provider-local sourceMatchId is deliberately not compared with a Sporttery ID.
    return false;
  });
}

function declaredPool(...contexts: RecordValue[]): ResultPool | 'conflict' | undefined {
  const markers = contexts.flatMap(context => ['poolCode', 'oddsPoolCode', 'externalOddsPoolCode', 'market']
    .map(key => text(context[key])?.toUpperCase()).filter(value => value === 'HAD' || value === 'HHAD'));
  const unique = [...new Set(markers)];
  return unique.length > 1 ? 'conflict' : unique[0] as ResultPool | undefined;
}

export function resolveMatchQuotes(match: QuoteMatchInput, options: QuoteResolutionOptions = {}) {
  const nowMs = options.asOf === undefined ? (options.nowMs ?? Date.now()) : quoteInstant(options.asOf);
  const maxAgeMs = options.maxAgeMs ?? 30 * 60_000;
  if (nowMs === null || !Number.isFinite(nowMs) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
    throw new TypeError('Quote selection needs a valid clock and nonnegative maxAgeMs');
  }
  const expectedLine = options.expectedHandicap === undefined ? undefined : parseResultHandicap(options.expectedHandicap);
  if (expectedLine === null) throw new TypeError('expectedHandicap must be an explicit integer');
  const signals = record(match.externalSignals), books = record(signals.bookmakerOdds);
  const api = record(books.apiFootball), generic = record(signals.externalOdds);
  const quotes: ResolvedQuote[] = [];
  const rejected: Array<{ candidateId: string; reason: string }> = [];
  const kickoff = quoteInstant(match.kickoffTime);
  const add = (candidateId: string, pool: ResultPool, value: unknown, source: unknown,
    updatedAt: unknown, line: unknown, direct: boolean, contexts: RecordValue[]) => {
    if (value === undefined || value === null) return;
    const reject = (reason: string) => { rejected.push({ candidateId, reason }); };
    const odds = normalizeQuoteOdds(value);
    if (!odds) return reject('invalid-odds');
    const marker = declaredPool(record(value));
    if (marker && marker !== pool) return reject('pool-conflict');
    if (identityConflict(match, contexts)) return reject('event-conflict');
    const handicap = pool === 'HHAD' ? parseResultHandicap(line) : null;
    if (pool === 'HHAD' && handicap === null) return reject('unknown-handicap');
    if (pool === 'HHAD' && present(record(value).handicapLine)
      && parseResultHandicap(record(value).handicapLine) !== handicap) return reject('handicap-conflict');
    if (pool === 'HHAD' && expectedLine !== undefined && handicap !== expectedLine) return reject('handicap-conflict');
    const sourceText = text(source);
    const official = direct && isOfficialQuoteSource(sourceText, pool);
    if (!direct && sourceText?.toLowerCase().startsWith('sporttery:')) return reject('external-official-source-conflict');
    if (options.officialOnly && !official) return reject('not-official');
    const time = quoteInstant(updatedAt);
    if (present(updatedAt) && time === null) return reject('invalid-observation-time');
    if (time !== null && time > nowMs) return reject('after-as-of');
    if (options.prematchOnly && (kickoff === null || time === null || time >= kickoff)) return reject('not-proven-prematch');
    const freshness = time === null ? 'unknown' : nowMs - time > maxAgeMs ? 'stale' : 'fresh';
    if (options.requireFresh && freshness !== 'fresh') return reject('not-fresh');
    quotes.push({ candidateId, pool, odds, source: sourceText,
      updatedAt: time === null ? undefined : new Date(time).toISOString(),
      ...(pool === 'HHAD' ? { handicap: String(handicap) } : {}),
      provenance: official ? 'official' : 'reference', freshness });
  };

  add('match.had', 'HAD', match.odds, match.oddsSource, match.oddsUpdatedAt, null, true, [record(match.odds)]);
  add('match.hhad', 'HHAD', match.handicapOdds, match.handicapOddsSource, match.handicapOddsUpdatedAt,
    match.handicapLine, true, [record(match.handicapOdds)]);
  for (const [key, pool] of [['had', 'HAD'], ['hhad', 'HHAD']] as const) {
    const value = record(books[key]);
    add(`bookmaker.${key}`, pool, books[key], value.source ?? signals.source, value.updatedAt ?? signals.updatedAt,
      value.handicapLine ?? signals.handicapLine, false, [signals, value]);
  }
  const apiHad = record(api.had);
  add('api-football.had', 'HAD', api.had, apiHad.source ?? api.source, apiHad.updatedAt ?? api.updatedAt,
    null, false, [signals, api, apiHad]);
  // Untyped legacy externalOdds cannot establish a market from a missing handicap alone.
  const genericPool = declaredPool(generic, signals);
  if (genericPool === 'HAD' || genericPool === 'HHAD') {
    add('externalOdds', genericPool, signals.externalOdds, generic.source ?? signals.source,
      generic.updatedAt ?? signals.updatedAt, generic.handicapLine ?? signals.handicapLine, false, [signals, generic]);
  } else if (signals.externalOdds) rejected.push({ candidateId: 'externalOdds', reason: 'ambiguous-market' });

  const qualityRank = { fresh: 0, stale: 1, unknown: 2 };
  const choose = (pool: ResultPool) => quotes.filter(quote => quote.pool === pool).sort((left, right) => {
    const freshness = options.preferFresh ? qualityRank[left.freshness] - qualityRank[right.freshness] : 0;
    const leftTime = quoteInstant(left.updatedAt) ?? -Infinity;
    const rightTime = quoteInstant(right.updatedAt) ?? -Infinity;
    return freshness || Number(left.provenance !== 'official') - Number(right.provenance !== 'official')
      || (leftTime === rightTime ? 0 : rightTime > leftTime ? 1 : -1);
  })[0];
  return { had: choose('HAD'), hhad: choose('HHAD'), rejected };
}
