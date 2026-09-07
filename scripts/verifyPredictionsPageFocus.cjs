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

const tieredRouteContract = hasAll(app, [
  '<PredictionsList viewMode="analysis" onSelectMatch={selectMatch} />',
  '<PredictionsList viewMode="fixtures" onSelectMatch={selectMatch} />'
]) && hasAll(predictions, [
  "const isAnalysisView = viewMode === 'analysis'",
  "const isFixturesView = viewMode === 'fixtures'",
  'const referenceTierCount = recommendationCounts.reference + recommendationCounts.live',
  'const directionShownCount = recommendationCounts.home + recommendationCounts.draw + recommendationCounts.away',
  'className="predictions-v4__evidence-snapshot"',
  'className="predictions-v4__snapshot-item is-tiers"',
  'className="predictions-v4__snapshot-item is-directions"',
  'className="predictions-v4__snapshot-item is-sp"',
  'className="predictions-v4__snapshot-item is-gaps"',
  "const poolRows = isFixturesView",
  "? getSportteryPoolRows(match, language).filter((row) => row.odds)"
]);

pushCheck("analysis and fixtures routes render distinct content modes", tieredRouteContract || hasAll(app, [
  '<PredictionsList viewMode="analysis" onSelectMatch={selectMatch} />',
  '<PredictionsList viewMode="fixtures" onSelectMatch={selectMatch} />'
]) && hasAll(predictions, [
  "viewMode: 'analysis' | 'fixtures'",
  "const isAnalysisView = viewMode === 'analysis'",
  "const isFixturesView = viewMode === 'fixtures'",
  "'赛前分析' : 'Pre-match Analysis'",
  "'赛程与官方赔率' : 'Fixtures and Official Odds'",
  'to="/predictions"',
  "const marketSelection = getListMarketSelection(",
  "publishedRecommendation,\n                    nowMs,\n                    true\n                  );",
  "const poolRows = isFixturesView",
  "? getSportteryPoolRows(match, language).filter((row) => row.odds)",
  "const publishedRecommendation = isVoid",
  "? null",
  ": getOnSaleDisplayRecommendation(match, language, nowMs) || getLiveDisplayRecommendation(match, language)",
  "const archivedPrediction = getArchivedPreMatchPrediction(match, now)",
  "|| Boolean(archivedPrediction)",
  "prediction = predictionFromReviewRow(reviewRow) || archivedPrediction",
  "The selector already enforces SCHEDULED state, kickoff, cutoff, and",
  "所有可用推荐直接标记方向",
  "const marketSelectionSummary = marketSelection",
  "const dualMarketSelectionSummary =",
  "数据推荐：${dualMarketSelectionSummary || marketSelectionSummary}",
  "const rowOutcomeLabel = rowSelection",
  "getSelectionToneLabel(selectionTone, language)} · ${rowOutcomeLabel}",
  "${recommendationCounts.reference} data references",
  "场方向已显示"
]) && predictions.includes('className="daily-review-panel is-compact is-priority"')
  && predictions.includes('effectiveSelectedDate < todayStr')
  && predictions.includes("{isAnalysisView && (\n      <details\n        className={`model-governance-panel system-model-details"), {
  analysisRouteMode: app.includes('<PredictionsList viewMode="analysis"'),
  fixturesRouteMode: app.includes('<PredictionsList viewMode="fixtures"'),
  fixturesUsesOfficialPoolsOnly: predictions.includes("? getSportteryPoolRows(match, language).filter((row) => row.odds)")
});

pushCheck("initial cutover loading never presents a false zero-match conclusion", hasAll(predictions, [
  'const headerDataPending = !dataSync.currentLoaded && baseFilteredMatches.length === 0',
  'const headerDataRecovering = headerDataPending && Boolean(',
  "? (language === 'zh' ? '赛程恢复中' : 'Schedule recovering')",
  ": (language === 'zh' ? '赛程加载中' : 'Loading schedule')",
  '正在自动重试赛程与推荐数据，不以 0 场作为结论',
  'matchSummary={headerMatchSummary}',
  'secondarySummary={headerSecondarySummary}'
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
  'className="daily-review-panel is-compact is-priority"',
  'className="league-stack"',
  'className="notice-banner is-compact"',
  'className={`source-health-panel',
  'className={`model-governance-panel system-model-details'
]);
const orderValues = Object.values(coreOrder);
pushCheck("predictions puts historical result summary before archived fixtures", orderValues.every((value) => value >= 0)
  && orderValues.every((value, index) => index === 0 || value > orderValues[index - 1]), {
  order: coreOrder
});

const onSaleHelperStart = predictions.indexOf("const getOnSaleDisplayRecommendation");
const componentStart = predictions.indexOf("export const PredictionsList", onSaleHelperStart);
const onSaleHelper = predictions.slice(onSaleHelperStart, componentStart);
const strictHelperUses = (predictions.match(/getOnSaleDisplayRecommendation\(/g) || []).length;
const tieredDisplayContract = hasAll(predictions, [
  "getOnSaleDisplayRecommendation(match, language, nowMs) || getLiveDisplayRecommendation(match, language)",
  "displayRecommendation.publicationTrack === 'live'",
  'const watchDirectionPrediction = !isFinished',
  "has-watch-direction",
  "if (!isReview) return null"
]);
pushCheck("formal picks require current SP while published live picks retain publication SP", tieredDisplayContract || hasAll(onSaleHelper, [
  "match.status !== 'SCHEDULED'",
  "getBestPrediction(match)",
  "isPredictionOfficialResultPoolAvailable(match, storedBest)",
  "getOfficialPredictionOdds(match, storedBest)",
  "getOfficialPredictionHandicapLine(match, storedBest)",
  "prediction: eligiblePrediction"
]) && strictHelperUses >= 2 && hasAll(predictions, [
  "getOnSaleDisplayRecommendation(match, language, nowMs) || getLiveDisplayRecommendation(match, language)",
  "displayRecommendation.publicationTrack === 'live'",
  "场推荐 / ${recommendationCounts.formal + recommendationCounts.live} 场正式或实时",
  "模型证据仍不足，本场暂不强行给方向",
  "赔率与可审计输入不足，暂不能形成可靠推荐。",
  "if (!isReview) return null"
]) && hasAll(displayRecommendation, [
  "const publishedLiveOdds = Number(promotedPrediction.livePublicationEvidence?.officialSp)",
  "odds: publishedOdds",
  "publicationTrack === 'formal' && isHandicapMarketContradicted"
]) && !predictions.includes("推荐SP"), {
  strictHelperUses
});

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
pushCheck("analysis gives every normal fixture a separately-accounted data direction", hasAll(predictions, [
  "getOnSaleAnalysisReference as selectAnalysisReferencePrediction",
  "selectOnSaleAnalysisReference",
  ") => selectAnalysisReferencePrediction(match, options);",
  "allowModelOnly: true",
  "candidate: rawDisplayRecommendation?.prediction",
  "const analysisReference = analysisReferenceSelection?.prediction",
  "now: nowMs",
  "data picks",
  "formatReferenceTime(",
  "no official SP is on sale",
  "const nowMs = clockNow",
  "getReferencePredictionOdds(match, pickedPrediction, language)",
  "500数据推荐",
  "500去水概率"
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
  "if (!isBeforeMatchSaleCutoff(match, now))",
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

const recommendationCountsStart = predictions.indexOf("const recommendationCounts = useMemo");
const fixtureCountsStart = predictions.indexOf("const fixtureMarketCounts = useMemo", recommendationCountsStart);
const recommendationCountsSource = predictions.slice(recommendationCountsStart, fixtureCountsStart);
pushCheck("reference picks count as recommendations and never inflate unavailable", hasAll(recommendationCountsSource, [
  "const analysisReference = displayRecommendation ? undefined : getOnSaleAnalysisReference(match, {",
  "allowModelOnly: true",
  "const archivedPrediction = getArchivedPreMatchPrediction(match, nowMs)",
  "if (isVoid || signal.category === 'finished' || archivedPrediction)",
  "if (!isVoid && archivedPrediction)",
  "counts.recommended += 1",
  "counts.reference += 1",
  "if (displayRecommendation || analysisReference) counts.recommended += 1",
  "else if (analysisReference) counts.reference += 1",
  "if (!displayRecommendation && !analysisReference) counts.unavailable += 1"
]) && !recommendationCountsSource.includes("if (!displayRecommendation) counts.unavailable += 1"));

pushCheck("500 data-pick cards show their labelled reference price instead of pending sale", hasAll(predictions, [
  "const fiveHundredDisplayOdds = fiveHundredPresentation?.reference.selectedSourceOdds",
  "'500.com reference odds'",
  "`SP ${fiveHundredDisplayOdds.toFixed(2)}`"
]));

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

pushCheck("fixtures render a decision for every row and keep archived decisions visible", hasAll(predictions, [
  "decision={isAnalysisView || isFixturesView || isArchived",
  "? renderDecisionCell(match, publishedRecommendation)",
  ": undefined}"
]) && hasAll(matchSummaryRow, [
  "const showDecision = isAnalysisView || decision !== undefined;",
  "data-has-decision={showDecision ? 'true' : 'false'}",
  "{showDecision && ("
]) && hasAll(predictionsCss, [
  ".predictions-v4__match-list.is-fixtures-view .predictions-v4__match-row.has-decision",
  "minmax(260px, 1.55fr)"
]));

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
const kickoffLabelStart = predictions.indexOf("const getRowKickoffLabel", sportteryMetaStart);
const kickoffLabelEnd = predictions.indexOf("const formatCoveragePercent", kickoffLabelStart);
const compactDateHelpers = predictions.slice(sportteryMetaStart, kickoffLabelEnd);
pushCheck("fixture rows avoid repeated selected dates", hasAll(compactDateHelpers, [
  "match.matchNo || ''",
  "sportteryDay === kickoffDay",
  "formatShortDate(kickoffDay, language)",
  "formatKickoffTime(match.kickoffTime, language)"
]) && !["竞彩日", "开赛日", "归档"].some((needle) => compactDateHelpers.includes(needle)));

const teamsCellStart = predictions.indexOf("teams={(\n");
const oddsCellStart = predictions.indexOf("odds={(\n", teamsCellStart);
const decisionCellStart = predictions.indexOf("decision={", oddsCellStart);
const teamsCell = predictions.slice(teamsCellStart, oddsCellStart);
const oddsCell = predictions.slice(oddsCellStart, decisionCellStart);
const fallbackDecisionStart = predictions.indexOf("if (\n      !isFinished\n      && !displayRecommendation\n      && !archivedPreMatchPrediction\n      && !analysisReference\n    )");
const fallbackReturnStart = predictions.indexOf("    return (", fallbackDecisionStart);
const fallbackDecisionEnd = predictions.indexOf("    return (", fallbackReturnStart + 1);
const fallbackDecision = predictions.slice(fallbackDecisionStart, fallbackDecisionEnd);
pushCheck("semantic match rows keep pending-sale copy out of team slots", teamsCellStart >= 0
  && hasAll(matchSummaryRow, [
    "<article",
    'className="match-teams-cell predictions-v4__match-slot is-teams"',
    'className="match-odds-cell predictions-v4__match-slot is-odds"',
    'className="match-decision-cell predictions-v4__match-slot is-decision"',
    'className="details-button"'
  ])
  && !matchSummaryRow.includes("onClick={onOpen}")
  && !["待开售", "Pending sale", "match-signal-line", "signal-badge"].some((needle) => teamsCell.includes(needle))
  && hasAll(oddsCell, ["t('closed')", "t('archivedOdds')", "alignedPoolRows.map"])
  && hasAll(predictions, ["closed: { zh: '未开售'", "en: 'Not on sale'"])
  && hasAll(fallbackDecision, [
    "'暂无推荐'",
    "'No pick'",
    "模型证据仍不足，本场暂不强行给方向",
    "赔率与可审计输入不足，暂不能形成可靠推荐。"
  ])
  && !fallbackDecision.includes("decision-meta")
  && hasAll(predictions, [
    "推荐结论",
    "Recommendation",
    "detailsAriaLabel",
    "const analysisReference = analysisReferenceSelection?.prediction",
    "const primaryMeta = fiveHundredPresentation",
    "isLowEvidenceReference",
    "RecommendationEvidenceFacts",
    "证据评分"
  ])
  && !predictions.includes("AI决策"), {
  teamsCellHasPendingCopy: ["待开售", "Pending sale"].some((needle) => teamsCell.includes(needle)),
  fallbackHasExtraMeta: fallbackDecision.includes("decision-meta")
});

const liveArchiveFallbackStart = predictions.indexOf("const isInPlayArchiveFallback = match.status === 'LIVE'");
const archivePickedPredictionStart = predictions.indexOf("const pickedPrediction = reviewPrediction", liveArchiveFallbackStart);
const archiveFallbackGuardStart = predictions.indexOf("if (\n      !isFinished", archivePickedPredictionStart);
const archiveFallbackProjection = predictions.slice(liveArchiveFallbackStart, archiveFallbackGuardStart);
pushCheck("live rows render the immutable pre-match archive before the no-pick fallback", liveArchiveFallbackStart >= 0
  && archivePickedPredictionStart > liveArchiveFallbackStart
  && archiveFallbackGuardStart > archivePickedPredictionStart
  && hasAll(archiveFallbackProjection, [
    "match.status === 'LIVE'",
    "&& !displayRecommendation",
    "&& Boolean(archivedPreMatchPrediction)",
    "|| archivedPreMatchPrediction\n      || analysisReference;",
    "archivedPreMatchPrediction?.recommendationAction === 'recommend'",
    "'原赛前推荐归档 · 进行中'",
    "getPredictionTipDisplay(pickedPrediction, language, true)",
    "pickedPrediction?.oddsPoolCode === 'HHAD'",
    "pickedPrediction.handicapLine || match.handicapLine"
  ])
  && hasAll(fallbackDecision, [
    "&& !displayRecommendation",
    "&& !archivedPreMatchPrediction",
    "&& !analysisReference"
  ]), {
  liveArchiveFallbackStart,
  archivePickedPredictionStart,
  archiveFallbackGuardStart,
  fallbackDecisionStart
});

const dualMarketFixtureStart = predictions.indexOf("const handicapSupplement =");
const dualMarketFixtureEnd = predictions.indexOf("const fiveHundredMarketPresentation", dualMarketFixtureStart);
const dualMarketFixtureProjection = predictions.slice(dualMarketFixtureStart, dualMarketFixtureEnd);
pushCheck("odds table highlights the primary HAD and bound HHAD companion without promoting the companion", hasAll(predictions, [
  "const marketSelection = getListMarketSelection(",
  "const handicapSupplement =",
  "publishedRecommendation?.companion",
  "getAnalysisReferenceHandicapSupplement(",
  "marketSelection?.referenceSource",
  "publishedRecommendation?.prediction || marketSelection?.prediction",
  "const handicapMarketSelection: ListMarketSelection | null",
  "const dualMarketSelectionSummary =",
  "data-hhad-selection-tone={handicapMarketSelection?.tone || 'none'}",
  "const rowSelection = marketSelection?.poolCode === row.poolCode",
  "marketSelection.referenceSource !== 'published-reference'",
  "sameHandicapLine(",
  "const isSelectedMarket = Boolean(rowSelection)",
  "const isSelectedOutcome = isSelectedMarket && rowSelection?.tipCode === outcome.code",
  "让球参考推荐",
  "The 500.com market leader is a comparison only; the published reference may differ and is excluded from formal results",
  "Cross-market directions conflict; no pick is issued",
  "Odds comparison, not the selected market",
  "Official odds comparison",
  "Published picks are marked directly in the odds table",
  "Official pick: ${dualMarketSelectionSummary",
  "Data pick: ${dualMarketSelectionSummary"
]) && hasAll(css, [
  ".sporttery-pool-row.is-selected-market",
  ".sporttery-pool-row.is-unselected-market",
  ".pool-odd.is-selected.is-recommendation",
  ".pool-odd.is-selected.is-analysis",
  ".pool-odd.is-selected.is-review"
]) && hasAll(dualMarketFixtureProjection, [
  "&& Boolean(publishedRecommendation || marketSelection)",
  "poolCode: 'HHAD'",
  "tone: 'analysis'"
]) && !dualMarketFixtureProjection.includes("tone: 'recommendation'")
  && !oddsCell.includes("Math.min("), {
  dualMarketFixtureStart,
  dualMarketFixtureEnd,
  lowestSpSelectionPresent: oddsCell.includes("Math.min(")
});

pushCheck("empty dates do not inherit historical leagues", !predictions.includes("import { leagues") && hasAll(predictions, [
  "const matchesForDate = matches.filter((match) => matchBelongsToDate(match, effectiveSelectedDate))",
  "return matchesForDate.reduce<League[]>",
  "{baseFilteredMatches.length > 0 && (",
  "{availableLeagues.length > 0 && ("
]), {
  importsStaticLeagues: predictions.includes("import { leagues")
});

pushCheck("historical date empty state waits for the history lane", hasAll(predictions, [
  "const isHistoryDateLoading = Boolean(",
  "effectiveSelectedDate < todayStr",
  "dataSync.historyLoading",
  "!dataSync.historyLoaded",
  "baseFilteredMatches.length === 0",
  ": isHistoryDateLoading",
  "Historical results are loading; matches and post-match reviews for this date will appear when ready."
]));

const modelDetailsStart = predictions.indexOf("<details\n        className={`model-governance-panel system-model-details");
const modelDetailsEnd = predictions.indexOf("</details>", modelDetailsStart);
const modelDetails = predictions.slice(modelDetailsStart, modelDetailsEnd);
const modelSummaryStart = modelDetails.indexOf('<summary className="system-model-summary">');
const modelSummaryEnd = modelDetails.indexOf("</summary>", modelSummaryStart);
const modelSummary = modelDetails.slice(modelSummaryStart, modelSummaryEnd);
pushCheck("model detail is collapsed with a compact summary", modelDetailsStart >= 0
  && !modelDetails.slice(0, modelDetails.indexOf(">") + 1).includes(" open")
  && hasAll(modelSummary, ["系统与模型说明", "systemRecommendationLabel", "dashboardUpdatedAt"])
  && modelSummary.indexOf("modelGovernanceItems") < 0
  && modelDetails.indexOf('data-testid="data-sync-strip"') > modelSummaryEnd, {
  modelDetailsStart,
  modelDetailsEnd,
  summaryContainsOnlyCompactFields: modelSummary.indexOf("modelGovernanceItems") < 0
});

const dailyReviewCondition = "{(\n        effectiveSelectedDate < todayStr\n        || dailyReviewStats.finished > 0\n        || dailyReviewStats.awaitingOfficial > 0\n        || dailyReviewStats.archivedDirections > 0\n        || dailyReviewStats.provisionalReferenceSettled > 0\n      ) && (";
pushCheck("daily review keeps formal, live, data-pick BEST, and all analysis rows separate", predictions.includes(dailyReviewCondition)
  && predictions.indexOf(dailyReviewCondition) < predictions.indexOf('className="league-stack"')
  && predictions.includes('className="daily-review-panel is-compact is-priority"')
  && hasAll(predictions, [
    "row.recommendationAction === 'recommend'",
    "row.reviewRole === 'main'",
    "row.performanceTrack === 'formal'",
    "isSettledReviewStatus(row.resultStatus)",
    "row?.performanceTrack === 'live-model'",
    "const formalBestRow = settledRows.find((row) => isFormalReviewRow(row) && row.marketType === 'BEST')",
    "const liveBestRow = settledRows.find((row) => isLiveReviewRow(row) && row.marketType === 'BEST')",
    "const referenceBestRow = analysisRows.find((row) => row.marketType === 'BEST')",
    "acc.analysisSettled += analysisRows.length",
    "formalHitRate",
    "data-live-settled={dailyReviewStats.liveSettled}",
    "liveSettled",
    "liveHitRate",
    "实时推荐",
    "referenceBestSettled",
    "referenceBestHitRate",
    "analysisSettled",
    "analysisHitRate",
    "const provisionalOutcome = !hasSettledReview ? getProvisionalArchivedOutcome(match, now) : null",
    "tone === 'archive'",
    "原赛前归档推荐：",
    "Original pre-match archive:",
    "acc.provisionalReferenceSettled += 1",
    "provisionalReferenceHitRate",
    "data-provisional-reference-settled={dailyReviewStats.provisionalReferenceSettled}",
    "data-awaiting-official={dailyReviewStats.awaitingOfficial}",
    "data-archived-directions={dailyReviewStats.archivedDirections}",
    "External-result shadow reference",
    "Official settlement and external-result references use separate denominators.",
    "await official results",
    "原赛前方向归档",
    "待官方赛果",
    "数据推荐 BEST",
    "全部分析项"
  ])
  && !predictions.includes("dailyReviewStats.liveSettled > 0 &&"));

const dailyReviewPanelCssStart = predictionsCss.indexOf(".predictions-v4 .daily-review-panel.is-compact");
const dailyReviewPanelCssEnd = predictionsCss.indexOf(".predictions-v4 .daily-review-panel.is-priority", dailyReviewPanelCssStart);
const dailyReviewPanelCss = predictionsCss.slice(dailyReviewPanelCssStart, dailyReviewPanelCssEnd);
const dailyReviewStatsCssStart = predictionsCss.indexOf(".predictions-v4 .daily-review-stats {");
const dailyReviewStatsCssEnd = predictionsCss.indexOf(".predictions-v4 .daily-review-stats span", dailyReviewStatsCssStart);
const dailyReviewStatsCss = predictionsCss.slice(dailyReviewStatsCssStart, dailyReviewStatsCssEnd);
pushCheck("daily review summary keeps readable width above its metric grid", hasAll(dailyReviewPanelCss, [
  "grid-template-columns: minmax(0, 1fr);",
]) && hasAll(dailyReviewStatsCss, [
  "grid-template-columns: repeat(auto-fit, minmax(112px, 1fr));",
  "width: 100%;"
]) && !dailyReviewPanelCss.includes("grid-template-columns: minmax(0, 1fr) auto;"), {
  singleColumnSummary: dailyReviewPanelCss.includes("grid-template-columns: minmax(0, 1fr);"),
  responsiveMetricGrid: dailyReviewStatsCss.includes("grid-template-columns: repeat(auto-fit, minmax(112px, 1fr));"),
  legacyOverflowLayoutRemoved: !dailyReviewPanelCss.includes("grid-template-columns: minmax(0, 1fr) auto;")
});

pushCheck("date chips use only the Sporttery business-day scope", hasAll(predictions, [
  "const sportteryDay = getSportteryDay(match);",
  "return sportteryDay ? [sportteryDay] : [];",
  'data-date-scope="sporttery-business-date"',
  "按竞彩业务日归档；跨午夜比赛只计入原竞彩日。"
]) && !predictions.includes("kickoffDay,\n    sportteryDay"));

pushCheck("date navigation opens the nearest available match day and stays user-controlled", hasAll(predictions, [
  "automaticInitialDateResolvedRef",
  "const nearestUpcomingDate = availableDates.find((date) => date >= todayStr)",
  "const nearestAvailableDate = nearestUpcomingDate || nearestRecentDate",
  "automaticInitialDateResolvedRef.current = true",
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

pushCheck("model scorecard separates formal samples from shadow evaluation", hasAll(predictions, [
  "configuredModelRequiredRows",
  ": 500;",
  "scorecardSample?.formalRecommendationRows ?? scorecardSample?.predictionRows",
  "scorecardHasFormalSample",
  "暂无正式样本",
  "暂无正式推荐样本；影子 LL/Brier 不计入赔率区间表现",
  "data-model-scorecard-has-formal-sample",
  "data-model-formal-recommendation-rows"
]) && !predictions.includes("modelGate?.thresholds?.minMarketBaselineRows ?? 100")
  && !predictions.includes("scorecardOddsCount} bands / ${scorecardComparisonNote}"));

pushCheck("publication and candidate samples use visibly independent ledgers", hasAll(predictions, [
  'data-testid="benchmark-hit-rate-audit"',
  'data-sample-track="publication-ledger"',
  "客户正式发布结算",
  '<strong>{hitRateAuditSettled}/{hitRateAuditRequiredRows}</strong>',
  'data-testid="benchmark-ledger-separation-note"',
  "独立账本说明：客户正式发布结算",
  "候选前瞻对标结算",
  "不计入正式命中率",
  'data-testid="candidate-prospective-ledger"',
  'data-sample-track="candidate-prospective-ledger"',
  '<strong>{candidateFormalSettled}/{candidateFormalRequired}</strong>',
]) && hasAll(css, [
  ".benchmark-audit-panel__ledger-note",
  "grid-column: 1 / -1;",
]) && !predictions.includes("hitRateAuditSettled + candidateFormalSettled")
  && !predictions.includes("candidateFormalSettled + hitRateAuditSettled"));

const scopedHeaderContract = hasAll(predictions, [
  "const referenceTierCount = recommendationCounts.reference + recommendationCounts.live",
  "const directionShownCount = recommendationCounts.home + recommendationCounts.draw + recommendationCounts.away",
  "Official SP ${fixtureMarketCounts.covered}/${baseFilteredMatches.length}",
  "${directionShownCount} directions shown",
  'className="predictions-v4__evidence-snapshot"'
]);
pushCheck("fixture header reports selected Sporttery-day direction coverage without a global claim", scopedHeaderContract || hasAll(predictions, [
  "本日 ${recommendationCounts.recommended}/${baseFilteredMatches.length} 场方向已显示",
  "${recommendationCounts.recommended}/${baseFilteredMatches.length} directions shown for this Sporttery day",
]) && !predictions.includes("${recommendationCounts.recommended} 场推荐已显示"));

pushCheck("missing audit metrics remain unavailable instead of coercing null to zero", hasAll(predictions, [
  "const toFiniteNumericMetric = (value",
  "const hitRateAuditRateLabel = formatModelPercent(hitRateAuditObserved?.hitRate);",
  "toFiniteNumericMetric(hitRateAuditInterval?.lower)",
  "toFiniteNumericMetric(hitRateAuditInterval?.upper)",
  "const benchmarkShadowRateLabel = formatModelPercent(benchmarkShadowMetrics?.hitRate);",
  "const benchmarkShadowRoi = toFiniteNumericMetric(benchmarkShadowMetrics?.roiPercent);",
  "candidateProspectiveMetrics?.logLossImprovement",
  "candidateProspectiveMetrics?.brierImprovement"
]) && !predictions.includes("Number.isFinite(Number(hitRateAuditObserved?.hitRate))")
  && !predictions.includes("Number(candidateProspectiveMetrics?.logLossImprovement)")
  && !predictions.includes("Number(candidateProspectiveMetrics?.brierImprovement)"));

pushCheck("80 percent benchmark is visibly audited instead of advertised as a result", hasAll(predictions, [
  'data-testid="benchmark-hit-rate-audit"',
  "data-audit-external-claim={hitRateAudit?.externalBenchmark?.verificationStatus",
  "80% 只作为待验证目标，不作为当前成绩",
  "只统计赛前冻结、写入不可变发布账本且已结算的正式推荐",
  "实时推荐、500 数据推荐和普通分析方向全部排除",
  "胜负完整公开，不删除失误样本",
  "截止后不可改方向、赔率或证据",
  "外部 80% 声称：未核验，不进入训练标签",
  "hitRateAuditObserved?.interval95",
  "hitRateAuditSettled}/{hitRateAuditRequiredRows",
  "data-clv-version={hitRateClvAudit?.version",
  "data-clv-timing-version={hitRateClvAudit?.timingAudit?.version",
  "data-clv-eligible-rows={hitRateClvRows}",
  "data-clv-candidate-rows={hitRateClvCandidateRows}",
  "收盘时点有效覆盖",
  "hitRateClvRows}/${hitRateClvCandidateRows}"
]) && hasAll(css, [
  ".benchmark-audit-panel",
  ".benchmark-audit-panel__metrics",
  ".benchmark-audit-panel__rules"
]));

pushCheck("high-selectivity benchmark cohort is visible but cannot affect formal recommendations", hasAll(predictions, [
  'data-testid="benchmark-shadow-track"',
  "benchmarkShadow?.version",
  "benchmarkShadow?.status",
  "benchmarkShadow?.minimumSettledRowsForPromotionReview",
  "benchmarkShadow?.minimumChronologicalFolds",
  "benchmarkShadow?.promotionReviewReady",
  "benchmarkShadowRateLabel",
  "benchmarkShadowIntervalLabel",
  "benchmarkShadowRoiLabel",
  "benchmarkCaptureHeartbeat?.fresh",
  "benchmarkCaptureHeartbeat?.intervalSeconds",
  "前瞻截止心跳"
]) && hasAll(css, [
  ".benchmark-audit-panel__shadow",
  ".benchmark-audit-panel__shadow-metrics"
]));

pushCheck("frozen candidate prospective ledger is visible and keeps formal rows separate", hasAll(predictions, [
  'data-testid="candidate-prospective-ledger"',
  "candidateProspective.state",
  "candidateProspective.chainValid",
  "candidateProspective.rootHash",
  "candidateProspective.gateSpecHash",
  "candidateProspectiveMetrics?.logLossImprovement",
  "candidateProspectiveMetrics?.brierImprovement",
  "candidateFormalFinalized",
  "candidateFormalSettled",
  "candidateShadow?.universe",
  "candidateCaptureHeartbeat?.fresh",
  "candidateCaptureHeartbeat?.intervalSeconds",
  "candidateAdmission?.admitted",
  "candidateAdmission?.pendingDeadline",
  "candidateAdmission?.dueUnrecorded",
  "截止点心跳"
]) && hasAll(predictions, [
  "data-formal-finalized={candidateFormalFinalized}",
  "data-formal-settled={candidateFormalSettled}",
  "data-shadow-universe={Number(candidateShadow?.universe || 0)}",
  "data-heartbeat-fresh={candidateCaptureHeartbeat?.fresh === true ? 'true' : 'false'}",
  "data-admitted={Number(candidateAdmission?.admitted || 0)}",
  "data-due-unrecorded={Number(candidateAdmission?.dueUnrecorded || 0)}"
]));

pushCheck("historical business days distinguish not-yet-due settlement from missing results", hasAll(predictions, [
  "const officialSettlementNotDue = dailyReviewStats.resultPhaseFixtures === 0;",
  "data-settlement-phase={officialSettlementNotDue ? 'not-due' : 'result-phase'}",
  "data-recorded-directions={reviewDirectionCount}",
  "data-not-yet-result-phase={dailyReviewStats.notYetResultPhase}",
  "赛前方向已记录",
  "跨午夜比赛仍归属原竞彩日，终场后自动结算",
  "官方结算状态",
  "未到终场"
]));

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
