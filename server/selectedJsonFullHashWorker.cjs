'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const { parentPort, workerData } = require('node:worker_threads');

// Fixed read-only FD protocol. No paths, commands, environment or write API.
if (!parentPort || !workerData || Object.keys(workerData).sort().join(',') !== 'action,expectedBytes,fd,nonce,version'
  || workerData.version !== 1 || workerData.action !== 'full-sha256'
  || !/^[a-f0-9]{32}$/.test(workerData.nonce) || !Number.isSafeInteger(workerData.fd) || workerData.fd < 0
  || !Number.isSafeInteger(workerData.expectedBytes) || workerData.expectedBytes < 0 || workerData.expectedBytes > 2 * 1024 ** 3)
  throw new Error('invalid fixed full hash request');
const started = performance.now(), before = fs.fstatSync(workerData.fd);
if (!before.isFile() || before.size !== workerData.expectedBytes) throw new Error('full hash descriptor identity mismatch');
const buffer = Buffer.allocUnsafe(1024 * 1024), hash = crypto.createHash('sha256');
let bytes = 0;
for (;;) {
  // Explicit positions never change the shared descriptor's seek offset.
  const count = fs.readSync(workerData.fd, buffer, 0, buffer.length, bytes);
  if (!count) break;
  bytes += count;
  if (bytes > before.size) throw new Error('full hash file grew');
  hash.update(buffer.subarray(0, count));
}
const after = fs.fstatSync(workerData.fd);
if (bytes !== before.size || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
  || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('full hash file changed');
parentPort.postMessage(JSON.stringify({ version: 1, action: 'full-sha256', nonce: workerData.nonce,
  bytes, sha256: hash.digest('hex'), durationMs: performance.now() - started }));
