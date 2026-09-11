'use strict';
// Operator-side transport: use the existing pinned SSH identity, never print credentials.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const root = path.resolve(__dirname, '..');
function environment() {
  const env={...process.env};
  for(const key of Object.keys(env))if(/^(RELEASE_|VERIFY_|FRONTEND_|VITE_|GIT_|NPM_CONFIG_|REMOTE_)/i.test(key)
    ||['NODE_OPTIONS','NODE_PATH','LD_PRELOAD','LD_LIBRARY_PATH','BASH_ENV','ENV'].includes(key.toUpperCase()))delete env[key];
  Object.assign(env,{
    RELEASE_SIGNING_PUBLIC_KEY:path.resolve(root,'../football-release-signing-public.pem'),
    RELEASE_DEPLOY_HOST:'134.175.132.183',RELEASE_DEPLOY_USER:'ubuntu',RELEASE_DEPLOY_PORT:'22',
    RELEASE_DEPLOY_KEY:'C:/Users/86188/.ssh/football-new-20260819',
    RELEASE_DEPLOY_KNOWN_HOSTS:'C:/Users/86188/.ssh/football-new-known-hosts',
    RELEASE_DEPLOY_HOST_KEY_SHA256:'SHA256:t3Y9DoAdbURl0ibCHQEYENSARoqcm3OSK+ERl/Sg8to',
    RELEASE_DEPLOY_HOST_KEY_TYPE:'ssh-ed25519',PUBLIC_BASE_URL:'https://134.175.132.183',
  });
  return env;
}
function remote(code, { timeout = 60000, prefix = 'repair-observation', maxBuffer = 8 * 1024 ** 2 } = {}) {
  const env = environment();
  const { validateReleaseSshHostKeyPin, buildPinnedSshBaseOptions } = require('./releaseSshHostKeyPin.cjs');
  const pin = validateReleaseSshHostKeyPin({ knownHostsPath: env.RELEASE_DEPLOY_KNOWN_HOSTS,
    host: env.RELEASE_DEPLOY_HOST, port: 22, expectedKeyType: env.RELEASE_DEPLOY_HOST_KEY_TYPE,
    expectedFingerprint: env.RELEASE_DEPLOY_HOST_KEY_SHA256 });
  const start = Date.now();
  const result = cp.spawnSync('C:/Windows/System32/OpenSSH/ssh.exe', [
    ...buildPinnedSshBaseOptions({ keyPath: env.RELEASE_DEPLOY_KEY, pin }), 'ubuntu@134.175.132.183',
    'sudo', '-n', '/usr/bin/env', '-i', 'PATH=/opt/node-v22.22.1/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    '/opt/node-v22.22.1/bin/node', '--max-old-space-size=1152', '-'],
  { input: code, env, encoding: 'utf8', windowsHide: true, timeout, maxBuffer });
  const output = path.join(root, 'outputs', prefix + '-' + Date.now() + '.json');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const report = { checkedAt: new Date().toISOString(), elapsedMs: Date.now() - start,
    exitCode: result.status, error: result.error?.code || null, stdout: result.stdout, stderr: result.stderr };
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  return { output, ...report };
}
module.exports = { remote, environment };
