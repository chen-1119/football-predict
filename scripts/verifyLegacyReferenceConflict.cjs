"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), Module = require("node:module");
const ts = require("typescript"), React = require("react"), { renderToStaticMarkup } = require("react-dom/server");
const resolveOriginal = Module._resolveFilename;
Module._resolveFilename = function(id, ...args) {
  if (id === "football-collector-diagnostics") return path.resolve(__dirname, "../src/services/apiFootballDiagnostics.cjs");
  return resolveOriginal.call(this, id, ...args);
};
require.extensions[".css"] = () => {};
for (const extension of [".ts", ".tsx"]) require.extensions[extension] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  }, fileName: filename }).outputText, filename);
};
const { hasUnboundLegacyReferenceConflict: detect } = require("../src/services/legacyReferenceConflict.ts");
const { RecommendationEvidenceFacts } = require("../src/components/predictions/RecommendationEvidenceFacts.tsx");
const { current } = require("./fixtures/fullAppEvidence.cjs");
const fixture = () => {
  const match = structuredClone(current);
  delete match.predictionMeta.publicReferenceDecision;
  match.predictionMeta.immutableAnalysisReferenceDecision = { version: "immutable-analysis-reference-decision-v1",
    sourceMatchId: match.sourceMatchId, kickoffTime: match.kickoffTime, eventVersion: match.eventVersion,
    market: "HAD", code: "1", source: { provider: "500.com" }, statisticsTrack: "analysis-only", privateSecret: "NEVER_RENDER_RAW_LEGACY" };
  return match;
};
let checks = 0;
const check = fn => { fn(); checks++; };
check(() => assert.equal(detect(fixture()), true));
for (const mutate of [m => { m.predictions[0].tipCode = "1"; }, m => { m.predictions[0].oddsPoolCode = "HHAD"; },
  m => { m.predictions[0].tipCode = "WATCH"; }, m => { m.predictions[0].recommendationAction = "recommend"; },
  m => { m.predictionMeta.immutableAnalysisReferenceDecision.sourceMatchId = "wrong-event"; },
  m => { m.predictionMeta.immutableAnalysisReferenceDecision.kickoffTime = "2026-09-08T12:00:00Z"; },
  m => { m.predictionMeta.immutableAnalysisReferenceDecision.eventVersion = "2026-09-08T12:00:00Z"; },
  m => { m.predictionMeta.immutableAnalysisReferenceDecision.code = "WATCH"; },
  m => { delete m.predictionMeta.immutableAnalysisReferenceDecision; },
  m => { m.predictionMeta.publicReferenceDecision = structuredClone(current.predictionMeta.publicReferenceDecision); },
]) check(() => { const match = fixture(); mutate(match); assert.equal(detect(match), false); });
for (const language of ["zh", "en"]) check(() => {
  const match = fixture(), before = JSON.stringify(match);
  const html = renderToStaticMarkup(React.createElement(RecommendationEvidenceFacts, { match, language, prediction: match.predictions[0] }));
  assert.ok(html.includes('data-testid="legacy-reference-conflict"'));
  assert.ok(html.includes(language === "zh" ? "不能据此补算命中" : "does not justify adding a hit"));
  assert.ok(html.includes(language === "zh" ? "无法确认当时展示的方向" : "proving what was shown"));
  assert.ok(!html.includes("NEVER_RENDER_RAW_LEGACY"));
  assert.equal(JSON.stringify(match), before);
});
check(() => {
  const match = fixture(); match.predictionMeta.publicReferenceDecision = structuredClone(current.predictionMeta.publicReferenceDecision);
  const html = renderToStaticMarkup(React.createElement(RecommendationEvidenceFacts, { match, language: "zh" }));
  assert.ok(!html.includes('data-testid="legacy-reference-conflict"'));
});
Module._resolveFilename = resolveOriginal;
console.log(JSON.stringify({ ok: true, checks, scope: "diagnostic only; actual TS selector and TSX render", historicalChanges: 0, productionWrites: false }));
