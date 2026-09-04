const fs = require("node:fs");
const path = require("node:path");
const {
  assessWebConsensusEvidence,
  buildWebConsensusEvidenceHash,
  WEB_CONSENSUS_EVIDENCE_VERSION,
  verifyWebConsensusPromotionManifest,
} = require("../src/services/webConsensusEvidence.cjs");

const rootDir = path.join(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const dataDir = path.join(publicDir, "data");
const serverDataDir = path.join(rootDir, "server-data");

const CURRENT_MATCHES_FILE = path.join(dataDir, "matches-current.json");
const EXTERNAL_SIGNALS_FILE = path.join(dataDir, "external-signals.json");
const OUTPUT_FILE = path.join(dataDir, "web-consensus-signals.json");
const DEFAULT_INPUT_FILE = path.join(serverDataDir, "web-consensus", "manual-insights.json");
const MODEL_FEATURE_ENABLED = process.env.ENABLE_VERIFIED_WEB_CONSENSUS_MODEL === "1";
const PROMOTION_MANIFEST_FILE = path.resolve(
  process.env.WEB_CONSENSUS_PROMOTION_MANIFEST_FILE
  || path.join(serverDataDir, "web-consensus", "promotion-manifest.json")
);
const EXPECTED_PROMOTION_MANIFEST_HASH = String(
  process.env.WEB_CONSENSUS_PROMOTION_MANIFEST_HASH || ""
).trim().toLowerCase();

const INPUT_FILES = [
  process.env.WEB_CONSENSUS_INPUT,
  path.join(serverDataDir, "web-consensus", "open-research-insights.json"),
  DEFAULT_INPUT_FILE,
  path.join(dataDir, "web-consensus-input.json"),
].filter(Boolean);

const nowIso = () => new Date().toISOString();

const readJson = (filePath, fallback) => {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    console.warn(`[syncWebConsensusSignals] failed to read ${filePath}: ${error.message}`);
    return fallback;
  }
};

const PROMOTION_MANIFEST = readJson(PROMOTION_MANIFEST_FILE, null);
const PROMOTION_AUTHORITY = verifyWebConsensusPromotionManifest(PROMOTION_MANIFEST, {
  expectedHash: EXPECTED_PROMOTION_MANIFEST_HASH,
});

const writeJson = (filePath, value) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const norm = (value) => String(value ?? "").trim();
const lower = (value) => norm(value).toLowerCase();

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const round = (value, digits = 3) => {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const parseDateTime = (value) => {
  const text = norm(value);
  if (!text) return NaN;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text)) {
    return Date.parse(text.replace(" ", "T") + "+08:00");
  }
  return Date.parse(text);
};

const sourceMatchId = (match) => norm(match?.sourceMatchId) || norm(match?.id).replace(/^sporttery_/, "");

const teamDateKey = (home, away, kickoffTime) => [
  lower(home),
  lower(away),
  norm(kickoffTime).slice(0, 10),
].join("__");

const matchKeys = (match) => Array.from(new Set([
  sourceMatchId(match),
  norm(match?.id),
  norm(match?.matchNo),
  teamDateKey(match?.homeTeamName || match?.homeTeamNameEn, match?.awayTeamName || match?.awayTeamNameEn, match?.kickoffTime),
].filter(Boolean)));

const insightKeys = (insight) => Array.from(new Set([
  norm(insight.sourceMatchId),
  norm(insight.matchId),
  norm(insight.matchNo),
  teamDateKey(insight.homeTeamName || insight.home, insight.awayTeamName || insight.away, insight.kickoffTime),
].filter(Boolean)));

const loadInputRows = () => {
  const rows = [];
  for (const filePath of INPUT_FILES) {
    const parsed = readJson(filePath, null);
    if (!parsed) continue;
    const values = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.rows)
        ? parsed.rows
        : parsed.matches && typeof parsed.matches === "object"
          ? Object.values(parsed.matches)
          : [];
    for (const value of values) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        rows.push({ ...value, inputFile: path.relative(rootDir, filePath) });
      }
    }
  }
  return rows;
};

const directionCode = (value) => {
  const text = lower(value);
  if (["1", "home", "home_win", "home-win", "主胜"].includes(text)) return "1";
  if (["x", "draw", "tie", "平", "平局"].includes(text)) return "X";
  if (["2", "away", "away_win", "away-win", "客胜"].includes(text)) return "2";
  return null;
};

const directionSide = (value) => {
  const code = directionCode(value);
  if (code === "1") return "home";
  if (code === "X") return "draw";
  if (code === "2") return "away";
  return null;
};

const goalsSide = (value) => {
  const text = lower(value);
  if (["over", "over25", "over2.5", "o2.5", "大", "大2.5"].includes(text)) return "over25";
  if (["under", "under25", "under2.5", "u2.5", "小", "小2.5"].includes(text)) return "under25";
  return null;
};

const drawRisk = (value) => {
  const text = lower(value);
  if (["high", "h", "高", "防平强"].includes(text)) return "high";
  if (["medium", "mid", "m", "中", "防平"].includes(text)) return "medium";
  if (["low", "l", "低"].includes(text)) return "low";
  return null;
};

const handicapView = (value) => {
  const text = lower(value);
  if (["favorite-win-not-cover", "favorite_not_cover", "not-cover", "win-not-cover", "强队赢不穿"].includes(text)) {
    return "favorite-win-not-cover";
  }
  if (["favorite-cover", "cover", "强队穿盘"].includes(text)) return "favorite-cover";
  if (["underdog-cover", "dog-cover", "受让不败", "受让"].includes(text)) return "underdog-cover";
  return text || null;
};

const scoreShape = (value) => {
  if (Array.isArray(value)) return value.map(norm).filter(Boolean).slice(0, 5);
  return norm(value)
    .split(/[\/,，、\s]+/)
    .map(norm)
    .filter(Boolean)
    .slice(0, 5);
};

const sourceItems = (insight, expectedMatchUuid = null) => {
  const raw = Array.isArray(insight.sourceItems)
    ? insight.sourceItems
    : Array.isArray(insight.sources)
      ? insight.sources.map((item) => (typeof item === "string" ? { name: item } : item))
      : [];
  return raw
    .map((item) => {
      const sourceLicense = item.sourceLicense || item.source_license || item.license || null;
      const normalized = {
      name: norm(item.name || item.source || item.title || item.url),
      url: norm(item.url),
      matchUuid: norm(item.matchUuid || item.match_uuid || expectedMatchUuid || insight.matchUuid || insight.match_uuid || insight.sourceMatchId || insight.matchId),
      publisherOwner: norm(item.publisherOwner || item.publisher_owner),
      publishedAt: norm(item.publishedAt || item.publication_time),
      ingestedAt: norm(item.ingestedAt || item.ingested_at || item.capturedAt || insight.ingestedAt || insight.ingested_at || insight.capturedAt),
      extractedAt: norm(item.extractedAt || item.extracted_at),
      factCategory: norm(item.factCategory || item.fact_category),
      extractedFact: norm(item.extractedFact || item.extracted_fact),
      rawSnippet: norm(item.rawSnippet || item.raw_snippet),
      riskDowngrade: norm(item.riskDowngrade || item.risk_downgrade),
      sourceLicense,
      rawSha256: norm(item.rawSha256 || item.raw_sha256),
      httpDate: norm(item.httpDate || item.http_date),
      llmGeneratedAt: norm(item.llmGeneratedAt || item.llm_generated_at),
      lean: directionSide(item.lean || item.oneXTwo),
      goals: goalsSide(item.goals),
      handicapView: handicapView(item.handicapView),
      scoreShape: scoreShape(item.scoreShape || item.scores),
      };
      const providedHash = norm(item.evidenceHash || item.evidence_hash).toLowerCase();
      return {
        ...normalized,
        evidenceHash: providedHash || buildWebConsensusEvidenceHash(normalized),
      };
    })
    .filter((item) => item.name || item.url);
};

const selectedModelCode = (match) => {
  const selected = match?.probabilityModel?.unifiedPosterior;
  if (selected?.selectedCode) return norm(selected.selectedCode).toUpperCase();
  const best = (match?.predictions || []).find((row) => row.marketType === "BEST");
  return best?.tipCode ? norm(best.tipCode).toUpperCase() : null;
};

const selectedModelMarket = (match) => {
  const selected = match?.probabilityModel?.unifiedPosterior;
  if (selected?.selectedMarket) return norm(selected.selectedMarket).toUpperCase();
  const best = (match?.predictions || []).find((row) => row.marketType === "BEST");
  return best?.oddsPoolCode ? norm(best.oddsPoolCode).toUpperCase() : null;
};

const modelAgreement = (match, consensus) => {
  const modelCode = selectedModelCode(match);
  const modelMarket = selectedModelMarket(match);
  const consensusCode = directionCode(consensus.oneXTwo);
  const view = handicapView(consensus.handicapView);
  if (!modelCode) return null;
  if (modelMarket === "HHAD" && view === "favorite-win-not-cover") return modelCode === "2";
  if (modelMarket === "HHAD" && view === "favorite-cover") return modelCode === "1";
  if (consensusCode) return modelCode === consensusCode;
  return null;
};

const normalizeInsight = (insight, match, updatedAt) => {
  const consensusInput = insight.consensus || insight;
  const expectedMatchUuid = sourceMatchId(match) || norm(match?.id || insight.matchUuid || insight.match_uuid);
  const sources = sourceItems(insight, expectedMatchUuid);
  const confidence = clamp(Number(consensusInput.confidence ?? insight.confidence ?? 0.5), 0.05, 0.95);
  const capturedAt = norm(insight.capturedAt || consensusInput.capturedAt || updatedAt);
  const cutoffTime = norm(match?.buyEndTime || match?.predictionMeta?.cutoffTime || insight.cutoffTime);
  const capturedMs = parseDateTime(capturedAt);
  const cutoffMs = parseDateTime(cutoffTime);
  const beforeCutoff = Number.isFinite(capturedMs) && Number.isFinite(cutoffMs) && capturedMs <= cutoffMs;
  const consensus = {
    oneXTwo: directionSide(consensusInput.oneXTwo || consensusInput.direction || consensusInput.pick),
    goals: goalsSide(consensusInput.goals || consensusInput.totalGoals),
    handicapView: handicapView(consensusInput.handicapView || consensusInput.handicap),
    scoreShape: scoreShape(consensusInput.scoreShape || consensusInput.scores || insight.scoreShape),
    drawRisk: drawRisk(consensusInput.drawRisk),
    confidence: round(confidence, 3),
  };
  const agree = modelAgreement(match, consensus);
  const modelUse = assessWebConsensusEvidence({
    sources,
    capturedAt,
    cutoffTime,
    matchUuid: expectedMatchUuid,
    explicitModelOptIn: insight.usableForModel === true,
    modelFeatureEnabled: MODEL_FEATURE_ENABLED,
    promotionManifest: PROMOTION_MANIFEST,
    expectedPromotionManifestHash: EXPECTED_PROMOTION_MANIFEST_HASH,
  });
  const eligibleForRiskDisplay = beforeCutoff && modelUse.eligibleForRiskDisplay === true;
  const eligibleForRiskAdvisory = eligibleForRiskDisplay && modelUse.eligibleForRiskAdvisory === true;
  // Compatibility flags are deliberately false. New callers may only use the
  // explicitly named advisory/display fields below.
  const usableForRisk = false;
  const usableForModel = false;
  const sourceCount = sources.length;
  const features = {
    modelAgree: agree,
    modelMarket: selectedModelMarket(match),
    modelCode: selectedModelCode(match),
    marketAgree: insight.features?.marketAgree ?? null,
    handicapConflict: Boolean(
      consensus.handicapView === "favorite-win-not-cover"
      || insight.features?.handicapConflict
    ),
    favoriteMayNotCover: consensus.handicapView === "favorite-win-not-cover" || Boolean(insight.features?.favoriteMayNotCover),
    drawRisk: consensus.drawRisk,
    goalsConsensus: consensus.goals,
  };
  const buckets = Array.from(new Set([
    eligibleForRiskDisplay ? "web:advisory-only" : "web:audit-only",
    agree === true ? "web:model-agree" : agree === false ? "web:model-conflict" : "web:model-unknown",
    consensus.handicapView ? `web:handicap:${consensus.handicapView}` : null,
    consensus.drawRisk ? `web:draw-risk:${consensus.drawRisk}` : null,
    consensus.goals ? `web:goals:${consensus.goals}` : null,
    confidence >= 0.7 && sourceCount >= 2 ? "web:strong-consensus" : null,
    confidence < 0.45 ? "web:low-confidence" : null,
  ].filter(Boolean)));

  return {
    version: "web-consensus-v2",
    source: "web-consensus",
    updatedAt,
    capturedAt,
    cutoffTime,
    usableForModel,
    usableForRisk,
    eligibleForNumericModel: false,
    eligibleForFormalQuality: false,
    eligibleForStrategyGate: false,
    eligibleForRiskDisplay,
    eligibleForRiskAdvisory,
    conflictFreeze: modelUse.conflictFreeze === true,
    advisoryPolicy: "display-only",
    modelUse,
    sourceMatchId: sourceMatchId(match),
    matchId: match?.id || insight.matchId,
    matchNo: match?.matchNo || insight.matchNo,
    kickoffTime: match?.kickoffTime || insight.kickoffTime,
    homeTeamName: match?.homeTeamName || insight.homeTeamName || insight.home,
    awayTeamName: match?.awayTeamName || insight.awayTeamName || insight.away,
    sources,
    consensus,
    features,
    quality: {
      sourceCount,
      confidence: round(confidence, 3),
      beforeCutoff,
      evidenceVersion: WEB_CONSENSUS_EVIDENCE_VERSION,
      independentDomains: modelUse.independentDomains,
      evidenceBlockers: modelUse.blockers,
      inputFile: insight.inputFile || null,
    },
    buckets,
    summary: {
      zh: `网络观点 ${sourceCount} 源，置信 ${Math.round(confidence * 100)}%，${eligibleForRiskDisplay ? "仅供风险展示" : "仅赛后审计"}。`,
      en: `Web consensus from ${sourceCount} source(s), confidence ${Math.round(confidence * 100)}%, ${eligibleForRiskDisplay ? "risk display only" : "audit only"}.`,
    },
  };
};

const sanitizeStoredConsensusRow = (value, key = null, updatedAt = nowIso()) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const legacyVersion = value.version === "web-consensus-v2" ? null : (value.version || "web-consensus-v1");
  const expectedMatchUuid = norm(value.sourceMatchId || value.matchId || key);
  const sources = sourceItems(value, expectedMatchUuid);
  const modelUseBase = assessWebConsensusEvidence({
    sources,
    capturedAt: value.capturedAt,
    cutoffTime: value.cutoffTime,
    matchUuid: expectedMatchUuid,
    explicitModelOptIn: false,
    modelFeatureEnabled: false,
    promotionManifest: PROMOTION_MANIFEST,
    expectedPromotionManifestHash: EXPECTED_PROMOTION_MANIFEST_HASH,
  });
  const modelUse = legacyVersion
    ? {
      ...modelUseBase,
      eligible: false,
      eligibleForRiskDisplay: false,
      eligibleForRiskAdvisory: false,
      onlineEffect: "audit-only",
      blockers: Array.from(new Set([...(modelUseBase.blockers || []), "legacy-web-consensus-row"])),
    }
    : modelUseBase;
  const buckets = Array.from(new Set([
    ...(Array.isArray(value.buckets)
      ? value.buckets.filter((bucket) => !["web:usable", "web:risk-only", "web:strong-consensus"].includes(bucket))
      : []),
    legacyVersion || modelUse.eligibleForRiskDisplay !== true ? "web:audit-only" : "web:advisory-only",
    legacyVersion ? "web:legacy-row" : null,
  ].filter(Boolean)));

  return {
    ...value,
    version: "web-consensus-v2",
    ...(legacyVersion ? { legacyVersion, migratedAt: updatedAt } : {}),
    updatedAt: value.updatedAt || updatedAt,
    sources,
    usableForModel: false,
    usableForRisk: false,
    eligibleForNumericModel: false,
    eligibleForFormalQuality: false,
    eligibleForStrategyGate: false,
    eligibleForRiskDisplay: legacyVersion ? false : modelUse.eligibleForRiskDisplay === true,
    eligibleForRiskAdvisory: legacyVersion ? false : modelUse.eligibleForRiskAdvisory === true,
    conflictFreeze: modelUse.conflictFreeze === true,
    advisoryPolicy: legacyVersion ? "legacy-audit-only" : "display-only",
    modelUse,
    buckets,
  };
};

const main = () => {
  const updatedAt = nowIso();
  const matches = readJson(CURRENT_MATCHES_FILE, []);
  const external = readJson(EXTERNAL_SIGNALS_FILE, { version: 1, source: "external-signals", matches: {}, sources: {} });
  const existingOutput = readJson(OUTPUT_FILE, { version: 1, source: "web-consensus", matches: {} });
  const matchIndex = new Map();
  for (const match of Array.isArray(matches) ? matches : []) {
    for (const key of matchKeys(match)) {
      if (key && !matchIndex.has(key)) matchIndex.set(key, match);
    }
  }

  const inputRows = loadInputRows();
  const rows = {};
  const warnings = [];

  for (const [key, value] of Object.entries(existingOutput.matches || {})) {
    const sanitized = sanitizeStoredConsensusRow(value, key, updatedAt);
    if (sanitized) rows[key] = sanitized;
  }

  for (const insight of inputRows) {
    const match = insightKeys(insight).map((key) => matchIndex.get(key)).find(Boolean);
    if (!match) {
      warnings.push({ reason: "match-not-found", matchNo: insight.matchNo || null, home: insight.homeTeamName || insight.home || null, away: insight.awayTeamName || insight.away || null });
      continue;
    }
    const payload = normalizeInsight(insight, match, updatedAt);
    rows[payload.sourceMatchId || payload.matchId] = payload;
  }

  const externalMatches = { ...(external.matches || {}) };
  for (const payload of Object.values(rows)) {
    if (!payload || typeof payload !== "object") continue;
    const aliases = Array.from(new Set([
      payload.sourceMatchId,
      payload.matchId,
      payload.matchNo,
      teamDateKey(payload.homeTeamName, payload.awayTeamName, payload.kickoffTime),
    ].filter(Boolean)));
    const primaryKey = aliases.find((key) => externalMatches[key]) || payload.sourceMatchId || aliases[0];
    const existing = externalMatches[primaryKey] || {};
    const next = {
      ...existing,
      source: Array.from(new Set(norm(existing.source || external.source || "external-signals").split("+").concat("web-consensus"))).filter(Boolean).join("+"),
      updatedAt,
      webConsensus: payload,
    };
    externalMatches[primaryKey] = next;
    for (const alias of aliases) {
      if (alias && !externalMatches[alias]) externalMatches[alias] = next;
    }
  }

  const output = {
    version: 2,
    source: "web-consensus",
    updatedAt,
    count: Object.keys(rows).length,
    matches: rows,
    summary: {
      rows: Object.keys(rows).length,
      usable: 0,
      numericEligible: 0,
      riskOnly: 0,
      advisoryDisplay: Object.values(rows).filter((row) => row.eligibleForRiskDisplay === true).length,
      auditOnly: Object.values(rows).filter((row) => row.eligibleForRiskDisplay !== true).length,
      warnings: warnings.slice(0, 20),
      promotionAuthority: {
        valid: PROMOTION_AUTHORITY.valid,
        manifestHash: PROMOTION_AUTHORITY.manifestHash,
        blockers: PROMOTION_AUTHORITY.blockers,
      },
    },
  };

  const nextExternal = {
    ...external,
    version: external.version || 1,
    source: Array.from(new Set(norm(external.source || "external-signals").split("+").concat("web-consensus"))).filter(Boolean).join("+"),
    updatedAt,
    count: Object.keys(externalMatches).length,
    matches: externalMatches,
    sources: {
      ...(external.sources || {}),
      webConsensus: {
        updatedAt,
        rows: output.count,
        usable: output.summary.usable,
        warnings: output.summary.warnings,
      },
    },
  };

  writeJson(OUTPUT_FILE, output);
  writeJson(EXTERNAL_SIGNALS_FILE, nextExternal);
  console.log(JSON.stringify({ ok: true, ...output.summary, output: path.relative(rootDir, OUTPUT_FILE) }, null, 2));
};

if (require.main === module) {
  main();
} else {
  module.exports = {
    normalizeInsight,
    sanitizeStoredConsensusRow,
    sourceItems,
  };
}
