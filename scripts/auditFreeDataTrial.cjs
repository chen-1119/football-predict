const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const defaultBaseUrl = "https://134.175.132.183";

const argValue = (name) => {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8"));

const fetchJson = async (url) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timer);
  }
};

const asCoverage = (component = {}) => ({
  rows: Number(component.rows || 0),
  verified: Number(component.verified || 0),
  estimated: Number(component.estimated || 0),
  missing: Number(component.missing || 0),
  coverage: Number(component.coverage || 0),
  nextSource: component.nextSource || null,
});

const buildReport = ({ health, apiFootballMeta = null, cloudflareHealth = null }) => {
  const sourceHealth = health?.sources || {};
  const status = health?.status || {};
  const preMatch = sourceHealth?.preMatchSignals || {};
  const components = preMatch?.coverageByComponent || {};
  const redundancy = status?.officialSourceRedundancy || sourceHealth?.officialSourceRedundancy || {};
  const externalSignals = sourceHealth?.externalSignals || {};
  const currentMatches = sourceHealth?.currentMatches || {};
  const providerSuspended = apiFootballMeta?.accountStatus?.suspended === true
    || apiFootballMeta?.apiAccess?.status?.suspended === true
    || /suspend/i.test(String(
      apiFootballMeta?.error
        || apiFootballMeta?.lastError
        || apiFootballMeta?.reason
        || apiFootballMeta?.accountStatus?.reason
        || apiFootballMeta?.status
        || "",
    ));

  const gaps = [
    ["referee", "裁判", "联赛/协会官方比赛报告"],
    ["injuries", "伤停", "俱乐部官方名单与赛前发布会"],
    ["lineup", "首发", "俱乐部或联赛官方比赛中心"],
    ["xg", "xG", "可审计公共比赛统计"],
    ["teamCards", "牌数据", "football-data纪律历史/官方报告"],
    ["weather", "天气", "Open-Meteo场地预报"],
    ["form", "近期状态", "签名滚动赛果历史"],
    ["market", "市场证据", "体彩HAD/HHAD"],
  ].map(([key, label, freeSource]) => ({
    key,
    label,
    freeSource,
    ...asCoverage(components[key]),
  }));

  const blockers = [];
  if (providerSuspended) blockers.push("api-football-account-suspended");
  if (!process.env.SPORTTERY_CLOUDFLARE_PULL_TOKEN) blockers.push("cloudflare-pull-token-not-installed-locally");
  if (Number(redundancy.trustedCollectorCount || 0) < Number(redundancy.requiredTrustedCollectors || 2)) {
    blockers.push("official-market-second-collector-not-yet-counted");
  }

  return {
    version: "free-data-trial-audit-v1",
    checkedAt: new Date().toISOString(),
    ok: health?.ok === true,
    production: {
      serviceOk: status.serviceOk === true,
      sourceHealthOk: status.sourceHealthOk === true,
      currentMatches: Number(currentMatches.count || health?.data?.currentCount || 0),
      externalSignalCoverage: Number(currentMatches.externalCoverage || 0),
      officialOddsMatches: Number(currentMatches.withSportteryOdds || 0),
      preMatchRows: Number(preMatch.rows || gaps[0]?.rows || 0),
    },
    freeSources: {
      freeFootball: {
        enabled: externalSignals.apiFootballStatus === "retired-not-required"
          || externalSignals.freeFootballRows > 0,
        rows: Number(externalSignals.freeFootballRows || 0),
        recommendationReady: Number(externalSignals.freeFootballRecommendationReady || 0),
      },
      cloudflareSportteryCollector: {
        reachable: cloudflareHealth?.ok === true,
        collectorConfigured: cloudflareHealth?.sportteryIndependentCollectorConfigured === true,
        evidenceUrl: process.env.SPORTTERY_CLOUDFLARE_EVIDENCE_URL
          || "https://football-predict-sync-trigger.doki981119.workers.dev/api/sporttery-evidence",
        productionTrustedCollectors: Number(redundancy.trustedCollectorCount || 0),
        requiredTrustedCollectors: Number(redundancy.requiredTrustedCollectors || 2),
        productionDomains: Array.isArray(redundancy.independenceDomains)
          ? redundancy.independenceDomains
          : [],
      },
      apiFootball: {
        enabledInProduction: sourceHealth?.mode?.enableApiFootballSync === true,
        status: providerSuspended
          ? "suspended"
          : String(externalSignals.apiFootballStatus || apiFootballMeta?.status || "not-configured"),
        mappedSignals: Number(externalSignals.apiFootballMappedSignals || 0),
        keyPresent: Boolean(process.env.API_FOOTBALL_KEY),
      },
    },
    gaps,
    trial: {
      priceCny: 0,
      durationDays: 14,
      enablePaidUpgrade: false,
      target: {
        officialCollectorRedundancy: "2/2",
        refereeCoverage: ">=50%",
        lineupCoverage: ">=50% near kickoff",
        injuryCoverage: ">=50%",
        publicMetricsCoverage: "observe only; never synthesize missing values",
      },
      blockers,
    },
  };
};

const renderMarkdown = (report) => {
  const percent = (value) => `${Math.round(Number(value || 0) * 100)}%`;
  const rows = report.gaps.map((gap) => (
    `| ${gap.label} | ${gap.verified}/${gap.rows} | ${percent(gap.coverage)} | ${gap.missing} | ${gap.freeSource} |`
  ));
  return [
    "# 免费数据试用审计",
    "",
    `- 检查时间：${report.checkedAt}`,
    `- 线上健康：${report.ok ? "通过" : "失败"}`,
    `- 当前比赛：${report.production.currentMatches}`,
    `- 免费足球信号：${report.freeSources.freeFootball.recommendationReady}/${report.freeSources.freeFootball.rows}`,
    `- 体彩独立采集器：${report.freeSources.cloudflareSportteryCollector.reachable ? "可访问" : "不可访问"}`,
    `- 生产可信采集器：${report.freeSources.cloudflareSportteryCollector.productionTrustedCollectors}/${report.freeSources.cloudflareSportteryCollector.requiredTrustedCollectors}`,
    `- API-Football：${report.freeSources.apiFootball.status}`,
    "",
    "| 数据项 | 已验证/总数 | 覆盖率 | 缺失 | 免费来源 |",
    "|---|---:|---:|---:|---|",
    ...rows,
    "",
    "## 14天零成本目标",
    "",
    "1. 接入现有 Cloudflare 体彩签名证据，使官方市场采集器达到 2/2。",
    "2. 继续使用 Open-Meteo、免费足球信号、官方联赛/俱乐部页面补天气、状态、首发、伤停和裁判。",
    "3. API-Football 仅在免费账号恢复后启用；不可用时保持关闭，不影响主同步。",
    "4. 缺失数据继续显示 `--`，不得用赔率、trustScore 或模型推断伪造。",
    "",
    `阻断项：${report.trial.blockers.length ? report.trial.blockers.join(", ") : "无"}`,
    "",
  ].join("\n");
};

const run = async () => {
  const healthFile = argValue("--health-file");
  const baseUrl = String(argValue("--base-url") || process.env.FOOTBALL_PUBLIC_BASE_URL || defaultBaseUrl)
    .replace(/\/$/, "");
  const health = healthFile
    ? readJson(path.resolve(healthFile))
    : await fetchJson(`${baseUrl}/api/v1/health`);
  const apiMetaPath = path.resolve(
    process.env.SERVER_STORE_DIR || path.join(rootDir, "public", "data"),
    "api-football-meta.json",
  );
  const apiFootballMeta = fs.existsSync(apiMetaPath) ? readJson(apiMetaPath) : null;
  let cloudflareHealth = null;
  try {
    cloudflareHealth = await fetchJson("https://football-predict-sync-trigger.doki981119.workers.dev/health");
  } catch {
    cloudflareHealth = null;
  }
  const report = buildReport({ health, apiFootballMeta, cloudflareHealth });
  const outputDir = path.resolve(argValue("--out-dir") || path.join(rootDir, "outputs", "free-data-trial"));
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "latest.json"), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(outputDir, "latest.md"), renderMarkdown(report));
  console.log(JSON.stringify({
    ok: report.ok,
    checkedAt: report.checkedAt,
    outputDir,
    blockers: report.trial.blockers,
    gaps: report.gaps.map(({ key, rows, verified, missing, coverage }) => ({
      key, rows, verified, missing, coverage,
    })),
  }, null, 2));
  if (!report.ok) process.exitCode = 1;
};

if (require.main === module) {
  run().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error?.message || String(error) }, null, 2));
    process.exit(1);
  });
}

module.exports = { buildReport, renderMarkdown };
