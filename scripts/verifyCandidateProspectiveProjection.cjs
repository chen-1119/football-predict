"use strict";

const assert = require("node:assert/strict");
const {
  activeRegistryCandidateRevisionId,
  selectCandidateProspectiveAudit,
} = require("../src/services/candidateProspectiveProjection.cjs");

const audit = (candidateRevisionId, overrides = {}) => ({
  candidateRevisionId,
  chainValid: true,
  decisionRecord: { complete: true },
  settlementRecord: { complete: true },
  cohort: { formal: { admitted: 0 } },
  ...overrides,
});

const registry = (candidateRevisionId) => ({
  activeLedgerId: "ledger-active",
  ledgers: [{
    ledgerId: "ledger-active",
    header: { candidateRevisionId },
  }],
});

const active = audit("candidate@active", { state: "ACTIVE" });
const retrospective = audit("candidate@retrospective", { state: "SHADOW" });

assert.equal(
  activeRegistryCandidateRevisionId(registry("candidate@active")),
  "candidate@active",
);
assert.equal(
  selectCandidateProspectiveAudit({
    backtestAudit: retrospective,
    heartbeatAudit: active,
    registry: registry("candidate@active"),
  }),
  active,
  "a verified heartbeat bound to the live active ledger must survive retrospective artifact drift",
);
assert.equal(
  selectCandidateProspectiveAudit({
    backtestAudit: retrospective,
    heartbeatAudit: active,
    registry: registry("candidate@different"),
  }),
  retrospective,
  "an unbound heartbeat must not override the current backtest artifact",
);
assert.equal(
  selectCandidateProspectiveAudit({
    backtestAudit: retrospective,
    heartbeatAudit: audit("candidate@active", { chainValid: false }),
    registry: registry("candidate@active"),
  }),
  retrospective,
  "an invalid heartbeat must fail closed",
);
assert.equal(
  selectCandidateProspectiveAudit({
    backtestAudit: retrospective,
    heartbeatAudit: audit("candidate@active", { settlementRecord: null }),
    registry: registry("candidate@active"),
  }),
  retrospective,
  "a heartbeat that omits the official settlement audit must fail closed",
);
assert.equal(
  selectCandidateProspectiveAudit({
    backtestAudit: null,
    heartbeatAudit: active,
    registry: null,
  }),
  active,
  "a complete heartbeat remains the fallback when no backtest audit exists",
);

console.log(JSON.stringify({
  ok: true,
  verifier: "candidate-prospective-projection",
  assertions: 6,
}, null, 2));
