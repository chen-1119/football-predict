const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT_DIR = path.resolve(__dirname, "..");
const CURRENT_FILE = path.join(ROOT_DIR, "public", "data", "matches-current.json");
const HISTORY_FILE = path.join(ROOT_DIR, "public", "data", "matches-history.json");
const SOURCE_FILE = path.join(ROOT_DIR, "scripts", "data", "official-club-result-sources.json");
const OUTPUT_FILE = path.join(ROOT_DIR, "public", "data", "official-club-results.json");
const VERSION = "official-club-results-v1";
const RESULT_PROVIDER = "official-club";
const RESULT_SOURCE = "official-club:result-page";
const RESULT_SOURCE_KIND = "official-club-result-page";
const SOURCE_VERSION = "official-club-result-sources-v1";
const REQUEST_TIMEOUT_MS = Math.max(5_000, Number(process.env.OFFICIAL_CLUB_RESULT_TIMEOUT_MS || 20_000));
const MAX_RESPONSE_BYTES = Math.max(256 * 1024, Number(process.env.OFFICIAL_CLUB_RESULT_MAX_BYTES || 2 * 1024 * 1024));
const ALLOWED_HOSTS = new Set(["www.aikfotboll.se", "www.rbk.no"]);

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const canonicalSourceMatchId = (value) => String(value || "").replace(/^sporttery_/, "").trim();

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};

const writeJsonAtomic = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
};

const canonicalInstant = (value) => {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

const allowedOfficialClubUrl = (value) => {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && ALLOWED_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
};

const loadSourceManifest = (file = SOURCE_FILE) => {
  const manifest = readJson(file, null);
  if (manifest?.version !== SOURCE_VERSION || !Array.isArray(manifest.sources)) {
    throw new Error("official club result source manifest is invalid");
  }
  const seen = new Set();
  for (const source of manifest.sources) {
    const sourceMatchId = canonicalSourceMatchId(source?.sourceMatchId);
    if (!sourceMatchId || seen.has(sourceMatchId)) {
      throw new Error(`official club result source id is invalid or duplicated: ${sourceMatchId || "missing"}`);
    }
    if (
      !allowedOfficialClubUrl(source?.sourceUrl)
      || !canonicalInstant(source?.providerKickoffTime)
      || !["aik-game-page", "ntf-match-page"].includes(source?.adapter)
      || !Array.isArray(source?.requiredTokens)
      || source.requiredTokens.length < 3
    ) {
      throw new Error(`official club result source is incomplete: ${sourceMatchId}`);
    }
    seen.add(sourceMatchId);
  }
  return manifest;
};

const decodeHtml = (value) => String(value || "")
  .replace(/&amp;/g, "&")
  .replace(/&quot;/g, "\"")
  .replace(/&#39;/g, "'")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">");

const assertRequiredTokens = (html, source) => {
  const missing = source.requiredTokens.filter((token) => !html.includes(token));
  if (missing.length) throw new Error(`required page identity missing: ${missing.join(", ")}`);
};

const parseAikGamePage = (html, source) => {
  assertRequiredTokens(html, source);
  const title = decodeHtml(html.match(/<title>([^<]+)<\/title>/i)?.[1]);
  const scoreMatches = [...html.matchAll(/>(\d+)<!-- -->\s*-\s*<!-- -->(\d+)<\/span>/g)];
  if (
    !title.includes(`${source.providerHomeTeamName} - ${source.providerAwayTeamName}`)
    || scoreMatches.length !== 1
  ) {
    throw new Error("AIK official result page did not prove one ordered final score");
  }
  return {
    scoreHome: Number(scoreMatches[0][1]),
    scoreAway: Number(scoreMatches[0][2]),
    pageTitle: title,
    statusEvidence: "Spelad match",
  };
};

const parseNtfMatchPage = (html, source) => {
  assertRequiredTokens(html, source);
  const title = decodeHtml(html.match(/<title>([^<]+)<\/title>/i)?.[1]);
  const scoreMatches = [...html.matchAll(
    /<td>Sluttresultat<\/td>\s*<td>\s*(\d+)\s*-\s*(\d+)\s*<\/td>/gi
  )];
  if (
    !title.includes(`${source.providerHomeTeamName} - ${source.providerAwayTeamName}`)
    || scoreMatches.length !== 1
  ) {
    throw new Error("NTF official result page did not prove one ordered final score");
  }
  return {
    scoreHome: Number(scoreMatches[0][1]),
    scoreAway: Number(scoreMatches[0][2]),
    pageTitle: title,
    statusEvidence: "Sluttresultat",
  };
};

const parseOfficialClubPage = (html, source) => {
  if (source.adapter === "aik-game-page") return parseAikGamePage(html, source);
  if (source.adapter === "ntf-match-page") return parseNtfMatchPage(html, source);
  throw new Error(`unsupported official club result adapter: ${source.adapter}`);
};

const evidenceHashForRecord = (record) => sha256(JSON.stringify({
  provider: RESULT_PROVIDER,
  providerMatchId: String(record?.providerMatchId || ""),
  sourceMatchId: canonicalSourceMatchId(record?.sourceMatchId),
  eventVersion: record?.eventVersion || record?.kickoffTime || null,
  providerKickoff: record?.providerKickoffTime || null,
  scoreHome: Number(record?.scoreHome),
  scoreAway: Number(record?.scoreAway),
  scoreKind: "regular-time",
  sourceUrl: record?.sourceUrl || null,
  responseSha256: record?.responseSha256 || null,
}));

const validOfficialClubEvidenceForMatch = (match, record) => {
  const sourceMatchId = canonicalSourceMatchId(match?.sourceMatchId || match?.id);
  const recordSourceMatchId = canonicalSourceMatchId(record?.sourceMatchId);
  const eventVersion = canonicalInstant(match?.eventVersion || match?.kickoffTime);
  const recordVersion = canonicalInstant(record?.eventVersion || record?.kickoffTime);
  const providerKickoff = canonicalInstant(record?.providerKickoffTime);
  const observedAt = canonicalInstant(record?.observedAt);
  const scoreHome = Number(record?.scoreHome);
  const scoreAway = Number(record?.scoreAway);
  return Boolean(
    match
    && record
    && record.version === VERSION
    && record.provider === RESULT_PROVIDER
    && record.source === RESULT_SOURCE
    && record.sourceKind === RESULT_SOURCE_KIND
    && record.status === "FINISHED"
    && record.scoreKind === "regular-time"
    && record.official === true
    && record.trusted === true
    && record.settlementEligible === true
    && record.promotionEligible === false
    && record.resultObservationFallback === false
    && sourceMatchId
    && recordSourceMatchId === sourceMatchId
    && eventVersion
    && recordVersion === eventVersion
    && providerKickoff === eventVersion
    && observedAt
    && Date.parse(observedAt) >= Date.parse(eventVersion)
    && allowedOfficialClubUrl(record.sourceUrl)
    && Number.isInteger(scoreHome)
    && scoreHome >= 0
    && Number.isInteger(scoreAway)
    && scoreAway >= 0
    && /^[a-f0-9]{64}$/.test(String(record.responseSha256 || ""))
    && /^[a-f0-9]{64}$/.test(String(record.evidenceHash || ""))
    && record.evidenceHash === evidenceHashForRecord(record)
  );
};

const buildEvidenceRecord = (match, source, parsed, response, observedAt, previous = null) => {
  const sourceMatchId = canonicalSourceMatchId(match?.sourceMatchId || match?.id);
  const eventVersion = canonicalInstant(match?.eventVersion || match?.kickoffTime);
  const providerKickoffTime = canonicalInstant(source.providerKickoffTime);
  if (!eventVersion || providerKickoffTime !== eventVersion) {
    throw new Error(`official club result clock mismatch: ${sourceMatchId}`);
  }
  const samePreviousScore = previous
    && Number(previous.scoreHome) === parsed.scoreHome
    && Number(previous.scoreAway) === parsed.scoreAway;
  const priorRevision = Math.max(0, Number(previous?.resultRevision || 0));
  const record = {
    version: VERSION,
    provider: RESULT_PROVIDER,
    source: RESULT_SOURCE,
    sourceKind: RESULT_SOURCE_KIND,
    providerHost: new URL(source.sourceUrl).hostname.toLowerCase(),
    providerMatchId: String(source.providerMatchId),
    sourceMatchId,
    matchId: match?.id || null,
    kickoffTime: match?.kickoffTime || null,
    eventVersion,
    providerKickoffTime,
    homeTeamName: match?.homeTeamName || null,
    awayTeamName: match?.awayTeamName || null,
    providerHomeTeamName: source.providerHomeTeamName,
    providerAwayTeamName: source.providerAwayTeamName,
    scoreHome: parsed.scoreHome,
    scoreAway: parsed.scoreAway,
    scoreText: `${parsed.scoreHome}:${parsed.scoreAway}`,
    scoreKind: "regular-time",
    status: "FINISHED",
    observedAt,
    firstObservedAt: samePreviousScore
      ? (previous.firstObservedAt || previous.observedAt || observedAt)
      : observedAt,
    observationSource: "official-club-page-response-received-at",
    resultObservationFallback: false,
    official: true,
    trusted: true,
    settlementEligible: true,
    promotionEligible: false,
    resultRevision: samePreviousScore ? Math.max(1, priorRevision) : Math.max(1, priorRevision + 1),
    sourceUrl: response.url,
    adapter: source.adapter,
    pageTitle: parsed.pageTitle,
    statusEvidence: parsed.statusEvidence,
    responseSha256: response.responseSha256,
  };
  return { ...record, evidenceHash: evidenceHashForRecord(record) };
};

const loadOfficialClubResults = (file = OUTPUT_FILE) => {
  const payload = readJson(file, { version: VERSION, matches: {} });
  return payload?.version === VERSION && payload?.matches && typeof payload.matches === "object"
    ? payload
    : { version: VERSION, matches: {} };
};

const applyOfficialClubResult = (match, store) => {
  if (
    !match
    || match?.resultProvenance?.provider === "sporttery"
    || match?.resultProvenance?.provider === "uefa"
  ) return match;
  const sourceMatchId = canonicalSourceMatchId(match?.sourceMatchId || match?.id);
  const record = store?.matches?.[sourceMatchId];
  if (!validOfficialClubEvidenceForMatch(match, record)) return match;
  return {
    ...match,
    status: "FINISHED",
    sourceStatus: "FINISHED",
    effectiveStatus: "FINISHED",
    statusReason: "trusted-official-club-result",
    scoreHome: Number(record.scoreHome),
    scoreAway: Number(record.scoreAway),
    resultSource: RESULT_SOURCE,
    resultObservedAt: record.observedAt,
    resultObservationSource: record.observationSource,
    resultObservationFallback: false,
    resultUpdatedAt: record.observedAt,
    settledAt: match?.settledAt || record.observedAt,
    resultProvenance: {
      version: "trusted-official-result-provenance-v2",
      provider: RESULT_PROVIDER,
      source: RESULT_SOURCE,
      sourceKind: RESULT_SOURCE_KIND,
      sourceUrl: record.sourceUrl,
      providerMatchId: record.providerMatchId,
      sourceMatchId,
      eventVersion: record.eventVersion,
      providerKickoffTime: record.providerKickoffTime,
      scoreKind: "regular-time",
      official: true,
      trusted: true,
      observedAt: record.observedAt,
      observationSource: record.observationSource,
      resultObservationFallback: false,
      responseSha256: record.responseSha256,
      evidenceHash: record.evidenceHash,
      resultRevision: record.resultRevision,
      promotionEligible: false,
    },
  };
};

const isTrustedOfficialClubResult = (match) => {
  const provenance = match?.resultProvenance;
  return validOfficialClubEvidenceForMatch(match, {
    version: VERSION,
    provider: provenance?.provider,
    source: provenance?.source,
    sourceKind: provenance?.sourceKind,
    sourceUrl: provenance?.sourceUrl,
    providerMatchId: provenance?.providerMatchId,
    sourceMatchId: provenance?.sourceMatchId,
    eventVersion: provenance?.eventVersion,
    providerKickoffTime: provenance?.providerKickoffTime,
    scoreHome: match?.scoreHome,
    scoreAway: match?.scoreAway,
    scoreKind: provenance?.scoreKind,
    status: match?.status,
    observedAt: provenance?.observedAt,
    resultObservationFallback: provenance?.resultObservationFallback,
    official: provenance?.official,
    trusted: provenance?.trusted,
    settlementEligible: true,
    promotionEligible: provenance?.promotionEligible === false ? false : null,
    responseSha256: provenance?.responseSha256,
    evidenceHash: provenance?.evidenceHash,
  });
};

const fetchOfficialPage = async (source) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(source.sourceUrl, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "football-predict/official-club-results-v1",
      },
    });
    if (!response.ok || !allowedOfficialClubUrl(response.url)) {
      throw new Error(`official club result page returned HTTP ${response.status}`);
    }
    const raw = Buffer.from(await response.arrayBuffer());
    if (raw.length > MAX_RESPONSE_BYTES) throw new Error("official club result page exceeded configured byte limit");
    return {
      url: response.url,
      raw,
      html: raw.toString("utf8"),
      responseSha256: sha256(raw),
    };
  } finally {
    clearTimeout(timeout);
  }
};

const syncOfficialClubResults = async (options = {}) => {
  const currentFile = path.resolve(options.currentFile || CURRENT_FILE);
  const historyFile = path.resolve(options.historyFile || HISTORY_FILE);
  const outputFile = path.resolve(options.outputFile || OUTPUT_FILE);
  const manifest = options.manifest || loadSourceManifest(options.sourceFile || SOURCE_FILE);
  const current = readJson(currentFile, []);
  const history = readJson(historyFile, []);
  const matches = [...(Array.isArray(current) ? current : []), ...(Array.isArray(history) ? history : [])];
  const bySourceId = new Map(matches.map((match) => [
    canonicalSourceMatchId(match?.sourceMatchId || match?.id),
    match,
  ]));
  const existing = loadOfficialClubResults(outputFile);
  const nextMatches = { ...(existing.matches || {}) };
  const observedAt = new Date(
    Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now()
  ).toISOString();
  const rejections = [];
  let matched = 0;

  for (const source of manifest.sources) {
    const sourceMatchId = canonicalSourceMatchId(source.sourceMatchId);
    const match = bySourceId.get(sourceMatchId);
    if (!match) {
      rejections.push({ sourceMatchId, reason: "fixture-not-found-in-current-or-history" });
      continue;
    }
    try {
      const response = options.responses?.[sourceMatchId] || await fetchOfficialPage(source);
      const parsed = parseOfficialClubPage(response.html, source);
      const record = buildEvidenceRecord(
        match,
        source,
        parsed,
        response,
        observedAt,
        nextMatches[sourceMatchId] || null,
      );
      if (!validOfficialClubEvidenceForMatch(match, record)) {
        throw new Error("constructed official club result evidence failed validation");
      }
      nextMatches[sourceMatchId] = record;
      matched += 1;
    } catch (error) {
      rejections.push({ sourceMatchId, reason: error.message || String(error) });
    }
  }

  const payload = {
    version: VERSION,
    source: RESULT_SOURCE,
    sourceKind: RESULT_SOURCE_KIND,
    checkedAt: observedAt,
    manifestVersion: manifest.version,
    manifestSha256: sha256(JSON.stringify(manifest)),
    summary: {
      configured: manifest.sources.length,
      matched,
      rejected: rejections.length,
      preserved: Object.keys(nextMatches).length - matched,
    },
    rejections,
    matches: nextMatches,
  };
  writeJsonAtomic(outputFile, payload);
  return payload;
};

if (require.main === module) {
  syncOfficialClubResults()
    .then((payload) => console.log(JSON.stringify({
      ok: payload.summary.rejected === 0,
      verifier: VERSION,
      checkedAt: payload.checkedAt,
      summary: payload.summary,
      outputFile: path.relative(ROOT_DIR, OUTPUT_FILE).replace(/\\/g, "/"),
      rejections: payload.rejections,
    }, null, 2)))
    .catch((error) => {
      console.error(JSON.stringify({
        ok: false,
        verifier: VERSION,
        checkedAt: new Date().toISOString(),
        error: error.message || String(error),
      }, null, 2));
      process.exitCode = 1;
    });
}

module.exports = {
  ALLOWED_HOSTS,
  RESULT_PROVIDER,
  RESULT_SOURCE,
  RESULT_SOURCE_KIND,
  VERSION,
  allowedOfficialClubUrl,
  applyOfficialClubResult,
  buildEvidenceRecord,
  evidenceHashForRecord,
  isTrustedOfficialClubResult,
  loadOfficialClubResults,
  loadSourceManifest,
  parseOfficialClubPage,
  syncOfficialClubResults,
  validOfficialClubEvidenceForMatch,
};
