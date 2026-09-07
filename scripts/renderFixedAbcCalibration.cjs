"use strict";
// Private offline research presentation. No training, HTTP, model or ledger writes.
const fs = require("node:fs");
const path = require("node:path");
const { stableHash } = require("./historicalAsOfFeatureBuilder.cjs");
const { freezeProtocol } = require("./fixedAbcResearch.cjs");
const ROUTES = ["A", "B", "C"], OUTCOMES = ["1", "X", "2"];
const LABELS = { A: "A · 去水赔率基准", B: "B · 动态球队模型", C: "C · 组合路线", "1": "主胜", X: "平局", "2": "客胜" };
const fail = message => { throw new Error(`calibration report rejected: ${message}`); };
const integer = n => Number.isSafeInteger(n) && n >= 0;
const finite = n => typeof n === "number" && Number.isFinite(n);
const close = (a, b, tolerance = 1e-7) => finite(a) && finite(b) && Math.abs(a - b) <= tolerance;
const committed = value => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { manifestHash, ...body } = value;
  return typeof manifestHash === "string" && /^[a-f0-9]{64}$/.test(manifestHash) && stableHash(body) === manifestHash;
};
function validateScore(score, expectedRows) {
  if (!score || !integer(score.rows) || score.rows !== expectedRows
    || ![score.hits, score.decided, score.abstainedTies].every(integer)
    || score.hits > score.decided || score.decided + score.abstainedTies !== score.rows) fail("score denominator");
  if (score.decided ? !close(score.accuracy, score.hits / score.decided) : score.accuracy !== null) fail("accuracy");
  if (score.rows ? !close(score.directionCoverage, score.decided / score.rows) : score.directionCoverage !== null) fail("coverage");
  for (const key of ["brier", "logLoss"]) if (score.rows ? !finite(score[key]) || score[key] < 0 : score[key] !== null) fail("loss");
  if (!score.calibration || Object.keys(score.calibration).sort().join() !== [...OUTCOMES].sort().join()) fail("outcome bins");
  const positives = {};
  for (const outcome of OUTCOMES) {
    const bins = score.calibration[outcome];
    if (!Array.isArray(bins) || bins.length !== 10) fail("ten fixed bins required");
    let count = 0, positive = 0;
    bins.forEach((bin, i) => {
      if (!bin || bin.lower !== i / 10 || bin.upper !== (i + 1) / 10 || !integer(bin.rows)) fail("bin shape");
      if (!bin.rows) {
        if (bin.meanProbability !== null || bin.observedFrequency !== null) fail("empty bin must remain null");
      } else {
        if (!finite(bin.meanProbability) || !finite(bin.observedFrequency)
          || bin.meanProbability < bin.lower - 1e-10 || bin.meanProbability > bin.upper + 1e-10
          || bin.observedFrequency < 0 || bin.observedFrequency > 1) fail("bin value");
        const n = bin.rows * bin.observedFrequency;
        if (!close(n, Math.round(n), Math.max(1e-7, bin.rows * 1e-10))) fail("fractional outcome count");
        positive += Math.round(n);
      }
      count += bin.rows;
    });
    if (count !== score.rows) fail("bin counts do not reconcile");
    positives[outcome] = positive;
  }
  if (OUTCOMES.reduce((sum, key) => sum + positives[key], 0) !== score.rows) fail("outcome totals");
  return positives;
}
function validateArtifact(artifact) {
  if (!committed(artifact) || artifact.version !== "fixed-abc-research-run-v2"
    || !committed(artifact.research) || !committed(artifact.ablations)) fail("artifact commitment or version");
  const r = artifact.research;
  if (r.version !== "fixed-abc-historical-research-v2" || r.researchOnly !== true
    || r.productionEligible !== false || r.strictPromotionEligible !== false
    || r.conclusion?.nominationAllowed !== false || artifact.combinedConclusion?.nominationAllowed !== false
    || artifact.combinedConclusion?.productionEligible !== false || r.fitted?.testLabelsUsedForFitting !== false) fail("research boundary");
  const { protocolHash, ...protocol } = r.protocol || {};
  if (freezeProtocol(protocol).protocolHash !== protocolHash) fail("protocol commitment");
  if (!r.reports || Object.keys(r.reports).sort().join() !== ROUTES.join()) fail("fixed routes");
  const n = r.coverage?.pairedTestRows, common = r.coverage?.commonDirectionRows;
  if (!integer(n) || !integer(common) || common > n || r.partition?.test?.rows !== n) fail("test denominator");
  if (r.fitted.temperatures?.A !== 1 || !r.protocol.residualWeights.includes(r.fitted.residualWeight)
    || ROUTES.some(k => !r.protocol.temperatures.includes(r.fitted.temperatures?.[k]))) fail("fitted parameters");
  let expectedPositives;
  for (const route of ROUTES) {
    const s = r.reports[route];
    const positives = validateScore(s.allPaired, n);
    if (expectedPositives && JSON.stringify(expectedPositives) !== JSON.stringify(positives)) fail("different outcome cohorts");
    expectedPositives = positives;
    if (JSON.stringify(validateScore(s.rawUncalibrated, n)) !== JSON.stringify(positives)) fail("raw/calibrated cohort mismatch");
    validateScore(s.commonDecisions, common);
    if (s.commonDecisions.decided !== common) fail("common cohort must be decidable");
    const f = s.fixedFilter;
    if (!integer(f?.rows) || f.rows > n || (n ? !close(f.coverage, f.rows / n) : f.coverage !== null)) fail("filtered coverage");
    if (JSON.stringify(validateScore(f.candidate, f.rows)) !== JSON.stringify(validateScore(f.sameRowsMarket, f.rows))) fail("filtered paired cohort");
    if (route !== "A") {
      const u = s.pairedUncertainty;
      if (u?.rows !== n || u.researchOnly !== true || u.promotionEligible !== false
        || stableHash(u.policy) !== stableHash(r.protocol.uncertainty)) fail("uncertainty denominator/boundary/policy");
      if (u.status === "computed-research-only") {
        if (u.familyAdjusted?.familySize !== 8 || u.familyAdjusted?.tailAlpha !== 0.003125) fail("uncertainty multiplicity");
        for (const metric of ["brier", "logLoss"]) {
          const interval = u.familyAdjusted.intervals?.[metric];
          if (!finite(interval?.lower) || !finite(interval?.upper) || interval.lower > interval.upper
            || !close(u.observedImprovement?.[metric], r.reports.A.allPaired[metric] - s.allPaired[metric])) fail("uncertainty values");
        }
      } else if (!["insufficient-calendar-support", "empty-bootstrap-replicate"].includes(u.status) || u.familyAdjusted !== null) fail("unknown uncertainty status");
    }
  }
  return r;
}
const escape = value => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const number = value => value === null ? "—" : Number(value).toFixed(6);
const percent = value => value === null ? "—" : `${(value * 100).toFixed(2)}%`;
function chart(outcome, route, score, raw) {
  const bins = score.calibration[outcome], rawBins = raw.calibration[outcome];
  const points = bins.filter(b => b.rows), before = rawBins.filter(b => b.rows);
  const xy = b => [58 + b.meanProbability * 238, 252 - b.observedFrequency * 216];
  const marks = (data, isRaw) => data.map(b => { const [x, y] = xy(b); return isRaw
    ? `<rect x="${x - 3}" y="${y - 3}" width="6" height="6" class="raw-mark"><title>${escape(`校准前：均值 ${percent(b.meanProbability)}；实际 ${percent(b.observedFrequency)}；${b.rows} 场`)}</title></rect>`
    : `<circle cx="${x}" cy="${y}" r="4" class="calibrated-mark"><title>${escape(`均值 ${percent(b.meanProbability)}；实际 ${percent(b.observedFrequency)}；${b.rows} 场`)}</title></circle>`; }).join("");
  const rows = bins.map((b, i) => `<tr><th scope="row">${i * 10}–${(i + 1) * 10}%</th><td>${b.rows}</td><td>${percent(b.meanProbability)}</td><td>${percent(b.observedFrequency)}</td></tr>`).join("");
  return `<article><h3>${LABELS[outcome]} · ${score.rows} 场</h3><svg viewBox="0 0 340 308" role="img" aria-label="${escape(`${route} ${LABELS[outcome]} 校准图，完整测试样本${score.rows}场`)}"><title>预测概率与实际频率</title><desc>圆点为校准后，方点为校准前。虚线是理想校准线；空分箱没有数据点。下方表格提供精确数字。</desc>
  ${[0, 0.5, 1].map(t => `<path class="grid" d="M58 ${252-t*216}H296 M${58+t*238} 36V252"/><text x="48" y="${257-t*216}" text-anchor="end">${t*100}%</text><text x="${58+t*238}" y="274" text-anchor="middle">${t*100}%</text>`).join("")}
  <path class="ideal" d="M58 252L296 36"/><text x="58" y="20">实际频率</text><text x="180" y="302" text-anchor="middle">平均预测概率</text>
  ${route !== "A" ? marks(before, true) : ""}${marks(points, false)}</svg>
  <details><summary>查看 ${LABELS[outcome]} 全部 10 个分箱</summary><table><caption>校准后；区间左闭右开，最后一箱含100%</caption><thead><tr><th>分箱</th><th>场数</th><th>概率均值</th><th>实际频率</th></tr></thead><tbody>${rows}</tbody></table></details></article>`;
}
function renderCalibrationReport(artifact) {
  const r = validateArtifact(artifact);
  const metricRows = ROUTES.map(k => { const s = r.reports[k]; return `<tr><th scope="row">${LABELS[k]}</th><td>${s.commonDecisions.hits} / ${s.commonDecisions.decided}<br>${percent(s.commonDecisions.accuracy)}</td><td>${number(s.allPaired.brier)}</td><td>${number(s.allPaired.logLoss)}</td><td>${s.allPaired.abstainedTies}</td></tr>`; }).join("");
  const intervals = ["B", "C"].map(k => { const u = r.reports[k].pairedUncertainty; return `<tr><th>${LABELS[k]}</th>${["brier", "logLoss"].map(metric => { const ci = u.familyAdjusted?.intervals?.[metric]; return `<td>${ci ? `${number(u.observedImprovement[metric])}<br>[${number(ci.lower)}, ${number(ci.upper)}]` : "待补足日期样本"}</td>`; }).join("")}</tr>`; }).join("");
  const sections = ROUTES.map(route => `<section><h2>${LABELS[route]}</h2><p>温度 ${r.fitted.temperatures[route]}${route === "C" ? ` · 模型修正权重 ${r.fitted.residualWeight}` : ""} · 圆点：校准后${route !== "A" ? "；方点：校准前" : "（未拟合校准）"}；虚线：理想校准。</p><div class="charts">${OUTCOMES.map(outcome => chart(outcome, route, r.reports[route].allPaired, r.reports[route].rawUncalibrated)).join("")}</div><p>固定筛选子集 ${r.reports[route].fixedFilter.rows} / ${r.coverage.pairedTestRows}（${percent(r.reports[route].fixedFilter.coverage)}）。图表始终使用全量配对样本，不使用该子集。</p></section>`).join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>固定 A/B/C · 历史校准诊断</title><style>
  *{box-sizing:border-box}body{margin:0;background:#10171d;color:#e9eef1;font:15px/1.7 system-ui,"Microsoft YaHei",sans-serif}main{max-width:1160px;margin:auto;padding:32px 24px}h1{font-size:30px;line-height:1.3}h2{font-size:22px}h3{font-size:17px}p{color:#b5c3cd}.notice{border-left:3px solid #dbb770;padding:12px 20px;background:#1a2229}.charts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px}section{border-top:1px solid #34424d;margin-top:30px;padding-top:16px}svg{display:block;width:100%;height:auto}svg text{fill:#cbd6dd;font-size:14px}.grid{fill:none;stroke:#2b3a45;stroke-width:1}.ideal{fill:none;stroke:#8899a5;stroke-dasharray:5 5}.raw-mark{fill:none;stroke:#e8b867;stroke-width:2}.calibrated-mark{fill:#5dd4b4;stroke:#10171d;stroke-width:1}table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;font-size:14px}th,td{text-align:left;vertical-align:top;border-bottom:1px solid #34424d;padding:9px 6px}caption{text-align:left;color:#b5c3cd}details{margin-top:8px}summary{cursor:pointer;padding:12px 0;min-height:44px}summary:focus-visible{outline:2px solid #dbb770}code{overflow-wrap:anywhere;font-size:12px}.table-scroll{overflow-x:auto}.metadata{overflow-wrap:anywhere}@media(max-width:900px){.charts{grid-template-columns:1fr}article{max-width:550px;width:100%;margin:auto}main{padding:24px 16px}}@media(max-width:400px){main{padding:20px 12px}h1{font-size:25px}th,td{padding:8px 3px;font-size:12px}}
  </style></head><body><main><header><p>研究诊断 · HAD 胜平负 · 不计入线上战绩</p><h1>概率说了多少，结果兑现多少？</h1><p>固定 A/B/C 历史对照：${escape(r.protocol.dates.test)} 至 ${escape(r.protocol.dates.end)}（右端不含），全量配对 ${r.coverage.pairedTestRows} 场。</p></header><aside class="notice">历史结果此前已被查看，且缺源端首次收到时钟证明。这不是独立盲测或前瞻验证，不能据此发布正式推荐。校准图不提供分箱置信区间；稀疏分箱不能据单点认定可靠。${r.fitted.residualWeight === 0 ? " C 的模型修正权重为 0，其变化来自市场概率校准，不是新增球队模型优势。" : ""}</aside>
  <section><h2>同组指标与分母</h2><p>命中率分母为三路线都能唯一判定的 ${r.coverage.commonDirectionRows} 场；Brier / Log Loss 与下方校准图使用全部 ${r.coverage.pairedTestRows} 场。两种分母不混用；概率误差越低越好。</p><div class="table-scroll"><table><thead><tr><th>路线</th><th>共同命中 / 可判定</th><th>Brier</th><th>Log Loss</th><th>自身平票</th></tr></thead><tbody>${metricRows}</tbody></table></div></section>
  ${sections}<section><h2>相对市场的误差改善与不确定性</h2><p>正值才是改善；7 日历日块，5,000 次重采样，4 个路线/范围对照 × 2 指标的双侧多重校正区间。它仍是历史敏感性分析，未完全解决球队依赖，不能作为晋级证明。</p><table><thead><tr><th>路线</th><th>Brier 改善 / 区间</th><th>Log Loss 改善 / 区间</th></tr></thead><tbody>${intervals}</tbody></table></section><footer class="metadata"><h2>可复核来源</h2><p>生成器只读取已保存的私有研究产物；没有重新拟合、修改冻结参数或变更历史战绩。内容哈希证明文件一致性，不证明来源真实性。</p><p>来源：${escape(artifact.source?.dataset || r.protocol.sourceDataset)}</p><p>产物哈希：<code>${artifact.manifestHash}</code><br>研究哈希：<code>${r.manifestHash}</code><br>协议哈希：<code>${r.protocol.protocolHash}</code></p></footer></main></body></html>\n`;
}
module.exports = { validateArtifact, validateScore, renderCalibrationReport };
if (require.main === module) {
  const input = path.resolve(process.argv[2] || "");
  const output = path.resolve(process.argv[3] || "");
  const outputRoot = path.resolve(__dirname, "../outputs");
  if (process.argv.length !== 4 || !output.startsWith(outputRoot + path.sep) || path.extname(output) !== ".html") fail("use input.json and a new workspace outputs/*.html path");
  if (fs.statSync(input).size > 8 * 1024 * 1024) fail("input too large");
  if (fs.existsSync(output)) fail("output already exists");
  const raw = fs.readFileSync(input, "utf8");
  const html = renderCalibrationReport(JSON.parse(raw));
  fs.mkdirSync(outputRoot, { recursive: true });
  const realRoot = fs.realpathSync(outputRoot);
  if (realRoot !== path.join(fs.realpathSync(path.resolve(__dirname, "..")), "outputs")) fail("symlinked output root");
  // Check the existing ancestor before making any nested directories.
  let ancestor = path.dirname(output);
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const realAncestor = fs.realpathSync(ancestor);
  if (realAncestor !== realRoot && !realAncestor.startsWith(realRoot + path.sep)) fail("output parent escapes workspace outputs");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, html, { flag: "wx" });
  console.log(JSON.stringify({ ok: true, output, bytes: Buffer.byteLength(html), reportHash: stableHash(html), writesToProduction: 0 }));
}
