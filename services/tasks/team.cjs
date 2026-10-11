'use strict';
async function main() {
  const pool = require('../../server/postgresStore.cjs').createPostgresPool({ max: 2, applicationName: 'football-separated-team-evidence' });
  try { const value = await require('../../scripts/syncTeamEvidence.cjs').run({ pool }); console.log(JSON.stringify(value)); if (!value.ok) process.exitCode = 1; }
  finally { await pool.end(); }
}
main().catch(error => {
  const unknown = /COMMIT_UNKNOWN/.test(error.code || '');
  console.error(unknown ? 'COMMIT_UNKNOWN_READ_BEFORE_RETRY' : error.code || 'TEAM_EVIDENCE_FAILED');
  process.exitCode = unknown ? 75 : 1;
});
