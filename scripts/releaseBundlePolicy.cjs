const path = require("node:path");

const RELEASE_BUNDLE_POLICY_VERSION = "release-secret-policy-v2";

const sensitiveTarExcludes = [
  ".env",
  ".env.*",
  ".npmrc",
  "**/.npmrc",
  ".netrc",
  "**/.netrc",
  ".pypirc",
  "**/.pypirc",
  "*.local",
  "deploy/light-server/env",
  "**/deploy/light-server/env",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_rsa",
  "id_ed25519",
  ".ssh",
  ".aws",
  ".azure",
  ".docker",
  "**/.docker",
  ".config/gcloud"
];

const normalizeReleaseEntry = (entry) => String(entry || "")
  .replace(/\\/g, "/")
  .replace(/^\.\//, "")
  .replace(/\/+$/, "");

const isSensitiveReleaseEntry = (entry) => {
  const normalized = normalizeReleaseEntry(entry);
  if (!normalized) return false;

  const segments = normalized.split("/").filter(Boolean);
  const baseName = segments.at(-1)?.toLowerCase() || "";
  const lowerPath = normalized.toLowerCase();
  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  const segmentNames = new Set(lowerSegments);
  const includesSequence = (...expected) => lowerSegments.some((segment, index) => (
    expected.every((value, offset) => lowerSegments[index + offset] === value)
  ));

  if (lowerPath === "deploy/light-server/env" || lowerPath.endsWith("/deploy/light-server/env")) return true;
  if (baseName === ".env" || baseName.startsWith(".env.")) return true;
  if ([".npmrc", ".netrc", ".pypirc"].includes(baseName)) return true;
  if (baseName.endsWith(".local")) return true;
  if (["id_rsa", "id_ed25519", "credentials", "credentials.json", "secrets", "secrets.json"].includes(baseName)) {
    return true;
  }
  if ([".pem", ".key", ".p12", ".pfx"].includes(path.extname(baseName))) return true;
  if ([".ssh", ".aws", ".azure", ".docker"].some((name) => segmentNames.has(name))) return true;
  if (includesSequence(".config", "gcloud")) return true;

  return false;
};

const findSensitiveReleaseEntries = (entries) => (
  [...new Set((entries || []).map(normalizeReleaseEntry).filter(isSensitiveReleaseEntry))]
    .sort((a, b) => a.localeCompare(b))
);

module.exports = {
  RELEASE_BUNDLE_POLICY_VERSION,
  findSensitiveReleaseEntries,
  isSensitiveReleaseEntry,
  normalizeReleaseEntry,
  sensitiveTarExcludes
};
