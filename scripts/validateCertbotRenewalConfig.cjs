#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const EXPECTED_SERVER = "https://acme-v02.api.letsencrypt.org/directory";
const EXPECTED_IP = "134.175.132.183";
const EXPECTED_WEBROOT = "/var/www/letsencrypt";
const EXPECTED_HOOK = "/etc/letsencrypt/renewal-hooks/deploy/football-predict-nginx";

const fail = (message) => {
  throw new Error(`Certbot renewal policy rejected: ${message}`);
};

const filePath = process.argv[2];
if (!filePath) fail("renewal config path is required");
const resolved = path.resolve(filePath);
const stat = fs.lstatSync(resolved);
if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
  fail("renewal config must be a single-link regular file");
}
if (process.platform !== "win32" && (stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o022) !== 0)) {
  fail("renewal config ownership or write permissions are unsafe");
}
if (stat.size <= 0 || stat.size > 64 * 1024) fail("renewal config size is outside the allowed range");

const unquote = (value) => {
  const trimmed = String(value || "").trim();
  if (trimmed.length >= 2
      && ((trimmed.startsWith('"') && trimmed.endsWith('"'))
        || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const sections = new Map();
let section = "";
for (const rawLine of fs.readFileSync(resolved, "utf8").split(/\r?\n/)) {
  const line = rawLine.trim();
  if (!line || line.startsWith("#") || line.startsWith(";")) continue;
  const nested = line.match(/^\[\[([^\]]+)\]\]$/);
  const regular = line.match(/^\[([^\]]+)\]$/);
  if (nested || regular) {
    section = nested ? `[[${nested[1].trim()}]]` : regular[1].trim();
    if (!sections.has(section)) sections.set(section, new Map());
    continue;
  }
  const separator = line.indexOf("=");
  if (separator <= 0 || !section) continue;
  const key = line.slice(0, separator).trim();
  const value = unquote(line.slice(separator + 1));
  const values = sections.get(section) || new Map();
  if (values.has(key)) fail(`duplicate ${section}.${key}`);
  values.set(key, value);
  sections.set(section, values);
}

const renewal = sections.get("renewalparams");
if (!renewal) fail("renewalparams section is missing");
if (renewal.get("server") !== EXPECTED_SERVER) fail("production ACME directory is not pinned");
if (renewal.get("authenticator") !== "webroot") fail("authenticator is not webroot");
if (renewal.get("preferred_profile") !== "shortlived") fail("preferred profile is not shortlived");
const deployHook = renewal.get("deploy_hook");
if (deployHook && deployHook !== EXPECTED_HOOK) fail("saved deploy hook is not the reviewed hook");

const webrootMap = sections.get("[[webroot_map]]");
const mappedWebroot = webrootMap?.get(EXPECTED_IP);
const fallbackWebroots = String(renewal.get("webroot_path") || "")
  .split(",")
  .map(unquote)
  .filter(Boolean);
if (mappedWebroot !== EXPECTED_WEBROOT && !fallbackWebroots.includes(EXPECTED_WEBROOT)) {
  fail("IP webroot mapping is missing or unexpected");
}

console.log("Certbot renewal policy: ok");
