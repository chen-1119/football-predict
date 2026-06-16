const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.join(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const dataDir = path.join(publicDir, "data");

const CURRENT_MATCHES_FILE = path.join(dataDir, "matches-current.json");
const HISTORY_MATCHES_FILE = path.join(dataDir, "matches-history.json");
const EXTERNAL_SIGNALS_FILE = path.join(dataDir, "external-signals.json");
const OUTPUT_FILE = path.join(dataDir, "pre-match-signals.json");

const nowIso = () => new Date().toISOString();

const readJson = (filePath, fallback) => {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    console.warn(`[syncPreMatchSignals] failed to read ${filePath}: ${error.message}`);
    return fallback;
  }
};

const writeJson = (filePath, value) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const norm = (value) => String(value || "").trim();

const num = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const round = (value, digits = 0) => {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const multi = (zh, en = zh) => ({ zh, en });

const matchKeys = (match) => Array.from(new Set([
  norm(match.sourceMatchId),
  norm(match.id).replace(/^sporttery_/, ""),
  norm(match.externalSignals?.sourceMatchId),
  norm(match.externalSignals?.fiveHundred?.sourceMatchId),
  norm(match.externalSignals?.fiveHundred?.infoMatchId),
  norm(match.externalSignals?.fiveHundred?.fixtureId),
  norm(match.matchNo),
  `${norm(match.homeTeamName || match.homeTeamId)}__${norm(match.awayTeamName || match.awayTeamId)}__${norm(match.kickoffTime).slice(0, 10)}`
].filter(Boolean)));

const findSignal = (externalMatches, match) => {
  for (const key of matchKeys(match)) {
    if (externalMatches[key]) return { key, signal: externalMatches[key] };
  }
  return { key: matchKeys(match)[0] || norm(match.id), signal: {} };
};

const teamNames = (match, side) => {
  const id = side === "home" ? match.homeTeamId : match.awayTeamId;
  const zh = side === "home" ? match.homeTeamName : match.awayTeamName;
  const en = side === "home" ? match.homeTeamNameEn : match.awayTeamNameEn;
  return Array.from(new Set([norm(id), norm(zh), norm(en)].filter(Boolean)));
};

const buildCardHistory = (historyMatches) => {
  const byTeam = new Map();
  const add = (teamName, stat) => {
    if (!teamName) return;
    const key = norm(teamName).toLowerCase();
    const current = byTeam.get(key) || {
      key,
      teamName,
      matches: 0,
      yellowCards: 0,
      redCards: 0,
      fouls: 0,
      corners: 0,
      cardRows: 0,
      xgFor: 0,
      xgAgainst: 0,
      xgRows: 0
    };
    const yellowCards = num(stat.yellowCards);
    const redCards = num(stat.redCards);
    const fouls = num(stat.fouls);
    const corners = num(stat.corners);
    const xgFor = num(stat.xgFor);
    const xgAgainst = num(stat.xgAgainst);
    current.matches += 1;
    if ([yellowCards, redCards, fouls].some((value) => value !== null)) {
      current.cardRows += 1;
      current.yellowCards += yellowCards || 0;
      current.redCards += redCards || 0;
      current.fouls += fouls || 0;
    }
    if (corners !== null) {
      current.corners += corners;
    }
    if (xgFor !== null && xgAgainst !== null) {
      current.xgFor += xgFor;
      current.xgAgainst += xgAgainst;
      current.xgRows += 1;
    }
    byTeam.set(key, current);
  };

  for (const match of historyMatches || []) {
    if (match.status !== "FINISHED") continue;
    const stats = match.stats || {};
    add(match.homeTeamName || match.homeTeamId, {
      yellowCards: stats.yellowCards?.home,
      redCards: stats.redCards?.home,
      fouls: stats.fouls?.home,
      corners: stats.corners?.home,
      xgFor: stats.xG?.home,
      xgAgainst: stats.xG?.away
    });
    add(match.awayTeamName || match.awayTeamId, {
      yellowCards: stats.yellowCards?.away,
      redCards: stats.redCards?.away,
      fouls: stats.fouls?.away,
      corners: stats.corners?.away,
      xgFor: stats.xG?.away,
      xgAgainst: stats.xG?.home
    });
  }

  return byTeam;
};

const selectTeamHistory = (index, names) => {
  for (const name of names) {
    const item = index.get(norm(name).toLowerCase());
    if (item) return item;
  }
  return null;
};

const average = (total, count, digits = 2) => count > 0 ? round(total / count, digits) : null;

const component = ({ key, label, status, score, source, note }) => ({
  key,
  label,
  status,
  score: Math.round(clamp(score, 0, 100)),
  source: source || "missing",
  note
});

const componentStatus = (available, verified, estimated = false) => {
  if (verified) return "verified";
  if (available && estimated) return "estimated";
  if (available) return "partial";
  return "missing";
};

const scoreComponent = (status, base = 0) => {
  if (status === "verified") return 100;
  if (status === "partial") return Math.max(58, base || 62);
  if (status === "estimated") return Math.max(42, base || 48);
  return 0;
};

const statusConnected = (status) => status === "verified" || status === "partial" || status === "estimated";

const buildQuality = ({ match, signal, teamHistory }) => {
  const referee = signal.referee || {};
  const lineups = signal.lineups || {};
  const injuries = signal.injuries || {};
  const xg = signal.expectedGoals || {};
  const weather = signal.weather || {};
  const fiveHundred = signal.fiveHundred || {};
  const marketAvailable = Boolean(
    match.odds
    || match.handicapOdds
    || signal.externalOdds
    || signal.bookmakerOdds?.had
    || signal.bookmakerOdds?.hhad
    || fiveHundred.europeOdds?.currentAverage
  );
  const rankingAvailable = Boolean(
    match.homeRank
    || match.awayRank
    || fiveHundred.rank?.home?.fifaRank
    || fiveHundred.rank?.away?.fifaRank
    || signal.worldCupPrior
    || match.worldCupPrior
  );
  const stageAvailable = Boolean(fiveHundred.futureSchedule?.home || fiveHundred.futureSchedule?.away || signal.buyEndTime || match.buyEndTime);
  const refereeVerified = Boolean(referee.name || num(referee.cardsPerMatch) !== null || num(referee.penaltiesPerMatch) !== null);
  const lineupAvailable = Boolean(
    lineups.summary?.zh
    || lineups.summary?.en
    || lineups.homeFormation
    || lineups.awayFormation
  );
  const injuryAvailable = Boolean(
    injuries.summary?.zh
    || injuries.summary?.en
    || (Array.isArray(injuries.home) && injuries.home.length)
    || (Array.isArray(injuries.away) && injuries.away.length)
  );
  const xgAvailable = Boolean(
    num(xg.homeXg) !== null
    || num(xg.awayXg) !== null
    || num(xg.homeXga) !== null
    || num(xg.awayXga) !== null
  );
  const historyHome = teamHistory.home;
  const historyAway = teamHistory.away;
  const teamCardsAvailable = Boolean(historyHome?.cardRows >= 5 && historyAway?.cardRows >= 5);
  const weatherAvailable = Boolean(
    weather.summary?.zh
    || weather.summary?.en
    || weather.condition?.zh
    || weather.condition?.en
    || num(weather.temperatureC) !== null
    || num(weather.windKph) !== null
  );
  const weatherVerified = Boolean(weatherAvailable && weather.verified !== false && weather.confidence !== "estimated-location");
  const xgHistoryAvailable = Boolean(historyHome?.xgRows >= 5 && historyAway?.xgRows >= 5);

  const components = {
    referee: component({
      key: "referee",
      label: multi("裁判牌数", "Referee cards"),
      status: componentStatus(refereeVerified, refereeVerified),
      score: scoreComponent(refereeVerified ? "verified" : "missing"),
      source: refereeVerified ? (referee.source || signal.source || "external") : "missing",
      note: refereeVerified
        ? multi(`裁判 ${referee.name || "--"}，场均牌 ${referee.cardsPerMatch ?? "--"}`, `Referee ${referee.name || "--"}, cards ${referee.cardsPerMatch ?? "--"}`)
        : multi("未接入真实裁判牌数", "No verified referee card profile")
    }),
    teamCards: component({
      key: "teamCards",
      label: multi("球队牌数历史", "Team card history"),
      status: componentStatus(teamCardsAvailable, false, teamCardsAvailable),
      score: scoreComponent(teamCardsAvailable ? "estimated" : "missing", teamCardsAvailable ? 52 : 0),
      source: teamCardsAvailable ? "local-history-stats" : "missing",
      note: teamCardsAvailable
        ? multi(`牌数样本 ${historyHome.cardRows}/${historyAway.cardRows} 场，黄牌均值 ${average(historyHome.yellowCards, historyHome.cardRows, 1)}/${average(historyAway.yellowCards, historyAway.cardRows, 1)}`, `Card sample ${historyHome.cardRows}/${historyAway.cardRows}, yellow avg ${average(historyHome.yellowCards, historyHome.cardRows, 1)}/${average(historyAway.yellowCards, historyAway.cardRows, 1)}`)
        : multi("未形成可用球队黄红牌样本", "No usable team card sample")
    }),
    lineup: component({
      key: "lineup",
      label: multi("首发/预计阵容", "Lineup"),
      status: componentStatus(lineupAvailable, false, lineupAvailable),
      score: scoreComponent(lineupAvailable ? "partial" : "missing", 62),
      source: lineupAvailable ? (lineups.source || "500.com/projected") : "missing",
      note: lineupAvailable
        ? (lineups.summary || multi("已接入预计名单", "Projected lineup loaded"))
        : multi("未接入首发或预计名单", "No lineup or projected XI")
    }),
    injuries: component({
      key: "injuries",
      label: multi("伤停", "Injuries"),
      status: componentStatus(injuryAvailable, false, injuryAvailable),
      score: scoreComponent(injuryAvailable ? "partial" : "missing", 58),
      source: injuryAvailable ? (injuries.source || "external") : "missing",
      note: injuryAvailable
        ? (injuries.summary || multi(`伤停条目 ${(injuries.home || []).length}/${(injuries.away || []).length}`, `Injury rows ${(injuries.home || []).length}/${(injuries.away || []).length}`))
        : multi("未接入伤停", "No injury signal")
    }),
    xg: component({
      key: "xg",
      label: multi("xG/xGA", "xG/xGA"),
      status: componentStatus(xgAvailable || xgHistoryAvailable, xgAvailable, xgHistoryAvailable && !xgAvailable),
      score: scoreComponent(xgAvailable ? "verified" : xgHistoryAvailable ? "estimated" : "missing", xgHistoryAvailable ? 54 : 0),
      source: xgAvailable ? (xg.source || "external-xg") : xgHistoryAvailable ? "local-history-xg" : "missing",
      note: xgAvailable
        ? (xg.summary || multi(`xG ${xg.homeXg ?? "--"}:${xg.awayXg ?? "--"}`, `xG ${xg.homeXg ?? "--"}:${xg.awayXg ?? "--"}`))
        : xgHistoryAvailable
          ? multi(`历史xG均值 ${average(historyHome.xgFor, historyHome.xgRows, 2)}:${average(historyAway.xgFor, historyAway.xgRows, 2)}`, `Historical xG avg ${average(historyHome.xgFor, historyHome.xgRows, 2)}:${average(historyAway.xgFor, historyAway.xgRows, 2)}`)
          : multi("未接入赛前 xG/xGA", "No pre-match xG/xGA")
    }),
    weather: component({
      key: "weather",
      label: multi("天气/场地", "Weather/pitch"),
      status: componentStatus(weatherAvailable, weatherVerified, weatherAvailable && !weatherVerified),
      score: scoreComponent(weatherVerified ? "verified" : weatherAvailable ? "estimated" : "missing", 48),
      source: weatherAvailable ? (weather.source || "weather") : "missing",
      note: weatherAvailable
        ? (weather.summary || multi("天气字段已接入", "Weather fields loaded"))
        : multi("未接入天气/场地", "No weather or pitch signal")
    }),
    market: component({
      key: "market",
      label: multi("盘口校验", "Market validation"),
      status: componentStatus(marketAvailable, Boolean(match.odds || match.handicapOdds), marketAvailable && !match.odds && !match.handicapOdds),
      score: scoreComponent(match.odds || match.handicapOdds ? "verified" : marketAvailable ? "partial" : "missing"),
      source: match.odds || match.handicapOdds ? "sporttery" : marketAvailable ? "external-odds" : "missing",
      note: marketAvailable ? multi("已有胜平负/让球盘口校验源", "Market validation source available") : multi("缺少盘口校验源", "No market validation source")
    }),
    motivation: component({
      key: "motivation",
      label: multi("排名/战意", "Table/motivation"),
      status: componentStatus(rankingAvailable || stageAvailable, rankingAvailable && stageAvailable, (rankingAvailable || stageAvailable) && !(rankingAvailable && stageAvailable)),
      score: scoreComponent(rankingAvailable && stageAvailable ? "verified" : rankingAvailable || stageAvailable ? "partial" : "missing"),
      source: rankingAvailable || stageAvailable ? "rank-stage-context" : "missing",
      note: rankingAvailable || stageAvailable ? multi("已接入排名或赛程阶段信息", "Rank or stage context loaded") : multi("缺少排名/赛程阶段信息", "No table or stage context")
    })
  };

  const weights = {
    referee: 10,
    teamCards: 10,
    lineup: 15,
    injuries: 15,
    xg: 14,
    weather: 6,
    market: 18,
    motivation: 12
  };
  const weightedScore = Object.entries(weights).reduce((sum, [key, weight]) => {
    return sum + (components[key].score * weight) / 100;
  }, 0);
  const score = Math.round(clamp(weightedScore, 0, 100));
  const missing = Object.values(components)
    .filter((item) => item.status === "missing")
    .map((item) => ({
      key: item.key,
      zh: `缺少${item.label.zh}`,
      en: `Missing ${item.label.en}`,
      severity: item.key === "lineup" || item.key === "injuries" || item.key === "market" ? "high" : "medium",
      weight: weights[item.key] || 5
    }));
  const lowQuality = Object.values(components)
    .filter((item) => item.status === "estimated")
    .map((item) => item.key);
  const severeMissingCount = missing.filter((item) => item.severity === "high").length;
  const sourceQuality = score >= 74 && severeMissingCount === 0
    ? "high"
    : score >= 52 && severeMissingCount <= 1
      ? "medium"
      : "low";
  const trustPenalty = Math.round(clamp(
    (sourceQuality === "low" ? 6 : sourceQuality === "medium" ? 3 : 0)
    + severeMissingCount * 2
    + lowQuality.length * 0.75,
    0,
    18
  ));

  return {
    version: "pre-match-quality-v50",
    score,
    sourceQuality,
    severeMissingCount,
    trustPenalty,
    components,
    missing,
    lowQuality,
    connected: Object.fromEntries(Object.entries(components).map(([key, value]) => [key, statusConnected(value.status)])),
    summary: {
      zh: `赛前数据质量 ${score}/100，${sourceQuality === "high" ? "覆盖较好" : sourceQuality === "medium" ? "部分覆盖" : "缺口偏多"}。`,
      en: `Pre-match data quality ${score}/100, ${sourceQuality} coverage.`
    }
  };
};

const buildDisciplineFromQuality = (teamHistory, quality) => {
  const home = teamHistory.home;
  const away = teamHistory.away;
  if (!home || !away || home.cardRows < 5 || away.cardRows < 5) return null;
  const homeYellow = average(home.yellowCards, home.cardRows, 2);
  const awayYellow = average(away.yellowCards, away.cardRows, 2);
  const homeRed = average(home.redCards, home.cardRows, 3);
  const awayRed = average(away.redCards, away.cardRows, 3);
  const totalYellow = round((homeYellow || 0) + (awayYellow || 0), 2);
  const redRiskTotal = round(clamp((homeRed || 0) + (awayRed || 0), 0.02, 0.38), 3);
  return {
    source: "local-history-stats",
    dataQuality: "estimated-history",
    homeCardsPerMatch: homeYellow,
    awayCardsPerMatch: awayYellow,
    expectedYellowCards: { home: homeYellow, away: awayYellow, total: totalYellow },
    redCardRisk: { home: homeRed, away: awayRed, total: redRiskTotal },
    sample: { home: home.cardRows, away: away.cardRows },
    trustPenalty: quality.components.teamCards.status === "estimated" ? 1 : 0,
    summary: multi(
      `历史牌数样本 ${home.cardRows}/${away.cardRows} 场，黄牌均值 ${homeYellow}/${awayYellow}。`,
      `Card-history sample ${home.cardRows}/${away.cardRows}, yellow avg ${homeYellow}/${awayYellow}.`
    )
  };
};

const main = () => {
  const updatedAt = nowIso();
  const matches = readJson(CURRENT_MATCHES_FILE, []);
  const history = readJson(HISTORY_MATCHES_FILE, []);
  const external = readJson(EXTERNAL_SIGNALS_FILE, { version: 1, source: "external-signals", matches: {}, sources: {} });
  const externalMatches = { ...(external.matches || {}) };
  const teamHistoryIndex = buildCardHistory(history);
  const preMatchRows = {};
  const warnings = [];

  for (const match of matches) {
    const { key, signal } = findSignal(externalMatches, match);
    const teamHistory = {
      home: selectTeamHistory(teamHistoryIndex, teamNames(match, "home")),
      away: selectTeamHistory(teamHistoryIndex, teamNames(match, "away"))
    };
    const quality = buildQuality({ match, signal, teamHistory });
    const discipline = buildDisciplineFromQuality(teamHistory, quality);
    const payload = {
      version: "sync-pre-match-signals-v50",
      source: "pre-match-signal-layer",
      updatedAt,
      sourceMatchId: norm(match.sourceMatchId) || norm(match.id).replace(/^sporttery_/, ""),
      matchId: match.id,
      matchNo: match.matchNo,
      kickoffTime: match.kickoffTime,
      homeTeamName: match.homeTeamName,
      awayTeamName: match.awayTeamName,
      quality,
      ...(discipline ? { discipline } : {}),
      qualitySummary: quality.summary
    };
    preMatchRows[payload.sourceMatchId || match.id] = payload;
    const existingSignal = signal && typeof signal === "object" ? signal : {};
    const nextSignal = {
      ...existingSignal,
      source: Array.from(new Set(String(existingSignal.source || "external-signals").split("+").concat("pre-match-signals"))).filter(Boolean).join("+"),
      updatedAt: existingSignal.updatedAt || updatedAt,
      preMatch: payload,
      ...(discipline ? { discipline: { ...(existingSignal.discipline || {}), ...discipline } } : {})
    };
    externalMatches[key] = nextSignal;
    const sourceId = payload.sourceMatchId;
    if (sourceId && key !== sourceId && !externalMatches[sourceId]) externalMatches[sourceId] = nextSignal;
    if (quality.sourceQuality === "low") {
      warnings.push({
        matchId: match.id,
        sourceMatchId: sourceId,
        homeTeamName: match.homeTeamName,
        awayTeamName: match.awayTeamName,
        score: quality.score,
        missing: quality.missing.slice(0, 4).map((item) => item.key)
      });
    }
  }

  const output = {
    version: 1,
    source: "pre-match-signal-layer",
    updatedAt,
    count: Object.keys(preMatchRows).length,
    matches: preMatchRows,
    summary: {
      rows: Object.keys(preMatchRows).length,
      high: Object.values(preMatchRows).filter((row) => row.quality.sourceQuality === "high").length,
      medium: Object.values(preMatchRows).filter((row) => row.quality.sourceQuality === "medium").length,
      low: Object.values(preMatchRows).filter((row) => row.quality.sourceQuality === "low").length,
      warnings: warnings.slice(0, 20)
    }
  };
  const nextExternal = {
    ...external,
    version: external.version || 1,
    source: Array.from(new Set(String(external.source || "external-signals").split("+").concat("pre-match-signals"))).filter(Boolean).join("+"),
    updatedAt,
    count: Object.keys(externalMatches).length,
    matches: externalMatches,
    sources: {
      ...(external.sources || {}),
      preMatchSignals: {
        updatedAt,
        rows: output.count,
        summary: output.summary
      }
    }
  };

  writeJson(OUTPUT_FILE, output);
  writeJson(EXTERNAL_SIGNALS_FILE, nextExternal);
  console.log(JSON.stringify({ ok: true, ...output.summary, output: path.relative(rootDir, OUTPUT_FILE) }, null, 2));
};

main();
