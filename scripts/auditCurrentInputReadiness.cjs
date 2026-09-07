"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// Read-only observer: no sync entry points, credentials, SQL or network calls.
function auditCurrentInputReadiness({ root, categoryAudit }) {
  const files = [];
  const read = (name, limit) => {
    const requested = path.join(root, "public", "data", `${name}.json`);
    const resolved = fs.realpathSync(requested);
    const before = fs.statSync(resolved);
    if (before.size > limit) throw new Error(`audit input exceeds bounded read: ${name}`);
    const raw = fs.readFileSync(resolved);
    const after = fs.statSync(resolved);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || fs.realpathSync(requested) !== resolved) throw new Error(`input changed during read: ${name}`);
    files.push({ name, requested, resolved, bytes: raw.length, mtime: after.mtime.toISOString(), sha256: crypto.createHash("sha256").update(raw).digest("hex") });
    return JSON.parse(raw);
  };
  const current = read("matches-current", 128 * 1024 * 1024);
  const history = read("matches-history", 256 * 1024 * 1024);
  const cache = read("api-football-cache", 32 * 1024 * 1024);
  if (!Array.isArray(current) || !Array.isArray(history)) throw new Error("unexpected match document shape");
  const bySource = new Map();
  // Prefer current rows; this observer never repairs or updates a mapping.
  for (const row of [...history, ...current]) {
    for (const id of [row.id, row.sourceMatchId]) if (id) bySource.set(String(id), row);
  }
  const blockers = {};
  const mappingSamples = [];
  let joined = 0, blocked = 0;
  for (const [key, mapping] of Object.entries(cache.fixtureMap || {})) {
    const match = bySource.get(key) || bySource.get(String(mapping.sourceMatchId || ""));
    if (!match) continue;
    joined++;
    const category = categoryAudit(match, { home: mapping.homeTeamName, away: mapping.awayTeamName });
    if (!category.compatible) {
      blocked++;
      for (const reason of category.blockers) blockers[reason] = (blockers[reason] || 0) + 1;
      if (mappingSamples.length < 8) mappingSamples.push({ sourceMatchId: match.sourceMatchId, kickoffTime: match.kickoffTime,
        localHome: match.homeTeamName || match.homeTeam, localAway: match.awayTeamName || match.awayTeam,
        providerHome: mapping.homeTeamName, providerAway: mapping.awayTeamName, reasons: category.blockers });
    }
  }
  const counts = { matches: current.length, formPresent: 0, pairedNumericSamples: 0, formObservationSummaryPresent: 0, latestMatchClockPresent: 0,
    lastMatchClockAfterDecision: 0, olderThan60DaysAtDecision: 0, eloPresent: 0, eloSourcePresent: 0, formSourcePresent: 0 };
  const samples = [];
  for (const row of current) {
    const model = row.probabilityModel || {};
    const form = model.form || row.formSnapshot;
    const elo = model.elo || row.eloSnapshot;
    if (elo) counts.eloPresent++;
    if (elo?.historicalSource) counts.eloSourcePresent++;
    if (!form) continue;
    counts.formPresent++;
    if (form.historicalSource) counts.formSourcePresent++;
    if ([form.home?.sampleSize, form.away?.sampleSize].every(v => typeof v === "number" && Number.isFinite(v) && v > 0)) counts.pairedNumericSamples++;
    if (form.home?.resultEvidence && form.away?.resultEvidence) counts.formObservationSummaryPresent++;
    const decision = Date.parse(row.predictionMeta?.decisionGeneratedAt || row.predictionMeta?.generatedAt || model.generatedAt || "");
    const clocks = [form.home?.lastMatchAt, form.away?.lastMatchAt].map(v => Date.parse(v || ""));
    if (clocks.every(Number.isFinite)) counts.latestMatchClockPresent++;
    if (Number.isFinite(decision) && clocks.some(t => t > decision)) counts.lastMatchClockAfterDecision++;
    if (Number.isFinite(decision) && clocks.some(t => Number.isFinite(t) && decision - t > 60 * 86400000)) counts.olderThan60DaysAtDecision++;
    if (samples.length < 4) samples.push({ sourceMatchId: row.sourceMatchId, kickoffTime: row.kickoffTime,
      decisionAt: Number.isFinite(decision) ? new Date(decision).toISOString() : null,
      home: { samples: form.home?.sampleSize ?? null, lastMatchAt: form.home?.lastMatchAt ?? null, observationSummary: Boolean(form.home?.resultEvidence) },
      away: { samples: form.away?.sampleSize ?? null, lastMatchAt: form.away?.lastMatchAt ?? null, observationSummary: Boolean(form.away?.resultEvidence) } });
  }
  // Fail rather than combine documents across a publish-directory switch.
  for (const file of files) if (fs.realpathSync(file.requested) !== file.resolved || fs.statSync(file.resolved).mtime.toISOString() !== file.mtime) throw new Error(`input changed across audit: ${file.name}`);
  return { observedAt: new Date().toISOString(), scope: "file snapshot diagnostics only; no source trust, adoption or accuracy claim", writes: 0, files,
    mapping: { cacheUpdatedAt: cache.updatedAt || null, cacheRows: Object.keys(cache.fixtureMap || {}).length, joined, notJoined: Object.keys(cache.fixtureMap || {}).length - joined,
      categoryBlocked: blocked, reasons: blockers, samples: mappingSamples }, form: { counts, samples } };
}
module.exports = { auditCurrentInputReadiness };
if (require.main === module) console.log(JSON.stringify(auditCurrentInputReadiness({ root: path.resolve(process.argv[2] || path.join(__dirname, "..")),
  categoryAudit: require("./teamCategoryIdentity.cjs").fixtureTeamCategoryAudit }), null, 2));
