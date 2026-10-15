'use strict';
const p = require('../../scripts/recommendationPlatform/reviewedAnalysis.cjs');
const { verifyRow } = require('../../scripts/postgresPrivateModelArtifactStore.cjs');
const { SELECT } = require('../../scripts/leagueBaselineRegistry.cjs');
const { epochNanoseconds } = require('../../src/services/prematchV3Clock.cjs');
const VERSION = 'reviewed-committed-combo-archive-v1';
const check = (value, code) => p.check(value, 'COMMITTED_COMBO_' + code);
const stamp = value => { const ns = epochNanoseconds(value); check(ns !== null, 'CLOCK'); return ns; };
function verifyView(view, observedAt) {
  const { contentHash, ...body } = view || {};
  check(view?.version === 'reviewed-analysis-view-v1' && view.formalEligible === false && p.hash(body) === contentHash, 'VIEW_SEAL');
  check(Array.isArray(view.records) && view.records.length >= 2 && view.records.length <= 32 && new Set(view.records.map(r => r.eventId)).size === view.records.length, 'RECORD_BOUND');
  check(stamp(view.createdAt) < stamp(view.commitObservedAt) && stamp(view.commitObservedAt) <= stamp(view.updatedAt) && stamp(view.updatedAt) <= stamp(observedAt), 'OBSERVATION_CLOCK');
  let populated = 0;
  for (const [key, size] of [['combos', 2], ['threeCombos', 3]]) {
    const values = view[key] || []; check(Array.isArray(values) && values.length <= 3, 'COMBO_BOUND');
    const groups = new Set(), bands = new Set();
    for (const combo of values) {
      check([2.5, 5, 10].includes(combo.band) && !bands.has(combo.band) && Array.isArray(combo.legs), 'BAND'); bands.add(combo.band);
      if (!combo.legs.length) { check(combo.product === null && combo.confidence === null, 'EMPTY'); continue; }
      populated++; check(combo.legs.length === size, 'SIZE');
      const bound = combo.legs.map(leg => {
        const record = view.records.find(r => r.eventId === leg.eventId); check(record && record.businessDate === view.businessDate, 'EVENT');
        const exact = { eventId: record.eventId, matchNum: record.matchNum, market: record.market, ...(record.market === 'HHAD' ? { handicap: record.handicap } : {}), selection: record.selection, sp: record.sp };
        check(p.hash(leg) === p.hash(exact) && stamp(observedAt) < stamp(record.cutoffAt) && stamp(record.cutoffAt) <= stamp(record.eventVersion), 'LEG_BINDING'); return record;
      });
      const group = bound.map(r => r.eventId).sort().join('/');
      check(new Set(bound.map(r => r.eventId)).size === size && !groups.has(group), 'DUPLICATE'); groups.add(group);
      const product = require('../../scripts/recommendationPlatform/reviewedComboHistory.cjs').exactProduct(combo.legs);
      const confidence = bound.some(r => r.confidence === '低') ? '低' : bound.some(r => r.confidence === '中') ? '中' : '高';
      check(combo.product === product && product >= combo.band && combo.confidence === confidence, 'PRODUCT');
    }
  }
  check(populated > 0, 'NO_SAVED_COMBO'); return true;
}
function prepare(view, publication, observedAt) {
  verifyView(view, observedAt);
  check(/^g-[a-f0-9]{64}$/.test(publication?.generationId || '') && stamp(publication.committedAt) <= stamp(observedAt), 'PUBLICATION');
  const stateHash = p.hash({ records: view.records, publicationHash: view.publicationHash, draftHash: view.draftHash, combos: view.combos, threeCombos: view.threeCombos || [] });
  const key = `reviewed-combo-view-${view.businessDate}-${stateHash}`;
  const archive = { version: VERSION, businessDate: view.businessDate, createdAt: observedAt, settlementEligible: false,
    source: { kind: 'postgres-committed-view', artifactKey: key, generationId: publication.generationId, committedAt: publication.committedAt, observedAt, viewJsonSha256: p.sha(JSON.stringify(view)) }, view };
  const sealed = p.seal(archive); check(Buffer.byteLength(JSON.stringify(sealed)) <= 524288, 'PAYLOAD_BOUND');
  return { key, archive: sealed };
}
async function retain(client, view, publication, observedAt) {
  if(view?.comboFreezePolicy==='persisted-original-groups-v1'){
    const restored=await require('../../server/researchFrozenCombos.cjs').freezeOriginalGroups(client,view,observedAt);
    check(p.hash(restored.combos)===p.hash(view.combos)&&p.hash(restored.threeCombos)===p.hash(view.threeCombos),'FROZEN_GROUP_CHANGED');
    return {retained:false,reason:'original-groups-already-archived'};
  }
  const { key, archive } = prepare(view, publication, observedAt);
  const prior = (await client.query(SELECT, [key])).rows;
  if (prior.length) { const row = verifyRow(prior[0], key, 524288); check(row.artifactVersion === VERSION && p.hash(row.payload.view.records) === p.hash(view.records), 'IMMUTABLE_CONFLICT'); return { key, retained: false }; }
  const counts = (await client.query('SELECT count(*)::int AS total FROM football.private_model_artifacts WHERE artifact_version=$1 AND artifact_key LIKE $2', [VERSION, `reviewed-combo-view-${view.businessDate}-%`])).rows;
  check(counts[0]?.total < 64, 'DAILY_BOUND');
  const json = JSON.stringify(archive);
  await client.query(`INSERT INTO football.private_model_artifacts (artifact_key,artifact_version,generated_at,updated_at,payload,payload_sha256,payload_bytes)
    VALUES($1,$2,$3,$3,$4::json,$5,$6)`, [key, VERSION, observedAt, json, p.sha(json), Buffer.byteLength(json)]);
  const row = verifyRow((await client.query(SELECT, [key])).rows[0], key, 524288); check(row.payloadJson === json, 'ROUNDTRIP');
  return { key, retained: true };
}
async function restore(client, history, asOf) {
  const keys = (await client.query(`SELECT artifact_key FROM football.private_model_artifacts WHERE artifact_version=$1 AND artifact_key LIKE $2 ORDER BY generated_at DESC,artifact_key LIMIT 65`, [VERSION, `reviewed-combo-view-${history.businessDate}-%`])).rows;
  check(keys.length <= 64, 'DAILY_BOUND');
  for (const { artifact_key: key } of keys) {
    const row = verifyRow((await client.query(SELECT, [key])).rows[0], key, 524288), archive = row.payload;
    const { contentHash, ...body } = archive; check(row.artifactVersion === VERSION && contentHash === p.hash(body) && archive.settlementEligible === false && archive.source?.artifactKey === key, 'ARCHIVE_SEAL');
    check(p.hash(prepare(archive.view, { generationId: archive.source.generationId, committedAt: archive.source.committedAt }, archive.source.observedAt).archive) === p.hash(archive), 'ARCHIVE_IDENTITY');
    check(archive.source.viewJsonSha256 === p.sha(JSON.stringify(archive.view)) && stamp(archive.createdAt) <= stamp(asOf), 'ARCHIVE_CLOCK');
    if (archive.businessDate !== history.businessDate || archive.view.publicationHash !== history.publicationHash || archive.view.draftHash !== history.draftHash || p.hash(archive.view.records) !== p.hash(history.records)) continue;
    const { contentHash: ignored, ...value } = history; void ignored;
    return p.seal({ ...value, comboArchive: archive });
  }
  return history;
}
module.exports = { VERSION, verifyView, prepare, retain, restore };
