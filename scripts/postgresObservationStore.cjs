"use strict";
const common = require("./openFootballObservationStore.cjs");
const { sourceUrl, inspectSource } = require("./auditOpenFootballCurrentSeason.cjs");
const { createPostgresPool, withPostgresTransaction } = require("../server/postgresStore.cjs");
const LOCK = "football-native-research-observations-v1";
const usePool = async (pool, task) => {
  const owned = !pool, selected = pool || createPostgresPool({ max: 1, applicationName: "football-research-receipts" });
  try { return await task(selected); } finally { if (owned) await selected.end(); }
};
const writeTransaction = (pool, task) => withPostgresTransaction(pool, async client => {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [LOCK]); return task(client);
}, { isolationLevel: "READ COMMITTED" });
const assertInitialized = async client => {
  const result = await client.query("SELECT value FROM football.research_observation_meta WHERE key='schema'");
  if (result.rows[0]?.value !== common.VERSION) throw new Error("native observation store requires verified import or explicit empty initialization");
};
async function* cursorRows(client, name, sql, size) {
  await client.query(`DECLARE ${name} NO SCROLL CURSOR FOR ${sql}`);
  try {
    while (true) {
      const batch = await client.query(`FETCH FORWARD ${size} FROM ${name}`);
      if (!batch.rows.length) break;
      for (const row of batch.rows) yield row;
    }
  } finally { await client.query(`CLOSE ${name}`); }
}
async function auditNativeClient(client, { allowUninitialized = false } = {}) {
  if (!allowUninitialized) await assertInitialized(client);
  const count = Number((await client.query("SELECT count(*) n FROM football.research_observations")).rows[0].n);
  const stats = (await client.query("SELECT count(*) n,coalesce(sum(octet_length(raw)),0) bytes FROM football.research_source_contents")).rows[0];
  const audit = common.createObservationAudit({ count, contents: { n: Number(stats.n), bytes: Number(stats.bytes) } });
  for await (const row of cursorRows(client, "research_audit_receipts", "SELECT * FROM football.research_observations ORDER BY sequence", 128)) audit.receipt(row);
  // Raw provider responses are at most 2 MiB each. Never materialize the
  // entire retained response corpus in the process just to verify its audit.
  for await (const row of cursorRows(client, "research_audit_contents", "SELECT * FROM football.research_source_contents ORDER BY source_url,content_hash", 1)) audit.content(row);
  return audit.finish();
}
async function initializeEmptyObservationStore({ pool }) {
  return writeTransaction(pool, async client => {
    for (const table of ["research_observation_meta", "research_source_contents", "research_observations"]) {
      if ((await client.query(`SELECT 1 FROM football.${table} LIMIT 1`)).rows.length) throw new Error("refuse to reset nonempty research observation store");
    }
    await client.query("INSERT INTO football.research_observation_meta VALUES('schema',$1)", [common.VERSION]);
    return { ok: true, initialized: true };
  });
}
async function auditPostgresObservationStore({ pool } = {}) {
  return usePool(pool, selected => withPostgresTransaction(selected, async client => {
    await client.query("SET TRANSACTION READ ONLY"); return auditNativeClient(client);
  }, { isolationLevel: "REPEATABLE READ" }));
}
async function recordPostgresObservation({ pool, season, league, raw, requestStartedAt, receivedAt }) {
  const started = common.canonicalClock(requestStartedAt), received = common.canonicalClock(receivedAt);
  if (received < started) throw new Error("Response receipt precedes request");
  const inspected = inspectSource(raw, { season, league, receivedAt: received }), url = sourceUrl(season, league), contentHash = common.digest(raw);
  return usePool(pool, selected => writeTransaction(selected, async client => {
    const audit = await auditNativeClient(client);
    const previousRow = (await client.query("SELECT * FROM football.research_observations ORDER BY sequence DESC LIMIT 1")).rows[0];
    const previous = common.verifyReceipt(previousRow);
    if (previous && received < previous.receivedAt) throw new Error("Observation clock moved backwards");
    const sequence = (previous?.sequence || 0) + 1;
    if (sequence > common.MAX_OBSERVATIONS) throw new Error("Observation capacity reached; retain evidence and stop");
    const existing = (await client.query("SELECT * FROM football.research_source_contents WHERE source_url=$1 AND content_hash=$2", [url, contentHash])).rows[0];
    let firstObservedAt = received, firstReceiptHash = null;
    if (existing) {
      if (!Buffer.from(existing.raw).equals(raw)) throw new Error("Stored source content integrity failed");
      const firstRow = (await client.query("SELECT * FROM football.research_observations WHERE receipt_hash=$1", [existing.first_receipt_hash])).rows[0];
      const first = common.verifyReceipt(firstRow);
      if (!first || first.sourceUrl !== url || first.contentSha256 !== contentHash || first.receivedAt !== existing.first_received_at || first.receivedAt > received) throw new Error("Stored first observation is invalid");
      firstObservedAt = first.receivedAt; firstReceiptHash = existing.first_receipt_hash;
    } else if (audit.rawBytes + raw.length > common.MAX_RAW_BYTES) throw new Error("Source content capacity reached; retain evidence and stop");
    const receipt = common.buildObservationReceipt({ sequence, url, league, season, contentHash, rawBytes: raw.length,
      started, received, firstObservedAt, previousReceiptHash: previousRow?.receipt_hash || null, firstReceiptHash, candidateRows: inspected.candidateRows });
    const hash = common.hashObject(receipt);
    if (!existing) await client.query("INSERT INTO football.research_source_contents VALUES($1,$2,$3,$4,$5)", [url, contentHash, raw, received, hash]);
    await client.query("INSERT INTO football.research_observations VALUES($1,$2,$3,$4,$5,$6)", [sequence, url, contentHash, received, JSON.stringify(receipt), hash]);
    return { ...receipt, receiptHash: hash, reusedContent: Boolean(existing), sourceContentsWritten: existing ? 0 : 1,
      productionAdmittedRows: 0, latestResultDate: inspected.latestResultDate };
  }));
}
async function collectPostgresSeasonObservations(options) {
  return usePool(options.pool, async pool => {
    await assertInitialized(pool); // Refuse incomplete migration before fetching.
    return common.collectSeasonObservations({ ...options, record: input => recordPostgresObservation({ ...input, pool }) });
  });
}
module.exports = { auditPostgresObservationStore, recordPostgresObservation, collectPostgresSeasonObservations,
  initializeEmptyObservationStore, auditNativeClient, writeTransaction, cursorRows };
