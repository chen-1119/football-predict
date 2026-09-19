'use strict';
const { createHash } = require('node:crypto');
const CONTRACT = '500-jczq-had-copy-v1';
const SOURCE = '500.com:jczq';
const COPY_SOURCE = '500.com:jczq:HAD';
const stable = v => v && typeof v === 'object'
  ? Array.isArray(v) ? v.map(stable) : Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v;
const digest = v => createHash('sha256').update(JSON.stringify(stable(v))).digest('hex');
const hex = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const name = v => typeof v === 'string' ? v.normalize('NFKC').trim().replace(/\s+/g, ' ') : '';
const id = v => typeof v === 'string' || typeof v === 'number' ? String(v).replace(/^sporttery_/, '').trim() : '';
function ms(value) {
  if (value instanceof Date) return Number.isFinite(+value) ? +value : NaN;
  if (typeof value !== 'string') return NaN;
  const s = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?$/.test(s)) return NaN;
  if (Number(s.slice(11, 13)) > 23 || Number(s.slice(14, 16)) > 59) return NaN;
  const d = s.slice(0, 10), date = Date.parse(`${d}T00:00:00Z`);
  if (!Number.isFinite(date) || new Date(date).toISOString().slice(0, 10) !== d) return NaN;
  return Date.parse(/Z$|[+-]\d{2}:\d{2}$/.test(s) ? s.replace(' ', 'T') : `${s.replace(' ', 'T')}+08:00`);
}
const iso = v => Number.isFinite(ms(v)) ? new Date(ms(v)).toISOString() : null;
function approvedUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && u.hostname === 'trade.500.com' && !u.port && !u.username && !u.password && !u.hash
      && ['/jczq/', '/jczq/index.php'].includes(u.pathname);
  } catch { return false; }
}
function odds(value) {
  if (!value || !['odds1', 'oddsX', 'odds2'].every(k => typeof value[k] === 'number' && Number.isFinite(value[k]) && value[k] > 1 && /^\d+(?:\.\d{1,4})?$/.test(String(value[k])))) return null;
  return { odds1: value.odds1, oddsX: value.oddsX, odds2: value.odds2 };
}
/** Only called by the warehouse bridge, on rows joined to a successful audited
 * collector run. A digest detects mutation; it is NOT a source signature. */
function buildWarehouseSpReceipt(row) {
  const p = row?.payload, a = row?.acquisition;
  if (!p || p.source !== SOURCE || p.pool !== 'had' || p.bookmaker !== 'sporttery' || p.lotterySpContract !== CONTRACT) return null;
  if (!a || a.source !== SOURCE || a.status !== 'completed'
    || !approvedUrl(a.payload?.url) || !hex(a.source_sha256) || !name(a.run_id) || !name(row.observation_id)) return null;
  if (!hex(row.content_hash) || row.content_hash !== digest(p) || row.latest_content_hash !== row.content_hash) return null;
  const first = ms(row.first_seen_at), last = ms(row.updated_at);
  if (![first, last, ms(row.last_seen_at), ms(a.started_at), ms(a.finished_at)].every(Number.isFinite)
    || first < ms(a.started_at) || first > ms(a.finished_at) || last < first || last !== ms(row.last_seen_at)) return null;
  const quote = odds(p), kickoff = iso(p.kickoffTime);
  if (!quote || !kickoff || !/^[1-9]\d*$/.test(id(p.sourceMatchId)) || !name(p.homeTeamName) || !name(p.awayTeamName)
    || name(p.homeTeamName) === name(p.awayTeamName)) return null;
  const saleCutoff = p.buyEndTime == null || p.buyEndTime === '' ? null : iso(p.buyEndTime);
  if (p.buyEndTime && !saleCutoff) return null;
  const receipt = {
    version: CONTRACT, source: COPY_SOURCE, sourceUrl: a.payload.url, priceType: 'lottery-sp', market: 'HAD',
    officialDirect: false, sourceVerification: 'warehouse-jczq-extraction',
    sourceMatchId: id(p.sourceMatchId), kickoffTime: kickoff, homeTeamName: name(p.homeTeamName), awayTeamName: name(p.awayTeamName),
    quoteOdds: quote, saleCutoff, firstObservedAt: new Date(first).toISOString(), observedAt: new Date(last).toISOString(),
    observationId: row.observation_id, acquisitionRunId: a.run_id, acquisitionBodySha256: a.source_sha256, observationContentHash: row.content_hash,
  };
  return { ...receipt, receiptHash: digest(receipt) };
}
function validReceipt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { receiptHash, ...body } = value;
  return value.version === CONTRACT && value.source === COPY_SOURCE && value.priceType === 'lottery-sp'
    && value.market === 'HAD' && value.officialDirect === false && value.sourceVerification === 'warehouse-jczq-extraction'
    && approvedUrl(value.sourceUrl) && hex(receiptHash) && digest(body) === receiptHash
    && hex(value.acquisitionBodySha256) && hex(value.observationContentHash) && Boolean(name(value.acquisitionRunId) && name(value.observationId))
    && Boolean(odds(value.quoteOdds)) && Boolean(iso(value.kickoffTime))
    && Number.isFinite(ms(value.firstObservedAt)) && ms(value.firstObservedAt) <= ms(value.observedAt)
    && (value.saleCutoff === null || Boolean(iso(value.saleCutoff)));
}
/** A bare 500.com label, externalOdds, European market or HHAD is never enough.
 * Identity must match exactly; aliases require upstream verified mapping. */
function warehouseQuoteForMatch(match, now, deadline) {
  const had = match?.externalSignals?.bookmakerOdds?.had;
  const receipt = had?.lotterySpReceipt;
  if (!validReceipt(receipt) || !odds(had)) return null;
  if (id(receipt.sourceMatchId) !== id(match.sourceMatchId || match.id)
    || ms(receipt.kickoffTime) !== ms(match.eventVersion || match.kickoffTime)
    || ms(receipt.kickoffTime) !== ms(match.kickoffTime)
    || name(receipt.homeTeamName) !== name(match.homeTeamName)
    || name(receipt.awayTeamName) !== name(match.awayTeamName)) return null;
  if (['odds1', 'oddsX', 'odds2'].some(k => had[k] !== receipt.quoteOdds[k])) return null;
  const observed = ms(receipt.observedAt), cutoffMs = Math.min(deadline, receipt.saleCutoff ? ms(receipt.saleCutoff) : deadline);
  if (!Number.isFinite(now) || !Number.isFinite(cutoffMs) || now >= cutoffMs || observed > now || now - observed > 15 * 60000 || observed >= cutoffMs) return null;
  return { odds: receipt.quoteOdds, source: COPY_SOURCE, at: receipt.observedAt, id: receipt.sourceMatchId,
    event: receipt.kickoffTime, cutoffMs, receipt };
}
module.exports = { CONTRACT, SOURCE, COPY_SOURCE, digest, buildWarehouseSpReceipt, validReceipt, warehouseQuoteForMatch };
