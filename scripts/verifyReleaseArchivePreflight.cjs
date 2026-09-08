"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm");
const { digest, DEFAULT_PATH } = require("./frozenArchiveRestoration.cjs");
const { evaluateArchivePreflight: evaluate, buildReadOnlyArchiveProbe } = require("./releaseArchivePreflight.cjs");
function verifyReleaseArchivePreflight() {
  const manifest = JSON.parse(fs.readFileSync(DEFAULT_PATH));
  const at = new Date(Date.parse(manifest.observedLoss.checkedAt) + 3600000).toISOString();
  const generation = { schemaVersion: 1, generationId: "g-" + "a".repeat(64), manifestHash: "a".repeat(64), sourceCycleId: "synthetic", committedAt: at };
  const baseline = { version: "release-archive-observation-v1", checkedAt: at, releaseMarker: "b".repeat(64), generation,
    rows: manifest.rows.map(row => ({ match: { ...row.identity, status: "FINISHED" }, archiveSha256: row.archiveSha256 })), productionWrites: 0 };
  const checks = [], check = (name, fn) => { fn(); checks.push({ name, ok: true }); };
  const run = snapshot => evaluate(snapshot, manifest, at);
  check("unchanged complete baseline", () => { const r = run(baseline); assert.equal(r.ok, true); assert.equal(r.preservedRows, 601); assert.equal(r.readyToCutover, false); });
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
