const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { buildReport, renderMarkdown } = require("./auditFreeDataTrial.cjs");

const rootDir = path.resolve(__dirname, "..");
const envExample = fs.readFileSync(path.join(rootDir, "deploy", "light-server", "env.example"), "utf8");
const workerSource = fs.readFileSync(path.join(rootDir, "scripts", "runSyncWorker.cjs"), "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));

const health = {
  ok: true,
  status: {
    serviceOk: true,
    sourceHealthOk: true,
    officialSourceRedundancy: {
      trustedCollectorCount: 1,
      requiredTrustedCollectors: 2,
      independenceDomains: ["collector-a"],
    },
  },
  data: { currentCount: 44 },
  sources: {
    mode: { enableApiFootballSync: false },
    externalSignals: {
      apiFootballStatus: "retired-not-required",
      freeFootballRows: 44,
      freeFootballRecommendationReady: 44,
    },
    currentMatches: { count: 44, externalCoverage: 1, withSportteryOdds: 30 },
    preMatchSignals: {
      rows: 44,
      coverageByComponent: {
        referee: { rows: 44, verified: 0, missing: 44, coverage: 0 },
        injuries: { rows: 44, verified: 0, missing: 41, coverage: 0 },
        lineup: { rows: 44, verified: 0, missing: 19, coverage: 0 },
        xg: { rows: 44, verified: 0, missing: 19, coverage: 0 },
        market: { rows: 44, verified: 30, missing: 14, coverage: 30 / 44 },
      },
    },
  },
};

const report = buildReport({
  health,
  apiFootballMeta: {
    accountStatus: {
      suspended: true,
      reason: "account-suspended",
    },
  },
  cloudflareHealth: {
    ok: true,
    sportteryIndependentCollectorConfigured: true,
  },
});

assert.equal(report.ok, true);
assert.equal(report.production.currentMatches, 44);
assert.equal(report.freeSources.freeFootball.recommendationReady, 44);
assert.equal(report.freeSources.cloudflareSportteryCollector.reachable, true);
assert.equal(report.freeSources.apiFootball.status, "suspended");
assert.equal(report.gaps.find((gap) => gap.key === "referee").missing, 44);
assert.equal(report.gaps.find((gap) => gap.key === "market").verified, 30);
assert.equal(report.trial.priceCny, 0);
assert.equal(report.trial.enablePaidUpgrade, false);
assert.ok(report.trial.blockers.includes("api-football-account-suspended"));
assert.match(renderMarkdown(report), /14天零成本目标/);
assert.match(renderMarkdown(report), /不得用赔率、trustScore 或模型推断伪造/);
assert.match(envExample, /^SPORTTERY_CLOUDFLARE_EVIDENCE_URL=https:\/\/football-predict-sync-trigger\.doki981119\.workers\.dev\/api\/sporttery-evidence$/m);
assert.match(envExample, /^SPORTTERY_CLOUDFLARE_PULL_TOKEN=$/m);
assert.match(envExample, /^SPORTTERY_CLOUDFLARE_UPLOAD_TRANSPORT=local-http$/m);
assert.match(envExample, /^SPORTTERY_CLOUDFLARE_LOCAL_UPLOAD_URL=http:\/\/127\.0\.0\.1:8788\/api\/admin\/sporttery-collector-evidence$/m);
assert.ok(workerSource.includes('"sync:cloudflare-sporttery-evidence"'));
assert.ok(workerSource.includes("SPORTTERY_CLOUDFLARE_PULL_TOKEN"));
assert.equal(packageJson.scripts?.["audit:free-data-trial"], "node scripts/auditFreeDataTrial.cjs");

console.log(JSON.stringify({
  ok: true,
  checkedAt: new Date().toISOString(),
  checks: 19,
}, null, 2));
