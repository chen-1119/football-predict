"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

if (!globalThis.crypto) globalThis.crypto = crypto.webcrypto;

const SETTING_NAMES = [
  "SPORTTERY_COLLECTOR_PRIVATE_KEY_PKCS8",
  "SPORTTERY_COLLECTOR_PRIVATE_KEY_PKCS8_BASE64",
  "SPORTTERY_COLLECTOR_KEY_ID",
  "SPORTTERY_COLLECTOR_KEY_FINGERPRINT",
  "SPORTTERY_COLLECTOR_TRANSPORT",
  "SPORTTERY_COLLECTOR_CYCLE_PREFIX",
  "SPORTTERY_COLLECTOR_REQUEST_TIMEOUT_MS",
  "FOOTBALL_PRODUCTION_BASE_URL",
  "FOOTBALL_PRODUCTION_ADMIN_TOKEN",
];

let collectorModulePromise = null;

const text = (value) => String(value ?? "").trim();

const setting = (context, name) => {
  const direct = text(process.env[name]);
  if (direct) return direct;
  if (typeof context?.getUserData === "function") {
    return text(context.getUserData(name));
  }
  return "";
};

const resolveEnvironment = (context) => {
  const env = Object.fromEntries(SETTING_NAMES.map((name) => [name, setting(context, name)]));
  if (!env.SPORTTERY_COLLECTOR_PRIVATE_KEY_PKCS8 && env.SPORTTERY_COLLECTOR_PRIVATE_KEY_PKCS8_BASE64) {
    env.SPORTTERY_COLLECTOR_PRIVATE_KEY_PKCS8 = Buffer.from(
      env.SPORTTERY_COLLECTOR_PRIVATE_KEY_PKCS8_BASE64,
      "base64",
    ).toString("utf8");
  }
  env.SPORTTERY_COLLECTOR_DELIVERY_MODE = "push";
  env.SPORTTERY_COLLECTOR_TRANSPORT ||= "huawei-functiongraph-direct";
  env.SPORTTERY_COLLECTOR_CYCLE_PREFIX ||= "huawei-functiongraph-sporttery";
  env.FOOTBALL_PRODUCTION_BASE_URL ||= "https://134.175.132.183";

  const baseUrl = new URL(env.FOOTBALL_PRODUCTION_BASE_URL);
  if (baseUrl.protocol !== "https:" || baseUrl.username || baseUrl.password || baseUrl.pathname !== "/") {
    throw new Error("FOOTBALL_PRODUCTION_BASE_URL must be a credential-free HTTPS origin");
  }
  return env;
};

const loadCollector = () => {
  if (!collectorModulePromise) {
    const configuredPath = text(process.env.SPORTTERY_COLLECTOR_MODULE_PATH);
    const moduleUrl = configuredPath
      ? pathToFileURL(path.resolve(configuredPath)).href
      : pathToFileURL(path.join(__dirname, "sportteryCollector.mjs")).href;
    collectorModulePromise = import(moduleUrl);
  }
  return collectorModulePromise;
};

exports.handler = async (event, context) => {
  const startedAt = new Date().toISOString();
  const env = resolveEnvironment(context);
  const collector = await loadCollector();
  if (!collector.sportteryCollectorConfigured(env)) {
    throw new Error("Huawei FunctionGraph collector signing settings are incomplete");
  }
  if (!env.FOOTBALL_PRODUCTION_ADMIN_TOKEN) {
    throw new Error("Huawei FunctionGraph collector upload token is missing");
  }

  const result = await collector.collectSportteryEvidence(env);
  if (result?.ok !== true || result?.skipped === true) {
    throw new Error(`Huawei FunctionGraph collector did not publish: ${result?.reason || "unknown"}`);
  }
  return {
    ok: true,
    provider: "sporttery",
    runtime: "huawei-functiongraph",
    triggerType: text(event?.trigger_type) || "manual",
    startedAt,
    finishedAt: new Date().toISOString(),
    sourceCycleId: result.sourceCycleId,
    endpoints: result.endpoints,
    acceptedRows: result.acceptedRows,
    storeRows: result.storeRows,
    storeRootHash: result.storeRootHash,
    fastLane: result.fastLane || {
      published: false,
      reason: "fast-lane-result-missing",
    },
    errors: Array.isArray(result.errors) ? result.errors : [],
  };
};
