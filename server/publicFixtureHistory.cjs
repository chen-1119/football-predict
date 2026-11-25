'use strict';

const { canonicalSourceMatchId, isTrustedOfficialFinal, isOfficialSportteryVoid } = require('../src/services/matchLifecycle.cjs');
const { day } = require('./researchArchiveRead.cjs');

function validDay(value) {
  try { return day(value); } catch { return null; }
}

function text(value) {
  return typeof value === 'string' && value.length <= 255 ? value.trim() : '';
}

function publicArchiveFixture(row) {
  const date = validDay(row.businessDate);
  const home = text(row.homeTeamName), away = text(row.awayTeamName);
  const id = text(row.id), kickoff = text(row.kickoffTime);
  if (!date || !id || !home || !away || !Number.isFinite(Date.parse(kickoff))) return null;
  const sourceConflict = row.sourceMatchId != null && canonicalSourceMatchId(row.sourceMatchId) !== canonicalSourceMatchId(id);
  const voided = !sourceConflict && isOfficialSportteryVoid(row);
  const finished = !sourceConflict && !voided && isTrustedOfficialFinal(row);
  return {
    id, businessDate: date, matchNo: text(row.matchNo), leagueName: text(row.leagueName),
    homeTeamName: home, awayTeamName: away, kickoffTime: new Date(kickoff).toISOString(),
    status: sourceConflict ? 'CONFLICT' : voided ? 'VOID' : finished ? 'FINISHED' : 'PENDING_RESULT',
    scoreHome: finished ? row.scoreHome : null, scoreAway: finished ? row.scoreAway : null,
  };
}

function buildArchive(rows) {
  const byDay = new Map();
  for (const match of rows) {
    if (!byDay.has(match.businessDate)) byDay.set(match.businessDate, []);
    byDay.get(match.businessDate).push(match);
  }
  const dates = [...byDay.keys()].sort().reverse();
  for (const matches of byDay.values()) {
    matches.sort((a, b) => a.kickoffTime.localeCompare(b.kickoffTime) || a.matchNo.localeCompare(b.matchNo) || a.id.localeCompare(b.id));
  }
  const latestResultDate = dates.find(date => byDay.get(date).some(row => row.status === 'FINISHED')) || null;
  return { dates, latestResultDate, byDay };
}

function createNativeCache() {
  let slot = null;
  return async function cached(key, load) {
    if (!slot || slot.key !== key) {
      const value = Promise.resolve().then(load).then(rows => rows.map(publicArchiveFixture).filter(Boolean));
      const next = {key, value};
      slot = next;
      value.catch(() => { if (slot === next) slot = null; });
    }
    return slot.value;
  };
}

function mergeSources(native, signed) {
  const rows = [...native], ids = new Map(), slots = new Map();
  const slotOf = r => r.businessDate + ':' + r.matchNo;
  function remember(map, key, index) {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(index);
  }
  function indexFixture(r, index) {
    remember(ids, canonicalSourceMatchId(r.id), index);
    if (r.matchNo) remember(slots, slotOf(r), index);
  }
  rows.forEach(indexFixture);
  const identity = ['businessDate', 'matchNo', 'kickoffTime', 'homeTeamName', 'awayTeamName'];
  for (const r of signed) {
    const byId = ids.get(canonicalSourceMatchId(r.id)) || [], bySlot = slots.get(slotOf(r)) || [];
    if (!byId.length && !bySlot.length) { indexFixture(r, rows.length); rows.push(r); continue; }
    const prior = rows[byId[0]];
    const same = byId.length === 1 && bySlot.length === 1 && byId[0] === bySlot[0] && identity.every(field => prior[field] === r[field]);
    if (same && (prior.status === 'PENDING_RESULT' || r.status === 'PENDING_RESULT'
        || (prior.status === r.status && prior.scoreHome === r.scoreHome && prior.scoreAway === r.scoreAway))) {
      if (prior.status === 'PENDING_RESULT') rows[byId[0]] = r;
      continue;
    }
    for (const index of new Set([...byId, ...bySlot])) {
      rows[index] = {...rows[index], status: 'CONFLICT', scoreHome: null, scoreAway: null};
    }
  }
  return buildArchive(rows);
}

function createArchiveReader(readNative, readSigned) {
  let combined, inflightNative;
  function readNativeBounded() {
    if (!inflightNative) inflightNative = Promise.resolve().then(readNative).finally(() => { inflightNative = null; });
    let timer;
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(null), 4000); });
    return Promise.race([inflightNative, timeout]).finally(() => clearTimeout(timer));
  }
  async function load() {
    const [stored, recent] = await Promise.allSettled([readNativeBounded(), Promise.resolve().then(readSigned)]);
    const native = stored.status === 'fulfilled' ? stored.value : null;
    const signed = recent.status === 'fulfilled' ? recent.value : null;
    if (!native && !signed) throw new Error('archive unavailable');
    if (!combined || combined.native !== native || combined.signed !== signed)
      combined = {native, signed, archive: mergeSources(native || [], signed?.matches || [])};
    return combined;
  }
  function checkDate(date) {
    if (date !== null && !validDay(date)) throw Object.assign(new Error('invalid match day'), {status: 400});
  }
  async function read(date) {
    checkDate(date);
    const {native, signed, archive} = await load();
    const selectedDate = date || archive.latestResultDate || archive.dates[0] || null;
    return {dates: archive.dates, latestResultDate: archive.latestResultDate, businessDate: selectedDate,
      sourceAvailable: {native: Boolean(native), signed: Boolean(signed)},
      incomplete: Boolean(signed?.incompleteDates.includes(selectedDate)),
      matches: archive.byDay.get(selectedDate) || []};
  }
  read.find = async (id, date = null) => {
    checkDate(date);
    const {native, signed, archive} = await load();
    const key = canonicalSourceMatchId(id);
    const rows = date ? archive.byDay.get(date) || [] : [...archive.byDay.values()].flat();
    const matches = rows.filter(r => canonicalSourceMatchId(r.id) === key);
    if (matches.length === 1) return matches[0];
    if (!matches.length && (!native || !signed || (date ? signed.incompleteDates.includes(date) : signed.incompleteDates.length > 0))) {
      throw new Error('fixture archive coverage unavailable');
    }
    return null;
  };
  return read;
}

module.exports = { validDay, publicArchiveFixture, buildArchive, createNativeCache, mergeSources, createArchiveReader };
