'use strict';
const fs = require('node:fs');
const path = require('node:path');
const schedule = require('./footballDataOrgSchedule.cjs');
const view = require('./footballDataOrgNeutralView.cjs');
const STORE = '/var/lib/football-data-org';
const CREDENTIAL = '/etc/football-data-org/credentials.env';
const collectionExitCode = result => result.productionObservationWrites || result.skipped === true && result.reason === 'hourly-collection-not-due' && result.requests === 0 ? 0 : 2;
async function main() {
  const disk = fs.statfsSync(STORE);
  if (disk.bavail * disk.bsize < 2 * 1024 ** 3) throw Object.assign(Error('DISK_RESERVE'), { code: 'DISK_RESERVE' });
  const result = await schedule.runFootballDataOrgSchedule({ storeDir: STORE, loadCredential: () => schedule.credential(CREDENTIAL) });
  if (result.outputDirectory) {
    const bytes = fs.readFileSync(path.join(result.outputDirectory, 'report.json'));
    if (view.sha(bytes) !== result.reportSha256) throw Error('REPORT_HASH_MISMATCH');
    require('./neutralCollectionStore.cjs').indexOrg(STORE, JSON.parse(bytes), result.outputDirectory);
    const data = view.summarize(JSON.parse(bytes), result.outputDirectory);
    const summaryBytes = Buffer.from(JSON.stringify(data, null, 2) + '\n');
    fs.writeFileSync(path.join(result.outputDirectory, 'neutral-summary.json'), summaryBytes, { flag: 'wx', mode: 0o600 });
    const pointer = { observation: path.basename(result.outputDirectory), reportSha256: result.reportSha256, summarySha256: view.sha(summaryBytes) };
    const temporary = path.join(STORE, result.attemptId + '.latest.tmp');
    fs.writeFileSync(temporary, JSON.stringify(pointer) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, path.join(STORE, 'neutral-latest.json'));
  }
  process.stdout.write(JSON.stringify({ ...result, credential: undefined }) + '\n');
  process.exitCode = collectionExitCode(result);
}
if (require.main === module) main().catch(error => { console.error(JSON.stringify({ ok: false, reason: /^[A-Z_]+$/.test(error.code || '') ? error.code : 'NEUTRAL_COLLECTION_FAILED' })); process.exitCode = 1; });
module.exports = { STORE, CREDENTIAL, main, collectionExitCode };
