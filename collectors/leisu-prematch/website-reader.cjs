'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { selectEvidence } = require('./website-adapter.cjs');

const cleanText = value => typeof value === 'string' ? value
  .replace(/(["'])\\\\[^"'\r\n]+\1/g, '资料')
  .replace(/\\\\[^\s\\/<>"'，。；、（）【】\])]+[\\/][^\s<>"'，。；、（）【】\])]+/g, '资料')
  .replace(/(?:https?:\/\/|file:\/\/|www\.)[^\s，。；<>"')]+/gi, '资料')
  .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,63}(?:\/[^\s，。；<>"')]+)?/gi, '资料')
  .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:\/[^\s，。；<>"')]+)?/g, '资料')
  .replace(/(?:[a-z]:[\\/]|\/)(?:[\w.-]+[\\/])+[^\s，。；<>"')]+/gi, '资料')
  .replace(/雷速(?:体育)?|500(?:\.com|网)|leisu|sporttery/gi, '赛前数据').slice(0, 300) : null;

function publicSection(section, kind) {
  const valid = section?.latestValid, attempt = section?.latestAttempt;
  const result = {
    status: attempt?.status || valid?.status || 'missing',
    observedAt: valid?.receivedAt || null,
    lastAttemptAt: attempt?.receivedAt || null,
    previousValue: Boolean(valid && attempt && attempt.status !== 'available'),
    data: null,
  };
  if (!valid?.data) return result;
  const sides = kind === 'injuries' ? valid.data.injuries : valid.data.teams;
  if (!Array.isArray(sides) || sides.some(item => !['home', 'away'].includes(item?.side))) throw new Error('Invalid team side');
  if (kind === 'lineup' && (sides.length !== 2 || new Set(sides.map(t => t.side)).size !== 2 ||
    sides.some(t => !Array.isArray(t.starters) || t.starters.length !== 11 || !Array.isArray(t.substitutes)))) throw new Error('Invalid lineup');
  if (kind === 'injuries') result.data = { players: valid.data.injuries.map(p => ({
    side: p.side, name: cleanText(p.name), reason: cleanText(p.reasonAsDisplayed),
    position: cleanText(p.positionAsDisplayed), expectedReturn: cleanText(p.returnDateAsDisplayed),
  })) };
  else result.data = { teams: valid.data.teams.map(team => ({
    side: team.side, name: cleanText(team.name), formation: cleanText(team.formation), coach: cleanText(team.coach),
    starters: team.starters.map(p => ({ name: cleanText(p.name), jersey: cleanText(p.jersey) })),
    substitutes: team.substitutes.map(p => ({ name: cleanText(p.name), jersey: cleanText(p.jersey) })),
  })) };
  return result;
}

function publicEvidence(selected, fixture) {
  const eventAt = Date.parse(fixture.eventVersion || fixture.kickoffTime || '');
  return {
    matchId: fixture.id, eventVersion: Number.isFinite(eventAt) ? new Date(eventAt).toISOString() : null,
    status: selected.status, updatedAt: selected.generatedAt,
    predictionEligible: false,
    sections: {
      injuries: publicSection(selected.sections?.injuries, 'injuries'),
      lineup: publicSection(selected.sections?.lineup, 'lineup'),
    },
  };
}

async function readCollectionStatus(file, now) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 16384) return null;
    const bytes = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== stat.size) return null;
    const value = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
    if (value.version !== 'prematch-scheduler-v1' || value.predictionEligible !== false) return null;
    const states = new Set(['disabled', 'running', 'blocked', 'login_required', 'source-unavailable', 'fixture-stale',
      'fixture-unavailable', 'collection-paused', 'completed', 'no-due-tasks', 'budget-exhausted', 'browser-unavailable', 'runtime-error']);
    const time = input => typeof input === 'string' && Number.isFinite(Date.parse(input)) ? new Date(input).toISOString() : null;
    const number = input => Number.isSafeInteger(input) && input >= 0 ? input : null;
    return { enabled: value.enabled === true, state: states.has(value.state) ? value.state : 'runtime-error',
      checkedAt: time(value.checkedAt), lastRunAt: time(value.lastRunAt), lastSuccessAt: time(value.lastSuccessAt), nextAttemptAt: time(value.nextAttemptAt),
      statusFresh: Number.isFinite(Date.parse(value.checkedAt)) && now - Date.parse(value.checkedAt) >= 0 && now - Date.parse(value.checkedAt) < 15 * 60000,
      sourceState: ['available', 'blocked', 'login_required', 'parse_error', 'conflict'].includes(value.sourceAccess?.state) ? value.sourceAccess.state : null,
      sourceHttpStatus: number(value.sourceAccess?.httpStatus),
      fixtureState: ['available', 'stale', 'unavailable'].includes(value.fixtureInput?.state) ? value.fixtureInput.state : null,
      eligibleMatches: number(value.fixtureInput?.eligibleMatches), collectedRows: number(value.collectedRows),
      strategy: { timezone: 'Asia/Shanghai', days: 2, checkMinutes: 5, injuriesEveryHours: 6,
        lineupMinutesBeforeKickoff: [90, 60, 30, 20, 10], automaticOdds: false } };
  } catch { return null; } finally { await handle?.close(); }
}

const publicTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const sectionStates = new Set(['available', 'source_empty', 'missing', 'unmapped', 'not-due', 'stale', 'blocked', 'login_required', 'parse_error', 'conflict', 'unavailable', 'budget-exhausted']);

async function readApiCollectionStatus(referencePath, now, fixture) {
  if (!referencePath) return null;
  let handle;
  try {
    handle = await fs.open(path.join(path.dirname(referencePath), 'daily-prematch-api/status.json'), 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 512 * 1024) return null;
    const value = JSON.parse(await handle.readFile('utf8'));
    const completed = Date.parse(value.completedAt);
    const states = ['completed', 'partial', 'no-due-tasks', 'source-unavailable', 'runtime-error', 'budget-exhausted'];
    if (value.version !== 'daily-prematch-api-v2' || value.provider !== 'api-football' || value.predictionEligible !== false
      || !Number.isFinite(completed) || completed > now || !states.includes(value.state)) return null;
    const failed = ['source-unavailable', 'runtime-error'].includes(value.state);
    const checkMinutes = value.checkIntervalMinutes === 5 ? 5 : 30;
    const checkIntervalMs = checkMinutes * 60000;
    const count = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
    const matches = fixture && Array.isArray(value.coverage) ? value.coverage.filter(item => item?.id === fixture.id) : [];
    const coverage = matches.length === 1 && matches[0].home === fixture.homeTeamName && matches[0].away === fixture.awayTeamName
      && publicTime(matches[0].kickoff) === publicTime(fixture.eventVersion || fixture.kickoffTime) ? matches[0] : null;
    const matchCoverage = coverage ? { mappingState: coverage.mapped === true ? 'verified' : coverage.mapped === false ? 'unmapped' : 'unknown',
      sections: Object.fromEntries(['injuries', 'lineup'].map(kind => {
        const attempt = coverage.attempts?.[kind], at = publicTime(attempt?.lastAttemptAt);
        return [kind, { status: sectionStates.has(coverage[kind]) ? coverage[kind] : 'missing',
          lastAttemptAt: at && Date.parse(at) <= completed ? at : null,
          attemptStatus: sectionStates.has(attempt?.status) ? attempt.status : null }];
      })) } : null;
    return { provider: 'api-football', enabled: true, state: value.state, checkedAt: value.completedAt,
      lastRunAt: publicTime(value.startedAt), lastSuccessAt: failed ? null : value.completedAt,
      nextAttemptAt: publicTime(value.nextAttemptAt) || new Date((Math.floor(completed / checkIntervalMs) + 1) * checkIntervalMs).toISOString(),
      statusFresh: now - completed < 65 * 60000, sourceState: failed ? 'parse_error' : 'available', sourceHttpStatus: null,
      fixtureState: value.rosterReceivedAt && now - Date.parse(value.rosterReceivedAt) < 65 * 60000 ? 'available' : 'stale',
      eligibleMatches: count(value.matches), collectedRows: count(value.referenceMatches), dataComplete: value.dataComplete === true,
      ...(matchCoverage ? { matchCoverage } : {}),
      strategy: { timezone: 'Asia/Shanghai', scope: 'official-business-date', checkMinutes, injuriesEveryHours: 6,
        lineupMinutesBeforeKickoff: [60, 30], automaticOdds: false } };
  } catch { return null; } finally { await handle?.close(); }
}

function createWebsiteReader({ exportPath, apiFootballReferencePath, readFixture, maxBytes = 10 * 1024 * 1024, now = Date.now }) {
  if (typeof readFixture !== 'function') throw new TypeError('readFixture must read the current website fixture');
  if (exportPath && !path.isAbsolute(exportPath)) throw new TypeError('exportPath must be an absolute configured path');
  if (apiFootballReferencePath && !path.isAbsolute(apiFootballReferencePath)) throw new TypeError('apiFootballReferencePath must be an absolute configured path');
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 50 * 1024 * 1024) throw new TypeError('Invalid export size limit');
  return async siteMatchId => {
    if (typeof siteMatchId !== 'string' || !/^sporttery_[1-9]\d*$/.test(siteMatchId) || /\s/.test(siteMatchId)) return { status: 'invalid-id', predictionEligible: false };
    if (!exportPath && !apiFootballReferencePath) return { matchId: siteMatchId, status: 'disabled', predictionEligible: false };
    const fixture = await readFixture(siteMatchId);
    if (!fixture || fixture.id !== siteMatchId) return { matchId: siteMatchId, status: 'missing', predictionEligible: false };
    const suppliedNow = now(), at = typeof suppliedNow === 'string' ? Date.parse(suppliedNow) : suppliedNow;
    const [apiCollection, leisuCollection] = await Promise.all([
      readApiCollectionStatus(apiFootballReferencePath, at, fixture),
      exportPath ? readCollectionStatus(path.join(path.dirname(exportPath), 'collection-status.json'), at) : null,
    ]);
    // Keep the older aggregate field for existing clients; source-specific states
    // below are independent, so a successful fallback cannot conceal a 405.
    const collection = apiCollection || leisuCollection;
    const statusFields = collection ? { collection } : {};
    let apiReference = null, apiDiagnostics = null, apiReadState = apiFootballReferencePath ? 'unavailable' : 'disabled';
    if (apiFootballReferencePath) {
      let referenceHandle;
      try {
        referenceHandle = await fs.open(apiFootballReferencePath, 'r');
        const stat = await referenceHandle.stat();
        if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw Error('Reference export too large');
        const apiDocument = JSON.parse(await referenceHandle.readFile('utf8'));
        const reference = require('./api-football-reference.cjs').selectReference(apiDocument, fixture, at);
        apiReadState = reference ? 'ok' : apiDocument?.items?.some?.(item => item?.fixture?.siteMatchId === siteMatchId) ? 'conflict' : 'missing';
        if (publicTime(apiDocument?.generatedAt) && at - Date.parse(apiDocument.generatedAt) > 6 * 3600000) apiReadState = 'stale';
        apiDiagnostics = expiredApiSections(apiDocument, fixture, at);
        if (!reference && apiDiagnostics && Object.values(apiDiagnostics).some(s => s.status === 'stale')) apiReadState = 'stale';
        if (reference) {
          // Only bounded public fields leave this private collector export.
          for (const section of Object.values(reference.sections)) {
            for (const player of section.data?.players || []) for (const key of ['name', 'reason', 'position']) player[key] = cleanText(player[key]);
            for (const team of section.data?.teams || []) {
              team.formation = cleanText(team.formation);
              for (const player of [...team.starters, ...team.substitutes]) player.name = cleanText(player.name);
            }
          }
          apiReference = reference;
        }
      } catch {} finally { await referenceHandle?.close(); }
    }
    let handle, document, leisuReference = { matchId: siteMatchId, status: exportPath ? 'unavailable' : 'disabled', predictionEligible: false };
    try {
      // The path is operator configuration, never derived from a request ID.
      // Open/stat/read the same inode so atomic export rotation is safe.
      if (!exportPath) throw new Error('source not configured');
      handle = await fs.open(exportPath, 'r');
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > maxBytes) throw new Error('invalid export size');
      const bytes = Buffer.alloc(Math.min(stat.size + 1, maxBytes + 1));
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset > stat.size || offset > maxBytes) throw new Error('export grew beyond its size limit');
      document = JSON.parse(bytes.subarray(0, offset).toString('utf8'));
      leisuReference = publicEvidence(selectEvidence(document, fixture, at), fixture);
    } catch {} finally { await handle?.close(); }
    return mergeSources({ fixture, at, leisuReference, apiReference, apiReadState, apiDiagnostics, leisuCollection, apiCollection, statusFields });
  };
}

function expiredApiSections(document, fixture, at) {
  const strictTime = require('../../src/services/strictInstant.cjs').strictInstant;
  const generated = strictTime(document?.generatedAt), kickoff = strictTime(fixture.kickoffTime);
  if (document?.version !== 'api-football-prematch-reference-v1' || document?.provider !== 'api-football'
    || document.predictionEligible !== false || !generated || !kickoff || Date.parse(generated) > at
    || !Array.isArray(document.items) || document.items.length > 200) return null;
  const matches = document.items.filter(item => item?.fixture?.siteMatchId === fixture.id), saved = matches[0]?.fixture;
  if (matches.length !== 1 || saved.homeName !== fixture.homeTeamName || saved.awayName !== fixture.awayTeamName
    || strictTime(saved.kickoffUtc) !== kickoff || strictTime(saved.eventVersion) !== strictTime(fixture.eventVersion || fixture.kickoffTime)) return null;
  return Object.fromEntries(['injuries', 'lineup'].map(kind => {
    const section = matches[0].sections?.[kind], receipt = strictTime(section?.observedAt);
    const expired = section?.status === 'available' && receipt && Date.parse(receipt) <= Date.parse(generated)
      && Date.parse(receipt) < Date.parse(kickoff) && at - Date.parse(receipt) > (kind === 'injuries' ? 6 : 2) * 3600000;
    return [kind, { status: expired ? 'stale' : 'missing', observedAt: expired ? receipt : null,
      lastAttemptAt: expired ? receipt : null, previousValue: false, data: null }];
  }));
}

function sourceSection(reference, kind, provider, collection, at) {
  const piece = reference?.sections?.[kind];
  const coverage = collection?.matchCoverage;
  const attempt = coverage?.sections?.[kind];
  let result = piece ? { ...piece } : { status: 'missing', observedAt: null, lastAttemptAt: null, previousValue: false, data: null };
  // Export freshness alone cannot make an old per-section receipt current.
  if (result.data && at - Date.parse(result.observedAt) > (kind === 'injuries' ? 6 : 2) * 3600000) {
    result = { ...result, status: 'stale', data: null, previousValue: false };
  }
  if (attempt?.lastAttemptAt && (!result.lastAttemptAt || Date.parse(attempt.lastAttemptAt) > Date.parse(result.lastAttemptAt))) {
    result.lastAttemptAt = attempt.lastAttemptAt;
    if (attempt.attemptStatus && attempt.attemptStatus !== 'available') {
      result.status = attempt.attemptStatus;
      result.previousValue = Boolean(result.data);
    }
  }
  if (!result.data && result.status === 'missing') {
    const envelope = reference?.status;
    result.status = ['stale', 'conflict', 'ineligible'].includes(envelope) ? envelope
      : coverage?.mappingState === 'unmapped' ? 'unmapped'
      : attempt?.status && attempt.status !== 'available' ? attempt.status
      : ['blocked', 'login_required', 'parse_error', 'conflict'].includes(collection?.sourceState) ? collection.sourceState
      : envelope && !['ok', 'missing'].includes(envelope) ? envelope : 'missing';
  }
  if (!result.data && coverage?.mappingState === 'unmapped') result.status = 'unmapped';
  return { ...result, provider, missingReason: result.data ? null : result.status };
}

function mergeSources({ fixture, at, leisuReference, apiReference, apiReadState, apiDiagnostics, leisuCollection, apiCollection, statusFields }) {
  const leisu = Object.fromEntries(['injuries', 'lineup'].map(kind => [kind, sourceSection(leisuReference, kind, 'leisu', leisuCollection, at)]));
  const api = Object.fromEntries(['injuries', 'lineup'].map(kind => {
    const reference = apiReference ? { ...apiReference, sections: { ...apiReference.sections,
      [kind]: !apiReference.sections[kind]?.data && apiDiagnostics?.[kind]?.status === 'stale' ? apiDiagnostics[kind] : apiReference.sections[kind] } }
      : { status: apiReadState, sections: apiDiagnostics };
    return [kind, sourceSection(reference, kind, 'api-football', apiCollection, at)];
  }));
  const sections = Object.fromEntries(['injuries', 'lineup'].map(kind => {
    // Selection is per section. A failed latest Leisu attempt may retain its
    // genuine prior receipt, but a fresh independent API receipt wins first.
    const candidates = [leisu[kind], api[kind]];
    const responseTime = piece => Date.parse(piece.lastAttemptAt || (piece.provider === 'leisu' ? leisuCollection : apiCollection)?.checkedAt || '') || 0;
    const answered = candidates.filter(piece => ['source_empty', 'not-due'].includes(piece.status))
      .sort((a, b) => responseTime(b) - responseTime(a));
    const selected = candidates.find(piece => piece.data && !piece.previousValue)
      || candidates.find(piece => piece.data)
      || answered[0]
      || candidates.find(piece => !['missing', 'disabled', 'unavailable'].includes(piece.status))
      || candidates.find(piece => piece.status !== 'disabled') || candidates[0];
    return [kind, { ...selected, statusProvider: selected.provider,
      fallback: Boolean(selected.data && selected.provider === 'api-football'), provider: selected.data ? selected.provider : null }];
  }));
  const view = section => ({ status: section.status, observedAt: section.observedAt, lastAttemptAt: section.lastAttemptAt,
    previousValue: section.previousValue, missingReason: section.missingReason });
  const sources = {
    leisu: { provider: 'leisu', status: leisuReference.status,
      mappingState: Object.values(leisu).some(s => s.observedAt || s.lastAttemptAt) ? 'verified' : leisuReference.status === 'conflict' ? 'conflict' : 'unknown',
      sections: Object.fromEntries(Object.entries(leisu).map(([kind, section]) => [kind, view(section)])), ...(leisuCollection ? { collection: leisuCollection } : {}) },
    'api-football': { provider: 'api-football', status: apiReference?.status || apiReadState,
      mappingState: apiReference ? 'verified' : apiCollection?.matchCoverage?.mappingState || (apiReadState === 'conflict' ? 'conflict' : 'unknown'),
      sections: Object.fromEntries(Object.entries(api).map(([kind, section]) => [kind, view(section)])), ...(apiCollection ? { collection: apiCollection } : {}) },
  };
  const providers = [...new Set(Object.values(sections).filter(s => s.data).map(s => s.provider))];
  const updatedAt = [leisuReference.updatedAt, apiReference?.updatedAt].filter(Boolean).sort().at(-1) || null;
  const any = Object.values(sections).some(s => s.data);
  const answered = Object.values(sections).some(s => ['source_empty', 'not-due'].includes(s.status));
  return { matchId: fixture.id, eventVersion: publicTime(fixture.eventVersion || fixture.kickoffTime),
    status: any ? 'ok' : answered ? 'partial' : leisuReference.status === 'disabled' ? apiReadState : leisuReference.status,
    updatedAt, predictionEligible: false, provider: providers.length > 1 ? 'mixed' : providers[0] || null,
    sections, sources, ...statusFields };
}

function createWebsiteHandler(options) {
  if (typeof options?.authorize !== 'function') throw new TypeError('An explicit website authorization callback is required');
  const read = createWebsiteReader(options);
  return async (req, res, siteMatchId) => {
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store' });
      res.end(req.method === 'HEAD' ? '' : JSON.stringify(body));
    };
    if (!['GET', 'HEAD'].includes(req.method)) return send(405, { status: 'method-not-allowed' });
    let authorized = false;
    try { authorized = await options.authorize(req) === true; } catch {}
    if (!authorized) return send(401, { status: 'unauthorized' });
    try {
      const result = await read(siteMatchId);
      return send(result.status === 'invalid-id' ? 400 : result.status === 'missing' ? 404 : 200, result);
    } catch { return send(503, { status: 'unavailable', predictionEligible: false }); }
  };
}

module.exports = { createWebsiteReader, createWebsiteHandler, publicEvidence, readCollectionStatus, readApiCollectionStatus };
