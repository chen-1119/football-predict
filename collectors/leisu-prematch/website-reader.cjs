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

function createWebsiteReader({ exportPath, readFixture, maxBytes = 10 * 1024 * 1024, now = Date.now }) {
  if (typeof readFixture !== 'function') throw new TypeError('readFixture must read the current website fixture');
  if (exportPath && !path.isAbsolute(exportPath)) throw new TypeError('exportPath must be an absolute configured path');
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 50 * 1024 * 1024) throw new TypeError('Invalid export size limit');
  return async siteMatchId => {
    if (typeof siteMatchId !== 'string' || !/^sporttery_[1-9]\d*$/.test(siteMatchId) || /\s/.test(siteMatchId)) return { status: 'invalid-id', predictionEligible: false };
    if (!exportPath) return { matchId: siteMatchId, status: 'disabled', predictionEligible: false };
    const fixture = await readFixture(siteMatchId);
    if (!fixture || fixture.id !== siteMatchId) return { matchId: siteMatchId, status: 'missing', predictionEligible: false };
    const collection = await readCollectionStatus(path.join(path.dirname(exportPath), 'collection-status.json'), now());
    const statusFields = collection ? { collection } : {};
    let handle, document;
    try {
      // The path is operator configuration, never derived from a request ID.
      // Open/stat/read the same inode so atomic export rotation is safe.
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
    } catch {
      return { matchId: siteMatchId, status: 'unavailable', predictionEligible: false, ...statusFields };
    } finally { await handle?.close(); }
    try { return { ...publicEvidence(selectEvidence(document, fixture, now()), fixture), ...statusFields }; }
    catch { return { matchId: siteMatchId, status: 'unavailable', predictionEligible: false, ...statusFields }; }
  };
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

module.exports = { createWebsiteReader, createWebsiteHandler, publicEvidence, readCollectionStatus };
