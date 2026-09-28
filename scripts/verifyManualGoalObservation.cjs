"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { capture, report, template } = require("./manualGoalObservation.cjs");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-observation-"));
const proof = path.join(dir, "proof.png");
// Small valid PNG; the collector stores bytes, hashes them and leaves OCR to a reviewer.
fs.writeFileSync(proof, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ucx8AAAAASUVORK5CYII=", "base64"));
const previous = { id: "sporttery_old", sourceMatchId: "old", kickoffTime: "2026-09-26T12:00:00Z",
  homeTeamName: "Home", awayTeamName: "Away", status: "FINISHED", scoreHome: 2, scoreAway: 1 };
const upcoming = { id: "sporttery_next", sourceMatchId: "next", kickoffTime: "2026-09-30T12:00:00Z",
  buyEndTime: "2026-09-30T11:00:00Z", homeTeamName: "Next Home", awayTeamName: "Next Away", status: "SCHEDULED" };
const matches = [previous, upcoming];
const make = (match, kind, values) => ({ ...template(match.id, kind, matches),
  sourceUrl: "https://example.org/fixture/123?view=stats", sourceLabel: "Source capture", values });

try {
  const xgInput = make(previous, "xg", { home: 1.52, away: 0.71 });
  xgInput.receivedAt = "2026-09-26T13:00:00Z"; // The user's asserted clock cannot backdate the receipt.
  const first = capture({ input: xgInput, evidencePath: proof, matches, storeDir: dir, now: "2026-09-29T00:00:00Z" });
  assert.equal(first.status, "captured");
  assert.equal(first.record.receivedAt, "2026-09-29T00:00:00Z");
  assert.equal(first.record.predictionEligible, false);
  const same = capture({ input: xgInput, evidencePath: proof, matches, storeDir: dir, now: "2026-09-29T01:00:00Z" });
  assert.equal(same.status, "duplicate");
  assert.equal(same.record.contentHash, first.record.contentHash);
  assert.equal(same.record.receivedAt, first.record.receivedAt);
  assert.throws(() => capture({ input: { ...xgInput, match: { ...xgInput.match, kickoffTime: upcoming.kickoffTime } },
    evidencePath: proof, matches, storeDir: dir }), /identity/);
  assert.throws(() => capture({ input: xgInput, evidencePath: proof, matches, storeDir: dir,
    now: "2026-09-26T11:00:00Z" }), /post-kickoff/);

  const result = make(previous, "result", { home: 2, away: 1 });
  capture({ input: result, evidencePath: proof, matches, storeDir: dir, now: "2026-09-29T00:00:00Z" });
  assert.throws(() => capture({ input: { ...result, values: { home: 0, away: 2 } },
    evidencePath: proof, matches, storeDir: dir, now: "2026-09-29T00:00:00Z" }), /conflicts/);

  const odds = make(upcoming, "total-odds", { bookmaker: "Test book", line: 2.5, over: 1.88, under: 1.97 });
  const pre = capture({ input: odds, evidencePath: proof, matches, storeDir: dir, now: "2026-09-30T10:00:00Z" });
  assert.equal(pre.record.preMatchCaptured, true);
  const after = capture({ input: { ...odds, values: { ...odds.values, over: 1.91 } }, evidencePath: proof,
    matches, storeDir: dir, now: "2026-09-30T11:30:00Z" });
  assert.equal(after.record.preMatchCaptured, false);
  assert.throws(() => capture({ input: { ...odds, values: { ...odds.values, line: 2.75, under: null } },
    evidencePath: proof, matches, storeDir: dir }), /both decimal prices/);
  assert.deepEqual(report(dir), { total: 4, result: 1, xg: 1, totalOdds: 2, preMatchTotalOdds: 1,
    lastReceivedAt: "2026-09-30T11:30:00Z", predictionEligible: 0 });

  const recordFile = path.join(dir, "observations", `${first.record.identityHash}.json`);
  const corrupt = JSON.parse(fs.readFileSync(recordFile, "utf8"));
  corrupt.values.home = 7;
  fs.writeFileSync(recordFile, JSON.stringify(corrupt));
  assert.throws(() => report(dir), /corrupt observation/);
  console.log("manual-goal-observation: exact event, system receipts, evidence hash, cutoff, idempotency and tamper rejection verified");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
