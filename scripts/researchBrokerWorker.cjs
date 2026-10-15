'use strict';
// Fixed unprivileged worker; only the root-owned signed broker may launch it.
// Installation, authentication and scheduled-agent activation remain separate.
const fs = require('node:fs');
const { createResearchWriteService, MAX_REQUEST_BYTES } = require('../server/researchWriteService.cjs');
async function main() {
  if (process.platform !== 'linux' || process.getuid() === 0) throw Error('RESEARCH_UNPRIVILEGED_WORKER_REQUIRED');
  const identity=fs.readFileSync('/proc/self/status','utf8');
  if(!/^NoNewPrivs:\s+1$/m.test(identity)||!/^CapEff:\s+0+$/m.test(identity)||!/^CapAmb:\s+0+$/m.test(identity))throw Error('RESEARCH_WORKER_PRIVILEGE_DROP_REQUIRED');
  // FD3 preserves the real flock if the root broker exits unexpectedly.
  const lock = fs.fstatSync(3), target = fs.lstatSync('/run/lock/football-release.lock');
  const info = fs.readFileSync('/proc/self/fdinfo/3', 'utf8');
  if (!target.isFile() || target.isSymbolicLink() || target.uid !== 0 || lock.dev !== target.dev || lock.ino !== target.ino
    || !/lock:\s+\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+/m.test(info)) throw Error('RESEARCH_INHERITED_RELEASE_LOCK_REQUIRED');
  const chunks = []; let bytes = 0;
  for await (const chunk of process.stdin) { bytes += chunk.length; if (bytes > MAX_REQUEST_BYTES) throw Error('RESEARCH_REQUEST_BOUND'); chunks.push(chunk); }
  const raw = Buffer.concat(chunks), pool = require('../server/postgresStore.cjs').createPostgresPool({ max: 1 });
  try {
    const service = createResearchWriteService({ pool, runExclusive: async action => {
      // Parent checked both release markers and signed source bytes before
      // launch. FD3 keeps the same kernel lock through COMMIT and readback.
      const current = fs.fstatSync(3);
      if (current.dev !== target.dev || current.ino !== target.ino) throw Error('RESEARCH_RELEASE_LOCK_CHANGED');
      return action();
    } });
    process.stdout.write(JSON.stringify({ ok: true, ...(await service.execute(raw)) }) + '\n');
  } finally { await pool.end(); }
}
if (require.main === module) main().catch(error => {
  process.stderr.write(JSON.stringify({ ok: false, error: /^[A-Z0-9_]+$/.test(error.code || '') ? error.code : 'RESEARCH_OPERATION_UNCONFIRMED_READ_FIRST', retryWriteAutomatically: false }) + '\n');
  process.exitCode = 1;
});
module.exports = { main };
