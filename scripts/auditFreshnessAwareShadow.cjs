"use strict";
const fs = require("node:fs"), path = require("node:path");
const { evaluateFreshnessAwareShadow, VERSION } = require("../src/services/freshnessAwareShadow.cjs");
function audit(rows) {
  const selected = new Map(), rejected = {};
  let sourceRows = 0;
  for (const row of rows) {
    sourceRows++;
    const result = evaluateFreshnessAwareShadow(row);
    if (!result.eligible) { result.blockers.forEach((key) => { rejected[key] = (rejected[key] || 0) + 1; }); continue; }
    const d = row.decisionSnapshot;
    const key = `${d.sourceMatchId}|${Date.parse(d.kickoffTime)}`;
    const previous = selected.get(key);
    if (!previous || Date.parse(d.decisionAt) > Date.parse(previous.row.decisionSnapshot.decisionAt)) selected.set(key, { row, result });
  }
  const valid = [...selected.values()];
  const directions = { "1": 0, X: 0, "2": 0 };
  valid.forEach(({result}) => { directions[Object.keys(result.probabilities).sort((a,b) => result.probabilities[b]-result.probabilities[a])[0]]++; });
  return { version: VERSION, generatedAt: new Date().toISOString(), scope: "retrospective-shadow-input-audit",
    sourceRows, eligibleEventHeads: valid.length, rejected, directions,
    missingFormClock: valid.filter(({result}) => result.diagnostics.missingFormClock).length,
    averageModelWeight: valid.length ? valid.reduce((sum,{result}) => sum+result.modelWeight,0)/valid.length : null,
    hitRate: null, promotionAllowed: false,
    blockers: ["new-policy-not-preregistered-prospectively", "independent-windows-not-accumulated", "no-trusted-paired-settlement-evaluation"],
    existingCandidateLedgerModified: false,
  };
}
if (require.main === module) {
  const input = process.argv[2] || path.join(__dirname, "../public/data/prediction-snapshots.json");
  const payload = JSON.parse(fs.readFileSync(input, "utf8"));
  const report = audit(Array.isArray(payload) ? payload : payload.rows || []);
  if (process.argv[3]) fs.writeFileSync(path.resolve(process.argv[3]), JSON.stringify(report, null, 2)+"\n");
  console.log(JSON.stringify(report, null, 2));
}
module.exports = { audit };
