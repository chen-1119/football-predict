"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  PAYLOAD_VERSION,
  updateAiArenaState,
} = require("./aiArenaEngine.cjs");

const rootDir = path.resolve(__dirname, "..");
const storeDir = path.resolve(process.env.SERVER_STORE_DIR || path.join(rootDir, "server-data"));
const publicDataDir = path.resolve(process.env.PUBLIC_DATA_DIR || path.join(rootDir, "public", "data"));
const statePath = path.resolve(process.env.AI_ARENA_STATE_PATH || path.join(storeDir, "ai-arena-state.json"));
const publicationPath = path.join(publicDataDir, "ai-arena.json");
const matchesPath = path.join(publicDataDir, "matches-current.json");
const refreshedAt = new Date(process.env.AI_ARENA_REFRESHED_AT || Date.now()).toISOString();

const readJson = (filePath, fallback = null) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
};

const matchRows = (value) => {
  if (Array.isArray(value)) return value;
  for (const key of ["matches", "data", "rows"]) {
    if (Array.isArray(value?.[key])) return value[key];
  }
  throw new Error("AI arena refresh requires a matches-current array");
};

const writeJsonAtomic = (filePath, value) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, filePath);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch { /* best-effort cleanup */ }
  }
};

const existingPublication = readJson(publicationPath, null);
const existingState = readJson(statePath, null);
if (!existingState && existingPublication?.state === "LOCKED") {
  throw new Error("refusing to reconstruct a locked AI arena without its immutable state");
}

const matches = matchRows(readJson(matchesPath, null));
const refreshed = updateAiArenaState({
  matches,
  state: existingState || { version: 1, updatedAt: refreshedAt, months: {} },
  now: refreshedAt,
});

if (refreshed.payload.state === "LOCKED") {
  const ids = (refreshed.payload.agents || []).map((agent) => String(agent.id));
  if (refreshed.payload.version !== PAYLOAD_VERSION) {
    throw new Error(`locked AI arena did not upgrade to ${PAYLOAD_VERSION}`);
  }
  if (!ids.includes("kimi") || !ids.includes("doubao") || ids.includes("claude") || ids.includes("grok")) {
    throw new Error("locked AI arena competitor migration is incomplete");
  }
  if (refreshed.payload.roundActive !== true || refreshed.payload.complete !== (refreshed.payload.availableMatches === 10)) {
    throw new Error("locked AI arena round lifecycle is inconsistent");
  }
}

writeJsonAtomic(statePath, refreshed.state);
writeJsonAtomic(publicationPath, refreshed.payload);

console.log(JSON.stringify({
  ok: true,
  verifier: "ai-arena-publication-refresh-v1",
  refreshedAt,
  state: refreshed.payload.state,
  version: refreshed.payload.version,
  availableMatches: refreshed.payload.availableMatches,
  complete: refreshed.payload.complete,
  roundActive: refreshed.payload.roundActive,
  agents: (refreshed.payload.agents || []).map((agent) => ({
    id: agent.id,
    forecasts: Array.isArray(agent.forecasts) ? agent.forecasts.length : 0,
  })),
}, null, 2));
