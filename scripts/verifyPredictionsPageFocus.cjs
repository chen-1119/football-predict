const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const readText = (relativePath) => fs.readFileSync(path.join(rootDir, relativePath), "utf8")
  .replace(/\r\n?/g, "\n");

const predictions = readText("src/pages/PredictionsList.tsx");
const bestTips = readText("src/pages/BestTips.tsx");
const matchDetail = readText("src/pages/MatchDetail.tsx");
const betSlip = readText("src/pages/BetSlipGenerator.tsx");
const personalReview = readText("src/pages/HitAndWin.tsx");
const app = readText("src/App.tsx");
const navbar = readText("src/components/Navbar.tsx");
const matchSummaryRow = readText("src/components/predictions/MatchSummaryRow.tsx");
const displayRecommendation = readText("src/services/displayRecommendation.ts");
const analysisReferenceEligibility = readText("src/services/analysisReferenceEligibility.ts");
const analysisReferenceSelection = readText("src/services/analysisReferenceSelection.ts");
const externalReferencePresentation = readText("src/services/externalOddsReferencePresentation.ts");
const liveScorePresentation = readText("src/services/liveScorePresentation.ts");
const css = readText("src/index.css");
const predictionsCss = readText("src/styles/predictions.css");
const eligibilityModulePath = path.join(rootDir, "src", "services", "officialRecommendationEligibility.cjs");
const { isOfficialRecommendationEligible, OFFICIAL_RECOMMENDATION_POLICY_VERSION } = require(eligibilityModulePath);

const archivedPreMatchPrediction = readText("src/services/archivedPreMatchPrediction.ts");
const evidenceFacts = readText("src/components/predictions/RecommendationEvidenceFacts.tsx");
const sourceNeutralText = readText("src/components/predictions/sourceNeutralText.ts");
const publicationLedger = readText("src/services/recommendationPublicationLedger.cjs");
const { buildHitRateAudit } = require("../server/hitRateAudit.cjs");
const { GOODWIN_BENCHMARK_SHADOW_POLICY, evaluateBenchmarkSelection } = require("../src/services/benchmarkSelectionPolicy.cjs");
const { completeCandidateAudit } = require("../src/services/candidateProspectiveProjection.cjs");

const checks = [];
const pushCheck = (name, ok, details = {}) => checks.push({ name, ok: Boolean(ok), ...details });
const hasAll = (text, needles) => needles.every((needle) => text.includes(needle));
const indexMap = (text, needles) => Object.fromEntries(needles.map((needle) => [needle, text.indexOf(needle)]));

const duplicateRecommendationMarkers = [
  "<WorldCupSpotlight",
  "recommendation-panel ${",
  "className=\"recommendation-grid\"",
  "parlayRecommendations",
  "renderRecommendationCard",
  "renderParlayCard"
].filter((needle) => predictions.includes(needle));

pushCheck("schedule-only live state never fabricates an elapsed minute", hasAll(liveScorePresentation, [
  "hasTrustedLiveObservation",
  "状态待确认",
  "赛程时间推算（非实时）",
  "未收到可信实时观测"
])
  && !liveScorePresentation.includes("const estimatedMinute")
  && !liveScorePresentation.includes("Math.min(120, elapsed)"), {
  estimatedMinuteRemoved: !liveScorePresentation.includes("const estimatedMinute"),
  inferredStateIsExplicit: liveScorePresentation.includes("状态待确认")
});

pushCheck("live-pick pool remains a gated secondary tool", hasAll(bestTips, [
  "赛前推荐",
  "优先展示通过正式门槛",
  "matches without official SP on sale are clearly marked unavailable",
  "isPredictionOfficialResultPoolAvailable",
  "getOfficialPredictionHandicapLine(match, prediction)",
  "getLiveCandidatePrediction(match, now)",
  "publicationTrack === 'live'"
]) && hasAll(app, [
  '<Route path="/" element={<Navigate to="/predictions" replace />} />',
  '<Route path="*" element={<Navigate to="/predictions" replace />} />',
  'path="/tools"',
  'path="/best"'
  , "'/best': { zh: '赛前推荐', en: 'Pre-match Picks' }"
]) && navbar.includes("setCurrentTab('tools')")
  && navbar.includes('role="menuitem"'), {
  defaultRouteIsPredictions: app.includes('<Route path="/" element={<Navigate to="/predictions" replace />} />'),
  formalPoolInTools: app.includes("onClick: () => navigate('/best')")
});

const primaryNavStart = navbar.indexOf('const navItems');
const primaryNavEnd = navbar.indexOf('export const Navbar', primaryNavStart);
const primaryNavSource = navbar.slice(primaryNavStart, primaryNavEnd);
pushCheck("primary navigation exposes the independent AI arena", hasAll(primaryNavSource, [
  "key: 'predictions'",
  "key: 'fixtures'",
  "key: 'arena'",
  "key: 'review'",
  "key: 'leagues'",
  "labelKey: 'topLeagues'"
]) && !["key: 'best'", "key: 'generator'", "key: 'hitwin'"].some((needle) => primaryNavSource.includes(needle))
  && hasAll(app, [
    "fixtures: '/fixtures'",
    "arena: '/ai-arena'",
    "review: '/review'",
    "leagues: '/leagues'",
    "tools: '/tools'",
    'path="/leagues"',
    'path="/ai-arena"',
    '<Route path="/worldcup" element={<Navigate to="/leagues" replace />} />',
    '<Route path="/hitwin" element={<Navigate to="/review" replace />} />'
  ]));

// Both routes now share the same compact match/pick/SP/result row contract.
pushCheck("analysis and fixtures routes share compact rows while retaining separate route state", hasAll(app, [
  '<PredictionsList viewMode="analysis" onSelectMatch={selectMatch} />',
  '<PredictionsList viewMode="fixtures" onSelectMatch={selectMatch} />'
]) && hasAll(predictions, [
  "viewMode: 'analysis' | 'fixtures'",
  "const isAnalysisView = viewMode === 'analysis'",
  'data-view-mode={viewMode}',
  "football.listView.",
  "group.matches.map(renderMatchRow)",
  "pickLabel={language === 'zh' ? '推荐方向' : 'Pick'}",
  'oddsLabel="SP"',
  "resultLabel={language === 'zh' ? '结果' : 'Result'}"
]));

pushCheck("initial loading and errors never present a false zero-match conclusion", hasAll(predictions, [
  "matchSummary={!dataSync.currentLoaded && baseFilteredMatches.length === 0",
  "'加载中' : 'Loading'",
  "const isLoading = Boolean(dataSync.currentLoading || (!dataSync.currentLoaded && !dataSync.error)",
  "const emptyStateText = isLoading",
  "!dataSync.currentLoaded && dataSync.error",
  "'暂时无法加载比赛，请稍后重试。'",
  "<p>{emptyStateText}</p>",
  'role="status" aria-live="polite"'
]));

pushCheck("secondary tools are bounded and explain empty formal pools", hasAll(betSlip, [
  "getFormalRecommendationPrediction",
  "formalRecommendationCount >= 2",
  'max="8.00"',
  "(['auto', 2, 3, 5] as const)",
  'min="62"',
  "disabled={!canGenerateCombination}",
  "onOpenObservations",
  "参考推荐不会进入组合",
  "正式推荐池不足 2 条"
]) && !betSlip.includes('max="150.00"')
  && !betSlip.includes("2, 3, 5, 10, 15")
  && !betSlip.includes("setOnlyImportant")
  && hasAll(personalReview, [
    "个人赛前复盘笔记",
    "不是本站官方推荐或公开挑战",
    "个人选择与本站正式推荐分开统计"
  ])
  && !personalReview.includes("本设备世界杯预测记录"));

const eligibleBase = {
  marketType: "BEST",
  oddsPoolCode: "HAD",
  handicapLine: "0",
  tipCode: "1",
  recommendationAction: "recommend",
  recommendationTier: "multi-factor-a"
};
const withEvidence = (prediction, odds, overrides = {}) => ({
  ...prediction,
  multiFactorEvidence: {
    version: OFFICIAL_RECOMMENDATION_POLICY_VERSION,
    eligible: true,
    market: prediction.oddsPoolCode,
    code: prediction.tipCode,
    handicapLine: prediction.oddsPoolCode === "HHAD" ? prediction.handicapLine : "0",
    odds,
    blockers: [],
    ...overrides
  }
});
const eligibilityFixtures = [
  { name: "valid HAD above old SP ceiling", prediction: withEvidence(eligibleBase, 2.35), odds: 2.35, line: 0, expected: true },
  { name: "valid HHAD multi-factor evidence", prediction: withEvidence({ ...eligibleBase, oddsPoolCode: "HHAD", handicapLine: "-1" }, 2.25), odds: 2.25, line: "-1", expected: true },
  { name: "stale HHAD -1 evidence at current -2 with same SP", prediction: withEvidence({ ...eligibleBase, oddsPoolCode: "HHAD", handicapLine: "-1" }, 2.25), odds: 2.25, line: "-2", expected: false },
  { name: "HHAD evidence line missing", prediction: withEvidence({ ...eligibleBase, oddsPoolCode: "HHAD", handicapLine: "-1" }, 2.25, { handicapLine: undefined }), odds: 2.25, line: "-1", expected: false },
  { name: "low SP without evidence", prediction: withEvidence(eligibleBase, 1.31, { eligible: false, blockers: ["negative-expected-value"] }), odds: 1.31, line: 0, expected: false },
  { name: "missing evidence", prediction: eligibleBase, odds: 1.55, line: 0, expected: false },
  { name: "legacy 1X2 fallback", prediction: withEvidence({ ...eligibleBase, marketType: "1X2" }, 1.55), odds: 1.55, line: 0, expected: false },
  { name: "reference action", prediction: withEvidence({ ...eligibleBase, recommendationAction: "reference" }, 1.55), odds: 1.55, line: 0, expected: false },
  { name: "reference tier", prediction: withEvidence({ ...eligibleBase, recommendationTier: "posterior-reference" }, 1.55), odds: 1.55, line: 0, expected: false },
  { name: "model-only tier", prediction: withEvidence({ ...eligibleBase, recommendationTier: "model-only-unified" }, 1.55), odds: 1.55, line: 0, expected: false },
  { name: "watch tier", prediction: withEvidence({ ...eligibleBase, recommendationTier: "multi-factor-watch" }, 1.55), odds: 1.55, line: 0, expected: false },
  { name: "missing official pool", prediction: withEvidence({ ...eligibleBase, oddsPoolCode: undefined }, 1.55), odds: 1.55, line: 0, expected: false },
  { name: "even-money boundary", prediction: withEvidence(eligibleBase, 1), odds: 1, line: 0, expected: false },
  { name: "evidence odds mismatch", prediction: withEvidence(eligibleBase, 1.8), odds: 1.81, line: 0, expected: false },
  { name: "HAD cannot use a non-zero official line", prediction: withEvidence(eligibleBase, 1.8), odds: 1.8, line: "-1", expected: false }
];
const eligibilityFixtureFailures = eligibilityFixtures.filter((fixture) => (
  isOfficialRecommendationEligible(fixture.prediction, fixture.odds, fixture.line) !== fixture.expected
));
pushCheck("official recommendation eligibility requires aligned multi-factor evidence", eligibilityFixtureFailures.length === 0
  && OFFICIAL_RECOMMENDATION_POLICY_VERSION === "multi-factor-market-evidence-v2", {
  fixtures: eligibilityFixtures.length,
  failures: eligibilityFixtureFailures.map((fixture) => fixture.name),
  policy: OFFICIAL_RECOMMENDATION_POLICY_VERSION
});

pushCheck("predictions has no duplicate recommendation board", duplicateRecommendationMarkers.length === 0, {
  duplicateRecommendationMarkers
});

const coreOrder = indexMap(predictions, [
  'className="dashboard-hero is-compact"',
  'className="date-toolbar"',
  'className="panel filters-panel filters-details"',
  'className="compact-record"',
  'className="league-stack"'
]);
const orderValues = Object.values(coreOrder);
pushCheck("compact settled summary precedes the fixtures without diagnostic panels", orderValues.every(value => value >= 0)
  && orderValues.every((value, index) => index === 0 || value > orderValues[index - 1]), { order: coreOrder });

const onSaleHelperStart = predictions.indexOf("const getOnSaleDisplayRecommendation");
const componentStart = predictions.indexOf("export const PredictionsList", onSaleHelperStart);
const onSaleHelper = predictions.slice(onSaleHelperStart, componentStart);
const strictHelperUses = (predictions.match(/getOnSaleDisplayRecommendation\(/g) || []).length;
pushCheck("formal picks require current bound SP while published live picks retain publication SP", onSaleHelperStart >= 0
  && hasAll(onSaleHelper, [
    "match.resultDisposition === 'VOID'", "match.status !== 'SCHEDULED'",
    "!isBeforeMatchSaleCutoff(match, now)", "getBestPrediction(match)",
    "isPredictionOfficialResultPoolAvailable(match, storedBest)",
    "getOfficialPredictionOdds(match, storedBest)",
    "isOfficialRecommendationEligible(", "getOfficialPredictionHandicapLine(match, storedBest)",
    "const eligiblePrediction = { ...storedBest, odds: officialOdds }", "prediction: eligiblePrediction"
  ]) && strictHelperUses >= 1 && hasAll(predictions, [
    "getOnSaleDisplayRecommendation(match, language, nowMs) || getLiveDisplayRecommendation(match, language)",
    "publishedRecommendation?.publicationTrack === 'live'",
    "displayRecommendation.publicationTrack !== 'live'"
  ]) && hasAll(displayRecommendation, [
    "const publishedLiveOdds = Number(promotedPrediction.livePublicationEvidence?.officialSp)",
    "odds: publishedOdds", "publicationTrack === 'formal' && isHandicapMarketContradicted"
  ]), { strictHelperUses });

const referenceSelectionOrder = indexMap(analysisReferenceSelection, [
  "isCalibratedMarketAnalysisReferenceEligible(match, storedBest, now)",
  "isDirectionalAnalysisReferenceEligible(match, storedBest, now)",
  "isModelOnlyAnalysisReferenceEligible(match, storedBest, now)",
  "const stableModelReference = buildStableLowEvidenceModelReference(match, storedBest, now)",
  "const officialMarketConsensus = buildOfficialMarketConsensusReference(match, undefined, now)",
  "const fiveHundred = buildFiveHundredMarketReferencePresentation(match, now)",
  "const lowEvidenceMarket = buildLowEvidenceMarketLeaderReference(",
]);
const referenceSelectionOrderValues = Object.values(referenceSelectionOrder);
pushCheck("analysis keeps the shared reference selector and evidence gates without provider copy", hasAll(predictions, [
  "import { selectOnSaleAnalysisReference }",
  "const analysisReferenceSelection = !isFinished && !displayRecommendation",
  "selectOnSaleAnalysisReference(match, { allowModelOnly: true, candidate: rawDisplayRecommendation?.prediction, now: nowMs })",
  "const analysisReference = analysisReferenceSelection?.prediction",
  "const nowMs = clockNow",
  "getReferencePredictionOdds(match, pickedPrediction)"
]) && hasAll(bestTips, [
  "selectOnSaleAnalysisReference(match, { allowModelOnly: false, now })",
  "reference.source === 'official-calibrated-market'",
  "reference.source === 'official-market-consensus'",
  "reference.source === 'five-hundred-market'",
  "reference.source === 'official-low-evidence-market'",
  "reference.source === 'five-hundred-low-evidence-market'",
  "reference.source === 'model-low-evidence'"
]) && hasAll(analysisReferenceSelection, [
  "match.resultDisposition === 'VOID'",
  "match.status !== 'SCHEDULED'",
  "const beforeCutoff = isBeforeMatchSaleCutoff(match, now);",
  "if (!beforeCutoff)",
  "if (publicRecord)",
  "sourceUpdatedAt: publicRecord.decisionAt",
  "canonicalSourceMatchId(publicRecord.sourceMatchId) === canonicalSourceMatchId(match.sourceMatchId || match.id)",
  "recordedAt <= now && decisionAt <= recordedAt && recordedAt < recordCutoffAt",
  "marketClockState(match, lockedFiveHundredCandidate.sourceUpdatedAt, now) === 'fresh'",
  "retainLockedPreCutoffReference",
  "isPredictionOfficialResultPoolAvailable(match, storedBest)",
  "source: 'official-calibrated-market'",
  "source: 'five-hundred-market'",
  "source: 'official-market-consensus'",
  "source: 'strong-model'",
  "source: 'model-only'",
  "source: 'model-low-evidence'",
  "'official-low-evidence-market'",
  "'five-hundred-low-evidence-market'",
  "buildLowEvidenceMarketLeaderReference(",
  "buildStableLowEvidenceModelReference(match, storedBest, now)",
  "market probability leader cannot overwrite the model probability leader",
  "OFFICIAL_MARKET_REFERENCE_MIN_LEADER_PROBABILITY = 0.55",
  "OFFICIAL_MARKET_REFERENCE_MIN_LEADER_GAP = 0.08",
  "leader.probability < OFFICIAL_MARKET_REFERENCE_MIN_LEADER_PROBABILITY",
  "leader.probability - runnerUp.probability < OFFICIAL_MARKET_REFERENCE_MIN_LEADER_GAP",
  "if (strongOppositeModel) return undefined",
  "displayOdds: null",
  "const poolCode = modelProbabilities ? 'HAD' : canonicalReferencePool(match, candidate)",
  "const probabilityLeader = modelOutcomeLeader(modelProbabilities, match.id)",
  "handicapDirectionLabel(tipCode)",
  "odds: 0"
]) && referenceSelectionOrderValues.every((value) => value >= 0)
  && referenceSelectionOrderValues.every((value, index) => index === 0 || value > referenceSelectionOrderValues[index - 1])
  && hasAll(analysisReferenceEligibility, [
    "DIRECTIONAL_REFERENCE_MIN_EVIDENCE_SCORE = 52",
    "DIRECTIONAL_REFERENCE_MIN_MODEL_GAP = 0.03",
    "DIRECTIONAL_REFERENCE_MIN_EXPECTED_VALUE = -0.01",
    "DIRECTIONAL_REFERENCE_MIN_DATA_QUALITY = 0.50",
    "supportingFactors.length >= 3",
    "evidence?.diagnostics?.scoreAligned === true",
    "!hasHardBlocker",
    "posterior?.selectedMarket === 'MODEL_ONLY_1X2'",
    "model?.inputSufficiency?.sufficient === true"
]) && hasAll(externalReferencePresentation, [
  "recommendationAction: 'reference'",
  "odds: 0",
  "FIVE_HUNDRED_REFERENCE_MAX_AGE_MS",
  "独立复盘统计"
]) && !analysisReferenceSelection.includes("recommendationAction: 'recommend'"), {
  referenceSelectionOrder
});

const detailPrimarySelectionStart = matchDetail.indexOf("const canonicalPublishedRecommendation");
const detailPrimarySelectionEnd = matchDetail.indexOf("const isFormalPrimaryRecommendation", detailPrimarySelectionStart);
const detailPrimarySelection = matchDetail.slice(detailPrimarySelectionStart, detailPrimarySelectionEnd);
const detailCanonicalOrder = indexMap(detailPrimarySelection, [
  "const canonicalPublishedRecommendation = rawDisplayRecommendation",
  "const detailAnalysisReferenceSelection = !isResultPhase && !canonicalPublishedRecommendation",
  "const canonicalPreMatchPrediction = canonicalPublishedRecommendation?.prediction",
  "|| archivedPreMatchPrediction",
  "|| analysisReferencePrediction;",
  "const archivedOutcomeFallback = isResultPhase",
  "const primaryOutcomePrediction = isPreMatchRecordSettling",
  "|| canonicalPreMatchPrediction",
  "|| archivedOutcomeFallback;"
]);
const detailCanonicalOrderValues = Object.values(detailCanonicalOrder);
const detailRawPrimaryStart = matchDetail.indexOf("const rawPrimaryOutcomePrediction");
const detailRawPrimaryEnd = matchDetail.indexOf("const handicapOverridePrediction", detailRawPrimaryStart);
const detailRawPrimarySelection = matchDetail.slice(detailRawPrimaryStart, detailRawPrimaryEnd);
pushCheck("list card and detail overview share the same canonical BEST decision", hasAll(matchDetail, [
  "import { selectOnSaleAnalysisReference } from '../services/analysisReferenceSelection';",
  "const detailAnalysisReferenceSelection = !isResultPhase && !canonicalPublishedRecommendation",
  "allowModelOnly: true",
  "const detailAnalysisCandidate = rawDisplayRecommendation?.prediction;",
  "candidate: detailAnalysisCandidate",
  "now: nowMs",
  "const analysisReferencePrediction = detailAnalysisReferenceSelection?.prediction;",
  "const archivedPreMatchPrediction = getArchivedPreMatchPrediction(match, nowMs);",
  "|| archivedPreMatchPrediction\n    || analysisReferencePrediction;",
  "Publication risk may downgrade how a direction is labelled",
  "HAD/HHAD rows below remain independent market analysis and must never replace it."
]) && detailCanonicalOrderValues.every((value) => value >= 0)
  && detailCanonicalOrderValues.every((value, index) => index === 0 || value > detailCanonicalOrderValues[index - 1])
  && detailRawPrimarySelection.indexOf("bestOutcomePrediction && isOutcomeTipCode(bestOutcomePrediction.tipCode)")
    < detailRawPrimarySelection.indexOf("isOutcomeTipCode(oneXTwoPrediction?.tipCode)")
  && !detailPrimarySelection.includes("|| rawDisplayRecommendation?.prediction")
  && !detailPrimarySelection.includes("|| fiveHundredMarketReference?.prediction")
  && !detailPrimarySelection.includes("|| displayRecommendation?.prediction\n      || rawDisplayRecommendation?.prediction"), {
  detailCanonicalOrder
});

const rowStart = predictions.indexOf("const renderMatchRow =");
const rowEnd = predictions.indexOf("const quickDateOptions =", rowStart);
const rowSource = predictions.slice(rowStart, rowEnd);
pushCheck("reference directions remain visible and never become unavailable or formal by default", hasAll(rowSource, [
  "const pickedPrediction = reviewPrediction || displayRecommendation?.prediction || archivedPreMatchPrediction || analysisReference",
  "const isReferencePick = Boolean(",
  "(!isFinished && !displayRecommendation && analysisReference)",
  "const hasPick = !isVoid && Boolean(pickedPrediction && directionLabel)",
  "hasPick ? directionLabel", "'暂无推荐' : 'No pick'",
  "isFormal ? 'is-formal' : 'is-reference'",
  "'正式' : 'Formal'", "'参考' : 'Reference'",
  "forceReference: isReferencePick"
]));

pushCheck("reference prices retain their selected SP without exposing the provider", hasAll(rowSource, [
  "const fiveHundredDisplayOdds = fiveHundredPresentation?.reference.selectedSourceOdds",
  "analysisReferenceSelection.displayOdds",
  "fiveHundredDisplayOdds && fiveHundredDisplayOdds > 1 ? fiveHundredDisplayOdds.toFixed(2)",
  'odds={<><strong className="compact-sp">{sp}</strong>',
  'className="compact-sp-note"', "'推荐方向' : 'Selected pick'"
]) && !rowSource.includes("'500.com reference odds'") && !rowSource.includes("500数据推荐"));

const directReferenceListStart = bestTips.indexOf('<div className="best-pool-v4__rows is-formal-list">');
const directReferenceList = bestTips.slice(directReferenceListStart);
const tipCardsStart = bestTips.indexOf('const tipCards = React.useMemo<TipCard[]>');
const dataCardsStart = bestTips.indexOf('const observationCards = React.useMemo<ObservationCard[]>', tipCardsStart);
const featuredCardsStart = bestTips.indexOf('const featuredMatchIds = React.useMemo', dataCardsStart);
const translationsStart = bestTips.indexOf('const translations =', featuredCardsStart);
const tipCardsSelection = bestTips.slice(tipCardsStart, dataCardsStart);
const dataCardsSelection = bestTips.slice(dataCardsStart, featuredCardsStart);
const featuredCardsSelection = bestTips.slice(featuredCardsStart, translationsStart);
pushCheck("best tips renders every data pick and limits only the featured marker to three", directReferenceListStart >= 0
  && hasAll(bestTips, [
    "const getCleanPickLabel = (prediction: PredictionDetail, language: Language)",
    "pickLabel: getCleanPickLabel(prediction, language)",
    "tipCards.length === 0 && observationCards.length === 0",
    "tipCards.length + observationCards.length",
    "observation: { zh: '数据推荐', en: 'Data pick' }",
    "blockers: { zh: '推荐依据', en: 'Pick basis' }",
    "reference.source === 'official-market-consensus'",
    "官方去水市场首位达到数据推荐门槛；独立复盘",
    "全部赛前推荐 · 重点 3 场",
    "市场去水概率 ${probabilityLabel} · 证据等级低",
    "saleClosed: boolean",
    "售卖已截止；仅保留截止前锁定数据，不可执行",
    "截止前锁定 · 不可执行",
    "已锁定数据推荐"
  ])
  && hasAll(directReferenceList, [
    "{tipCards.map((card) => {",
    "{observationCards.map((card) => {",
    'key={`reference-${match.id}',
    'className="best-pool-v4__row is-observation"',
    "card.referenceSource === 'official-market-consensus'",
    "官方市场数据推荐"
  ])
  && !tipCardsSelection.includes(".slice(0, 3)")
  && !dataCardsSelection.includes("remainingSlots")
  && hasAll(featuredCardsSelection, [
    "[...tipCards, ...observationCards]",
    ".slice(0, 3)"
  ])
  && !bestTips.includes("card.evidenceScore ?? Number(prediction.trustScore || 0)")
  && !bestTips.includes("<details")
  && !bestTips.includes("观察")
  && !bestTips.includes("if (tipCards.length > 0) return []"));

const rollingDayContract = hasAll(predictions, [
  "const hasFreshListReturnScroll =",
  "const restoreReturnView = React.useMemo(() => hasFreshListReturnScroll(viewMode), [viewMode])",
  "const previousTodayRef = React.useRef(todayStr)",
  "setSelectedDate((current) => current === previousToday ? todayStr : current)",
  "const filteredMatches = baseFilteredMatches",
  "const directionShownCount = recommendationCounts.home + recommendationCounts.draw + recommendationCounts.away"
]) && !predictions.includes("signal-quick-filter") && !predictions.includes("signalFilter");
pushCheck("analysis always opens on the complete day and rolls forward across midnight", rollingDayContract || hasAll(predictions, [
  "const hasFreshListReturnScroll =",
  "const restoreReturnView = React.useMemo(() => hasFreshListReturnScroll(viewMode), [viewMode])",
  "const previousTodayRef = React.useRef(todayStr)",
  "setSelectedDate((current) => current === previousToday ? todayStr : current)",
  "const filteredMatches = baseFilteredMatches"
]) && !predictions.includes("有方向")
  && !predictions.includes("signal-quick-filter")
  && !predictions.includes("signalFilter"));

pushCheck("fixtures keeps the full schedule in the selected sort order", hasAll(predictions, [
  "const filteredMatches = baseFilteredMatches",
  "const sorted = [...filteredMatches]",
  "comparison = new Date(a.kickoffTime).getTime() - new Date(b.kickoffTime).getTime()"
]) && !predictions.includes("if (aHasDirection !== bHasDirection)"));

pushCheck("every row renders market odds separately from direction, SP and archived results", rowStart >= 0
  && hasAll(predictions, ["group.matches.map(renderMatchRow)", "getArchivedPreMatchPrediction(match, nowMs)"])
  && hasAll(rowSource, ["pick={<div", "odds={<><strong", "result={<span",
    "marketOdds={<MatchMarketOdds match={match} language={language} capturedData={capturedDataByMatchId?.[match.id]} />}"])
  && hasAll(matchSummaryRow, [
    "pick: ReactNode", "odds: ReactNode", "result: ReactNode", "marketOdds: ReactNode",
    'className="predictions-v4__match-slot is-market-odds"', "{marketOdds}",
    'className="predictions-v4__match-slot is-pick"',
    'className="predictions-v4__match-slot is-sp"',
    'className="predictions-v4__match-slot is-result"', "{pick}", "{odds}", "{result}"
  ]) && !matchSummaryRow.includes("showDecision &&"));

pushCheck("public diagnostics do not reuse observation wording for stale or risky states",
  !predictions.includes("language === 'zh' ? '观察' : 'Watch'")
  && !predictions.includes("个观察信号")
  && !predictions.includes("language === 'zh' ? '观察' : 'watch'"));

const filterDetailsStart = predictions.indexOf('<details className="panel filters-panel filters-details"');
const filterDetailsEnd = predictions.indexOf("</details>", filterDetailsStart);
const filterDetails = predictions.slice(filterDetailsStart, filterDetailsEnd);
pushCheck("filters are keyboard-accessible and collapsed by default", filterDetailsStart >= 0
  && !filterDetails.slice(0, filterDetails.indexOf(">") + 1).includes(" open")
  && hasAll(filterDetails, [
    '<summary className="filters-summary">',
    "筛选与排序",
    "filteredMatches.length",
    "filterLeagueSummary"
  ]) && hasAll(css, [
    ".filters-panel.filters-details",
    ".filters-details:not([open]) > .filters-details-body",
    ".filters-summary",
    "min-height: 42px"
  ]), {
  filterDetailsStart,
  filterDetailsEnd
});

const sportteryMetaStart = predictions.indexOf("const getSportteryMeta");
const kickoffLabelEnd = predictions.indexOf("const hasOfficialScore", sportteryMetaStart);
const compactDateHelpers = predictions.slice(sportteryMetaStart, kickoffLabelEnd);
pushCheck("fixture rows avoid repeated dates but preserve cross-midnight kickoff context", hasAll(compactDateHelpers, [
  "match.matchNo || ''", "sportteryDay === kickoffDay", "formatShortDate(kickoffDay, language)",
  "getCrossDayKickoffLabel(match, language) || formatKickoffTime(match.kickoffTime, language)",
  "timeZone: 'Asia/Shanghai'"
]) && !["竞彩日", "开赛日", "归档"].some(needle => compactDateHelpers.includes(needle)));

const teamsCellStart = rowSource.indexOf("teams={");
const pickCellStart = rowSource.indexOf("pick={", teamsCellStart);
const teamsCell = rowSource.slice(teamsCellStart, pickCellStart);
pushCheck("semantic compact rows reserve team slots for teams and keep details keyboard-accessible", teamsCellStart >= 0
  && hasAll(matchSummaryRow, [
    "<article", 'className="match-teams-cell predictions-v4__match-slot is-teams"',
    'className="details-button"', 'type="button"', "event.stopPropagation();", "onOpen();"
  ]) && !matchSummaryRow.includes("onClick={onOpen}")
  && !["待开售", "Pending sale", "match-signal-line", "signal-badge", "RecommendationEvidenceFacts"].some(needle => teamsCell.includes(needle))
  && hasAll(rowSource, ["detailsAriaLabel=", "onOpen={() => onSelectMatch(match.id)}", "'暂无推荐' : 'No pick'"]));

const liveArchiveFallbackStart = rowSource.indexOf("const isInPlayArchiveFallback = match.status === 'LIVE'");
const archivePickedPredictionStart = rowSource.indexOf("const pickedPrediction = reviewPrediction", liveArchiveFallbackStart);
const fallbackDecisionStart = rowSource.indexOf("const hasPick =", archivePickedPredictionStart);
pushCheck("live rows retain immutable pre-match direction and recorded SP before no-pick fallback", liveArchiveFallbackStart >= 0
  && archivePickedPredictionStart > liveArchiveFallbackStart && fallbackDecisionStart > archivePickedPredictionStart
  && hasAll(rowSource, [
    "&& !displayRecommendation && Boolean(archivedPreMatchPrediction)",
    "reviewPrediction || displayRecommendation?.prediction || archivedPreMatchPrediction || analysisReference",
    "archivedPreMatchPrediction?.recommendationAction === 'recommend'",
    "isFinished || isInPlayArchiveFallback ? (recordedOdds > 1 ? recordedOdds.toFixed(2) : '--')"
  ]) && hasAll(archivedPreMatchPrediction, [
    "archive.source === 'immutable-pre-match-prediction-snapshot'",
    "archivedSourceMatchId === matchSourceMatchId", "archivedAt < kickoffAt",
    "archivedAt <= archiveDeadlineAt", "archivedEventAt === matchEventAt",
    "archivedPrediction?.marketType === 'BEST'"
  ]), { liveArchiveFallbackStart, archivePickedPredictionStart, fallbackDecisionStart });

pushCheck("selected SP stays bound to its direction and HHAD line without promoting companion picks", hasAll(predictions, [
  "prediction.oddsPoolCode === 'HHAD' ? official.hhad?.odds : official.had?.odds",
  "!sameHandicapLine(prediction.handicapLine, official.hhad?.handicap)",
  "!sameHandicapLine(prediction.handicapLine, resolved.hhad?.handicap)",
  "prediction.tipCode === '1' ? odds?.odds1 : prediction.tipCode === 'X' ? odds?.oddsX : odds?.odds2",
  "const isPublishedReferenceSpUnavailable =",
  "isVoid || !pickedPrediction || isPublishedReferenceSpUnavailable ? '--'",
  "companion: undefined"
]) && hasAll(displayRecommendation, [
  "recommendationAction: 'reference'", "recommendationTier: 'handicap-companion-bound'",
  "const companion = companionAudit.status === 'bound'"
]) && !rowSource.includes("Math.min(") && !rowSource.includes("companion?.prediction"));

pushCheck("empty dates do not inherit historical leagues", !predictions.includes("import { leagues") && hasAll(predictions, [
  "const matchesForDate = matches.filter((match) => matchBelongsToDate(match, effectiveSelectedDate))",
  "return matchesForDate.reduce<League[]>",
  "{baseFilteredMatches.length > 0 && (",
  "{availableLeagues.length > 0 && ("
]), {
  importsStaticLeagues: predictions.includes("import { leagues")
});

pushCheck("historical empty state waits for the history lane", hasAll(predictions, [
  "effectiveSelectedDate < todayStr && dataSync.historyLoading && !dataSync.historyLoaded",
  "const emptyStateText = isLoading", "'比赛加载中…' : 'Loading matches…'",
  "groupedMatches.length === 0", "<p>{emptyStateText}</p>"
]));

const evidenceTabStart = matchDetail.indexOf("{activeTab === 'evidence' && (");
const evidenceTabEnd = matchDetail.indexOf("{activeTab === 'history' && (", evidenceTabStart);
const evidenceTab = matchDetail.slice(evidenceTabStart, evidenceTabEnd);
const overviewTabStart = matchDetail.indexOf("{activeTab === 'overview' && (");
const overviewTab = matchDetail.slice(overviewTabStart, evidenceTabStart);
pushCheck("detailed evidence belongs to the match analysis tab and is absent from list and overview", evidenceTabStart >= 0
  && evidenceTabEnd > evidenceTabStart && overviewTabStart >= 0
  && hasAll(evidenceTab, [
    'data-section="evidence"', "<RecommendationEvidenceFacts", "match={match}",
    "prediction={primaryOutcomePrediction || primaryPostReviewPrediction}", 'className="is-detail"',
    "数据与分析", "确认首发、预计阵容和模型估计各按实际状态展示"
  ]) && !overviewTab.includes("<RecommendationEvidenceFacts")
  && (matchDetail.match(/<RecommendationEvidenceFacts\b/g) || []).length === 1
  && !predictions.includes("RecommendationEvidenceFacts"));

pushCheck("daily review retains separate formal, live, reference BEST and analysis denominators", hasAll(predictions, [
  "row.recommendationAction === 'recommend'", "row.reviewRole === 'main'", "row.performanceTrack === 'formal'",
  "isSettledReviewStatus(row.resultStatus)", "row?.performanceTrack === 'live-model'",
  "const formalBestRow = settledRows.find((row) => isFormalReviewRow(row) && row.marketType === 'BEST')",
  "const liveBestRow = settledRows.find((row) => isLiveReviewRow(row) && row.marketType === 'BEST')",
  "const referenceBestRow = analysisRows.find((row) => row.marketType === 'BEST')",
  "acc.analysisSettled += analysisRows.length",
  "const provisionalOutcome = !hasSettledReview ? getProvisionalArchivedOutcome(match, now) : null",
  "acc.provisionalReferenceSettled += 1",
  "stats.formalWon / stats.formalSettled", "stats.liveWon / stats.liveSettled",
  "stats.referenceBestWon / stats.referenceBestSettled", "stats.analysisWon / stats.analysisSettled",
  "stats.provisionalReferenceWon / stats.provisionalReferenceSettled",
  "参考、待赛果与作废场次不计入正式命中率。"
]) && !/formal(?:Won|Settled)\s*\+\s*(?:(?:stats|acc|dailyReviewStats)\.)?(?:live|reference|analysis|provisional|candidate)/.test(predictions));

const dailyReviewPanelCssStart = predictionsCss.indexOf(".predictions-compact .compact-record {");
const dailyReviewPanelCssEnd = predictionsCss.indexOf("}", dailyReviewPanelCssStart);
const dailyReviewPanelCss = predictionsCss.slice(dailyReviewPanelCssStart, dailyReviewPanelCssEnd);
pushCheck("compact settled summary wraps its independent counters at narrow widths", dailyReviewPanelCssStart >= 0
  && hasAll(dailyReviewPanelCss, ["display: flex;", "flex-wrap: wrap;", "align-items: center;"])
  && !dailyReviewPanelCss.includes("white-space: nowrap"));

pushCheck("date chips use only the Sporttery business-day scope", hasAll(predictions, [
  "const sportteryDay = getSportteryDay(match);",
  "return sportteryDay ? [sportteryDay] : [];",
  'data-date-scope="sporttery-business-date"',
  "按竞彩业务日归档；跨午夜比赛只计入原竞彩日。"
]) && !predictions.includes("kickoffDay,\n    sportteryDay"));

pushCheck("date navigation opens the nearest available match day and stays user-controlled", hasAll(predictions, [
  "automaticInitialDateResolved",
  "const nearestUpcomingDate = availableDates.find((date) => date >= todayStr)",
  "const nearestAvailableDate = nearestUpcomingDate || nearestRecentDate",
  "setAutomaticInitialDateResolved(true)",
  "onSelectDate={handleDateSelect}"
]) && hasAll(personalReview, [
  "<DateScopeBar",
  "quickReviewDates",
  "olderReviewDates",
  "更多复盘日期",
  "dailyReviewBucket(formalReviewPerformance, activeReviewDate)",
  "dailyReviewBucket(referenceReviewPerformance, activeReviewDate)",
  "validReviewBucket(formalReviewPerformance?.cumulative)",
  "validReviewBucket(referenceReviewPerformance?.cumulative)",
  "formatHitRate(bucket)",
  'data-review-denominator="one-frozen-best-per-match"'
]));

const emptyAudit = buildHitRateAudit();
const settledAudit = buildHitRateAudit({ metrics: { settled: 2, won: 1, lost: 1 } });
pushCheck("formal sample gates survive removal of the model scorecard", emptyAudit.minimumSettledRows === 500
  && emptyAudit.sampleReady === false && emptyAudit.observed.hitRate === null
  && settledAudit.observed.hitRate === 0.5 && settledAudit.sampleReady === false
  && hasAll(predictions, ["stats.formalSettled > 0", "stats.formalWon / stats.formalSettled", "row.performanceTrack === 'formal'"])
  && !predictions.includes("scorecardSample") && !predictions.includes("benchmarkShadowMetrics"));

pushCheck("publication samples exclude candidate, live and reference rows even without ledger dashboards",
  emptyAudit.denominatorPolicy.includes("formal-publication-ledger-only")
  && emptyAudit.denominatorPolicy.includes("reference-live-and-analysis-tracks-excluded")
  && hasAll(predictions, ["!isFormalReviewRow(row)", "!isLiveReviewRow(row)", "row.recommendationAction === 'reference'"])
  && !predictions.includes("candidateFormalSettled") && !predictions.includes("hitRateAuditSettled"));

pushCheck("fixture header reports only the selected date and filter count", hasAll(predictions, [
  "matches.filter((match) => matchBelongsToDate(match, effectiveSelectedDate))",
  "baseFilteredMatches.length + (language === 'zh' ? ' 场比赛' : ' matches')",
  "查看比赛赔率、推荐方向、SP 与赛后结果"
]) && !predictions.includes("场方向已显示") && !predictions.includes("directions shown")
  && !predictions.includes("predictions-v4__evidence-snapshot"));

pushCheck("missing rates and analysis facts stay unavailable instead of becoming zero", emptyAudit.observed.hitRate === null
  && emptyAudit.observed.interval95.lower === null && emptyAudit.observed.interval95.upper === null
  && emptyAudit.observed.brier === null && emptyAudit.observed.logLoss === null
  && hasAll(predictions, ["const formatDailyRate =", "value === null ?", "'无样本' : 'N/A'"])
  && hasAll(evidenceFacts, ["breakdown.modelProbability === null", "formatEvidenceCompleteness(breakdown, '--')",
    "formatFreshnessQuality(breakdown, '--')", "formatCalibrationSample(breakdown, '--')", "观测时间未知"]));

pushCheck("80 percent remains an unverified audit target and never a public performance claim",
  emptyAudit.targetRate === 0.8 && emptyAudit.externalBenchmark.verificationStatus === "unverified-external-claim"
  && emptyAudit.externalBenchmark.usableAsTrainingLabel === false
  && emptyAudit.publicationPolicy.immutableLedgerRequired === true
  && emptyAudit.publicationPolicy.appendOnlySettlementRequired === true
  && emptyAudit.publicationPolicy.completeWinsAndLossesRequired === true
  && emptyAudit.publicationPolicy.postCutoffMutationForbidden === true
  && emptyAudit.denominatorPolicy.includes("pre-match-frozen-before-cutoff")
  && emptyAudit.denominatorPolicy.includes("settled-non-void-only")
  && emptyAudit.denominatorPolicy.includes("no-retrospective-row-deletion")
  && !predictions.includes("80%") && !predictions.includes("benchmark-hit-rate-audit"));

const shadowSelection = evaluateBenchmarkSelection({ marketType: "BEST", oddsPoolCode: "HAD", tipCode: "1", odds: 1.5, trustScore: 70 });
pushCheck("benchmark cohort stays shadow-only and cannot promote formal recommendations",
  shadowSelection.qualified === true && shadowSelection.role === "shadow-only" && shadowSelection.formalOnlineEffect === false
  && GOODWIN_BENCHMARK_SHADOW_POLICY.minimumSettledRowsForPromotionReview >= 200
  && GOODWIN_BENCHMARK_SHADOW_POLICY.minimumChronologicalFolds >= 6
  && GOODWIN_BENCHMARK_SHADOW_POLICY.hitRateDisclosureOnly === true
  && !predictions.includes("benchmark-shadow-track"));

pushCheck("candidate audit still requires its immutable chain and complete decision/settlement pair",
  completeCandidateAudit({ chainValid: false, decisionRecord: {}, settlementRecord: {}, cohort: {}, candidateRevisionId: "sample" }) === false
  && completeCandidateAudit({ chainValid: true, decisionRecord: {}, cohort: {}, candidateRevisionId: "sample" }) === false
  && completeCandidateAudit({ chainValid: true, decisionRecord: {}, settlementRecord: {}, cohort: {}, candidateRevisionId: "sample" }) === true
  && hasAll(publicationLedger, ['"previousRecordHash"', '"recordHash"', '"evidenceHash"', '"featureHash"', '"publication-after-cutoff"', '"record-hash-mismatch"'])
  && !predictions.includes("candidate-prospective-ledger"));

pushCheck("historical dates keep pending/void rows out of won/lost results and formal rates", hasAll(predictions, [
  "if (isResultPhase) acc.resultPhaseFixtures += 1", "else acc.notYetResultPhase += 1",
  "else if (isResultPhase)", "acc.awaitingOfficial += 1",
  "const settledStatus = isFinished && reviewRow && isSettledReviewStatus(reviewRow.resultStatus) ? reviewRow.resultStatus : undefined",
  "const resultLabel = isVoid ?", "'已作废' : 'Void'", "'待赛果' : 'Pending result'",
  "参考、待赛果与作废场次不计入正式命中率。"
]) && !rowSource.includes("getProvisionalArchivedOutcome("));

const bannedListPanels = [
  "source-health-panel", "model-governance-panel", "benchmark-audit-panel", "predictions-v4__evidence-snapshot",
  "RecommendationEvidenceFacts", "recommendation-evidence-breakdown", "data-sync-strip", "model-scorecard"
];
pushCheck("main list contains no collection/source/model/evidence dashboard", bannedListPanels.every(needle => !predictions.includes(needle)), {
  forbiddenPanelsFound: bannedListPanels.filter(needle => predictions.includes(needle))
});
const providerBindings = /(?:href\s*=\s*\{[^}]*source(?:Url|Path)|\{\s*(?:match|row|source)\.(?:sourceUrl|sourcePath)\s*\})/i;
pushCheck("source addresses are excluded from list bindings and neutralized in detail text",
  !providerBindings.test(predictions) && !providerBindings.test(matchDetail)
  && hasAll(matchDetail, ["const displayText =", "formatSourceNeutralText(value, language, fallback)"])
  && hasAll(sourceNeutralText, ["Presentation only: never pass the result back", "sourceUrl|source_url|sourcePath|source_path"])
  && hasAll(evidenceFacts, ["formatSourceNeutralText(formatMarketConsistency("]));

pushCheck("compact semantic rows expose the first fixture near the first viewport", hasAll(predictions, [
  "<PredictionsPageHeader",
  "<DateScopeBar",
  "<MatchSummaryRow",
  'className="league-stack"'
]) && !predictions.includes("<table") && hasAll(predictionsCss, [
  ".predictions-v4 .dashboard-hero.is-compact",
  ".predictions-v4__page-header",
  ".predictions-v4__match-row",
  ".predictions-v4__match-action .details-button",
  "@media (max-width: 768px)",
  "@media (max-width: 480px)",
  "grid-template-columns: minmax(104px, 0.72fr) minmax(0, 1.28fr);",
  "grid-template-columns: minmax(0, 1.12fr) minmax(118px, 0.88fr);"
]) && !predictionsCss.includes("!important") && !predictionsCss.includes(":has("));

const ok = checks.every((check) => check.ok);
console.log(JSON.stringify({
  ok,
  checkedAt: new Date().toISOString(),
  summary: {
    total: checks.length,
    passed: checks.filter((check) => check.ok).length,
    failed: checks.filter((check) => !check.ok).length,
    duplicateRecommendationMarkers,
    strictHelperUses
  },
  checks
}, null, 2));

if (!ok) process.exitCode = 1;
