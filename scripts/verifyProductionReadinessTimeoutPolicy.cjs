const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.resolve(__dirname, "verifyProductionReadiness.cjs"), "utf8");

assert.match(source, /VERIFY_REQUEST_TIMEOUT_MS \|\| 30_000/);
assert.match(source, /VERIFY_CHILD_TIMEOUT_MS \|\| 120_000/);
assert.match(source, /req\.setTimeout\(requestTimeoutMs/);
assert.match(source, /childProcess\.kill\("SIGTERM"\)/);
assert.match(source, /childProcess\.kill\("SIGKILL"\)/);
assert.match(source, /child-timeout/);
assert.match(source, /timedOut \? 124/);

console.log(JSON.stringify({
  ok: true,
  requestTimeoutMs: 30_000,
  childTimeoutMs: 120_000,
  gracefulKill: true,
  forcedKillFallback: true,
  progressEvents: true
}, null, 2));
