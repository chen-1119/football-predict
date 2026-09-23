"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm");
const { digest, DEFAULT_PATH } = require("./frozenArchiveRestoration.cjs");
const { evaluateArchivePreflight: evaluate, buildReadOnlyArchiveProbe, SUCCESSOR_LINEAGE } = require("./releaseArchivePreflight.cjs");
function verifyReleaseArchivePreflight() {
  const manifest = JSON.parse(fs.readFileSync(DEFAULT_PATH));
  const at = new Date(Date.parse(manifest.observedLoss.checkedAt) + 3600000).toISOString();
  const generation = { schemaVersion: 1, generationId: "g-" + "a".repeat(64), manifestHash: "a".repeat(64), sourceCycleId: "synthetic", committedAt: at };
  const baseline = { version: "release-archive-observation-v1", checkedAt: at, releaseMarker: "b".repeat(64), generation,
    rows: manifest.rows.map(row => ({ match: { ...row.identity, status: "FINISHED" }, archiveSha256: row.archiveSha256 })), productionWrites: 0 };
  const checks = [], check = (name, fn) => { fn(); checks.push({ name, ok: true }); };
  const run = snapshot => evaluate(snapshot, manifest, at);
  check("unchanged complete baseline", () => { const r = run(baseline); assert.equal(r.ok, true); assert.equal(r.preservedRows, 601); assert.equal(r.readyToCutover, false); });
  check("serving id rekey retains only the byte-identical signed original", () => {
    const s = structuredClone(baseline), row = s.rows.find(item => item.match.id === "fivehundred_2041279");
    assert.ok(row, "audited original rekey row is missing");
    const signedArchive = manifest.rows.find(item => item.identity.id === row.match.id).archive;
    row.archiveMeta = { sourceMatchId: signedArchive.sourceMatchId, matchId: signedArchive.matchId,
      eventVersion: signedArchive.eventVersion, kickoffTime: signedArchive.kickoffTime,
      source: signedArchive.source, capturedAt: signedArchive.capturedAt, phase: signedArchive.phase,
      cutoffTime: signedArchive.cutoffTime, oddsPoolCode: signedArchive.prediction?.oddsPoolCode,
      tipCode: signedArchive.prediction?.tipCode, odds: signedArchive.prediction?.odds };
    row.match.id = "sporttery_2041279";
    const preserved = run(s);
    assert.equal(preserved.ok, true); assert.equal(preserved.preservedRows, 601);
    assert.equal(preserved.rekeyedIdentityRows, 1); assert.equal(preserved.supersededRows, 0);
    const mutated = structuredClone(s);
    mutated.rows.find(item => item.match.id === row.match.id).archiveSha256 = "0".repeat(64);
    assert.equal(run(mutated).ok, false, "id rekey may not conceal changed archive bytes");
    const changedTeam = structuredClone(s);
    changedTeam.rows.find(item => item.match.id === row.match.id).match.homeTeamName += " WRONG";
    assert.equal(run(changedTeam).ok, false, "id rekey must preserve exact signed teams");
    const changedId = structuredClone(s);
    changedId.rows.find(item => item.match.id === row.match.id).match.id = "totally_unrelated_fixture_999";
    assert.equal(run(changedId).ok, false, "only the audited old-to-new id mapping can rekey an original");
    const changedArchiveIdentity = structuredClone(s);
    changedArchiveIdentity.rows.find(item => item.match.id === row.match.id).archiveMeta.matchId = row.match.id;
    assert.equal(run(changedArchiveIdentity).ok, false, "id rekey must retain original archive identity");
    const ambiguous = structuredClone(s);
    ambiguous.rows.push({ ...structuredClone(row), match: { ...row.match, id: row.match.id.replace(/^(fivehundred|sporttery)_/, "third_") } });
    assert.equal(run(ambiguous).ok, false, "two source-equivalent rows may not silently inherit the same original");
  });
  check("successor lineage team identity is pinned by full content hash", () => {
    const team = SUCCESSOR_LINEAGE.successor.homeTeamName;
    try {
      SUCCESSOR_LINEAGE.successor.homeTeamName = team + " WRONG";
      assert.throws(() => run(baseline), /archive successor lineage content changed/);
    } finally {
      SUCCESSOR_LINEAGE.successor.homeTeamName = team;
    }
  });
  check("one exact later Sporttery archive can follow its signed FiveHundred original", () => {
    const s = structuredClone(baseline), target = s.rows.find(row => row.match.id === SUCCESSOR_LINEAGE.original.id);
    Object.assign(target.match, SUCCESSOR_LINEAGE.successor);
    target.archiveSha256 = SUCCESSOR_LINEAGE.successor.archiveSha256;
    target.archiveMeta = { sourceMatchId: SUCCESSOR_LINEAGE.successor.sourceMatchId,
      matchId: SUCCESSOR_LINEAGE.successor.id, eventVersion: SUCCESSOR_LINEAGE.successor.eventVersion,
      kickoffTime: SUCCESSOR_LINEAGE.successor.kickoffTime, source: SUCCESSOR_LINEAGE.successor.source,
      capturedAt: SUCCESSOR_LINEAGE.successor.capturedAt, phase: SUCCESSOR_LINEAGE.successor.phase,
      cutoffTime: SUCCESSOR_LINEAGE.successor.cutoffTime, oddsPoolCode: SUCCESSOR_LINEAGE.successor.oddsPoolCode,
      tipCode: SUCCESSOR_LINEAGE.successor.tipCode,
      odds: SUCCESSOR_LINEAGE.successor.odds };
    const result = run(s);
    assert.equal(result.ok, true); assert.equal(result.preservedRows, 600);
    assert.equal(result.supersededRows, 1); assert.equal(result.restorableRows, 0);
    assert.equal(result.superseded[0].originalArchiveSha256, SUCCESSOR_LINEAGE.original.archiveSha256);
    for (const [name, mutate] of [
      ["successor hash", row => { row.archiveSha256 = "0".repeat(64); }],
      ["successor id", row => { row.match.id = "fivehundred_2040739"; }],
      ["successor home team", row => { row.match.homeTeamName += " WRONG"; }],
      ["successor away team", row => { row.match.awayTeamName += " WRONG"; }],
      ["successor event", row => { row.match.eventVersion = "2026-08-09T00:00:00+08:00"; }],
      ["successor cutoff", row => { row.archiveMeta.cutoffTime = "2026-08-07 21:00:00"; }],
      ["successor capture", row => { row.archiveMeta.capturedAt = "2026-08-07T14:01:00.000Z"; }],
      ["successor tip", row => { row.archiveMeta.tipCode = "1"; }],
    ]) {
      const changed = structuredClone(s), row = changed.rows.find(item => item.match.sourceMatchId === SUCCESSOR_LINEAGE.original.sourceMatchId);
      mutate(row);
      assert.equal(run(changed).ok, false, name + " must not inherit the one-row exception");
    }
    const changedOther = structuredClone(s);
    changedOther.rows.find(row => row.match.id !== SUCCESSOR_LINEAGE.successor.id).archiveSha256 = "0".repeat(64);
    assert.equal(run(changedOther).ok, false, "the other 600 original archives remain exact");
  });
  check("all originals can be missing without inventing replacements", () => { const s = structuredClone(baseline); s.rows.forEach(r => { r.archiveSha256 = null; }); const result = run(s); assert.equal(result.ok, true); assert.equal(result.restorableRows, 601); });
  check("later omission not in observed subset is covered", () => { const s = structuredClone(baseline), r = s.rows.find(r => !manifest.observedLoss.sourceMatchIds.includes(r.match.sourceMatchId)); r.archiveSha256 = null; const result = run(s); assert.equal(result.ok, true); assert.equal(result.restorableRows, 1); });
  for (const [name, mutate] of [
    ["existing object mismatch", s => { s.rows[0].archiveSha256 = "0".repeat(64); }],
    ["event disappears", s => { s.rows.shift(); }],
    ["missing object team conflict", s => { s.rows[0].archiveSha256 = null; s.rows[0].match.homeTeamName += " WRONG"; }],
    ["missing object late original cutoff", s => { s.rows[0].archiveSha256 = null; s.rows[0].match.buyEndTime = "2000-01-01T00:00:00Z"; }],
    ["nested external cutoff retained", s => { s.rows[0].archiveSha256 = null; s.rows[0].match.externalSignals = { fiveHundred: { sale: { buyEndTime: "2000-01-01T00:00:00Z" } } }; }],
    ["official void is never republished", s => { s.rows[0].archiveSha256 = null; Object.assign(s.rows[0].match, { resultDisposition: "VOID", voidSource: "sporttery:fixture", voidReason: "cancelled" }); }],
    ["event changes", s => { s.rows[0].match.eventVersion = "2000-01-01T00:00:00Z"; }],
  ]) check(name, () => { const s = structuredClone(baseline); mutate(s); assert.equal(run(s).ok, false); });
  for (const [name, mutate] of [
    ["duplicate event", s => s.rows.push(structuredClone(s.rows[0]))],
    ["stale observation", s => { s.checkedAt = new Date(Date.parse(at) - 900001).toISOString(); }],
    ["future observation", s => { s.checkedAt = new Date(Date.parse(at) + 5001).toISOString(); }],
    ["wrong observation schema", s => { s.version = "unknown"; }],
    ["production writes rejected", s => { s.productionWrites = 1; }],
  ]) check(name, () => { const s = structuredClone(baseline); mutate(s); assert.throws(() => run(s)); });
  check("observation and manifest are not mutated", () => { const before = digest([baseline, manifest]); run(baseline); assert.equal(digest([baseline, manifest]), before); });
  check("serialized probe only reads generation and preserves nested cutoff", () => {
    const sample = { ...manifest.rows[0].identity, archivedPreMatchPrediction: manifest.rows[0].archive,
      externalSignals: { fiveHundred: { sale: { buyEndTime: "2000-01-01T00:00:00Z" } } } };
    let reads = 0, observed;
    const store = { resolveCurrentGeneration: () => ({ pointer: generation }), readGenerationFile: (_c, name) => { assert.ok(["matches-current.json", "matches-history.json"].includes(name)); reads++; return name === "matches-current.json" ? [sample] : []; } };
    vm.runInNewContext(buildReadOnlyArchiveProbe(manifest), { require: name => {
      if (name === "/opt/football-predict/server/dataGenerationStore.cjs") return store;
      if (name === "node:fs") return { readFileSync: p => { assert.equal(p, "/opt/football-predict/.release-bundle-sha256"); return baseline.releaseMarker; } };
      if (["node:crypto", "node:assert/strict"].includes(name)) return require(name);
      throw Error("unexpected capability " + name);
    }, console: { log: text => { observed = JSON.parse(text); } } }, { timeout: 1000 });
    assert.equal(reads, 2); assert.equal(observed.rows[0].archiveSha256, manifest.rows[0].archiveSha256);
    assert.equal(observed.rows[0].match.externalSignals.fiveHundred.sale.buyEndTime, "2000-01-01T00:00:00Z");
  });
  return { ok: true, checks, productionWrites: 0, synthetic: true };
}
module.exports = { verifyReleaseArchivePreflight };
if (require.main === module) console.log(JSON.stringify(verifyReleaseArchivePreflight(), null, 2));
