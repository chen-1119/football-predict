"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  createFileJsonPayload, isFileJsonPayload, fileJsonPayloadChunks,
  MAX_FILE_JSON_BYTES, FILE_JSON_CHUNK_BYTES,
} = require("../scripts/postgresFileJsonPayload.cjs");
const { insertBatches, streamIteratorInsert } = require("../scripts/postgresProjectionSync.cjs");
const { snapshotUpsertConflict } = require("../scripts/postgresSnapshotUpsert.cjs");
const { withPostgresTransaction } = require("../server/postgresStore.cjs");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "football-pg-json-parts-"));
let sequence = 0;
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const spool = raw => {
  const filePath = path.join(dir, `${sequence++}.json`);
  fs.writeFileSync(filePath, raw);
  return createFileJsonPayload(filePath, { bytes: Buffer.byteLength(raw), sha256: sha(raw) });
};
const consume = async payload => {
  const chunks = [];
  for await (const piece of fileJsonPayloadChunks(payload)) chunks.push(piece);
  return chunks.join("");
};
const options = (client, rows, extra = {}) => ({
  client, table: "source_snapshots", columns: ["id", "source", "captured_at", "payload"],
  rows, conflict: snapshotUpsertConflict("source_snapshots"), jsonColumns: ["payload"], ...extra,
});
const row = (id, payload) => ({ id, source: "sporttery:public-reference", captured_at: "2026-09-27T00:00:00.000Z", payload });

const fakeDatabase = ({ onParts, failAt } = {}) => {
  const state = { calls: [], committed: new Map(), pending: null, parts: new Map(),
    maxPartBytes: 0, maxBatchBytes: 0, assembled: 0, released: false, normalBatches: [] };
  const client = {
    async query(sql, values = []) {
      const normalized = sql.trim().replace(/\s+/g, " ");
      state.calls.push(normalized);
      if (normalized.startsWith("BEGIN")) { state.pending = new Map(state.committed); return { rows: [] }; }
      if (normalized === "ROLLBACK") { state.pending = null; state.parts.clear(); return { rows: [] }; }
      if (normalized === "COMMIT") { state.committed = state.pending; state.pending = null; state.parts.clear(); return { rows: [] }; }
      if (normalized.startsWith("CREATE TEMP TABLE")) {
        assert.match(normalized, /^CREATE TEMP TABLE projection_json_parts_[a-f0-9]{24} \(seq integer PRIMARY KEY, piece text NOT NULL\) ON COMMIT DROP$/);
        state.parts.set(normalized.split(" ")[3], new Map());
        return { rows: [] };
      }
      if (normalized.startsWith("INSERT INTO projection_json_parts_")) {
        if (failAt === "parts") throw new Error("injected parts failure");
        const target = normalized.match(/^INSERT INTO (\w+)/)[1], parts = state.parts.get(target);
        assert.ok(parts);
        let batchBytes = 0;
        for (let index = 0; index < values.length; index += 2) {
          assert.equal(typeof values[index + 1], "string");
          const bytes = Buffer.byteLength(values[index + 1]);
          state.maxPartBytes = Math.max(state.maxPartBytes, bytes);
          batchBytes += bytes + 12;
          assert.ok(!parts.has(values[index]));
          parts.set(values[index], values[index + 1]);
        }
        state.maxBatchBytes = Math.max(state.maxBatchBytes, batchBytes);
        if (onParts) onParts(state);
        return { rows: [], rowCount: values.length / 2 };
      }
      if (normalized.startsWith("INSERT INTO football.source_snapshots")) {
        assert.ok(state.pending, "writer must use caller transaction");
        if (normalized.includes("string_agg")) {
          if (failAt === "assembly") throw new Error("injected assembly failure");
          assert.match(normalized, /string_agg\(piece, '' ORDER BY seq\)::json FROM projection_json_parts_[a-f0-9]{24}/);
          assert.ok(!normalized.includes("::jsonb"));
          assert.ok(normalized.endsWith(snapshotUpsertConflict("source_snapshots").replace(/\s+/g, " ")));
          assert.equal(values.length, 3);
          const target = normalized.match(/FROM (projection_json_parts_\w+)/)[1];
          const ordered = [...state.parts.get(target)].sort((a, b) => a[0] - b[0]);
          assert.deepEqual(ordered.map(([seq]) => seq), ordered.map((_, index) => index));
          const payload = ordered.map(([, piece]) => piece).join("");
          JSON.parse(payload);
          state.pending.set(values[0], { source: values[1], captured_at: values[2], payload });
          state.assembled++;
          return { rows: [], rowCount: 1 };
        }
        state.normalBatches.push(values.length / 4);
        for (let index = 0; index < values.length; index += 4) {
          state.pending.set(values[index], { source: values[index + 1], captured_at: values[index + 2], payload: values[index + 3] });
        }
        return { rows: [], rowCount: values.length / 4 };
      }
      if (normalized.startsWith("DROP TABLE")) { state.parts.delete(normalized.split(" ")[2]); return { rows: [] }; }
      throw new Error(`Unexpected fake query: ${normalized}`);
    },
    release() { state.released = true; },
  };
  return { state, client, pool: { connect: async () => client } };
};

after(() => {
  assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(dir).startsWith("football-pg-json-parts-"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("file descriptors are immutable, internally branded and strictly bounded", async () => {
  const payload = spool('{"ok":true}');
  assert.ok(isFileJsonPayload(payload));
  assert.ok(Object.isFrozen(payload));
  assert.equal(isFileJsonPayload({ ...payload }), false);
  assert.equal(isFileJsonPayload(Object.create(payload)), false);
  assert.equal(isFileJsonPayload(null), false);
  assert.equal(isFileJsonPayload(payload.filePath), false);
  await assert.rejects(consume({ ...payload }), /Unbranded/);
  for (const maxBytes of [0, -1, Infinity, 1.5, MAX_FILE_JSON_BYTES + 1]) {
    assert.throws(() => createFileJsonPayload(payload.filePath, { ...payload, maxBytes }), /Invalid bounded/);
  }
  assert.throws(() => createFileJsonPayload(payload.filePath, { ...payload, bytes: MAX_FILE_JSON_BYTES + 1 }), /Invalid bounded/);
  assert.throws(() => createFileJsonPayload(payload.filePath, { ...payload, bytes: payload.bytes + 1 }), { code: "POSTGRES_FILE_JSON_SIZE_MISMATCH" });
  assert.throws(() => createFileJsonPayload(payload.filePath, { ...payload, sha256: "wrong" }), /Invalid bounded/);
  assert.throws(() => createFileJsonPayload(dir, { bytes: 2, sha256: sha("{}") }), /regular single-link/);
});

test("UTF-8 codepoints crossing read boundaries retain original text and each piece stays bounded", async () => {
  const raw = '{ "z": "' + "x".repeat(FILE_JSON_CHUNK_BYTES - 12) + "汉字⚽😺é".repeat(90000) + '", "a": 1 }\n';
  const payload = spool(raw), chunks = [], rawHash = crypto.createHash("sha256");
  for await (const piece of fileJsonPayloadChunks(payload, { onBytes: bytes => rawHash.update(bytes) })) {
    assert.ok(Buffer.byteLength(piece) <= FILE_JSON_CHUNK_BYTES);
    assert.ok(!piece.includes("\ufffd"));
    chunks.push(piece);
  }
  assert.ok(chunks.length > 3);
  assert.equal(chunks.join(""), raw);
  assert.equal(rawHash.digest("hex"), sha(raw));
});

test("rejects hash mismatch, invalid UTF-8, hardlinks and mutation before or during reads", async () => {
  const initial = spool('{"a":1}');
  const wrongHash = createFileJsonPayload(initial.filePath, { bytes: initial.bytes, sha256: "0".repeat(64) });
  await assert.rejects(consume(wrongHash), { code: "POSTGRES_FILE_JSON_HASH_MISMATCH" });
  const invalid = spool(Buffer.from([0x22, 0xf0, 0x28, 0x8c, 0x28, 0x22]));
  await assert.rejects(consume(invalid), { code: "POSTGRES_FILE_JSON_UTF8_INVALID" });
  fs.writeFileSync(initial.filePath, '{"a":2}');
  await assert.rejects(consume(initial), { code: "POSTGRES_FILE_JSON_CHANGED" });
  const linked = spool("{}");
  fs.linkSync(linked.filePath, path.join(dir, "hardlink.json"));
  assert.throws(() => createFileJsonPayload(linked.filePath, linked), /regular single-link/);
  await assert.rejects(consume(linked), /regular single-link/);
  const during = spool('"' + "a".repeat(FILE_JSON_CHUNK_BYTES * 2) + '"');
  const iterator = fileJsonPayloadChunks(during);
  assert.equal((await iterator.next()).done, false);
  fs.appendFileSync(during.filePath, " ");
  await assert.rejects(async () => { for await (const ignored of iterator) void ignored; }, /byte limit|changed/);
});

test("final component symbolic links are never admitted", t => {
  const original = spool("{}");
  const link = path.join(dir, "symlink.json");
  try { fs.symlinkSync(original.filePath, link, "file"); }
  catch (error) {
    if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error.code)) {
      t.skip("Windows account cannot create file symlinks");
      return;
    }
    throw error;
  }
  assert.throws(() => createFileJsonPayload(link, original), /regular single-link/);
});

test("mixed rows preserve inventory and exact table hash while reading the file once into bounded parts", async () => {
  const raw = '{ "version": "public-reference-decisions-v2", "z": "' + "中文⚽😺".repeat(800000) + '", "a": 1 }\n';
  const payload = spool(raw), rows = [row("a", '{"n":1}'), row("archive", payload), row("z", '{"n":2}')];
  const db = fakeDatabase();
  const open = fs.openSync, read = fs.readSync;
  let opens = 0, bytesRead = 0;
  fs.openSync = function (file, ...args) { if (file === payload.filePath) opens++; return open.call(this, file, ...args); };
  fs.readSync = function (...args) { const bytes = read.apply(this, args); bytesRead += bytes; return bytes; };
  let result;
  try {
    result = await withPostgresTransaction(db.pool, client => streamIteratorInsert({
      ...options(client, rows), iterator: rows, mapper: value => value, collectRows: true,
    }));
  } finally { fs.openSync = open; fs.readSync = read; }
  assert.equal(opens, 1);
  assert.equal(bytesRead, payload.bytes);
  assert.deepEqual(result.activeIds, ["a", "archive", "z"]);
  assert.equal(result.written, 3);
  assert.deepEqual(result.rows, rows);
  assert.equal(result.hash, sha('a\0{"n":1}\narchive\0' + raw + '\nz\0{"n":2}\n'));
  assert.equal(db.state.committed.get("archive").payload, raw);
  assert.equal(db.state.committed.get("archive").source, rows[1].source);
  assert.equal(db.state.committed.get("archive").captured_at, rows[1].captured_at);
  assert.ok(db.state.maxPartBytes <= FILE_JSON_CHUNK_BYTES);
  assert.ok(db.state.maxBatchBytes <= 4 * 1024 * 1024);
  assert.ok(db.state.calls.filter(sql => sql.startsWith("INSERT INTO projection_json_parts_")).length >= 3);
  assert.deepEqual(db.state.normalBatches, [1, 1]);
  assert.equal(db.state.parts.size, 0);
  assert.ok(db.state.calls.some(sql => sql.startsWith("DROP TABLE projection_json_parts_")));
  assert.ok(db.state.released);
});

test("ordinary row batches respect byte and row limits and retain fail-closed affected-row checks", async () => {
  const db = fakeDatabase(), rows = Array.from({ length: 5 }, (_, index) => row(String(index), JSON.stringify({ value: "中".repeat(12) })));
  await withPostgresTransaction(db.pool, client => insertBatches(options(client, rows, { batchBytes: 250, batchRows: 3 })));
  assert.deepEqual(db.state.normalBatches, [2, 2, 1]);
  await assert.rejects(insertBatches(options(db.client, rows, { maxRowBytes: 20 })), { code: "POSTGRES_INLINE_ROW_LIMIT" });
  await assert.rejects(insertBatches(options(db.client, rows, { batchRows: 0 })), /byte\/row bound/);
  await assert.rejects(insertBatches(options(db.client, rows, { table: "source_snapshots; DROP TABLE x" })), /insert target/);
  await assert.rejects(insertBatches(options({ query: async () => ({ rowCount: 0 }) }, rows.slice(0, 1), { requireAffectedRows: true })), { code: "POSTGRES_FAIL_CLOSED_UPSERT_INCOMPLETE" });
});

test("file payloads cannot enter other tables, columns, jsonb, or custom conflict SQL", async () => {
  const payload = spool("{}"), db = fakeDatabase(), rows = [row("archive", payload)];
  for (const extra of [
    { table: "match_snapshots" }, { columns: ["id", "source", "payload", "captured_at"] },
    { jsonbColumns: ["payload"] }, { conflict: "ON CONFLICT DO NOTHING" },
    { rows: [{ ...rows[0], source: payload, payload: "{}" }] },
  ]) await assert.rejects(insertBatches(options(db.client, rows, extra)), /only allowed/);
  assert.equal(db.state.calls.length, 0);
});

test("tamper or database errors roll back all previous rows and never commit partial archive text", async () => {
  for (const failAt of ["parts", "assembly", "tamper", "hash"]) {
    const raw = JSON.stringify({ padding: "x".repeat(9 * 1024 * 1024) });
    let payload = spool(raw), changed = false;
    if (failAt === "hash") payload = createFileJsonPayload(payload.filePath, { ...payload, sha256: "0".repeat(64) });
    const db = fakeDatabase({ failAt, onParts: () => {
      if (failAt === "tamper" && !changed) {
        changed = true;
        fs.appendFileSync(payload.filePath, " ");
      }
    } });
    await assert.rejects(withPostgresTransaction(db.pool, client => insertBatches(options(client, [row("before", "{}"), row("archive", payload)]))), /injected|changed|byte limit|hash does not match/);
    assert.equal(db.state.committed.size, 0);
    assert.equal(db.state.parts.size, 0);
    assert.equal(db.state.pending, null);
    assert.equal(db.state.assembled, 0);
    assert.equal(db.state.calls.at(-1), "ROLLBACK");
    assert.ok(!db.state.calls.includes("COMMIT"));
    assert.ok(db.state.released);
  }
});
