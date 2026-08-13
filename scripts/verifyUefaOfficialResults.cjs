const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  VERSION,
  applyUefaOfficialResult,
  buildEvidenceRecord,
  evidenceHashForRecord,
  eligibleUnresolvedMatches,
  isUefaCompetitionMatch,
  isTrustedUefaOfficialResult,
  mergeUefaCandidateRows,
  normalizeTeamName,
  regularTimeScore,
  selectUefaEventForMatch,
  syncUefaOfficialResults,
  validUefaEvidenceForMatch,
} = require("./syncUefaOfficialResults.cjs");
const {
  isTrustedOfficialFinal,
  resolveMatchLifecycle,
} = require("../src/services/matchLifecycle.cjs");
const {
  hasAcceptedResultOnlySource,
} = require("./resultOnlyValidation.cjs");

const kickoffTime = "2026-07-28T23:00:00+08:00";
const observedAt = "2026-07-28T18:00:00.000Z";
const responseSha256 = "a".repeat(64);
const match = {
  id: "sporttery_2040643",
  source: "sporttery",
  sourceMatchId: "2040643",
  status: "PENDING_RESULT",
  kickoffTime,
  eventVersion: kickoffTime,
  leagueName: "欧冠",
  leagueNameEn: "UEFA Champions League",
  homeTeamName: "库奥皮奥",
  awayTeamName: "萨巴赫",
};

const team = (internationalName, zh) => ({
  internationalName,
  translations: {
    displayName: { EN: internationalName, ZH: zh },
    displayOfficialName: { EN: `${internationalName} FC`, ZH: zh },
    shortName: { EN: internationalName, ZH: zh },
  },
});

const event = {
  id: "2048729",
  status: "FINISHED",
  kickOffTime: { dateTime: "2026-07-28T15:00:00Z" },
  matchday: { competitionId: "1" },
  homeTeam: team("KuPS Kuopio", "古比斯库皮奥"),
  awayTeam: team("Sabah", "Sabah"),
  score: {
    regular: { home: 0, away: 2 },
    aggregate: { home: 0, away: 3 },
    total: { home: 0, away: 2 },
  },
};

const checks = [];
const check = (name, fn) => {
  fn();
  checks.push({ name, ok: true });
};

check("normalization handles the official Chinese KuPS alias", () => {
  assert.equal(normalizeTeamName("古比斯库皮奥"), "库奥皮奥库皮奥");
});

check("Lech Poznan transliterations normalize to one canonical Chinese identity", () => {
  assert.equal(
    normalizeTeamName("\u6ce2\u5179\u5357\u83b1\u8d6b"),
    normalizeTeamName("\u6ce2\u65af\u5357\u83b1\u65bd"),
  );
  assert.equal(normalizeTeamName("\u6ce2\u5179\u5357"), "\u6ce2\u5179\u5357");
});

check("regular-time score is used instead of aggregate score", () => {
  assert.deepEqual(regularTimeScore(event), { home: 0, away: 2 });
});

check("UEFA result recovery follows event identity even when the schedule row came from a fallback lane", () => {
  const fallbackRow = {
    ...match,
    id: "fivehundred_2040643",
    source: "five-hundred",
    status: "PENDING_RESULT",
  };
  assert.equal(eligibleUnresolvedMatches(
    [fallbackRow],
    Date.parse("2026-07-29T03:00:00+08:00")
  ).length, 1);
});

check("Europa and Conference League rows use the same official organizer result lane", () => {
  assert.equal(isUefaCompetitionMatch({
    leagueName: "欧罗巴",
    leagueNameEn: "UEFA Europa League",
  }), true);
  assert.equal(isUefaCompetitionMatch({
    leagueName: "欧协联",
    leagueNameEn: "UEFA Conference League",
  }), true);
});

const selection = selectUefaEventForMatch(match, [event]);
check("unique exact-clock UEFA event maps to the Sporttery row", () => {
  assert.equal(selection.matched, true);
  assert.equal(selection.evidence.kickoffDeltaMs, 0);
  assert.equal(selection.evidence.score.home, 0);
  assert.equal(selection.evidence.score.away, 2);
});

const record = buildEvidenceRecord(match, selection, observedAt, responseSha256);
check("evidence is cryptographically bound and valid for the exact event", () => {
  assert.equal(record.version, VERSION);
  assert.equal(record.evidenceHash, evidenceHashForRecord(record));
  assert.equal(validUefaEvidenceForMatch(match, record), true);
});

const settled = applyUefaOfficialResult(match, { version: VERSION, matches: { "2040643": record } });
check("trusted UEFA result becomes a formal settlement input", () => {
  assert.equal(settled.status, "FINISHED");
  assert.equal(settled.scoreHome, 0);
  assert.equal(settled.scoreAway, 2);
  assert.equal(settled.resultProvenance.provider, "uefa");
  assert.equal(isTrustedUefaOfficialResult(settled), true);
});

check("trusted UEFA result survives the shared lifecycle resolver", () => {
  const resolved = resolveMatchLifecycle(settled, { now: observedAt });
  assert.equal(isTrustedOfficialFinal(resolved), true);
  assert.equal(
    hasAcceptedResultOnlySource({
      ...resolved,
      id: "fivehundred_2040643",
      odds: undefined,
      oddsSource: undefined,
    }),
    true,
    "a trusted organizer result must validate even when the retained archive row has no Sporttery odds URL",
  );
  assert.equal(resolved.status, "FINISHED");
  assert.equal(resolved.statusReason, "official-uefa-final");
  assert.equal(resolved.scoreHome, 0);
  assert.equal(resolved.scoreAway, 2);
  assert.equal(resolved.resultProvenance.provider, "uefa");
  assert.equal(resolved.resultProvenance.promotionEligible, false);
});

check("an exact official Sporttery result is never overwritten", () => {
  const officialSporttery = {
    ...match,
    status: "FINISHED",
    scoreHome: 1,
    scoreAway: 0,
    resultProvenance: { provider: "sporttery", official: true, trusted: true },
  };
  assert.equal(
    applyUefaOfficialResult(officialSporttery, { version: VERSION, matches: { "2040643": record } }),
    officialSporttery,
  );
});

check("event-version mismatch fails closed", () => {
  const moved = { ...match, kickoffTime: "2026-07-28T23:05:00+08:00", eventVersion: "2026-07-28T23:05:00+08:00" };
  assert.equal(validUefaEvidenceForMatch(moved, record), false);
});

check("tampered score fails the evidence hash check", () => {
  assert.equal(validUefaEvidenceForMatch(match, { ...record, scoreHome: 5 }), false);
  assert.equal(
    hasAcceptedResultOnlySource({
      ...settled,
      scoreHome: 5,
      sourceUrl: undefined,
      resultUrl: undefined,
    }),
    false,
    "an unbound score must not gain result-only trust from the UEFA source label alone",
  );
});

check("ambiguous same-clock events fail closed unless both identities separate them", () => {
  const unrelated = {
    ...event,
    id: "other",
    homeTeam: team("Other Home", "其他主队"),
    awayTeam: team("Other Away", "其他客队"),
  };
  const result = selectUefaEventForMatch(match, [event, unrelated]);
  assert.equal(result.matched, false);
  assert.equal(result.reason, "team-identity-or-uniqueness-not-proven");
});

check("swapped home and away ordering is rejected", () => {
  const swapped = {
    ...event,
    id: "swapped",
    homeTeam: event.awayTeam,
    awayTeam: event.homeTeam,
  };
  assert.equal(selectUefaEventForMatch(match, [swapped]).matched, false);
});

check("an official score correction increments the immutable revision", () => {
  const correctedSelection = {
    ...selection,
    evidence: {
      ...selection.evidence,
      event: {
        ...event,
        score: { ...event.score, regular: { home: 1, away: 2 } },
      },
      score: { home: 1, away: 2 },
    },
  };
  const corrected = buildEvidenceRecord(match, correctedSelection, "2026-07-28T18:05:00.000Z", "b".repeat(64), record);
  assert.equal(corrected.resultRevision, 2);
  assert.equal(corrected.firstObservedAt, corrected.observedAt);
});

const verifyArchivedLechSettlement = async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "football-uefa-archive-"));
  try {
    const currentFile = path.join(tempDir, "matches-current.json");
    const unresolvedArchiveFile = path.join(tempDir, "matches-unresolved-archive.json");
    const outputFile = path.join(tempDir, "uefa-official-results.json");
    const lechKickoff = "2026-07-29T17:00:00.000Z";
    const archivedPrediction = Object.freeze({
      market: "HAD",
      selection: "HOME_WIN",
      odds: 1.53,
      capturedAt: "2026-07-29T15:00:00.000Z",
    });
    const lechMatch = {
      id: "fivehundred_2040646",
      sourceMatchId: "2040646",
      status: "PENDING_RESULT",
      kickoffTime: lechKickoff,
      eventVersion: lechKickoff,
      leagueName: "\u6b27\u51a0",
      leagueNameEn: "UEFA Champions League",
      homeTeamName: "\u6ce2\u5179\u5357",
      awayTeamName: "\u5965\u80e1\u65af",
      preMatchPredictionSnapshot: archivedPrediction,
    };
    const lechEvent = {
      id: "2048731",
      status: "FINISHED",
      kickOffTime: { dateTime: lechKickoff },
      matchday: { competitionId: "1" },
      homeTeam: team("Lech Poznan", "\u6ce2\u65af\u5357\u83b1\u65bd"),
      awayTeam: team("Aarhus", "\u5965\u80e1\u65af"),
      score: {
        regular: { home: 0, away: 3 },
        total: { home: 1, away: 4 },
        penalty: { home: 3, away: 4 },
      },
    };

    fs.writeFileSync(currentFile, "[]\n", "utf8");
    fs.writeFileSync(
      unresolvedArchiveFile,
      `${JSON.stringify({ version: 1, rows: [lechMatch] }, null, 2)}\n`,
      "utf8",
    );

    const merged = mergeUefaCandidateRows([lechMatch], [lechMatch]);
    check("current and unresolved-archive candidates deduplicate by source match id", () => {
      assert.equal(merged.length, 1);
    });

    const raw = Buffer.from(JSON.stringify([lechEvent]), "utf8");
    const payload = await syncUefaOfficialResults({
      currentFile,
      unresolvedArchiveFile,
      outputFile,
      nowMs: Date.parse("2026-07-29T20:00:00.000Z"),
      response: { raw, body: [lechEvent] },
    });
    check("an unresolved archived UEFA row receives the organizer regular-time result", () => {
      assert.equal(payload.summary.currentRows, 0);
      assert.equal(payload.summary.archiveRows, 1);
      assert.equal(payload.summary.combinedRows, 1);
      assert.equal(payload.summary.eligible, 1);
      assert.equal(payload.summary.matched, 1);
      assert.equal(payload.matches["2040646"].scoreText, "0:3");
      assert.equal(payload.matches["2040646"].scoreKind, "regular-time");
    });

    const archivedSettled = applyUefaOfficialResult(lechMatch, payload);
    check("official settlement preserves the immutable archived recommendation", () => {
      assert.equal(archivedSettled.status, "FINISHED");
      assert.equal(archivedSettled.scoreHome, 0);
      assert.equal(archivedSettled.scoreAway, 3);
      assert.deepEqual(archivedSettled.preMatchPredictionSnapshot, archivedPrediction);
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
};

verifyArchivedLechSettlement()
  .then(() => {
    console.log(JSON.stringify({
      ok: true,
      verifier: "uefa-official-results-contract-v1",
      assertions: checks.length,
      checks,
    }, null, 2));
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
