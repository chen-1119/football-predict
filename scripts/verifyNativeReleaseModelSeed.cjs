"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { Pool } = require("pg");
async function verifyNativeReleaseModelSeed(pool) {
  const source = (await pool.query("SELECT current_database() name,host(inet_server_addr()) address")).rows[0];
  assert.match(source.name, /^q2_evidence_[a-z0-9_]+$/); assert.equal(source.address, "127.0.0.1");
  const name = `football_release_${crypto.randomBytes(6).toString("hex")}_${Math.floor(Date.now() / 1000)}`;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "football-native-release-model-")), checks = [];
  const native = require("./postgresPrivateModelArtifactStore.cjs"), seed = require("./releasePrivateModelSeed.cjs");
  let created = false, candidatePool;
  try {
    await pool.query(`CREATE DATABASE "${name}"`); created = true;
    const url = new URL(process.env.EVIDENCE_TEST_POSTGRES_URL); url.pathname = "/" + name;
    candidatePool = new Pool({ connectionString: url.href, ssl: false, max: 1 });
    await require("../server/postgresStore.cjs").runPostgresMigrations(candidatePool);
    const at = "2026-09-01T00:00:00.000Z", key = "hhad-companion-audit";
    const aggregate = { version: "synthetic-audit-v1", evaluatedAt: at, gate: { onlineEffect: "shadow" }, counts: { finalRevisions: 1, settlementRows: 0 } };
    const raw = JSON.stringify({ ...aggregate, finalExposureRows: [{ tip: "X", note: "原始平局" }], settlementRows: [] }, null, 2) + "\n";
    await native.importPrivateModelArtifact({ pool, row: { artifact_key: key, artifact_version: aggregate.version,
      generated_at: at, updated_at: at, payload_json: raw, payload_bytes: Buffer.byteLength(raw),
      payload_sha256: crypto.createHash("sha256").update(raw).digest("hex") } });
    fs.mkdirSync(path.join(temp, "model-artifacts"));
    fs.writeFileSync(path.join(temp, "model-artifacts/evaluation.json"), JSON.stringify({ hhadCompanionEvaluation: aggregate, sample: { hhadCompanion: aggregate.counts } }));
    for (const file of ["model-strategy.json", "model-artifacts/candidate-prospective-registry.json"])
      fs.writeFileSync(path.join(temp, file), '{"version":"synthetic"}');
    await assert.rejects(seed.seedPrivateModelAuditPostgres({ sourcePool: pool, candidatePool: pool, candidateStore: temp }), /independent-database/);
    await assert.rejects(seed.seedPrivateModelAuditPostgres({ sourcePool: candidatePool, candidatePool: pool, candidateStore: temp }), /independent-database/);
    const copied = await seed.seedPrivateModelAuditPostgres({ sourcePool: pool, candidatePool, candidateStore: temp });
    assert.equal(copied.seeded, true); assert.equal(copied.modelPromotionAuthorized, false);
    const result = await native.readPrivateModelArtifact({ pool: candidatePool, artifactKey: key });
    assert.equal(result.payloadJson, raw); assert.equal(result.updatedAt, at);
    checks.push({ name: "independent native candidate receives original private audit bytes and clocks, never the source database", ok: true });
    const policy = require("./releaseModelWorkPolicy.cjs");
    const root = path.resolve(__dirname, "..");
    const classified = await policy.classifyModelWorkPostgres({ liveRoot: root, sourceRoot: root, storeDir: temp, pool: candidatePool, runtime: "v22.22.1" });
    assert.equal(classified.mode, "preserve", JSON.stringify(classified));
    assert.equal(classified.artifacts["postgres:hhad-companion-audit"].sha256, copied.payloadSha256);
    assert.equal(fs.existsSync(path.join(temp, "football.db")), false);
    checks.push({ name: "unchanged model code reuses verified native audit without recomputation or creating SQLite", ok: true });
    await candidatePool.query("UPDATE football.private_model_artifacts SET payload_sha256=$1 WHERE artifact_key=$2", ["0".repeat(64), key]);
    const rejected = await policy.classifyModelWorkPostgres({ liveRoot: root, sourceRoot: root, storeDir: temp, pool: candidatePool, runtime: "v22.22.1" });
    assert.equal(rejected.mode, "recompute");
    await assert.rejects(seed.seedPrivateModelAuditPostgres({ sourcePool: pool, candidatePool, candidateStore: temp }), /SHA-256 mismatch/);
    assert.equal((await native.readPrivateModelArtifact({ pool, artifactKey: key })).payloadJson, raw);
    checks.push({ name: "corrupt candidate audit blocks reuse and import without changing the source audit", ok: true });
    return { ok: true, checks, candidateDatabaseIsolated: true, productionWrites: 0 };
  } finally {
    if (candidatePool) await candidatePool.end();
    if (created) { assert.match(name, /^football_release_[a-f0-9]{12}_[0-9]{1,10}$/); await pool.query(`DROP DATABASE "${name}"`); }
    const resolved = fs.realpathSync(temp);
    assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(resolved).startsWith("football-native-release-model-")); fs.rmSync(resolved, { recursive: true, force: true });
  }
}
module.exports = { verifyNativeReleaseModelSeed };
