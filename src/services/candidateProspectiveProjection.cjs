"use strict";

const activeRegistryCandidateRevisionId = (registry) => {
  const activeLedgerId = String(registry?.activeLedgerId || "");
  if (!activeLedgerId || !Array.isArray(registry?.ledgers)) return null;
  const active = registry.ledgers.find(
    (ledger) => String(ledger?.ledgerId || "") === activeLedgerId,
  );
  return String(active?.header?.candidateRevisionId || "") || null;
};

const completeCandidateAudit = (audit) => Boolean(
  audit
  && typeof audit === "object"
  && audit.chainValid === true
  && audit.decisionRecord
  && audit.settlementRecord
  && audit.cohort
  && audit.candidateRevisionId,
);

const selectCandidateProspectiveAudit = ({
  backtestAudit = null,
  heartbeatAudit = null,
  registry = null,
} = {}) => {
  if (!completeCandidateAudit(heartbeatAudit)) return backtestAudit;
  const heartbeatRevisionId = String(
    heartbeatAudit.candidateRevisionId || "",
  );
  const backtestRevisionId = String(
    backtestAudit?.candidateRevisionId || "",
  );
  const registryRevisionId = activeRegistryCandidateRevisionId(registry);
  const heartbeatIsRegistryActive = Boolean(
    registryRevisionId && registryRevisionId === heartbeatRevisionId,
  );
  if (
    heartbeatIsRegistryActive
    || !backtestRevisionId
    || backtestRevisionId === heartbeatRevisionId
  ) {
    return heartbeatAudit;
  }
  return backtestAudit;
};

module.exports = {
  activeRegistryCandidateRevisionId,
  completeCandidateAudit,
  selectCandidateProspectiveAudit,
};
