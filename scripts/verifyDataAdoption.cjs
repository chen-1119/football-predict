"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { bindPublicReferenceDecision: bind, attestPublicReferenceDecision: attest } = require("../src/services/publicReferenceDecision.cjs");
const root = path.resolve(__dirname, "..");
const load = (file, overrides = {}) => {
  const compiled = ts.transpileModule(fs.readFileSync(path.join(root, file), "utf8"), { compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", compiled)(id => overrides[id] || require(id), module, module.exports);
  return module.exports;
};
const service = load("src/services/dataAdoption.ts", { "football-collector-diagnostics": require("../src/services/apiFootballDiagnostics.cjs") });
const { DataAdoptionDetails } = load("src/components/predictions/DataAdoptionDetails.tsx", { "../../services/dataAdoption": service });
const clone = value => JSON.parse(JSON.stringify(value));
const at = "2026-09-07T01:00:00.000Z";
const kickoff = "2026-09-07T12:00:00.000Z";
const base = {
  id: "sporttery_991001", sourceMatchId: "991001", kickoffTime: kickoff, eventVersion: kickoff, status: "SCHEDULED",
  predictions: [{ marketType: "BEST", recommendationAction: "reference", oddsPoolCode: "HAD", tipCode: "X", odds: 3.4 }],
  probabilityModel: { version: "synthetic-model", generatedAt: at },
  predictionMeta: { generatedAt: at, decisionId: "synthetic-decision", modelVersion: "synthetic-model", policyVersion: "synthetic-policy",
    featureSnapshot: { sourceMatchId: "991001", kickoffTime: kickoff, capturedAt: at, modelInputs: {
      form: { home: { sampleSize: 4, lastMatchAt: "2026-08-31T12:00:00.000Z" }, away: { sampleSize: 0, lastMatchAt: null }, historicalSource: { source: "shared-history" } },
      elo: { homeMatches: 20, awayMatches: 20, historicalSource: { source: "shared-history" } },
      dataGaps: { connected: { officialOdds: true, externalMarket: true, lineup: false }, preMatchQuality: { components: {
        market: { status: "verified", sourceObservedAt: at },
        lineup: { status: "not_yet_publishable" },
        weather: { status: "verified", sourceObservedAt: "2026-09-07T00:00:00.000Z", source: "weather-fixture" },
        injuries: { status: "stale_or_unverified", privateRaw: "NEVER_PUBLIC" },
        referee: { status: "published_after_cutoff", sourceObservedAt: "2026-09-07T13:00:00.000Z" },
      } } },
    } },
  },
};
const published = bind(base, null, "2026-09-07T01:00:01.000Z");
const row = (match, key) => service.getDataAdoptionFacts(match).find(row => row.key === key);
const render = (match, language) => renderToStaticMarkup(React.createElement(DataAdoptionDetails, { match, language }));
const overview = html => {
  const start = html.indexOf('<details class="data-adoption-details">');
  assert.ok(start > 0, "full audit remains a closed details element");
  return html.slice(0, start);
};
// Synthetic SSR fixtures use the real publisher for identity binding. Arithmetic
// receipt/source validation is covered separately by verifyDataAdoptionSources.
const sourceFixture = (sources, used = true) => {
  const input = clone(base);
  if (sources?.length === 1 && sources[0] === "500-recent-form") input.predictionMeta.featureSnapshot.modelInputs.form = null;
  input.predictionMeta.featureSnapshot.modelInputs.usageSummary = {
    version: "model-input-usage-v1", scope: "base-calculation-only", sourceVerified: false,
    rows: [{ key: "form", stage: "form-lambda-blend", weight: used ? 0.42 : 0, used,
      receiptHash: "e".repeat(64), ...(sources === undefined ? {} : { sources }) }],
  };
  return bind(input, null, "2026-09-07T01:00:01.000Z");
};
let checks = 0;
const check = (name, fn) => { fn(); checks++; };
check("real publisher freezes compact presence with its public hash", () => {
  assert.ok(published.predictionMeta.publicReferenceDecision.evidenceBinding);
  assert.equal(row(published, "homeForm").sampleSize, 4);
  assert.equal(row(published, "awayForm").sampleSize, 0);
  assert.equal(JSON.stringify(published.predictionMeta.publicReferenceDecision).includes("NEVER_PUBLIC"), false);
});
check("legacy connected flags never become adoption or independent market proof", () => {
  for (const key of ["officialOdds", "externalMarket"]) assert.equal(row(published, key).state, "unverified");
  assert.equal(service.getDataAdoptionFacts(published).some(row => row.state === "adopted"), false);
});
for (const [key, state] of [["homeForm", "unverified"], ["awayForm", "missing"], ["elo", "unverified"], ["lineup", "not-yet-published"], ["weather", "available-not-adopted"], ["injuries", "unverified"], ["referee", "after-decision"]]) {
  check("source state preserved: " + key, () => assert.equal(row(published, key).state, state));
}
check("current collection cannot overwrite frozen absence or publication window", () => {
  const match = clone(published);
  match.probabilityModel.contextSignals = { dataGaps: { connected: { lineup: true, injuries: true } } };
  assert.equal(row(match, "lineup").state, "not-yet-published");
  assert.equal(row(match, "injuries").state, "unverified");
});
check("invalid public record cannot fall back to private current evidence", () => {
  const match = clone(published); match.predictionMeta.publicReferenceDecision.integrityVerified = false;
  match.predictionMeta.decisionDataGaps = base.predictionMeta.featureSnapshot.modelInputs.dataGaps;
  assert.equal(service.getDataAdoptionFacts(match).every(row => row.state === "unknown"), true);
});
for (const [observedAt, expected] of [["2026-01-01T00:00:00.000Z", "stale"], [at, "after-decision"], [null, "unverified"]]) {
  check("form time policy: " + expected, () => {
    const match = clone(published);
    match.predictionMeta.publicReferenceDecision.dataGaps.inputSummaries.form.home.lastMatchAt = observedAt;
    assert.equal(row(match, "homeForm").state, expected);
  });
}
for (const value of [null, "", false, "0", -1, 1.5]) check("malformed sample is unknown rather than zero: " + JSON.stringify(value), () => {
  const match = clone(published);
  match.predictionMeta.publicReferenceDecision.dataGaps.inputSummaries.form.away.sampleSize = value;
  assert.equal(row(match, "awayForm").sampleSize, null);
  assert.equal(row(match, "awayForm").state, "unknown");
});
check("future observation is rejected even if upstream calls it verified pre cutoff", () => {
  const match = clone(published);
  match.predictionMeta.publicReferenceDecision.dataGaps.preMatchQuality.components.weather.sourceObservedAt = "2026-09-07T02:00:00.000Z";
  assert.equal(row(match, "weather").state, "after-decision");
});
check("timezone-free legacy observation clocks use Beijing independent of browser locale", () => {
  const match = clone(published);
  match.predictionMeta.publicReferenceDecision.dataGaps.preMatchQuality.components.weather.sourceObservedAt = "2026-09-07 10:00:00";
  assert.equal(row(match, "weather").state, "after-decision");
  assert.equal(row(match, "weather").observedAt, "2026-09-07T10:00:00+08:00");
});
check("legacy missing frozen fields stay unknown and are not reconstructed", () => {
  const match = clone(published); match.predictionMeta.publicReferenceDecision.dataGaps = null;
  assert.equal(service.getDataAdoptionFacts(match).every(row => row.state === "unknown"), true);
});
check("actual TSX renders decision identity, sample counts and neutral reason labels", () => {
  for (const language of ["zh", "en"]) {
    const html = render(published, language);
    const values = language === "zh"
      ? ["训练历史样本 4 场", "训练历史样本 0 场", "数据接通不等于参与计算", "synthetic-model", "采用未核验", "同一历史源"]
      : ["4 training-history samples", "0 training-history samples", "Connection does not prove model usage", "synthetic-model", "training history", "not independent sources"];
    for (const value of values) assert.ok(html.includes(value), value);
    assert.equal(html.includes("本版已采用"), false);
    assert.equal(html.includes("100%"), false);
  }
  const empty = renderToStaticMarkup(React.createElement(DataAdoptionDetails, { match: {}, language: "zh" }));
  assert.ok(empty.includes("缺少有效公开记录绑定"));
  assert.ok(empty.includes("未记录"));
});
check("base arithmetic receipts remain separate from source verification and final contribution", () => {
  const match = clone(published);
  match.predictionMeta.publicReferenceDecision.dataGaps.calculationUsage = {
    version: "model-input-usage-v1", scope: "base-calculation-only", sourceVerified: false,
    rows: [{ key: "form", stage: "form-lambda-blend", weight: 0.42, used: true, receiptHash: "b".repeat(64), fallbackMetrics: 1 },
      { key: "elo", stage: "base-outcome-blend", weight: 0, used: false, receiptHash: "c".repeat(64) }],
  };
  const html = renderToStaticMarkup(React.createElement(DataAdoptionDetails, { match, language: "zh" }));
  for (const value of ["基础计算使用记录", "已参与基础计算", "本阶段未使用", "系数 0.420", "含 1 项缺失指标回退", "各阶段不能相加"]) assert.ok(html.includes(value), value);
  assert.equal(row(match, "elo").state, "unverified");
  match.predictionMeta.publicReferenceDecision.evidenceBinding = null;
  assert.equal(service.getDataAdoptionReport(match).calculationRows.length, 0);
});
for (const language of ["zh", "en"]) {
  check(`always-visible summary separates decision time and limitations from the closed audit: ${language}`, () => {
    const html = render(published, language);
    const visible = overview(html);
    const labels = language === "zh"
      ? ["依据与限制", "决策时间（北京）", "不以页面刷新或补采时间替代", "基础计算记录", "输入缺口与待核验", "暂无可核验的基础计算回执", "不等于最终推荐已采用"]
      : ["Inputs and limitations", "Decision time (Beijing)", "refresh or later collection times cannot replace it", "Base calculation records", "Missing and unverified inputs", "No verifiable base-calculation receipt", "Not final-pick adoption"];
    for (const label of labels) assert.ok(visible.includes(label), label);
    assert.ok(visible.includes(at), "decision clock remains the frozen timestamp");
    assert.equal(visible.includes("data-state="), false, "the twelve detailed audit rows remain collapsed");
    assert.equal((html.match(/<details\b/g) || []).length, 1);
  });
  check(`500-only source is shown consistently in the visible card and full receipt: ${language}`, () => {
    const match = sourceFixture(["500-recent-form"]);
    const html = render(match, language), visible = overview(html);
    const card = visible.match(/<li data-calculation-used="true">([\s\S]*?)<\/li>/)?.[1];
    assert.ok(card, "used form calculation is visible without opening details");
    const source = language === "zh" ? "500 近期状态" : "500 recent form";
    assert.ok(card.includes(source));
    assert.ok(card.includes(language === "zh" ? "已参与基础计算" : "Used in base calculation"));
    assert.equal(card.includes(language === "zh" ? "训练历史" : "Training history"), false);
    assert.equal(html.split(source).length - 1, 2, "same recorded source appears in both calculation views");
    assert.equal(html.includes(language === "zh" ? "训练历史样本 4 场" : "4 training-history samples"), false);
    assert.equal(service.getDataAdoptionReport(match).rows.some(value => value.state === "adopted"), false);
  });
  check(`both-source, zero-unused and unrecorded-source cards preserve their distinct meanings: ${language}`, () => {
    const both = render(sourceFixture(["training-history", "500-recent-form"]), language);
    const combined = language === "zh" ? "训练历史 / 500 近期状态" : "Training history / 500 recent form";
    assert.equal(both.split(combined).length - 1, 2);
    const zero = render(sourceFixture([], false), language);
    const zeroCard = overview(zero).match(/<li data-calculation-used="false">([\s\S]*?)<\/li>/)?.[1];
    assert.ok(zeroCard);
    assert.ok(zeroCard.includes(language === "zh" ? "本阶段未使用" : "Not used in this stage"));
    const noInput = language === "zh" ? "本阶段无候选输入" : "No candidate input in this stage";
    assert.equal(zero.split(noInput).length - 1, 2);
    const unrecorded = render(sourceFixture(undefined), language);
    const unknown = language === "zh" ? "来源明细未记录／不可核验" : "Source details unrecorded / unverifiable";
    assert.equal(unrecorded.split(unknown).length - 1, 2);
    assert.ok(overview(unrecorded).includes('data-calculation-used="true"'), "missing names do not erase an existing stage-use receipt");
    assert.equal(unrecorded.includes(noInput), false, "unrecorded is not an observed empty source list");
  });
  check(`major gaps are outside details and supplementary collector stays after all twelve audit inputs: ${language}`, () => {
    const match = clone(published);
    const components = match.predictionMeta.publicReferenceDecision.dataGaps.preMatchQuality.components;
    components.homeForm = { status: "conflicting" };
    components.elo = { status: "stale" };
    match.externalSignals = { apiFootball: { fixtureId: 7711, mappingVerified: false, lastCheckedAt: "2026-09-07T14:00:00Z" } };
    const html = render(match, language), visible = overview(html);
    for (const state of ["conflicting", "after-decision", "stale", "missing", "unverified", "not-yet-published"]) {
      assert.ok(visible.includes(`data-gap-state="${state}"`), state);
    }
    assert.ok(visible.includes(language === "zh" ? "主队近期（训练历史）" : "Home form (training history)"));
    const collectorStart = html.indexOf('<section class="collector-diagnostics"');
    const auditStart = html.indexOf("<dl>"), auditEnd = html.indexOf("</dl>");
    assert.ok(auditStart > visible.length && auditEnd > auditStart && collectorStart > auditEnd);
    assert.equal((html.slice(auditStart, auditEnd).match(/data-state="/g) || []).length, 12);
    assert.equal(visible.includes("collector-diagnostics"), false);
    assert.equal(visible.includes("API-Football"), false);
  });
}
check("SSR and later collector data leave frozen direction, identity and binding unchanged", () => {
  const match = sourceFixture(["training-history", "500-recent-form"]);
  const before = clone(match.predictionMeta.publicReferenceDecision);
  const beforeReport = service.getDataAdoptionReport(match);
  match.externalSignals = { apiFootball: { fixtureId: 7711, mappingVerified: false, lastCheckedAt: "2026-09-07T14:00:00Z" },
    fiveHundred: { recentForm: { home: { sampleSize: 999 }, away: { sampleSize: 999 } } } };
  for (const language of ["zh", "en"]) {
    const html = render(match, language);
    assert.ok(html.includes(`title="${before.contentHash}"`));
    assert.ok(html.includes(before.contentHash.slice(0, 12)));
    assert.deepEqual(match.predictionMeta.publicReferenceDecision, before);
    assert.deepEqual(service.getDataAdoptionReport(match), beforeReport);
    assert.equal(attest(match.predictionMeta.publicReferenceDecision, match)?.contentHash, before.contentHash);
    assert.equal(match.predictionMeta.publicReferenceDecision.prediction.tipCode, "X");
  }
});
const observationFixture = () => ({ version: "recent-form-result-evidence-v1", sourceVerified: false,
  sampleRows: 4, homeRows: 3, awayRows: 1, observedRows: 2, missingObservedAtRows: 2, missingSourceRows: 1,
  beforeKickoffRows: 0, afterDecisionRows: 0, latestObservedAt: "2026-09-06T14:00:00Z", decisionAt: at,
  temporalStatus: "unverified", selectionHash: "d".repeat(64) });
const withObservation = value => {
  const match = clone(published);
  match.predictionMeta.publicReferenceDecision.dataGaps.inputSummaries.form.home.resultEvidence = value;
  return match;
};
const contentFixture = () => ({ version: "recent-form-content-receipt-summary-v1", scope: "local-content-receipt-only", sourceVerified: false,
  sampleRows: 4, receivedRows: 3, missingReceiptRows: 1, afterDecisionRows: 0, latestFirstObservedAt: "2026-09-06T18:00:00.000Z", decisionAt: at });
const withContent = contentObservation => withObservation({ ...observationFixture(), contentObservation });
check("file receipt is separately labelled without upgrading result evidence or adoption", () => {
  const match = withContent(contentFixture());
  assert.equal(row(match, "homeForm").state, "unverified"); assert.equal(row(match, "homeForm").resultObservation.observedRows, 2);
  assert.equal(row(match, "homeForm").resultObservation.contentObservation.receivedRows, 3);
  for (const language of ["zh", "en"]) {
    const html=renderToStaticMarkup(React.createElement(DataAdoptionDetails,{match,language}));
    assert.ok(html.includes(language === "zh" ? "另有本地文件接收凭据 3 / 4" : "Separate local file receipts 3/4"));
    assert.ok(html.includes(language === "zh" ? "文件接收不等于赛果当时可用" : "File receipt is not historical result availability"));
  }
});
check("late local content reception is adverse even with older matches", () => {
  const match=withContent({...contentFixture(),latestFirstObservedAt:"2026-09-07T10:00:00.000Z",afterDecisionRows:1});
  assert.equal(row(match,"homeForm").state,"after-decision");
  match.predictionMeta.publicReferenceDecision.dataGaps.preMatchQuality.components.homeForm={status:"conflicting"};
  assert.equal(row(match,"homeForm").state,"conflicting");
});
for (const [name, change] of [
  ["wrong denominator",{sampleRows:5}], ["missing count",{receivedRows:null}], ["inconsistent counts",{missingReceiptRows:2}],
  ["wrong clock",{decisionAt:"2026-09-07T00:00:00.000Z"}], ["invalid date",{latestFirstObservedAt:"2026-02-30T00:00:00Z"}],
  ["time count conflict",{latestFirstObservedAt:"2026-09-07T10:00:00.000Z"}], ["source claim",{sourceVerified:true}], ["wrong scope",{scope:"official-result"}],
]) check("invalid content summary stays unverified: "+name, () => {
  const match=withContent({...contentFixture(),...change});
  assert.equal(row(match,"homeForm").resultObservation.contentObservation,null);
  assert.equal(row(match,"homeForm").state,"unverified");
});
check("observed result clocks and sample venues render separately from last match clocks", () => {
  const match = withObservation(observationFixture());
  assert.equal(row(match, "homeForm").reason, "result-clock-missing");
  const html = renderToStaticMarkup(React.createElement(DataAdoptionDetails, { match, language: "zh" }));
  for (const value of ["样本主场 3 / 客场 1", "有观测时钟 2 / 4", "缺时钟 2", "最近赛果观测", "不等于来源已核验或首次收到时间已证明"]) assert.ok(html.includes(value), value);
});
check("future result observation is not admitted by a past last-match date", () => {
  const match = withObservation({ ...observationFixture(), latestObservedAt: "2026-09-07T10:00:00Z" });
  assert.equal(row(match, "homeForm").state, "after-decision");
});
check("form aggregation from after the public decision cannot be labelled timely", () => {
  const match = withObservation({ ...observationFixture(), decisionAt: "2026-09-07T10:00:00Z" });
  assert.equal(row(match, "homeForm").state, "after-decision");
});
check("impossible result timing takes precedence over generic unverified status", () => {
  assert.equal(row(withObservation({ ...observationFixture(), beforeKickoffRows: 1 }), "homeForm").state, "conflicting");
});
check("malformed counts and unproven source flags never render a trustworthy summary", () => {
  for (const change of [{ sampleRows: 3 }, { observedRows: 5 }, { missingSourceRows: -1 }, { homeRows: "3" }, { sourceVerified: true }, { selectionHash: null }]) {
    assert.equal(row(withObservation({ ...observationFixture(), ...change }), "homeForm").resultObservation, null);
  }
});
check("missing observation clock renders unrecorded rather than zero time", () => {
  const match = withObservation({ ...observationFixture(), observedRows: 0, missingObservedAtRows: 4, latestObservedAt: null });
  assert.equal(row(match, "homeForm").resultObservation.latestObservedAt, null);
  const html = renderToStaticMarkup(React.createElement(DataAdoptionDetails, { match, language: "zh" }));
  assert.ok(html.includes("有观测时钟 0 / 4")); assert.equal(html.includes("1970"), false);
});
check("legacy unbound observation metadata cannot backfill public evidence", () => {
  const match = withObservation(observationFixture()); match.predictionMeta.publicReferenceDecision.evidenceBinding = null;
  assert.equal(row(match, "homeForm").resultObservation, null);
});
for (const key of ["homeForm", "elo"]) {
  for (const status of ["conflicting", "published_after_cutoff", "stale"]) check(`sample presence preserves adverse source state: ${key}/${status}`, () => {
    const match = clone(published);
    match.predictionMeta.publicReferenceDecision.dataGaps.preMatchQuality.components[key] = { status };
    const expected = status === "published_after_cutoff" ? "after-decision" : status;
    assert.equal(row(match, key).state, expected);
  });
}
for (const value of ["2026-02-30T00:00:00Z", "2026-04-31T00:00:00Z", "2025-02-29T00:00:00Z", "2026-09-01T24:00:00Z", "2026-09-01", "09/01/2026", "2026-09-01T00:00:00+08:60", "2026-02-30 08:00:00"]) {
  check("invalid observation calendar/clock cannot attest timeliness: " + value, () => {
    const match = clone(published);
    match.predictionMeta.publicReferenceDecision.dataGaps.preMatchQuality.components.weather = { status: "verified", sourceObservedAt: value };
    assert.equal(row(match, "weather").observedAt, null);
    assert.equal(row(match, "weather").state, "unverified");
    assert.equal(row(match, "weather").reason, "clock-missing");
  });
}
for (const value of ["2024-02-29T00:00:00Z", "2026-09-01T08:00:00+08:00", "2026-09-01T00:00:00.123Z", "2026-09-01 08:00"]) check("valid explicit and Beijing legacy clocks remain accepted: " + value, () => {
  const match = clone(published);
  match.predictionMeta.publicReferenceDecision.dataGaps.preMatchQuality.components.weather = { status: "verified", sourceObservedAt: value };
  assert.notEqual(row(match, "weather").observedAt, null);
  assert.equal(row(match, "weather").state, "available-not-adopted");
});
check("closed summary accounts for every input and exposes conflicts, late and aged states", () => {
  const match = clone(published);
  const components = match.predictionMeta.publicReferenceDecision.dataGaps.preMatchQuality.components;
  components.homeForm = { status: "conflicting" };
  components.elo = { status: "stale" };
  const report = service.getDataAdoptionReport(match);
  for (const language of ["zh", "en"]) {
    const html = renderToStaticMarkup(React.createElement(DataAdoptionDetails, { match, language }));
    const summary = html.match(/<summary>([\s\S]*?)<\/summary>/)[1];
    const actual = Object.fromEntries([...summary.matchAll(/data-summary-state="([^"]+)">([^<]+)</g)].map(m => [m[1], Number(m[2].match(/\d+/)[0])]));
    assert.equal(Object.values(actual).reduce((a, b) => a + b, 0), report.rows.length);
    assert.equal(actual.conflicting, 1); assert.equal(actual["after-decision"], 1); assert.equal(actual.stale, 1);
    assert.equal(actual.unverified, report.rows.filter(r => ["unknown", "unverified", "available-not-adopted"].includes(r.state)).length);
    assert.equal(actual["not-yet-published"], 1);
    assert.equal(summary.includes("%"), false);
  }
});
check("collector diagnostics never change frozen evidence or its counts", () => {
  const match = clone(published);
  const before = service.getDataAdoptionReport(match);
  match.externalSignals = { apiFootball: { fixtureId: 7711, mappingVerified: false, lastCheckedAt: "2026-09-07T14:00:00Z",
    temporalRejections: ["lineups:clock-evidence-not-verifiable"], privateToken: "NEVER_PUBLIC" } };
  assert.deepEqual(service.getDataAdoptionReport(match), before);
  assert.equal(service.getCollectorDiagnostics(match).features[1].state, "clock-rejected");
  for (const language of ["zh", "en"]) {
    const html = renderToStaticMarkup(React.createElement(DataAdoptionDetails, { match, language }));
    assert.ok(html.includes(language === "zh" ? "不回填原推荐" : "does not backfill"));
    assert.ok(html.includes(language === "zh" ? "时间证据未通过" : "Time evidence rejected"));
    assert.ok(!html.includes("NEVER_PUBLIC"));
  }
});
check("date access window is independent of mapping and frozen input usage", () => {
  const match = clone(published), before = service.getDataAdoptionReport(match);
  const { buildFixtureAccessDiagnostic } = require("../src/services/apiFootballDiagnostics.cjs");
  match.externalSignals = { apiFootball: { mappingVerified: false, lastCheckedAt: "2026-09-07T14:00:00Z",
    fixtureAccess: buildFixtureAccessDiagnostic({ updatedAt: "2026-09-07T13:30:00Z", allowedFrom: "2026-09-06", allowedTo: "2026-09-08" }, "2026-09-09", "2026-09-07T14:00:00Z") } };
  assert.deepEqual(service.getDataAdoptionReport(match), before);
  for (const language of ["zh", "en"]) {
    const html = renderToStaticMarkup(React.createElement(DataAdoptionDetails, { match, language }));
    assert.ok(html.includes('data-fixture-access="outside-recorded-window"'));
    assert.ok(html.includes("2026-09-09")); assert.ok(html.includes("2026-09-06")); assert.ok(html.includes("2026-09-08"));
    assert.ok(html.includes(language === "zh" ? "两项独立检查" : "separate checks"));
  }
});
console.log(JSON.stringify({ ok: true, checks, scope: "actual publisher, pure TS rules and actual TSX rendering; synthetic only", modelWeightsChanged: false }, null, 2));
