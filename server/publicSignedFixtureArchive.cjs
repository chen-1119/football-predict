'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const { resolve } = require('node:path');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { performance } = require('node:perf_hooks');
const { verifyCollectorAttestation, COLLECTOR_TRUST_REGISTRY_VERSION } = require('../src/services/collectorAttestation.cjs');
const { expectedCollectorCommitment } = require('./relayCollectorEvidence.cjs');
const { validDay } = require('./publicFixtureHistory.cjs');
const { SPORTTERY_BASE } = require('../scripts/sportteryEndpointContract.cjs');

const MAX_BYTES = 16 * 1024 * 1024, MAX_PAGES = 128;
const requireProof = condition => { if (!condition) throw new Error('official fixture archive could not be verified'); };
const numberId = value => /^[1-9]\d{0,17}$/.test(String(value));
const name = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 255;

function* verifiedPages(snapshot, registry, now) {
  requireProof(registry?.version === COLLECTOR_TRUST_REGISTRY_VERSION && Array.isArray(registry.keys));
  requireProof(Array.isArray(snapshot?.endpoints) && snapshot.endpoints.length <= MAX_PAGES + 12);
  const pages = snapshot.endpoints.filter(e => e.method === 'all').sort((a, b) => a.page - b.page);
  requireProof(pages.length > 0 && pages.length <= MAX_PAGES);
  const groups = new Map(), ids = new Set(), issueSlots = new Set();
  const asOf = new Date(now + 8 * 3600000).toISOString().slice(0, 10);
  for (const [index, e] of pages.entries()) {
    const page = index + 1, req = e.sourceRequest, value = e.payload?.value;
    const base = SPORTTERY_BASE + '/gateway/uniform/fb/getMatchDataPageListV1.qry?method=all&pageSize=80';
    const url = page === 1 ? base : base + '&pageNo=' + page + '&pageType=0';
    const received = Date.parse(e.receivedAt), requested = Date.parse(e.requestedAt);
    requireProof(e.page === page && e.url === url && req?.url === url && req.method === 'GET'
      && req.role === 'method:all' && req.page === page && e.ok === true && e.httpStatus === 200
      && /^application\/json(?:\s*;|$)/i.test(e.contentType) && e.payload?.success === true
      && Number.isSafeInteger(e.rawBytes) && e.rawBytes > 0 && e.rawBytes <= 2 * 1024 * 1024
      && e.sourceCycleId && e.sourceCycleId === snapshot.sourceCycleId
      && requested <= received && received <= now
      && value?.pageNo === page && value.prePage === (page === pages.length ? '0' : '1')
      && Array.isArray(value.matchInfoList) && value.matchInfoList.length <= 160);
    requireProof(verifyCollectorAttestation(e.collectorAttestation, {
      trustRegistry: registry, payload: e.payload, expected: expectedCollectorCommitment(e),
    }).eligible);
    let rowCount = 0;
    for (const group of value.matchInfoList) {
      requireProof(Array.isArray(group?.subMatchList) && Number.isSafeInteger(group.matchCount) && group.matchCount >= 0 && group.matchCount <= 256);
      for (const row of group.subMatchList) {
        requireProof(++rowCount <= 512);
        const day = validDay(row?.businessDate);
        requireProof(day && (!group.businessDate || group.businessDate === day) && group.matchDate === day
          && validDay(row.matchDate) && /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(row.matchTime)
          && numberId(row.matchId) && numberId(row.homeTeamId) && numberId(row.awayTeamId)
          && String(row.homeTeamId) !== String(row.awayTeamId) && name(row.homeTeamAllName) && name(row.awayTeamAllName)
          && name(row.matchNumStr));
        const id = 'sporttery_' + row.matchId, slot = day + ':' + row.matchNumStr;
        requireProof(!ids.has(id) && !issueSlots.has(slot));
        ids.add(id); issueSlots.add(slot);
        if (!groups.has(day)) groups.set(day, {expected: group.matchCount, fixtures: []});
        const bucket = groups.get(day);
        requireProof(bucket.expected === group.matchCount);
        const kickoffTime = new Date(row.matchDate + 'T' + row.matchTime + '+08:00').toISOString();
        const score = /^(\d{1,2}):(\d{1,2})$/.exec(String(row.sectionsNo999 || ''));
        const terminal = String(row.matchStatus) === '11' && score && Date.parse(kickoffTime) <= received;
        const voided = String(row.matchStatus) === '12' && row.matchStatusName === '取消竞猜';
        bucket.fixtures.push({
          id, businessDate: day, matchNo: row.matchNumStr, leagueName: name(row.leagueAllName) ? row.leagueAllName : '',
          homeTeamName: row.homeTeamAllName, awayTeamName: row.awayTeamAllName, kickoffTime,
          status: terminal ? 'FINISHED' : voided ? 'VOID' : 'PENDING_RESULT',
          scoreHome: terminal ? Number(score[1]) : null, scoreAway: terminal ? Number(score[2]) : null,
        });
      }
    }
    yield;
  }
  const matches = [], incompleteDates = [];
  for (const [day, bucket] of groups) {
    if (day >= asOf) continue;
    if (bucket.expected !== bucket.fixtures.length) { incompleteDates.push(day); continue; }
    matches.push(...bucket.fixtures);
  }
  return {matches, incompleteDates};
}

function projectFullRelay(snapshot, registry, now = Date.now()) {
  const pages = verifiedPages(snapshot, registry, now);
  let step = pages.next();
  while (!step.done) step = pages.next();
  return step.value;
}

function fileToken(s) { return [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(':'); }
const MAX_REGISTRY_BYTES = 256 * 1024;

async function fixedJson(file, token, limit, check) {
  const fd = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const before = await fd.stat();
    requireProof(before.isFile() && before.size > 0 && before.size <= limit && fileToken(before) === token);
    const buffer = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < buffer.length) {
      check();
      const length = Math.min(256 * 1024, buffer.length - offset);
      const {bytesRead} = await fd.read(buffer, offset, length, offset);
      requireProof(bytesRead > 0);
      offset += bytesRead;
    }
    requireProof(fileToken(await fd.stat()) === token);
    check();
    return JSON.parse(buffer.toString('utf8'));
  } finally { await fd.close(); }
}

async function projectFile(file, token, registryFile, registryToken, check, now) {
  const [snapshot, registry] = await Promise.all([
    fixedJson(file, token, MAX_BYTES, check),
    fixedJson(registryFile, registryToken, MAX_REGISTRY_BYTES, check),
  ]);
  const pages = verifiedPages(snapshot, registry, now);
  for (;;) {
    await nextTurn();
    check();
    const step = pages.next();
    check();
    if (step.done) {
      const [current, issuer] = await Promise.all([fs.lstat(file), fs.lstat(registryFile)]);
      requireProof(fileToken(current) === token && fileToken(issuer) === registryToken);
      check();
      return step.value;
    }
  }
}
function createSignedReader(file, registryFile = process.env.SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH
  || resolve(__dirname, '../deploy/light-server/collector-trust-registry.json')) {
  let slot = null;
  return async () => {
    const [stat, registryStat] = await Promise.all([fs.lstat(file), fs.lstat(registryFile)]);
    requireProof(stat.isFile() && stat.size > 0 && stat.size <= MAX_BYTES
      && registryStat.isFile() && registryStat.size > 0 && registryStat.size <= MAX_REGISTRY_BYTES);
    const now = Date.now(), token = fileToken(stat), registryToken = fileToken(registryStat);
    const today = new Date(now + 8 * 3600000).toISOString().slice(0, 10);
    const key = token + '/' + registryToken + '/' + today;
    if (slot?.key === key) return slot.value;
    const deadline = performance.now() + 15000;
    const timeoutError = () => new Error('fixture archive verification timeout');
    const check = () => {
      if (performance.now() >= deadline) throw timeoutError();
      if (slot?.key !== key) throw new Error('fixture archive changed during verification');
    };
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(timeoutError()), 15000); });
    const pending = projectFile(file, token, registryFile, registryToken, check, now);
    const value = Promise.race([pending, timeout]).finally(() => clearTimeout(timer));
    slot = {key, value};
    // Invalid evidence stays unavailable until either the file or the issuer registry changes.
    return value;
  };
}
module.exports = {projectFullRelay, createSignedReader};
