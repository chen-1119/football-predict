const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const {
  eventSafeExistingSignal,
  stampSignalEvent,
} = require("./externalSignalEventIdentity.cjs");
const { FREE_FOOTBALL_TEAM_ALIASES } = require("./freeFootballTeamAliases.cjs");

const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const dataDir = path.join(publicDir, "data");
const currentMatchesFile = path.join(dataDir, "matches-current.json");
const externalSignalsFile = path.join(dataDir, "external-signals.json");
const serverLocationsFile = path.join(rootDir, "server-data", "weather-locations.json");
const publicLocationsFile = path.join(dataDir, "weather-locations.json");

const provider = process.env.WEATHER_PROVIDER || "open-meteo";
const enabled = process.env.ENABLE_WEATHER_SYNC !== "0";
const maxMatches = Math.max(1, Number(process.env.WEATHER_MAX_MATCHES || 32));
const timeoutMs = Math.max(3000, Number(process.env.WEATHER_TIMEOUT_SECONDS || 12) * 1000);
const lookaheadDays = Math.max(1, Number(process.env.WEATHER_LOOKAHEAD_DAYS || 10));
const maxAgeMinutes = Math.max(15, Number(process.env.WEATHER_MAX_AGE_MINUTES || 180));
const enableWorldCupRotation = process.env.WEATHER_ENABLE_WORLDCUP_ROTATION !== "0";
const enableTheSportsDbVenueDiscovery = process.env.WEATHER_ENABLE_THESPORTSDB_VENUE_DISCOVERY !== "0";
const maxVenueDiscoveries = Math.max(0, Math.min(12, Number(process.env.WEATHER_VENUE_DISCOVERY_MAX_TEAMS || 4)));
const venueDiscoveryRetryMinutes = Math.max(60, Number(process.env.WEATHER_VENUE_DISCOVERY_RETRY_MINUTES || 1440));
const theSportsDbApiKey = String(process.env.THESPORTSDB_API_KEY || "123").trim() || "123";
const theSportsDbBaseUrl = `https://www.thesportsdb.com/api/v1/json/${encodeURIComponent(theSportsDbApiKey)}`;
const openMeteoGeocodingUrl = "https://geocoding-api.open-meteo.com/v1/search";

const normText = (value, fallback = "") => {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text || fallback;
};

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};

const writeJson = (file, payload) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.renameSync(temp, file);
};

const requestJson = (url) => new Promise((resolve, reject) => {
  const req = https.get(url, {
    timeout: timeoutMs,
    headers: {
      "accept": "application/json",
      "user-agent": "football-predict-weather/1.0"
    }
  }, (res) => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) {
        req.destroy(new Error("weather response too large"));
      }
    });
    res.on("end", () => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error(`${url} -> HTTP ${res.statusCode} ${body.slice(0, 160)}`));
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error(`invalid weather JSON from ${url}: ${error.message}`));
      }
    });
  });
  req.on("timeout", () => req.destroy(new Error(`weather request timed out: ${url}`)));
  req.on("error", reject);
});

const normalizeTeamLookup = (value) => normText(value)
  .normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .replace(/\b(association football club|football club|soccer club|afc|fc|cf|sc)\b/g, " ")
  .replace(/[^a-z0-9]+/g, "")
  .trim();

const teamLookupQuery = (match) => {
  const displayName = normText(match?.homeTeamName || match?.homeTeam);
  return normText(FREE_FOOTBALL_TEAM_ALIASES[displayName] || match?.homeTeamNameEn || "");
};

const venueRetryDue = (row, nowMs = Date.now()) => {
  const attemptedAtMs = Date.parse(row?.attemptedAt || "");
  if (!Number.isFinite(attemptedAtMs)) return true;
  return nowMs - attemptedAtMs >= venueDiscoveryRetryMinutes * 60_000;
};

const teamCandidateMatches = (query, team) => {
  const expected = normalizeTeamLookup(query);
  if (expected.length < 3 || normText(team?.strSport).toLowerCase() !== "soccer") return false;
  const candidates = [team?.strTeam, ...(normText(team?.strTeamAlternate).split(","))]
    .map(normalizeTeamLookup)
    .filter(Boolean);
  return candidates.some((candidate) => (
    candidate === expected
    || (expected.length >= 4 && candidate.includes(expected))
    || (candidate.length >= 4 && expected.includes(candidate))
  ));
};

const dmsToDecimal = (degrees, minutes, seconds, direction) => {
  const value = Number(degrees) + Number(minutes || 0) / 60 + Number(seconds || 0) / 3600;
  return /[SW]/i.test(direction) ? -value : value;
};

const parseVenueCoordinates = (value) => {
  const text = normText(value);
  if (!text) return null;
  const decimal = text.match(/(-?\d{1,3}(?:\.\d+)?)\s*[,;/]\s*(-?\d{1,3}(?:\.\d+)?)/);
  if (decimal) {
    const latitude = Number(decimal[1]);
    const longitude = Number(decimal[2]);
    if (Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180) {
      return { latitude, longitude };
    }
  }
  const dms = text.match(/(\d{1,3}(?:\.\d+)?)\D+(\d{1,2}(?:\.\d+)?)\D+(\d{1,2}(?:\.\d+)?)\D*([NS])\D+(\d{1,3}(?:\.\d+)?)\D+(\d{1,2}(?:\.\d+)?)\D+(\d{1,2}(?:\.\d+)?)\D*([EW])/i);
  if (!dms) return null;
  const latitude = dmsToDecimal(dms[1], dms[2], dms[3], dms[4]);
  const longitude = dmsToDecimal(dms[5], dms[6], dms[7], dms[8]);
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return { latitude, longitude };
};

const geocodeProviderLocation = async (locationText, country) => {
  const query = normText(locationText).split(",").slice(0, 2).join(", ");
  if (query.length < 3) return null;
  const params = new URLSearchParams({ name: query, count: "1", language: "en", format: "json" });
  const payload = await requestJson(`${openMeteoGeocodingUrl}?${params.toString()}`);
  const row = Array.isArray(payload?.results) ? payload.results[0] : null;
  const latitude = Number(row?.latitude);
  const longitude = Number(row?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return {
    latitude,
    longitude,
    city: normText(row?.name || query),
    country: normText(row?.country || country),
    coordinateSource: "open-meteo-geocoding",
  };
};

const discoverTeamLocation = async (match) => {
  const localTeamId = normText(match?.homeTeamId);
  const query = teamLookupQuery(match);
  if (!localTeamId || !query) return { ok: false, reason: "missing-reviewed-alias", localTeamId, query };

  const teamUrl = `${theSportsDbBaseUrl}/searchteams.php?t=${encodeURIComponent(query)}`;
  const teamPayload = await requestJson(teamUrl);
  const team = Array.isArray(teamPayload?.teams) ? teamPayload.teams.find((row) => teamCandidateMatches(query, row)) : null;
  if (!team) return { ok: false, reason: "provider-team-mismatch", localTeamId, query };

  let venue = null;
  let coordinates = null;
  const providerVenueId = normText(team?.idVenue);
  if (providerVenueId) {
    const venueUrl = `${theSportsDbBaseUrl}/lookupvenue.php?id=${encodeURIComponent(providerVenueId)}`;
    const venuePayload = await requestJson(venueUrl);
    venue = Array.isArray(venuePayload?.venues) ? venuePayload.venues[0] : null;
    coordinates = parseVenueCoordinates(venue?.strMap);
  }
  if (!coordinates) {
    const geocoded = await geocodeProviderLocation(venue?.strLocation || team?.strLocation, venue?.strCountry || team?.strCountry);
    if (geocoded) coordinates = geocoded;
  }
  if (!coordinates) return { ok: false, reason: "provider-venue-coordinate-missing", localTeamId, query };

  const discoveredAt = new Date().toISOString();
  return {
    ok: true,
    localTeamId,
    location: {
      name: normText(venue?.strVenue || team?.strStadium || `${query} home venue`),
      city: normText(coordinates.city || venue?.strLocation || team?.strLocation),
      country: normText(coordinates.country || venue?.strCountry || team?.strCountry),
      latitude: coordinates.latitude,
      longitude: coordinates.longitude,
      verified: false,
      source: "thesportsdb-free-team-venue",
      coordinateSource: normText(coordinates.coordinateSource || "thesportsdb-venue-map"),
      providerTeamId: normText(team?.idTeam),
      providerVenueId,
      providerMatchedName: normText(team?.strTeam),
      matchedQuery: query,
      discoveredAt,
      reviewState: "provider-exact-reference",
    },
  };
};

const discoverMissingTeamLocations = async (matches, locations) => {
  const output = locations && typeof locations === "object" ? locations : { version: 2, matches: {}, teams: {} };
  output.matches = output.matches && typeof output.matches === "object" ? output.matches : {};
  output.teams = output.teams && typeof output.teams === "object" ? output.teams : {};
  output.unresolvedTeams = output.unresolvedTeams && typeof output.unresolvedTeams === "object" ? output.unresolvedTeams : {};
  if (!enableTheSportsDbVenueDiscovery || maxVenueDiscoveries === 0) return { locations: output, attempted: 0, added: 0, unresolved: 0 };

  const unique = [];
  const seen = new Set();
  for (const match of matches) {
    const localTeamId = normText(match?.homeTeamId);
    if (
      !localTeamId
      || seen.has(localTeamId)
      || finiteLocation(output.teams[localTeamId])
      || !venueRetryDue(output.unresolvedTeams[localTeamId])
    ) continue;
    seen.add(localTeamId);
    unique.push(match);
  }

  let attempted = 0;
  let added = 0;
  let unresolved = 0;
  for (const match of unique.slice(0, maxVenueDiscoveries)) {
    const localTeamId = normText(match?.homeTeamId);
    attempted += 1;
    try {
      const result = await discoverTeamLocation(match);
      if (result.ok) {
        output.teams[localTeamId] = result.location;
        delete output.unresolvedTeams[localTeamId];
        added += 1;
      } else {
        output.unresolvedTeams[localTeamId] = {
          teamName: normText(match?.homeTeamName || match?.homeTeam),
          query: result.query || teamLookupQuery(match),
          reason: result.reason,
          attemptedAt: new Date().toISOString(),
        };
        unresolved += 1;
      }
    } catch (error) {
      output.unresolvedTeams[localTeamId] = {
        teamName: normText(match?.homeTeamName || match?.homeTeam),
        query: teamLookupQuery(match),
        reason: "provider-request-failed",
        error: normText(error?.message || error).slice(0, 240),
        attemptedAt: new Date().toISOString(),
      };
      unresolved += 1;
    }
  }
  if (attempted > 0) {
    output.version = Math.max(2, Number(output.version) || 0);
    output.updatedAt = new Date().toISOString();
    output.sources = {
      ...(output.sources || {}),
      "thesportsdb:team-venue": {
        endpoint: "https://www.thesportsdb.com/api/v1/json/{key}/searchteams.php",
        terms: "https://www.thesportsdb.com/docs_terms_of_use.php",
        updatedAt: output.updatedAt,
        attempted,
        added,
        unresolved,
        retryMinutes: venueDiscoveryRetryMinutes,
        reviewSemantics: "reference-only-until-human-verified",
      },
    };
  }
  return { locations: output, attempted, added, unresolved };
};

const sourceMatchId = (match) => normText(match?.sourceMatchId || String(match?.id || "").replace(/^(sporttery|fivehundred)_/, ""));

const kickoffMs = (match) => {
  const value = Date.parse(match?.kickoffTime || "");
  return Number.isFinite(value) ? value : null;
};

const isWithinLookahead = (match) => {
  const time = kickoffMs(match);
  if (time === null) return false;
  const now = Date.now();
  return time >= now - 3 * 60 * 60 * 1000 && time <= now + lookaheadDays * 24 * 60 * 60 * 1000;
};

const locationKey = (location) => [
  Number(location?.latitude).toFixed(4),
  Number(location?.longitude).toFixed(4)
].join(",");

const finiteLocation = (location) => {
  const latitude = Number(location?.latitude);
  const longitude = Number(location?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return {
    name: normText(location.name || location.venue || location.city || "Match venue"),
    city: normText(location.city || location.name || ""),
    country: normText(location.country || ""),
    latitude,
    longitude,
    verified: Boolean(location.verified),
    source: normText(location.source || "weather-location"),
  };
};

const resolveVenueSignal = (match) => {
  const venue = match?.externalSignals?.venue || {};
  return finiteLocation({
    name: venue.name,
    city: venue.city,
    country: venue.country,
    latitude: venue.latitude,
    longitude: venue.longitude,
    verified: venue.verified,
    source: venue.source || "external-venue",
  });
};

const isWorldCup = (match) => /世界杯|world\s*cup/i.test(`${match?.leagueName || ""} ${match?.leagueNameEn || ""}`);

const resolveLocation = (match, locations, worldCupIndex) => {
  const id = sourceMatchId(match);
  const byMatch = finiteLocation(locations?.matches?.[id]);
  if (byMatch) return byMatch;

  const homeTeamId = normText(match?.homeTeamId);
  const byHomeTeam = finiteLocation(locations?.teams?.[homeTeamId]);
  if (byHomeTeam) return byHomeTeam;

  const venueSignal = resolveVenueSignal(match);
  if (venueSignal) return venueSignal;

  if (enableWorldCupRotation && isWorldCup(match) && Array.isArray(locations?.worldCupHostRotation) && locations.worldCupHostRotation.length) {
    const rotation = finiteLocation(locations.worldCupHostRotation[worldCupIndex % locations.worldCupHostRotation.length]);
    if (rotation) return rotation;
  }

  return null;
};

const weatherCodeText = (code) => {
  const value = Number(code);
  if ([0].includes(value)) return { zh: "晴", en: "Clear" };
  if ([1, 2].includes(value)) return { zh: "少云", en: "Partly cloudy" };
  if ([3].includes(value)) return { zh: "多云", en: "Cloudy" };
  if ([45, 48].includes(value)) return { zh: "雾", en: "Fog" };
  if ([51, 53, 55, 56, 57].includes(value)) return { zh: "毛毛雨", en: "Drizzle" };
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(value)) return { zh: "雨", en: "Rain" };
  if ([71, 73, 75, 77, 85, 86].includes(value)) return { zh: "雪", en: "Snow" };
  if ([95, 96, 99].includes(value)) return { zh: "雷阵雨", en: "Thunderstorm" };
  return { zh: "天气可用", en: "Weather available" };
};

const riskLevel = ({ temperatureC, windKph, windGustKph, precipitationMm }) => {
  if (
    precipitationMm >= 8 ||
    windKph >= 38 ||
    windGustKph >= 55 ||
    temperatureC <= 0 ||
    temperatureC >= 34
  ) return "high";
  if (
    precipitationMm >= 2.5 ||
    windKph >= 24 ||
    windGustKph >= 40 ||
    temperatureC <= 4 ||
    temperatureC >= 30
  ) return "medium";
  return "low";
};

const riskText = (level) => {
  if (level === "high") return { zh: "高风险", en: "high risk" };
  if (level === "medium") return { zh: "中等风险", en: "medium risk" };
  return { zh: "低风险", en: "low risk" };
};

const nearestHourlyWeather = (payload, matchTimeMs) => {
  const hourly = payload?.hourly || {};
  const times = Array.isArray(hourly.time) ? hourly.time : [];
  if (!times.length) return null;

  let bestIndex = -1;
  let bestDiff = Infinity;
  for (let index = 0; index < times.length; index += 1) {
    const timeMs = Date.parse(`${times[index]}Z`);
    if (!Number.isFinite(timeMs)) continue;
    const diff = Math.abs(timeMs - matchTimeMs);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIndex = index;
    }
  }
  if (bestIndex < 0 || bestDiff > 3 * 60 * 60 * 1000) return null;

  const read = (key) => {
    const arr = hourly[key];
    const value = Array.isArray(arr) ? Number(arr[bestIndex]) : NaN;
    return Number.isFinite(value) ? value : null;
  };

  return {
    forecastTime: `${times[bestIndex]}Z`,
    temperatureC: read("temperature_2m"),
    precipitationMm: read("precipitation"),
    windKph: read("wind_speed_10m"),
    windGustKph: read("wind_gusts_10m"),
    weatherCode: read("weather_code"),
  };
};

const forecastUrl = (location) => {
  const params = new URLSearchParams({
    latitude: String(location.latitude),
    longitude: String(location.longitude),
    hourly: "temperature_2m,precipitation,weather_code,wind_speed_10m,wind_gusts_10m",
    timezone: "UTC",
    forecast_days: String(Math.min(16, Math.max(1, lookaheadDays + 1)))
  });
  return `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
};

const buildWeatherSignal = (match, location, row, fetchedAt) => {
  const condition = weatherCodeText(row.weatherCode);
  const metrics = {
    temperatureC: row.temperatureC,
    precipitationMm: row.precipitationMm,
    windKph: row.windKph,
    windGustKph: row.windGustKph,
  };
  const level = riskLevel(metrics);
  const risk = riskText(level);
  const tempText = Number.isFinite(metrics.temperatureC) ? `${metrics.temperatureC}C` : "--";
  const windText = Number.isFinite(metrics.windKph) ? `${metrics.windKph}km/h` : "--";
  const rainText = Number.isFinite(metrics.precipitationMm) ? `${metrics.precipitationMm}mm` : "--";
  const confidenceZh = location.verified ? "球场定位" : "场地估算";
  const confidenceEn = location.verified ? "venue located" : "venue estimated";

  return {
    source: "open-meteo",
    provider,
    updatedAt: fetchedAt,
    forecastTime: row.forecastTime,
    verified: location.verified,
    confidence: location.verified ? "venue" : "estimated-location",
    locationSource: location.source,
    condition,
    temperatureC: metrics.temperatureC,
    windKph: metrics.windKph,
    windGustKph: metrics.windGustKph,
    precipitationMm: metrics.precipitationMm,
    weatherCode: row.weatherCode,
    riskLevel: level,
    summary: {
      zh: `${location.city || location.name} ${confidenceZh}天气：${condition.zh}，${tempText}，风速 ${windText}，降水 ${rainText}，环境${risk.zh}。`,
      en: `${location.city || location.name} ${confidenceEn} weather: ${condition.en}, ${tempText}, wind ${windText}, precipitation ${rainText}, ${risk.en}.`,
    },
    impact: {
      zh: level === "high"
        ? "恶劣天气会降低进球稳定性并提高让球盘波动。"
        : level === "medium"
          ? "天气存在扰动，主要作为进球数与让球信心的轻量修正。"
          : "天气扰动较低，按中性环境处理。",
      en: level === "high"
        ? "Severe weather lowers goal stability and increases handicap volatility."
        : level === "medium"
          ? "Weather adds some noise, mainly as a light modifier for goals and handicap confidence."
          : "Weather disruption is low and treated as a neutral environment.",
    },
  };
};

async function main() {
  if (!enabled) {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: "ENABLE_WEATHER_SYNC=0" }, null, 2));
    return;
  }
  if (provider !== "open-meteo") {
    throw new Error(`Unsupported WEATHER_PROVIDER: ${provider}`);
  }

  const currentMatches = readJson(currentMatchesFile, []);
  const externalSignals = readJson(externalSignalsFile, {
    version: 1,
    source: "external-signals",
    updatedAt: null,
    matches: {},
    sources: {},
  });
  let locations = readJson(serverLocationsFile, readJson(publicLocationsFile, { matches: {}, teams: {} }));
  const fetchedAt = new Date().toISOString();
  const candidates = (Array.isArray(currentMatches) ? currentMatches : [])
    .filter(isWithinLookahead)
    .slice(0, maxMatches);

  const venueDiscovery = await discoverMissingTeamLocations(candidates, locations);
  locations = venueDiscovery.locations;
  if (venueDiscovery.attempted > 0) writeJson(serverLocationsFile, locations);

  const forecastCache = new Map();
  const updated = [];
  const skipped = [];
  const errors = [];
  let worldCupIndex = 0;

  for (const match of candidates) {
    const id = sourceMatchId(match);
    const matchTime = kickoffMs(match);
    const wcIndex = isWorldCup(match) ? worldCupIndex++ : worldCupIndex;
    const location = resolveLocation(match, locations, wcIndex);
    if (!id || matchTime === null || !location) {
      skipped.push({ id, reason: "missing-location" });
      continue;
    }

    try {
      const cacheKey = locationKey(location);
      let payload = forecastCache.get(cacheKey);
      if (!payload) {
        payload = await requestJson(forecastUrl(location));
        forecastCache.set(cacheKey, payload);
      }

      const row = nearestHourlyWeather(payload, matchTime);
      if (!row) {
        skipped.push({ id, reason: "no-hourly-forecast", city: location.city });
        continue;
      }

      const existing = eventSafeExistingSignal(externalSignals.matches?.[id] || {}, match);
      const weather = buildWeatherSignal(match, location, row, fetchedAt);
      externalSignals.matches = externalSignals.matches || {};
      externalSignals.matches[id] = stampSignalEvent({
        ...existing,
        source: existing.source || externalSignals.source || "external-signals",
        updatedAt: fetchedAt,
        venue: {
          ...(existing.venue || {}),
          name: location.name,
          city: location.city,
          country: location.country,
          latitude: location.latitude,
          longitude: location.longitude,
          verified: location.verified,
          source: location.source,
          summary: {
            zh: `${location.name || location.city}，${location.city || location.country}。${location.verified ? "球场定位已确认。" : "当前为场地估算，后续可用官方球场覆盖。"}`,
            en: `${location.name || location.city}, ${location.city || location.country}. ${location.verified ? "Venue location confirmed." : "Venue is estimated and can be replaced by official venue data."}`,
          },
        },
        weather,
      }, match);
      updated.push({
        id,
        match: `${match.homeTeamName || match.homeTeam} vs ${match.awayTeamName || match.awayTeam}`,
        city: location.city,
        verified: location.verified,
        riskLevel: weather.riskLevel,
      });
    } catch (error) {
      errors.push({ id, error: error.message || String(error) });
    }
  }

  externalSignals.version = externalSignals.version || 1;
  externalSignals.source = externalSignals.source || "external-signals";
  externalSignals.updatedAt = fetchedAt;
  externalSignals.count = Object.keys(externalSignals.matches || {}).length;
  externalSignals.sources = {
    ...(externalSignals.sources || {}),
    "open-meteo:forecast": {
      url: "https://api.open-meteo.com/v1/forecast",
      updatedAt: fetchedAt,
      rows: candidates.length,
      mapped: updated.length,
      skipped: skipped.length,
      errors: errors.length,
      maxAgeMinutes,
      lookaheadDays,
      provider,
    },
    "thesportsdb:team-venue": {
      ...(externalSignals.sources?.["thesportsdb:team-venue"] || {}),
      url: "https://www.thesportsdb.com/api/v1/json/{key}/searchteams.php",
      updatedAt: fetchedAt,
      attempted: venueDiscovery.attempted,
      added: venueDiscovery.added,
      unresolved: venueDiscovery.unresolved,
      storedTeams: Object.keys(locations.teams || {}).length,
      reviewSemantics: "reference-only-until-human-verified",
    },
  };

  writeJson(externalSignalsFile, externalSignals);
  console.log(JSON.stringify({
    ok: errors.length === 0,
    provider,
    candidates: candidates.length,
    updated: updated.length,
    skipped: skipped.length,
    errors: errors.length,
    venueDiscovery: {
      attempted: venueDiscovery.attempted,
      added: venueDiscovery.added,
      unresolved: venueDiscovery.unresolved,
      storedTeams: Object.keys(locations.teams || {}).length,
    },
    sample: updated.slice(0, 6),
  }, null, 2));

  if (errors.length) {
    console.error(JSON.stringify({ errors }, null, 2));
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  discoverMissingTeamLocations,
  discoverTeamLocation,
  parseVenueCoordinates,
  resolveLocation,
  teamCandidateMatches,
  teamLookupQuery,
  venueRetryDue,
};
