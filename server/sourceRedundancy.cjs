const timestampMs = (value) => {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
};

const normalizedTransport = (value) => String(value || "").trim().toLowerCase();

const isDirectTransport = (value) => ["direct", "proxy"].includes(normalizedTransport(value));

const relaySnapshotHasTrustedEvidence = (relaySnapshot, collectorState) => {
  if (!relaySnapshot || typeof relaySnapshot !== "object") return false;
  const state = collectorState && typeof collectorState === "object"
    ? collectorState
    : relaySnapshot.collectorState && typeof relaySnapshot.collectorState === "object"
      ? relaySnapshot.collectorState
      : {};
  const trustLevel = String(state.effectiveTrustLevel || state.lastUploadTrustLevel || "").toLowerCase();
  const trusted = state.lastUploadSnapshotTrusted === true
    || trustLevel === "trusted"
    || trustLevel === "trusted-fallback";
  const currentLane = relaySnapshot.currentLane || null;
  const fresh = currentLane
    ? currentLane.stale === false
    : relaySnapshot.stale === false && relaySnapshot.validationOk !== false;
  return trusted && fresh;
};

const healthyEgressProof = ({ egress, maxAgeMinutes, now }) => {
  if (!egress || typeof egress !== "object") return false;
  const status = String(egress.status || "").toLowerCase();
  const transport = normalizedTransport(egress.transport);
  const checkedAtMs = timestampMs(egress.checkedAt);
  const ageMs = checkedAtMs > 0 ? Math.max(0, now - checkedAtMs) : Infinity;
  const maxAgeMs = Math.max(1, Number(maxAgeMinutes || 20)) * 60 * 1000;
  const jsonEndpoints = Number(egress.summary?.jsonEndpoints || 0);
  const rows = Number(egress.summary?.rows || 0);
  return egress.ok === true
    && status === "healthy"
    && isDirectTransport(transport)
    && jsonEndpoints > 0
    && rows > 0
    && ageMs <= maxAgeMs;
};

const assessOfficialSourceRedundancy = ({
  skipSportteryDirectFetch = false,
  syncTransport = null,
  currentLaneFresh = false,
  sportteryEgress = null,
  relaySnapshot = null,
  relayCollectorState = null,
  trustedCollectorCount = null,
  requiredTrustedCollectors = 2,
  egressProofMaxAgeMinutes = 20,
  now = Date.now()
} = {}) => {
  const runtimeDirectProof = !skipSportteryDirectFetch
    && currentLaneFresh === true
    && isDirectTransport(syncTransport);
  const egressProbeProof = !skipSportteryDirectFetch && healthyEgressProof({
    egress: sportteryEgress,
    maxAgeMinutes: egressProofMaxAgeMinutes,
    now
  });
  const serverDirectAvailable = runtimeDirectProof || egressProbeProof;
  const relayTrusted = relaySnapshotHasTrustedEvidence(relaySnapshot, relayCollectorState);
  const hasExplicitCollectorCount = trustedCollectorCount !== null
    && trustedCollectorCount !== undefined
    && trustedCollectorCount !== ""
    && Number.isFinite(Number(trustedCollectorCount));
  const evidencedCollectorCount = hasExplicitCollectorCount
    ? Math.max(0, Math.floor(Number(trustedCollectorCount)))
    : relayTrusted
      ? 1
      : 0;
  const collectorProof = evidencedCollectorCount > 0
    ? hasExplicitCollectorCount
      ? "current-cryptographically-attested-market-lane"
      : relayTrusted
        ? "current-trusted-relay-snapshot"
        : "runtime-collector-evidence"
    : "none";
  const collectorEvidenceScope = evidencedCollectorCount > 0
    ? hasExplicitCollectorCount
      ? "current-market-lane"
      : "relay-snapshot"
    : "none";
  const requiredCollectors = Math.max(2, Math.floor(Number(requiredTrustedCollectors || 2)));
  const officialSourceSinglePoint = !serverDirectAvailable && evidencedCollectorCount < requiredCollectors;
  const mode = officialSourceSinglePoint
    ? evidencedCollectorCount > 0
      ? "single-collector"
      : "no-verified-independent-path"
    : serverDirectAvailable && evidencedCollectorCount > 0
      ? "server-direct-plus-relay"
      : serverDirectAvailable
        ? "server-direct"
        : "multi-collector";

  return {
    status: officialSourceSinglePoint ? "watch" : "redundant",
    mode,
    officialSourceSinglePoint,
    serverDirectAvailable,
    serverDirectProof: runtimeDirectProof
      ? "successful-sync-transport"
      : egressProbeProof
        ? "fresh-egress-probe"
        : "none",
    trustedCollectorCount: evidencedCollectorCount,
    requiredTrustedCollectors: requiredCollectors,
    collectorProof,
    collectorEvidenceScope,
    reason: officialSourceSinglePoint
      ? `verified server direct/proxy unavailable and trusted collectors ${evidencedCollectorCount}/${requiredCollectors}`
      : serverDirectAvailable
        ? "verified server direct/proxy path available"
        : `trusted collectors ${evidencedCollectorCount}/${requiredCollectors}`
  };
};

module.exports = {
  assessOfficialSourceRedundancy,
  healthyEgressProof,
  relaySnapshotHasTrustedEvidence
};
