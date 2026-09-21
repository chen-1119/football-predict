const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const readText = (relativePath) => fs.readFileSync(path.join(rootDir, relativePath), "utf8");
const checks = [];

const pushCheck = (name, ok, details = {}) => {
  checks.push({ name, ...details, ok: Boolean(ok) });
};

const app = readText("src/App.tsx");
const navbar = readText("src/components/Navbar.tsx");
const footer = readText("src/components/Footer.tsx");
const contactDock = readText("src/components/ContactDock.tsx");
const glossaryModal = readText("src/components/GlossaryModal.tsx");
const dialogFocus = readText("src/services/dialogFocus.ts");
const betSlip = readText("src/pages/BetSlipGenerator.tsx");
const hitAndWin = readText("src/pages/HitAndWin.tsx");
const matchDetail = readText("src/pages/MatchDetail.tsx");
const predictions = readText("src/pages/PredictionsList.tsx");
const auth = readText("src/pages/Auth.tsx");
const accessAdmin = readText("src/pages/AccessCodeAdmin.tsx");
const bestTips = readText("src/pages/BestTips.tsx");
const indexHtml = readText("index.html");
const css = readText("src/index.css");
const predictionsCss = readText("src/styles/predictions.css");
const bestTipsCss = readText("src/styles/best-tips.css");
const tokensCss = readText("src/styles/tokens.css");
const shellCss = readText("src/styles/shell.css");

pushCheck("clipboard uses verified fallback result", [
  "import { copyText }",
  "await copyText(text)",
  "if (!result.ok)",
  "copyState === 'success'",
  'aria-live="polite"'
].every((needle) => betSlip.includes(needle)) && !betSlip.includes("navigator.clipboard.writeText"), {
  directClipboardCall: betSlip.includes("navigator.clipboard.writeText")
});

pushCheck("dialogs trap and restore focus", [
  "event.key !== 'Tab'",
  "event.shiftKey",
  "last.focus()",
  "first.focus()",
  "dialog.focus()"
].every((needle) => dialogFocus.includes(needle))
  && [contactDock, glossaryModal].every((source) => source.includes("trapDialogFocus(event") && source.includes("tabIndex={-1}"))
  && contactDock.includes("triggerRef.current?.focus()")
  && glossaryModal.includes("previouslyFocusedRef.current?.focus()"), {
  contactTrap: contactDock.includes("trapDialogFocus(event"),
  glossaryTrap: glossaryModal.includes("trapDialogFocus(event")
});

pushCheck("match detail tab keyboard model", [
  "type DetailTab = 'overview' | 'probability' | 'evidence' | 'history'",
  "detailTabOrder",
  "ArrowRight",
  "ArrowLeft",
  "Home",
  "End",
  'role="tablist"',
  'role="tab"',
  'role="tabpanel"',
  "aria-selected={activeTab === item.key}",
  "aria-controls={detailPanelId}",
  "aria-labelledby={detailTabId(activeTab)}",
  "tabIndex={activeTab === item.key ? 0 : -1}",
  "{ key: 'overview', label: t('overviewTab') }",
  "{ key: 'probability', label: t('probabilityTab') }",
  "{ key: 'evidence', label: t('evidenceTab') }",
  "{ key: 'history', label: t('historyTab') }",
  "activeTab === 'overview'",
  "activeTab === 'probability'",
  "activeTab === 'evidence'",
  "activeTab === 'history'"
].every((needle) => matchDetail.includes(needle))
  && (matchDetail.match(/role="tabpanel"/g) || []).length === 1
  && ![
    "predictionViewOrder",
    "predictionViewPanelId",
    "predictionViewTabId(predictionView)",
    "tabIndex={predictionView === item.key ? 0 : -1}"
  ].some((needle) => matchDetail.includes(needle)));

const matchRowResponsiveBlock = predictionsCss.match(
  /@media \(max-width:\s*(\d+)px\)\s*\{[\s\S]*?\.predictions-v4__match-row,[\s\S]*?grid-template-columns:\s*112px minmax\(0,\s*1fr\) 62px;/
);
const matchRowStackBreakpoint = Number(matchRowResponsiveBlock?.[1] || 0);
pushCheck("prediction rows stack before the 1024px shell can clip them",
  matchRowStackBreakpoint >= 1080
  && predictionsCss.includes(".predictions-v4__match-slot.is-odds")
  && predictionsCss.includes(".predictions-v4__match-slot.is-decision")
  && predictionsCss.includes("grid-column: 1 / -1;"), {
    matchRowStackBreakpoint
  });

pushCheck("semantic status tokens preserve legacy HSL and direct-color consumers", [
  "--warning: 42 63% 57%;",
  "--danger: 0 65% 65%;",
  "--status-warning: var(--shell-warning);",
  "--status-danger: var(--shell-danger);"
].every((needle) => tokensCss.includes(needle))
  && bestTipsCss.includes("var(--status-warning")
  && bestTipsCss.includes("var(--status-danger")
  && !bestTipsCss.includes("var(--warning,")
  && !bestTipsCss.includes("var(--danger,"));

pushCheck("mobile controls meet touch targets and match cards stay compact", [
  ".predictions-v4 .history-date-select select",
  "min-height: 44px;",
  "@media (max-width: 480px)",
  "grid-template-columns: minmax(104px, 0.72fr) minmax(0, 1.28fr);",
  "grid-template-columns: minmax(0, 1.12fr) minmax(118px, 0.88fr);"
].every((needle) => predictionsCss.includes(needle))
  && shellCss.includes(".app-shell-v2 .app-footer-policy.footer-policy-details summary")
  && shellCss.includes(".app-shell-v2 .app-footer .contact-entry-button.contact-dock-button")
  && (shellCss.match(/min-height:\s*44px;/g) || []).length >= 2);

pushCheck("mobile navigation has one column per visible tab and never covers the footer",
  navbar.includes("{ key: 'leagues', labelKey: 'topLeagues'")
  && shellCss.includes("grid-template-columns: repeat(5, minmax(0, 1fr));")
  // One reserve on the whole frame protects both content and footer; adding
  // separate reserves to main and footer produced three blank navigation gaps.
  && /\.app-frame\.app-shell-v2\s*\{\s*padding-bottom: calc\(var\(--shell-mobile-tabbar-height\) \+ env\(safe-area-inset-bottom\)\);/.test(shellCss));

pushCheck("unverified access does not masquerade as an endless data sync",
  navbar.includes("type DataStatus = 'locked'")
  && navbar.includes("if (!currentUser) return 'locked';")
  && navbar.includes("dataLocked: { zh: '待校验'"));

pushCheck("live score presentation is display-only and exposes freshness",
  predictions.includes("buildLiveScorePresentation")
  && predictions.includes('data-live-score-settlement-eligible="false"')
  && predictions.includes("liveScore.updatedLabel")
  && predictionsCss.includes(".live-score-card.is-stale"));

pushCheck("match detail public overview excludes pseudo-precise heuristics", [
  "publicPreMatchFactCards",
  "hasUsableFiveHundredDetails",
  "fiveHundredUsablePanels.map",
  "publicRecommendationBlockers",
  "predictionDataPolicyCopy",
  "本场未启用",
  "模型进球期望（λ）",
  "官方赔率 / 让球",
  "盘口变化",
  "数据缺口"
].every((needle) => matchDetail.includes(needle))
  && !matchDetail.includes("predictionMeta?.dataPolicy?.[language]")
  && ![
    "冷门指数",
    "冷门触发",
    "排名与进攻欲望",
    "key: 'attack-intent'",
    "key: 'ranking-pressure'",
    "upsetRiskScore"
  ].some((needle) => matchDetail.includes(needle)));

pushCheck("footer policy disclosures are accessible and accurate", [
  "<details",
  "<summary>",
  "football_access_session",
  "nerdy_lang",
  "nerdy_user",
  "nerdy_hw_submission",
  "football_worldcup_prediction_wall",
  "不会上传或共享",
  "not uploaded or shared"
].every((needle) => footer.includes(needle)) && css.includes(".footer-policy-details"));

pushCheck("post-match review is historical-only and excludes personal pre-match notes", [
  "Post-match Review Center",
  "Only historical fixtures with results are shown",
  "selectedReviewDate",
  "systemReviewMatches",
  "Open full review"
].every((needle) => hitAndWin.includes(needle))
  && !hitAndWin.includes("localStorage.setItem(STORAGE_KEY")
  && !hitAndWin.includes("todayMatches.map")
  && !hitAndWin.includes("<form")
  && app.includes('path="/review"')
  && app.includes('<Route path="/hitwin" element={<Navigate to="/review" replace />} />'));

pushCheck("navigation uses current-page semantics and dynamic status announcements", navbar.includes("aria-current={isActive ? 'page' : undefined}")
  && !navbar.includes("aria-pressed={isActive}")
  && navbar.includes('aria-haspopup="menu"')
  && navbar.includes('role="menu"')
  && navbar.includes("event.key === 'ArrowDown'")
  && navbar.includes("event.key === 'Escape'")
  && predictions.includes('role="status"')
  && predictions.includes('aria-live="polite"')
  && app.includes("handleRetry")
  && app.includes("handleBackToPredictions"));

pushCheck("localized standings and route headings", [
  "'Rank'",
  "'Team'",
  "'Played'",
  "'Points'",
  "scope=\"col\"",
  "<h1 className=\"sr-only\">"
].every((needle) => matchDetail.includes(needle))
  && [auth, accessAdmin, bestTips, betSlip, hitAndWin].every((source) => source.includes("<h1"))
  && css.includes(".sr-only"));

pushCheck("lazy route fallback reserves the viewport before fixture cards render", [
  "min-height: max(420px, calc(100vh - 80px));",
  "min-height: max(420px, calc(100dvh - 80px));"
].every((needle) => shellCss.includes(needle))
  && shellCss.includes(".app-shell-v2 .route-loading,"));

pushCheck("shared route hero is discoverable before lazy route rendering", [
  'rel="preload"',
  'as="image"',
  'href="%BASE_URL%media/worldcup-glory-hero.jpg"',
  'fetchpriority="high"'
].every((needle) => indexHtml.includes(needle)));

const failed = checks.filter((check) => !check.ok);
const result = {
  ok: failed.length === 0,
  checkedAt: new Date().toISOString(),
  summary: {
    total: checks.length,
    passed: checks.length - failed.length,
    failed: failed.length
  },
  checks
};

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
