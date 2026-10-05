'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const jobs = [
  ['typescript', ['node_modules/typescript/bin/tsc', '-b']],
  ['vite', ['node_modules/vite/bin/vite.js', 'build']],
  ['strip-dist', ['scripts/stripLargeStaticPayloads.cjs']],
  ['eslint', ['node_modules/eslint/bin/eslint.js', 'src', 'vite.config.ts']],
];
const report = { startedAt: new Date().toISOString(), node: process.version, productionWrites: false, deployed: false, jobs: [] };
for (const [name, args] of jobs) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  fs.writeFileSync(path.join(__dirname, name + '.log'), String(result.stdout || '') + String(result.stderr || ''));
  report.jobs.push({ name, args, startedAt, completedAt: new Date().toISOString(), exitCode: result.status, error: result.error?.message || null });
  console.log(JSON.stringify(report.jobs.at(-1)));
  if (result.status !== 0 && name !== 'eslint') break;
}
report.ok = report.jobs.length === jobs.length && report.jobs.every(row => row.exitCode === 0);
report.completedAt = new Date().toISOString();
fs.writeFileSync(path.join(__dirname, 'build-verification.json'), JSON.stringify(report, null, 2) + '\n');
process.exitCode = report.ok ? 0 : 1;
