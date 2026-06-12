const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");

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
  const locations = readJson(serverLocationsFile, readJson(publicLocationsFile, { matches: {} }));
  const fetchedAt = new Date().toISOString();
  const candidates = (Array.isArray(currentMatches) ? currentMatches : [])
    .filter(isWithinLookahead)
    .slice(0, maxMatches);

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

      const existing = externalSignals.matches?.[id] || {};
      const weather = buildWeatherSignal(match, location, row, fetchedAt);
      externalSignals.matches = externalSignals.matches || {};
      externalSignals.matches[id] = {
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
      };
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
  };

  writeJson(externalSignalsFile, externalSignals);
  console.log(JSON.stringify({
    ok: errors.length === 0,
    provider,
    candidates: candidates.length,
    updated: updated.length,
    skipped: skipped.length,
    errors: errors.length,
    sample: updated.slice(0, 6),
  }, null, 2));

  if (errors.length) {
    console.error(JSON.stringify({ errors }, null, 2));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
