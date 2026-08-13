const fs = require("node:fs");
const path = require("node:path");
const {
  createCollectorKeyPair,
} = require("../src/services/collectorAttestation.cjs");

const rootDir = path.resolve(__dirname, "..");
const forbiddenDefaultStore = path.resolve(rootDir, "server-data");

const argValue = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
};

const isInside = (parent, candidate) => {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

const writeExclusive = (filePath, value, mode = 0o600) => {
  fs.writeFileSync(filePath, value, { encoding: "utf8", flag: "wx", mode });
};

const main = () => {
  const outputInput = argValue("--out-dir");
  const keyId = argValue("--key-id");
  const independenceDomain = argValue("--independence-domain");
  if (!outputInput || !keyId || !independenceDomain) {
    throw new Error("usage: node scripts/generateCollectorAttestationKey.cjs --out-dir <external-secure-dir> --key-id <collector-key-id> --independence-domain <stable-runtime-domain>");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(keyId)) {
    throw new Error("collector key id must use 1-128 ASCII letters, digits, dot, underscore, or hyphen");
  }
  const outputDir = path.resolve(outputInput);
  if (isInside(forbiddenDefaultStore, outputDir)) {
    throw new Error("refusing to generate collector private keys under server-data; choose an external secure directory");
  }
  fs.mkdirSync(outputDir, { recursive: true });
  const pair = createCollectorKeyPair({ keyId, independenceDomain });
  const privateKeyPath = path.join(outputDir, `${keyId}.private.pem`);
  const publicKeyPath = path.join(outputDir, `${keyId}.public.pem`);
  const registryPath = path.join(outputDir, "collector-trust-registry.json");
  writeExclusive(privateKeyPath, pair.privateKeyPem, 0o600);
  writeExclusive(publicKeyPath, pair.publicKeyPem, 0o644);
  writeExclusive(registryPath, `${JSON.stringify(pair.registry, null, 2)}\n`, 0o644);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    keyId,
    independenceDomain,
    fingerprint: pair.fingerprint,
    privateKeyPath,
    publicKeyPath,
    registryPath,
    collectorEnv: {
      SPORTTERY_COLLECTOR_PRIVATE_KEY_PATH: privateKeyPath,
      SPORTTERY_COLLECTOR_KEY_ID: keyId,
    },
    verifierEnv: {
      SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH: registryPath,
    },
  }, null, 2)}\n`);
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message || error}\n`);
    process.exit(1);
  }
}

module.exports = { isInside, main };
