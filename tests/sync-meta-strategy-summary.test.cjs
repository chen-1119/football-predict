"use strict";
const test = require("node:test");
const a = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { spawn } = require("node:child_process");
const { summarizeStrategyForSyncMeta: summary } = require("../scripts/syncMetaStrategySummary.cjs");
const { acquireSyncMetaCommitLock } = require("../scripts/syncMetaCommitLock.cjs");
const optimizerPath = path.resolve(__dirname, "../scripts/optimizePredictionStrategy.cjs");
const optimizerSource = fs.readFileSync(optimizerPath, "utf8");
const functionSource = optimizerSource.slice(optimizerSource.indexOf("function reconcileShadowStrategyArtifacts("),
  optimizerSource.indexOf("\nfunction ", optimizerSource.indexOf("function reconcileShadowStrategyArtifacts(") + 10));
const fixtureStrategy = (ready = false, onlineEffect = "shadow") => ({ version: "v1", generatedAt: "2026-10-26T15:00:00Z",
  sample: { recommendationRows: 600 }, activeGates: {}, activation: { onlineEffect,
    promotionGate: { status: "eligible", eligibleScope: "model-signal", sample: { marketBaselineRows: 600 },
      metrics: { rollingPassRate: 0.7 }, modelSignal: { onlineEffect, readyForGuardedUse: ready },
      productionValidation: { rows: Array(2000).fill("retained complete in original strategy") } } } });

function reconcileAt(dir, writeJson) {
  return vm.runInNewContext(`(${functionSource})`, { publicDataDir: dir, path,
    readJson: (file, fallback) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback,
    writeJson: writeJson || ((file, value) => fs.writeFileSync(file, JSON.stringify(value))),
    summarizeStrategyForSyncMeta: summary, acquireSyncMetaCommitLock });
}

test("summary is idempotent, preserves health gate types and complete original", () => {
  for (const ready of [false, true, null, "true", 0]) for (const effect of ["shadow", "guarded-active", null]) {
    const strategy = fixtureStrategy(ready, effect), before = JSON.stringify(strategy), result = summary(strategy);
    a.equal(JSON.stringify(strategy), before);
    a.deepEqual(summary(result), result);
    a.equal(result.activation.promotionGate.modelSignal.readyForGuardedUse, ready);
    a.equal(result.activation.promotionGate.modelSignal.onlineEffect, effect);
    a.equal(result.activation.promotionGate.productionValidation, undefined);
    a.deepEqual(result.sample, strategy.sample);
  }
});

test("both production writers use the same summary; native observation merge remains", () => {
  const sync = fs.readFileSync(path.resolve(__dirname, "../scripts/syncData.cjs"), "utf8");
  a.match(sync, /modelStrategy: existingModelStrategy \? summarizeStrategyForSyncMeta\(existingModelStrategy\) : null/);
  a.match(functionSource, /summarizeStrategyForSyncMeta\(/);
  a(functionSource.indexOf("acquireSyncMetaCommitLock") < functionSource.indexOf("readJson(syncMetaFile"));
  a.match(functionSource, /finally\s*\{\s*syncMetaLock.release\(\)/);
});

test("optimizer preserves all observation rows, other metadata, and releases lock on write failure", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meta-summary-test-"));
  const file = path.join(dir, "sync-meta.json");
  const observations = { rows: Array.from({ length: 912 }, (_, i) => ({ id: i, receipt: "original-" + i })) };
  const original = { fastResultObservations: observations, unrelated: { clock: "original" }, modelStrategy: fixtureStrategy() };
  fs.writeFileSync(file, JSON.stringify(original));
  const next = fixtureStrategy(false, "disabled");
  try {
    const run = reconcileAt(dir);
    a.equal(run(next).syncMetaUpdated, true);
    const result = JSON.parse(fs.readFileSync(file, "utf8"));
    a.deepEqual(result.fastResultObservations, observations);
    a.deepEqual(result.unrelated, original.unrelated);
    a.equal(run(next).syncMetaUpdated, false);
    a.equal(fs.existsSync(file + ".commit.lock"), false);
    a.throws(() => reconcileAt(dir, () => { throw new Error("fixture EIO"); })(fixtureStrategy(true, "guarded-active")), /fixture EIO/);
    a.equal(fs.existsSync(file + ".commit.lock"), false);
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test("optimizer waiting for a real writer rereads its newly committed receipt", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meta-summary-race-"));
  const file = path.join(dir, "sync-meta.json");
  fs.writeFileSync(file, JSON.stringify({ fastResultObservations: { rows: [{ id: "old" }] } }));
  const lock = acquireSyncMetaCommitLock({ filePath: file });
  const childSource = `const fs=require('fs'),vm=require('vm'),path=require('path');
    const {summarizeStrategyForSyncMeta}=require(${JSON.stringify(path.resolve(__dirname, "../scripts/syncMetaStrategySummary.cjs"))});
    const {acquireSyncMetaCommitLock}=require(${JSON.stringify(path.resolve(__dirname, "../scripts/syncMetaCommitLock.cjs"))});
    const run=vm.runInNewContext('('+${JSON.stringify(functionSource)}+')',{publicDataDir:${JSON.stringify(dir)},path,
      readJson:(p,f)=>fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf8')):f,
      writeJson:(p,v)=>fs.writeFileSync(p,JSON.stringify(v)),summarizeStrategyForSyncMeta,acquireSyncMetaCommitLock});
    process.send('ready');run(${JSON.stringify(fixtureStrategy(false, "disabled"))});process.send('complete');`;
  const childFile = path.join(dir, "writer.cjs");
  fs.writeFileSync(childFile, childSource);
  const child = spawn(process.execPath, [childFile], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let errors = "", completed = false;
  child.stderr.on("data", x => { errors += x; });
  const exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  try {
    await new Promise((resolve, reject) => { child.once("message", resolve); child.once("error", reject); });
    child.on("message", x => { if (x === "complete") completed = true; });
    await new Promise(resolve => setTimeout(resolve, 150));
    a.equal(completed, false);
    fs.writeFileSync(file, JSON.stringify({ fastResultObservations: { rows: [{ id: "old" }, { id: "new-receipt" }] } }));
    lock.release();
    a.equal(await exited, 0, errors);
    a.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).fastResultObservations.rows, [{ id: "old" }, { id: "new-receipt" }]);
    a.equal(fs.existsSync(file + ".commit.lock"), false);
  } finally {
    lock.release();
    if (child.exitCode === null) { child.kill(); await exited; }
    fs.rmSync(dir, { recursive: true });
  }
});
