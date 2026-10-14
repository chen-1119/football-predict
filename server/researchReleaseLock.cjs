'use strict';
// A lock must already be held by util-linux flock --no-fork in this process.
// This module never creates an alternate mutex or accepts an environment flag.
const fs = require('node:fs');
const fail = code => { throw Object.assign(Error(code), { code }); };
function findHeldReleaseLock({ lockPath = '/run/lock/football-release.lock', requireRoot = true } = {}) {
  if (process.platform !== 'linux' || (requireRoot && process.getuid() !== 0)) fail('RESEARCH_ROOT_LINUX_REQUIRED');
  const target = fs.lstatSync(lockPath);
  if (!target.isFile() || target.isSymbolicLink() || target.nlink !== 1 || (requireRoot && target.uid !== 0)) fail('RESEARCH_LOCK_IDENTITY');
  for (const name of fs.readdirSync('/proc/self/fd')) {
    if (!/^\d+$/.test(name)) continue;
    const fd = Number(name);
    let s, info; try { s = fs.fstatSync(fd); info = fs.readFileSync('/proc/self/fdinfo/' + fd, 'utf8'); } catch { continue; }
    if (s.dev !== target.dev || s.ino !== target.ino) continue;
    // fdinfo describes this open-file description, so a same-path file without
    // the inherited flock does not pass. The holder must be this broker PID.
    const match = /lock:\s+\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+(\d+)\s+/m.exec(info);
    if (match && Number(match[1]) === process.pid) return fd;
  }
  fail('RESEARCH_RELEASE_LOCK_NOT_HELD');
}
function releaseBoundary(root, expectedSha) {
  if (!/^[a-f0-9]{64}$/.test(expectedSha || '')) fail('RESEARCH_RELEASE_SHA');
  for (const name of ['.release-bundle-sha256', '.release-live-complete']) {
    const file = root + '/' + name, stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || fs.readFileSync(file, 'utf8').trim() !== expectedSha) fail('RESEARCH_RELEASE_IDENTITY');
  }
  if (fs.existsSync('/var/lib/football-release/recovery/current')) fail('RESEARCH_RECOVERY_PENDING');
}
module.exports = { findHeldReleaseLock, releaseBoundary };
