const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  resolvePrivateKeyPath,
  resolvePublicKeyPath,
  publicKeyId
} = require("./releaseSigning.cjs");

const privateKeyPath = resolvePrivateKeyPath();
const publicKeyPath = resolvePublicKeyPath();

for (const filePath of [privateKeyPath, publicKeyPath]) {
  if (fs.existsSync(filePath)) {
    console.error(JSON.stringify({
      ok: false,
      error: "refusing to overwrite an existing release signing key",
      path: filePath
    }, null, 2));
    process.exit(1);
  }
}

for (const dir of new Set([path.dirname(privateKeyPath), path.dirname(publicKeyPath)])) {
  fs.mkdirSync(dir, { recursive: true });
}

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 3072,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" }
});

fs.writeFileSync(privateKeyPath, privateKey, { mode: 0o600, flag: "wx" });
fs.writeFileSync(publicKeyPath, publicKey, { mode: 0o644, flag: "wx" });

console.log(JSON.stringify({
  ok: true,
  algorithm: "rsa-3072",
  keyId: publicKeyId(crypto.createPublicKey(publicKey)),
  privateKeyPath,
  publicKeyPath,
  privateKeyMustRemainLocal: true
}, null, 2));
