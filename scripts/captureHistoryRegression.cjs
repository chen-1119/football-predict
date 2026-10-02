"use strict";
// Read-only transport. No uploads, database writes, service operations or credentials in output.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { validateReleaseSshHostKeyPin, buildPinnedSshBaseOptions } = require('./releaseSshHostKeyPin.cjs');
const FAILURE_CODES = new Set(('CONTROL_BOUND CONTROL_RACE SOURCE_BOUND SOURCE_RACE FILE_BOUND ITEM_BOUND JSON_SYNTAX JSON_DUPLICATE_KEY JSON_INCOMPLETE JSON_TRAILING_DATA SOURCE_HASH GENERATION_CHANGED MANIFEST_IDENTITY HISTORY_SHAPE PROJECTED_ROW_BOUND OUTPUT_BOUND READ_ONLY_EXPORT_FAILED JSON_NON_FINITE JSON_DEPTH CONTROL_JSON_INVALID MANIFEST_SHAPE POINTER_SHAPE SOURCE_PATH JSON_KEY_BOUND REGISTRY_INVALID REGISTRY_CHANGED PRIVATE_KEY_FORBIDDEN MANIFEST_HASH INVALID_READ_ONLY_RECEIPT INVALID_REMOTE_JSON REMOTE_TIMEOUT REMOTE_OUTPUT_BOUND REMOTE_EXIT TRANSPORT_ERROR').split(' '));
const ERROR_CLASSES = new Set(['AssertionError', 'ValueError', 'TypeError', 'KeyError', 'OSError', 'UnicodeDecodeError', 'JSONDecodeError', 'RecursionError', 'OverflowError']);
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function failureReceipt(result) {
  let reported = null;
  try { if (Buffer.byteLength(result.stdout || '', 'utf8') <= 4096) reported = JSON.parse(result.stdout); } catch {}
  const transportCode = result.error?.code === 'ETIMEDOUT' || result.status === 124 || result.status === 137 ? 'REMOTE_TIMEOUT'
    : result.error?.code === 'ENOBUFS' ? 'REMOTE_OUTPUT_BOUND' : result.error ? 'TRANSPORT_ERROR' : 'REMOTE_EXIT';
  return { version:'bounded-online-history-capture-failure-v1', ok:false, productionWrites:false,
    code:reported?.ok === false && FAILURE_CODES.has(reported.code) ? reported.code : transportCode,
    errorClass:ERROR_CLASSES.has(reported?.errorClass) ? reported.errorClass : null,
    exitStatus:Number.isSafeInteger(result.status) ? result.status : null,
    receivedAt:new Date().toISOString() };
}
function capture({ programFile, outputFile }) {
  const expectedProgram = path.join(__dirname,'historyRegressionRemote.py');
  if (path.resolve(programFile) !== expectedProgram || fs.realpathSync(programFile) !== fs.realpathSync(expectedProgram)) throw Error('EXPORTER_NOT_ALLOWED');
  const programStat = fs.lstatSync(programFile);
  if (!programStat.isFile() || programStat.isSymbolicLink() || programStat.size > 65536) throw Error('EXPORTER_NOT_ALLOWED');
  for (const file of [outputFile, outputFile+'.remote-response.json', outputFile+'.failure.json']) {
    if (fs.existsSync(file)) throw Error('OUTPUT_EXISTS');
  }
  const host = '134.175.132.183';
  const pin = validateReleaseSshHostKeyPin({host, port:22,
    knownHostsPath: process.env.HISTORY_KNOWN_HOSTS || 'C:/Users/86188/Documents/football/.codex-tmp/football-production.known_hosts',
    expectedFingerprint:'SHA256:t3Y9DoAdbURl0ibCHQEYENSARoqcm3OSK+ERl/Sg8to'});
  const source = fs.readFileSync(programFile);
  const result = spawnSync('ssh', ['-p','22', ...buildPinnedSshBaseOptions({
    keyPath:process.env.HISTORY_SSH_KEY || 'C:/Users/86188/.ssh/football-new-20260819', pin}),
    'ubuntu@'+host, 'sudo -n timeout --signal=TERM --kill-after=5s 110s python3 -'], {input:source, windowsHide:true,
    timeout:120000, maxBuffer:12*1024*1024});
  if (result.status !== 0 || result.error) {
    const receipt = failureReceipt(result), failureFile = outputFile + '.failure.json';
    fs.mkdirSync(path.dirname(failureFile), {recursive:true});
    fs.writeFileSync(failureFile, JSON.stringify(receipt,null,2)+'\n', {flag:'wx'});
    const error = new Error('READ_ONLY_CAPTURE_FAILED: ' + receipt.code);
    error.code = receipt.code; error.failureFile = failureFile; throw error;
  }
  let document;
  const rawResponse = result.stdout;
  try { document = JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(rawResponse)); } catch { throw Error('INVALID_REMOTE_JSON'); }
  if (rawResponse.length > 10*1024*1024+1 || document.productionWrites !== false || document.ok !== true
    || document.version !== 'bounded-online-history-export-v1' || document.sameSnapshot !== true
    || !Array.isArray(document.rows) || document.rows.length > 500
    || new Set(document.rows.map(row => row.matchId)).size !== document.rows.length
    || rawResponse.toString('utf8').toUpperCase().includes('PRIVATE KEY')) throw Error('INVALID_READ_ONLY_RECEIPT');
  const rawResponseFile = outputFile+'.remote-response.json';
  document.transport = {sourceHost:host, pinnedSshFingerprint:pin.fingerprint,
    exporterSha256:digest(source), responseByteSha256:digest(rawResponse), rawResponseFile, receivedAt:new Date().toISOString(),
    canonicalHashEncoding:'Python JSON: ensure_ascii=false, separators=(comma,colon), sort_keys=true; do not verify with JSON.stringify'};
  fs.mkdirSync(path.dirname(outputFile), {recursive:true});
  fs.writeFileSync(rawResponseFile, rawResponse, {flag:'wx'});
  fs.writeFileSync(outputFile, JSON.stringify(document,null,2)+'\n', {flag:'wx'});
  return {outputFile, bytes:fs.statSync(outputFile).size, rows:document.rows?.length, ok:true};
}
if(require.main===module){
  const args=process.argv.slice(2);
  if(args.length!==2)throw Error('Usage: node scripts/captureHistoryRegression.cjs scripts/historyRegressionRemote.py OUTPUT.json');
  // Only the reviewed exporter is accepted by the CLI, never arbitrary remote code.
  if(path.resolve(args[0])!==path.join(__dirname,'historyRegressionRemote.py'))throw Error('EXPORTER_NOT_ALLOWED');
  console.log(JSON.stringify(capture({programFile:path.resolve(args[0]),outputFile:path.resolve(args[1])})));
}
module.exports={capture, failureReceipt};
