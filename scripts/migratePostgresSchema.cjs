"use strict";

const {
  createPostgresPool,
  getPostgresHealth,
  runPostgresMigrations,
} = require("../server/postgresStore.cjs");

const main = async () => {
  const pool = createPostgresPool({ applicationName: "football-schema-migration" });
  try {
    const before = await getPostgresHealth(pool);
    const migrations = await runPostgresMigrations(pool);
    const after = await getPostgresHealth(pool);
    console.log(JSON.stringify({ ok: true, before, migrations, after }, null, 2));
  } finally {
    await pool.end();
  }
};

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    code: error.code || null,
    error: error.message || String(error),
  }, null, 2));
  process.exitCode = 1;
});
