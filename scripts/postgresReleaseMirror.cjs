"use strict";
// Refresh an INDEPENDENT candidate database. Never a production writer. The
// caller owns the source's generation-bound REPEATABLE READ/read-only session
// and a root-held HMAC key which must not be passed to candidate application code.
const crypto = require("node:crypto");
const VERSION = "postgres-release-mirror-v1", BATCH = 128, METADATA_BATCH = 2048;
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const ident = value => { if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw Error("unsafe mirror identifier"); return `"${value}"`; };
const tableSql = table => `football.${ident(table.name)}`;
const keySql = (table, alias = "") => `array_to_json(ARRAY[${table.pk.map(name => `${alias}${ident(name)}::text`).join(",")}])::text`;
const payloadSql = table => table.columns.map(col => `${ident(col.name)}::text AS ${ident(col.name)}`).join(",");
const keyFor = (table, row) => JSON.stringify(table.pk.map(name => row[name]));
const xid = value => typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);
const mac = (key, value) => crypto.createHmac("sha256", key).update(JSON.stringify(value)).digest("hex");
const validMac = (key, value, signature) => typeof signature === "string" && /^[a-f0-9]{64}$/.test(signature)
  && crypto.timingSafeEqual(Buffer.from(mac(key, value), "hex"), Buffer.from(signature, "hex"));

async function identity(client) {
  return (await client.query(`SELECT current_database() AS name,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,
    inet_server_addr()::text AS address,inet_server_port() AS port,pg_postmaster_start_time()::text AS started_at`)).rows[0];
}
async function catalog(client) {
  const tables = (await client.query(`SELECT c.relname AS name,c.relkind,c.relrowsecurity,
    CASE WHEN c.relkind='v' THEN pg_get_viewdef(c.oid,true) ELSE NULL END AS view_definition,
    (SELECT json_agg(json_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'generated',a.attgenerated,
      'expression',pg_get_expr(d.adbin,d.adrelid),'notnull',a.attnotnull) ORDER BY a.attnum)
     FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
     WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS columns,
    (SELECT json_agg(a.attname ORDER BY k.ordinality) FROM pg_constraint p,
      unnest(p.conkey) WITH ORDINALITY k(num,ordinality),pg_attribute a
      WHERE p.conrelid=c.oid AND p.contype='p' AND a.attrelid=c.oid AND a.attnum=k.num) AS pk,
    (SELECT json_agg(pg_get_constraintdef(p.oid) ORDER BY p.conname) FROM pg_constraint p WHERE p.conrelid=c.oid) AS constraints,
    (SELECT json_agg(pg_get_indexdef(i.indexrelid) ORDER BY i.indexrelid::regclass::text) FROM pg_index i WHERE i.indrelid=c.oid) AS indexes,
    (SELECT count(*)::int FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal) AS triggers,
    (SELECT coalesce(json_agg(r.relname ORDER BY r.relname),'[]'::json) FROM pg_constraint p JOIN pg_class r ON r.oid=p.confrelid
      WHERE p.conrelid=c.oid AND p.contype='f') AS parents
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='football' AND c.relkind IN ('r','p','v','m','f') ORDER BY c.relname`)).rows;
  if (!tables.some(t => t.name === "prediction_snapshots") || !tables.some(t => t.name === "projection_meta")) throw Error("incomplete mirror schema");
  for (const table of tables) {
    ident(table.name);
    if (!["r", "v"].includes(table.relkind) || table.relrowsecurity || table.triggers
      || (table.relkind === "r" && (!Array.isArray(table.pk) || !table.pk.length))) throw Error("unsupported mirror table");
    (table.pk || []).forEach(ident);
    for (const column of table.columns) {
      ident(column.name);
      if (!/^(text(?:\[\])?|json|jsonb|bytea|integer|bigint|smallint|boolean|date|double precision|time without time zone|timestamp with time zone|numeric(?:\([0-9]+,[0-9]+\))?)$/.test(column.type)) throw Error("unsupported mirror column type: " + column.type);
    }
  }
  return tables;
}
function dependencyOrder(tables) {
  const pending = new Map(tables.map(t => [t.name, t])), ordered = [], done = new Set();
  while (pending.size) {
    const ready = [...pending.values()].filter(t => t.parents.every(parent => done.has(parent)));
    if (!ready.length) throw Error("unsupported mirror dependency cycle or foreign schema");
    for (const table of ready) { ordered.push(table); done.add(table.name); pending.delete(table.name); }
  }
  return ordered;
}
function keysWhere(table, rows) {
  const values = [], expressions = rows.map(row => "(" + table.pk.map(name => {
    const value = row[name]; if (typeof value !== "string") throw Error("invalid mirror primary key");
    values.push(value); return `$${values.length}::${table.columns.find(c => c.name === name).type}`;
  }).join(",") + ")");
  return { sql: `(${table.pk.map(ident).join(",")}) IN (${expressions.join(",")})`, values };
}
async function eachSourceBatch(source, table, action) {
  await source.query(`DECLARE mirror_rows NO SCROLL CURSOR FOR SELECT ${table.pk.map(name => `${ident(name)}::text AS ${ident(name)}`).join(",")},xmin::text AS mirror_xmin
    FROM ${tableSql(table)}`);
  try {
    while (true) {
      const rows = (await source.query(`FETCH FORWARD ${METADATA_BATCH} FROM mirror_rows`)).rows;
      if (!rows.length) break;
      await action(rows);
    }
  } finally { await source.query("CLOSE mirror_rows"); }
}
async function eachStagedBatch(target, table, action) {
  // Reuse the already-read metadata in a candidate-only temporary table.
  // Ordering by the source PK would require random heap reads for xmin; a
  // second source pass would reread gigabytes of review heap unnecessarily.
  await target.query("DECLARE mirror_staged NO SCROLL CURSOR FOR SELECT key_json,source_xmin FROM mirror_seen WHERE table_name=$1", [table.name]);
  try {
    while (true) {
      const rows = (await target.query(`FETCH FORWARD ${METADATA_BATCH} FROM mirror_staged`)).rows;
      if (!rows.length) break;
      await action(rows.map(row => {
        const values = JSON.parse(row.key_json);
        if (!Array.isArray(values) || values.length !== table.pk.length || !values.every(value => typeof value === "string")) throw Error("invalid staged mirror key");
        return { ...Object.fromEntries(table.pk.map((name, index) => [name, values[index]])), mirror_xmin: row.source_xmin };
      }));
    }
  } finally { await target.query("CLOSE mirror_staged"); }
}

async function mirrorPostgresCandidate({ sourceSession, candidatePool, key, expectedSourceDatabase, timeoutMs = 600000 }) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw Error("root-held mirror HMAC key required");
  if (!sourceSession?.client || !sourceSession.identity || !/^[a-z0-9_]+$/.test(expectedSourceDatabase || "")) throw Error("bound read-only source session required");
  if (candidatePool === sourceSession.pool) throw Error("independent candidate database required");
  const source = sourceSession.client;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw Error("invalid mirror time budget");
  const deadline = Date.now() + timeoutMs;
  const withinBudget = () => { if (Date.now() >= deadline) throw Error("candidate mirror time budget exhausted"); };
  if ((await source.query("SHOW transaction_read_only")).rows[0].transaction_read_only !== "on"
    || (await source.query("SHOW transaction_isolation")).rows[0].transaction_isolation !== "repeatable read") throw Error("mirror source must be repeatable-read/read-only");
  await source.query("SET LOCAL TIME ZONE 'UTC'");
  const origin = await identity(source);
  if (origin.name !== expectedSourceDatabase) throw Error("mirror source database identity differs");
  const target = await candidatePool.connect();
  let begun = false;
  try {
    const destination = await identity(target);
    if (!/^football_release_[a-f0-9]{12}_[0-9]{1,10}$/.test(destination.name) || destination.name === origin.name) throw Error("independent candidate database required");
    await target.query("BEGIN; SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='120s'; SET LOCAL TIME ZONE 'UTC'"); begun = true;
    if (!(await target.query("SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired", [VERSION])).rows[0].acquired) throw Error("candidate mirror busy");
    // Locks apply ONLY to the validated independent candidate. Source readers
    // never block official writers, and the caller's generation lease survives.
    const sourceCatalog = await catalog(source), targetCatalog = await catalog(target);
    if (hash(sourceCatalog) !== hash(targetCatalog)) throw Error("candidate schema differs; isolated schema preparation required");
    const tables = dependencyOrder(sourceCatalog.filter(table => table.relkind === "r"));
    await source.query(`LOCK TABLE ${tables.map(tableSql).join(",")} IN ACCESS SHARE MODE`);
    await target.query(`LOCK TABLE ${tables.map(tableSql).join(",")} IN ACCESS EXCLUSIVE MODE`);
    if (hash(await catalog(target)) !== hash(targetCatalog)) throw Error("candidate schema changed while acquiring locks");
    const context = { version: VERSION, origin, destination, catalogHash: hash(sourceCatalog) }, contextHash = hash(context);
    await target.query(`CREATE SCHEMA IF NOT EXISTS football_release_private;
      CREATE TABLE IF NOT EXISTS football_release_private.mirror_head(singleton integer PRIMARY KEY CHECK(singleton=1),payload text NOT NULL,mac text NOT NULL);
      CREATE TABLE IF NOT EXISTS football_release_private.mirror_rows(table_name text NOT NULL,key_json text NOT NULL,source_xmin text NOT NULL,target_xmin text NOT NULL,mac text NOT NULL,PRIMARY KEY(table_name,key_json));
      CREATE TEMP TABLE mirror_seen(table_name text NOT NULL,key_json text NOT NULL,source_xmin text NOT NULL,PRIMARY KEY(table_name,key_json)) ON COMMIT DROP`);
    const sourceTx = (await source.query("SELECT txid_snapshot_xmax(txid_current_snapshot())::text AS value")).rows[0].value;
    const targetTx = (await target.query("SELECT txid_current()::text AS value")).rows[0].value;
    const head = (await target.query("SELECT payload,mac FROM football_release_private.mirror_head WHERE singleton=1")).rows[0];
    let previous = null;
    if (head) {
      previous = JSON.parse(head.payload);
      if (!validMac(key, previous, head.mac)) throw Error("candidate mirror head authentication failed");
      if (previous.contextHash !== contextHash) throw Error("candidate mirror baseline identity changed; explicit reseed required");
    } else if ((await target.query("SELECT 1 FROM football_release_private.mirror_rows LIMIT 1")).rows.length) throw Error("candidate mirror head missing");
    const recent = (current, prior) => xid(current) && xid(prior) && BigInt(current) >= BigInt(prior)
      && BigInt(current) - BigInt(prior) < 2147483648n;
    const incremental = Boolean(previous && recent(sourceTx, previous.sourceTx) && recent(targetTx, previous.targetTx));
    const report = { ok: false, version: VERSION, mode: incremental ? "incremental" : "full-seed", database: destination.name,
      publication: sourceSession.identity, inspectedRows: 0, copiedRows: 0, copiedPayloadBytes: 0, reusedRows: 0, removedCandidateRows: 0,
      batchSize: BATCH, metadataBatchSize: METADATA_BATCH, sourceMetadataPasses: 1, productionWrites: 0, tables: [] };
    // Populate membership before removing old candidate-only rows in reverse
    // foreign-key order. The canonical source database is never modified.
    for (const table of tables) await eachSourceBatch(source, table, async rows => {
      withinBudget();
      const values = rows.map(row => keyFor(table, row));
      await target.query("INSERT INTO mirror_seen SELECT $1,unnest($2::text[]),unnest($3::text[])", [table.name, values, rows.map(row => row.mirror_xmin)]);
    });
    await target.query("ANALYZE mirror_seen");
    for (const table of [...tables].reverse()) {
      withinBudget();
      const removed = await target.query(`DELETE FROM ${tableSql(table)} t WHERE NOT EXISTS
        (SELECT 1 FROM mirror_seen s WHERE s.table_name=$1 AND s.key_json=${keySql(table, "t.")})`, [table.name]);
      report.removedCandidateRows += removed.rowCount;
    }
    // The partial unique index permits only one current publication. Clear
    // only a superseded candidate head; its changed xmin forces exact recopy.
    const current = (await source.query("SELECT publication_id FROM football.publications WHERE state='current'")).rows.map(row => row.publication_id);
    await target.query("UPDATE football.publications SET state='previous' WHERE state='current' AND NOT(publication_id=ANY($1::text[]))", [current]);
    for (const table of tables) {
      const summary = { table: table.name, rows: 0, copied: 0 };
      await eachStagedBatch(target, table, async rows => {
        withinBudget();
        const where = keysWhere(table, rows), keys = rows.map(row => keyFor(table, row));
        const actual = new Map((await target.query(`SELECT ${table.pk.map(name => `${ident(name)}::text AS ${ident(name)}`).join(",")},xmin::text AS mirror_xmin FROM ${tableSql(table)} WHERE ${where.sql}`, where.values)).rows.map(row => [keyFor(table, row), row.mirror_xmin]));
        const states = new Map((await target.query("SELECT * FROM football_release_private.mirror_rows WHERE table_name=$1 AND key_json=ANY($2::text[])", [table.name, keys])).rows.map(row => [row.key_json, row]));
        const changed = rows.filter(row => {
          const k = keyFor(table, row), state = states.get(k);
          if (!xid(row.mirror_xmin)) throw Error("invalid source transaction identity");
          if (state && !validMac(key, [contextHash, table.name, k, state.source_xmin, state.target_xmin], state.mac)) throw Error("candidate mirror row authentication failed");
          return !incremental || !state || state.source_xmin !== row.mirror_xmin || state.target_xmin !== actual.get(k);
        });
        summary.rows += rows.length; report.inspectedRows += rows.length; report.reusedRows += rows.length - changed.length;
        if (!changed.length) return;
        for (let offset = 0; offset < changed.length; offset += BATCH) {
        withinBudget();
        const slice = changed.slice(offset, offset + BATCH), changedWhere = keysWhere(table, slice);
        const originals = (await source.query(`SELECT ${payloadSql(table)} FROM ${tableSql(table)} WHERE ${changedWhere.sql}`, changedWhere.values)).rows;
        if (originals.length !== slice.length) throw Error("source snapshot row membership changed");
        const columns = table.columns.filter(col => !col.generated), values = [];
        const tuples = originals.map(row => "(" + columns.map(col => {
          const value = row[col.name]; if (value !== null && typeof value !== "string") throw Error("mirror requires original column text");
          values.push(value); report.copiedPayloadBytes += value === null ? 0 : Buffer.byteLength(value);
          return `$${values.length}::${col.type}`;
        }).join(",") + ")");
        const update = columns.filter(col => !table.pk.includes(col.name)).map(col => `${ident(col.name)}=EXCLUDED.${ident(col.name)}`).join(",");
        await target.query(`INSERT INTO ${tableSql(table)} (${columns.map(col => ident(col.name)).join(",")}) VALUES ${tuples.join(",")}
          ON CONFLICT (${table.pk.map(ident).join(",")}) DO ${update ? "UPDATE SET " + update : "NOTHING"}`, values);
        const after = new Map((await target.query(`SELECT ${payloadSql(table)},xmin::text AS mirror_xmin FROM ${tableSql(table)} WHERE ${changedWhere.sql}`, changedWhere.values)).rows.map(row => [keyFor(table, row), row]));
        const sourceXmins = new Map(slice.map(row => [keyFor(table, row), row.mirror_xmin])), stateValues = [];
        const stateTuples = originals.map(row => {
          const k = keyFor(table, row), result = after.get(k);
          if (!result || !xid(result.mirror_xmin) || table.columns.some(col => row[col.name] !== result[col.name])) throw Error("candidate original bytes or generated values differ");
          const parts = [table.name, k, sourceXmins.get(k), result.mirror_xmin];
          parts.push(mac(key, [contextHash, ...parts]));
          return "(" + parts.map(value => { stateValues.push(value); return "$" + stateValues.length; }).join(",") + ")";
        });
        await target.query(`INSERT INTO football_release_private.mirror_rows(table_name,key_json,source_xmin,target_xmin,mac) VALUES ${stateTuples.join(",")}
          ON CONFLICT(table_name,key_json) DO UPDATE SET source_xmin=EXCLUDED.source_xmin,target_xmin=EXCLUDED.target_xmin,mac=EXCLUDED.mac`, stateValues);
        summary.copied += originals.length; report.copiedRows += originals.length;
        }
      });
      report.tables.push(summary);
    }
    await target.query("DELETE FROM football_release_private.mirror_rows r WHERE NOT EXISTS(SELECT 1 FROM mirror_seen s WHERE s.table_name=r.table_name AND s.key_json=r.key_json)");
    const payload = { contextHash, sourceTx, targetTx };
    await target.query(`INSERT INTO football_release_private.mirror_head VALUES(1,$1,$2) ON CONFLICT(singleton) DO UPDATE SET payload=EXCLUDED.payload,mac=EXCLUDED.mac`, [JSON.stringify(payload), mac(key, payload)]);
    withinBudget(); await target.query("COMMIT"); begun = false; report.ok = true; return report;
  } catch (error) {
    if (begun) await target.query("ROLLBACK");
    throw error;
  } finally { target.release(); }
}
module.exports = { mirrorPostgresCandidate };
