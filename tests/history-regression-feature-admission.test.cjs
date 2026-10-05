"use strict";

// Every row below is synthetic. These adversarial adapter probes validate
// admission boundaries; they are not evidence of historical model performance.
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  FEATURE_CONTRACT, runHistoryRegressionReplay, summarizePublishedHistory, score,
} = require("../scripts/historyRegressionReplay.cjs");

const CANDIDATE = "synthetic-feature-admission-probe";
const CLOCKS = ["providerObservedAt", "receivedAt", "availableAt", "observedAt"];
const REQUIRED_CLOCKS = CLOCKS.slice(0, 3);
const day = value => `2026-01-${String(value).padStart(2, "0")}`;
const clock = (value, hour) => `${day(value)}T${hour}:00:00+08:00`;

function feature(value, matchDay) {
  return {
    value, source: "SYNTHETIC_PROVIDER_ONLY", payloadSha256: "a".repeat(64),
    providerObservedAt: clock(matchDay, "07"), observedAt: clock(matchDay, "08"),
    receivedAt: clock(matchDay, "08").replace(":00:00", ":30:00"),
    availableAt: clock(matchDay, "09"),
  };
}

function fixtures(names = ["elo"]) {
  return Array.from({ length: 8 }, (_, i) => ["home", "draw"].map((outcome, j) => ({
    matchId: `synthetic-admission-${i + 1}-${j}`, market: "HAD", league: "SYNTHETIC_FEATURE_TEST_ONLY",
    kickoffAt: clock(i + 1, "12"),
    decision: { id: `synthetic-admission-decision-${i + 1}-${j}`, at: clock(i + 1, "10"),
      modelVersion: "synthetic-frozen", probabilities: { home: 0.5, draw: 0.3, away: 0.2 } },
    officialOdds: { sp: { home: 2, draw: 3, away: 4 } },
    result: { outcome, observedAt: clock(i + 1, "15") },
    features: { candidateEligible: true, values: Object.fromEntries(names.map(name => [name, feature(j, i + 1)])) },
  }))).flat();
}

function options(names = ["elo"], calls = [], predict) {
  return {
    windows: { train: { start: day(1), end: day(3) }, calibration: { start: day(3), end: day(5) },
      validation: { start: day(5), end: day(7) }, finalTest: { start: day(7), end: day(9) } },
    minimumRows: { training: 1, calibration: 1, validation: 1, finalTest: 1 },
    bootstrap: { iterations: 200, minBlocks: 2, minRows: 2, seed: 919 },
    source: { fixture: "SYNTHETIC_FEATURE_ADMISSION_ONLY" },
    candidates: [{ id: CANDIDATE, version: "1", requiredFeatures: names, requiresCalibration: true,
      fit(rows) { calls.push({ stage: "fit", rows }); return {}; },
      calibrate(state, rows) { calls.push({ stage: "calibrate", rows }); return state; },
      predict(state, row) {
        calls.push({ stage: Number(row.kickoffAt.slice(8, 10)) < 7 ? "validation" : "final", row });
        return predict ? predict(state, row) : row.decision.probabilities;
      },
    }],
  };
}

function auditFor(report, matchId) {
  return report.featureAdmission.rows.find(row => row.matchId === matchId).candidates[CANDIDATE];
}

function rejectedEverywhere(mutate, reason, names = ["elo"]) {
  const rows = fixtures(names), calls = [];
  rows.forEach(row => mutate(row, row.features.values[names[0]]));
  const report = runHistoryRegressionReplay(rows, options(names, calls));
  assert.equal(report.selection.selectedCandidate, null);
  assert.equal(report.validation.metrics[CANDIDATE].n, 0);
  assert.equal(report.validation.metrics[CANDIDATE].brier, null);
  assert.deepEqual(calls, [], "Unadmitted features must never reach even the fit adapter");
  for (const row of rows) {
    const audit = auditFor(report, row.matchId);
    assert.equal(audit.eligible, false);
    if (reason) assert.match(audit.reason, reason);
    assert.equal(Object.hasOwn(audit, "features"), false);
  }
  assert.equal(report.productionEligible, false);
  return { report, rows };
}

test("synthetic positive: all reviewed names preserve original clocks in four stage inputs and audit evidence", () => {
  const names = ["elo", "form", "weather"], rows = fixtures(names), calls = [];
  for (const row of rows) {
    row.features.values.weather.value = true;
    row.features.values.elo.providerObservedAt = new Date(row.features.values.elo.providerObservedAt).toISOString();
    row.features.values.form.extraFuture = "SYNTHETIC_FORBIDDEN_EXTRA";
  }
  const before = structuredClone(rows);
  const report = runHistoryRegressionReplay(rows, options(names, calls));
  assert.deepEqual(FEATURE_CONTRACT.allowedNames, names);
  assert.deepEqual(report.protocol.featureContract, FEATURE_CONTRACT);
  assert.equal(report.featureAdmission.contractVersion, FEATURE_CONTRACT.version);
  assert.equal(report.selection.selectedCandidate, CANDIDATE);
  assert.deepEqual(calls.map(call => call.stage), ["fit", "calibrate", ...Array(4).fill("validation"), ...Array(4).fill("final")]);
  for (const call of calls) for (const received of call.rows ?? [call.row]) {
    const original = rows.find(row => row.matchId === received.matchId);
    assert.ok(Object.isFrozen(received.features));
    for (const name of names) {
      const expected = { ...original.features.values[name] };
      delete expected.extraFuture;
      assert.deepEqual(received.features[name], expected);
      assert.deepEqual(auditFor(report, received.matchId).features[name], expected);
    }
    if (call.row) assert.equal(Object.hasOwn(received, "result"), false);
    assert.equal(JSON.stringify(received.features).includes("SYNTHETIC_FORBIDDEN_EXTRA"), false);
  }
  assert.deepEqual(rows, before);
  assert.equal(report.productionEligible, false);
});

test("synthetic positive: optional observedAt remains absent and equal required clocks are permitted", () => {
  const rows = fixtures(), calls = [];
  for (const row of rows) {
    const value = row.features.values.elo;
    delete value.observedAt;
    for (const key of REQUIRED_CLOCKS) value[key] = row.decision.at;
  }
  const report = runHistoryRegressionReplay(rows, options(["elo"], calls));
  assert.equal(report.selection.selectedCandidate, CANDIDATE);
  for (const call of calls) for (const row of call.rows ?? [call.row]) {
    assert.equal(Object.hasOwn(row.features.elo, "observedAt"), false);
    assert.equal(Object.hasOwn(auditFor(report, row.matchId).features.elo, "observedAt"), false);
    for (const key of REQUIRED_CLOCKS) assert.equal(row.features.elo[key], row.decision.at);
  }
});

test("synthetic exploit: old availability cannot hide future provider and receipt clocks", () => {
  const { report, rows } = rejectedEverywhere((row, value) => {
    value.providerObservedAt = row.result.observedAt;
    value.observedAt = row.result.observedAt;
    value.receivedAt = row.result.observedAt;
  }, /unavailable at decision/);
  for (const row of rows) {
    assert.deepEqual(auditFor(report, row.matchId).declaredClocks.elo,
      Object.fromEntries(CLOCKS.map(key => [key, row.features.values.elo[key]])));
  }
});

test("synthetic exploit: camelCase finalScoreHome cannot manufacture a perfect candidate score", () => {
  const rows = fixtures(["finalScoreHome"]), calls = [];
  const oracle = value => ({ home: Number(value === 0), draw: Number(value === 1), away: 0 });
  // This encodes future outcomes on purpose. Its hypothetical Brier is zero,
  // making success of the rejection observable rather than merely name based.
  for (const row of rows) assert.equal(score(oracle(row.features.values.finalScoreHome.value), row.result.outcome).brier, 0);
  const report = runHistoryRegressionReplay(rows, options(["finalScoreHome"], calls,
    (_, row) => oracle(row.features.finalScoreHome.value)));
  assert.equal(report.selection.selectedCandidate, null);
  assert.equal(report.validation.metrics[CANDIDATE].n, 0);
  assert.equal(report.validation.metrics[CANDIDATE].brier, null);
  assert.deepEqual(calls, []);
  assert.ok(report.featureAdmission.rows.every(row => !row.candidates[CANDIDATE].eligible));
});

for (const name of ["final_score_home", "final-score-home", "FinalScoreHome", "final.score.home",
  "result", "resultObservedAt", "outcome_code", "closingOdds", "postMatchRating", "xg", "Elo", "elo.home"]) {
  test(`synthetic feature contract rejects unreviewed or outcome-derived spelling ${name}`, () => {
    rejectedEverywhere(() => {}, /forbidden|unreviewed/, [name]);
  });
}

for (const [label, eligibility] of [["absent", undefined], ["false", false], ["true string", "true"], ["false string", "false"], ["one", 1], ["null", null]]) {
  test(`synthetic top-level qualification must be explicitly true: ${label}`, () => {
    rejectedEverywhere(row => {
      if (eligibility === undefined) delete row.features.candidateEligible;
      else row.features.candidateEligible = eligibility;
    }, /eligibility|ineligible/);
  });
}

for (const key of REQUIRED_CLOCKS) test(`synthetic required clock ${key} cannot be absent or synthesized`, () => {
  const { report, rows } = rejectedEverywhere((_, value) => { delete value[key]; }, /clock missing/);
  assert.ok(rows.every(row => !Object.hasOwn(auditFor(report, row.matchId).declaredClocks.elo, key)));
});

for (const key of CLOCKS) {
  test(`synthetic ${key} requires an explicit timezone`, () => {
    rejectedEverywhere((_, value) => { value[key] = "2026-01-01T07:00:00"; }, /strict|timestamp/);
  });
  test(`synthetic ${key} rejects a nonexistent calendar date`, () => {
    rejectedEverywhere((_, value) => { value[key] = "2025-02-30T07:00:00+08:00"; }, /strict|timestamp/);
  });
  test(`synthetic ${key} rejects future time even when availableAt is old`, () => {
    rejectedEverywhere((row, value) => { value[key] = row.result.observedAt; }, /unavailable at decision/);
  });
  for (const [label, invalid] of [["undefined", undefined], ["null", null], ["number", 1767218400000], ["Date object", new Date("2025-12-31T23:00:00Z")]]) {
    test(`synthetic original ${key} type ${label} is rejected before JSON copying`, () => {
      const { report, rows } = rejectedEverywhere((_, value) => { value[key] = invalid; }, /strict|timestamp/);
      assert.ok(rows.every(row => Object.hasOwn(auditFor(report, row.matchId).declaredClocks.elo, key)));
      const marker = auditFor(report, rows[0].matchId).declaredClocks.elo[key];
      assert.equal(typeof marker, "object");
      assert.equal(marker.invalidType, invalid === null ? "null" : typeof invalid);
    });
  }
}

for (const [label, mutate] of [
  ["provider after observation", (_, value) => { value.providerObservedAt = value.receivedAt; }],
  ["observation after receipt", (_, value) => { value.observedAt = value.availableAt; }],
  ["receipt after availability", (row, value) => { value.receivedAt = row.decision.at; }],
  ["provider after receipt without optional observation", (_, value) => { delete value.observedAt; value.providerObservedAt = value.availableAt; }],
]) test(`synthetic required original clock ordering: ${label}`, () => {
  rejectedEverywhere(mutate, /clock order/);
});

for (const [label, mutate] of [
  ["missing true", (_, value) => { value.missing = true; }],
  ["available false", (_, value) => { value.available = false; }],
  ["field candidateEligible false", (_, value) => { value.candidateEligible = false; }],
  ["group candidateEligible false", (row) => { row.features.groups = { elo: { available: true, candidateEligible: false } }; }],
  ["missing status", (_, value) => { value.status = "missing"; }],
  ["unavailable status", (_, value) => { value.status = "unavailable"; }],
  ["unknown status", (_, value) => { value.status = "unknown"; }],
  ["excluded status", (_, value) => { value.status = "excluded"; }],
  ["named in missing list", row => { row.features.missing = ["elo"]; }],
  ["whitespace-only source", (_, value) => { value.source = " \t "; }],
  ["missing payload hash", (_, value) => { delete value.payloadSha256; }],
  ["malformed payload hash", (_, value) => { value.payloadSha256 = "a".repeat(63); }],
  ["NaN value", (_, value) => { value.value = NaN; }],
  ["infinite value", (_, value) => { value.value = Infinity; }],
  ["numeric string value", (_, value) => { value.value = "0.2"; }],
  ["null value", (_, value) => { value.value = null; }],
]) test(`synthetic field provenance or completeness is not overridden by top-level true: ${label}`, () => {
  rejectedEverywhere(mutate, /missing|ineligible|source|hash|numeric/);
});

for (const [stage, index] of [["fit", 0], ["calibrate", 4], ["validation", 8], ["final", 12]]) {
  test(`synthetic late receipt is gated independently at ${stage}`, () => {
    const rows = fixtures(), calls = [], invalid = rows[index];
    invalid.features.values.elo.receivedAt = invalid.result.observedAt;
    const report = runHistoryRegressionReplay(rows, options(["elo"], calls));
    const seen = calls.flatMap(call => call.rows ?? [call.row]);
    assert.equal(seen.some(row => row.matchId === invalid.matchId), false);
    assert.equal(auditFor(report, invalid.matchId).eligible, false);
    assert.equal(auditFor(report, invalid.matchId).declaredClocks.elo.receivedAt, invalid.result.observedAt);
    const count = label => calls.filter(call => call.stage === label).length;
    assert.equal(count("fit"), stage === "fit" ? 0 : 1);
    assert.equal(count("calibrate"), ["fit", "calibrate"].includes(stage) ? 0 : 1);
    assert.equal(count("validation"), stage === "validation" ? 3 : stage === "final" ? 4 : 0);
    assert.equal(count("final"), stage === "final" ? 3 : 0);
    assert.equal(report.selection.selectedCandidate, stage === "final" ? CANDIDATE : null);
    if (stage === "validation") assert.equal(report.validation.metrics[CANDIDATE].coverage, 0.75);
    if (stage === "final") assert.equal(report.finalTest.metrics[CANDIDATE].coverage, 0.75);
    assert.equal(report.status, "blocked-or-baseline-only-shadow");
    assert.equal(report.productionEligible, false);
  });
}

test("synthetic candidate admission leaves original frozen review and input unchanged", () => {
  const rows = fixtures(), calls = [];
  rows[8].features.values.elo.receivedAt = rows[8].result.observedAt;
  const beforeRows = structuredClone(rows);
  const before = summarizePublishedHistory(rows, options());
  const withoutCandidate = runHistoryRegressionReplay(rows, { ...options(), candidates: [] });
  const withCandidate = runHistoryRegressionReplay(rows, options(["elo"], calls));
  const after = summarizePublishedHistory(rows, options());
  assert.deepEqual(after, before, "Frozen original predictions must not depend on candidate feature audit");
  assert.deepEqual(rows, beforeRows);
  for (const stage of ["validation", "finalTest"]) for (const baseline of ["publishedModel", "sameDecisionMarket"]) {
    assert.deepEqual(withCandidate[stage].metrics[baseline], withoutCandidate[stage].metrics[baseline]);
  }
  assert.equal(withCandidate.selection.selectedCandidate, null);
});

for (const key of CLOCKS) for (const [label, fraction] of [["1ns", "000000001"], ["100us", "000100000"]]) {
  test(`synthetic ${key} ${label} after decision is rejected without millisecond truncation`, () => {
    const { report, rows } = rejectedEverywhere((row, value) => {
      value[key] = row.decision.at.replace("T10:00:00", `T10:00:00.${fraction}`);
    }, /unavailable at decision/);
    for (const row of rows) assert.equal(auditFor(report, row.matchId).declaredClocks.elo[key], row.features.values.elo[key]);
  });
}

for (const [before, after, omitObserved] of [
  ["providerObservedAt", "observedAt", false],
  ["observedAt", "receivedAt", false],
  ["receivedAt", "availableAt", false],
  ["providerObservedAt", "receivedAt", true],
]) test(`synthetic ${before} 1ns after ${after} violates original clock order`, () => {
  rejectedEverywhere((_, value) => {
    if (omitObserved) delete value.observedAt;
    value[before] = value[after].replace(/:00\+08:00$/, ":00.000000001+08:00");
    value[after] = value[after].replace(/:00\+08:00$/, ":00.000000000+08:00");
  }, /clock order/);
});

test("synthetic equal submillisecond instants with different zones and decimal lengths retain their exact bytes", () => {
  const rows = fixtures(), calls = [];
  for (const row of rows) {
    const date = row.decision.at.slice(0, 10), value = row.features.values.elo;
    row.decision.at = `${date}T10:00:00.123400000+08:00`;
    value.providerObservedAt = `${date}T02:00:00.1234Z`;
    value.observedAt = `${date}T03:00:00.123400+01:00`;
    value.receivedAt = `${date}T10:00:00.123400000+08:00`;
    value.availableAt = `${date}T10:00:00.12340000+08:00`;
  }
  const report = runHistoryRegressionReplay(rows, options(["elo"], calls));
  assert.equal(report.selection.selectedCandidate, CANDIDATE);
  for (const call of calls) for (const row of call.rows ?? [call.row]) {
    const original = rows.find(source => source.matchId === row.matchId);
    assert.deepEqual(row.features.elo, original.features.values.elo);
    assert.deepEqual(auditFor(report, row.matchId).features.elo, original.features.values.elo);
    assert.equal(row.decision.at, original.decision.at);
  }
});

test("synthetic nanosecond feature clocks just before a nine-digit decision clock remain eligible", () => {
  const rows = fixtures(), calls = [];
  for (const row of rows) {
    const prefix = row.decision.at.replace("T10:00:00", "T10:00:00.123456");
    row.decision.at = prefix.replace("+08:00", "789+08:00");
    for (const [key, suffix] of [["providerObservedAt", "785"], ["observedAt", "786"], ["receivedAt", "787"], ["availableAt", "788"]]) {
      row.features.values.elo[key] = prefix.replace("+08:00", `${suffix}+08:00`);
    }
  }
  const report = runHistoryRegressionReplay(rows, options(["elo"], calls));
  assert.equal(report.selection.selectedCandidate, CANDIDATE);
  assert.ok(report.featureAdmission.rows.every(row => row.candidates[CANDIDATE].eligible));
  for (const call of calls) for (const row of call.rows ?? [call.row]) {
    const original = rows.find(source => source.matchId === row.matchId);
    assert.deepEqual(row.features.elo, original.features.values.elo);
    assert.equal(row.decision.at, original.decision.at);
  }
});
