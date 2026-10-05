"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const https = require("node:https");
const output = __dirname;
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const readPublic = endpoint => new Promise((resolve, reject) => {
  const startedAt = new Date().toISOString();
  const request = https.get(new URL(endpoint, "https://134.175.132.183"), { timeout: 15000 }, response => {
    const parts = [];
    response.on("data", part => parts.push(part));
    response.on("end", () => {
      const raw = Buffer.concat(parts);
      resolve({ endpoint, startedAt, completedAt: new Date().toISOString(), status: response.statusCode,
        sha256: sha(raw), bytes: raw.length, body: JSON.parse(raw.toString("utf8")) });
    });
  });
  request.on("timeout", () => request.destroy(new Error("timeout")));
  request.on("error", reject);
});
(async () => {
  const observations = await Promise.all([readPublic("/api/v1/health"), readPublic("/api/v1/source-health")]);
  const report = { version: "release-readiness-public-snapshot-v1", capturedAt: new Date().toISOString(),
    readOnly: true, tlsVerified: true, authenticated: false, observations };
  fs.writeFileSync(path.join(output, "release-readiness-live.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ capturedAt: report.capturedAt, endpoints: observations.map(row => ({ endpoint: row.endpoint, status: row.status, bytes: row.bytes, sha256: row.sha256 })) }, null, 2));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
