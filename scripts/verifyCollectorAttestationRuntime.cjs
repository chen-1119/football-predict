const fs = require("node:fs");
const path = require("node:path");
const {
  loadCollectorTrustRegistry,
  verifyCollectorAttestation,
} = require("../src/services/collectorAttestation.cjs");
const {
  isStrictMarketSourceProvenance,
  normalizeMarketSourceProvenance,
} = require("../src/services/marketSourceProvenance.cjs");
const {
  matchesFromSportteryRelaySnapshot,
} = require("./syncData.cjs");
const {
  summarizeTrustedMarketCollectorEvidence,
} = require("../server/relayCollectorEvidence.cjs");

const rootDir = path.resolve(__dirname, "..");
const strictMode = process.argv.includes("--strict");
const positionalPath = process.argv.slice(2).find((value) => !value.startsWith("--"));
const snapshotPath = path.resolve(
  positionalPath
  || process.env.SPORTTERY_RELAY_SNAPSHOT_PATH
  || path.join(rootDir, ".codex-tmp", "sporttery-relay-snapshot.json"),
);
const registryPath = path.resolve(
  process.env.SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH
  || path.join(rootDir, "deploy", "light-server", "collector-trust-registry.json"),
);

const countBy = (values) => values.reduce((counts, value) => {
  const key = String(value || "unknown");
  counts[key] = (counts[key] || 0) + 1;
  return counts;
}, {});

const fail = (reason, detail = {}) => {
  console.log(JSON.stringify({
    ok: false,
    status: "blocked",
    verifier: "collector-attestation-runtime-v1",
    snapshotPath,
    registryPath,
    blockers: [reason],
    ...detail,
  }, null, 2));
  if (strictMode) process.exitCode = 1;
};

if (!fs.existsSync(snapshotPath)) {
  fail("snapshot-missing");
} else if (!fs.existsSync(registryPath)) {
  fail("collector-trust-registry-missing");
} else {
  try {
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
    const registry = loadCollectorTrustRegistry(registryPath);
    if (!registry) throw new Error("collector-trust-registry-invalid");

    const endpoints = Array.isArray(snapshot?.endpoints)
      ? snapshot.endpoints
      : Array.isArray(snapshot?.payloads)
        ? snapshot.payloads
        : [];
    const usableEndpoints = endpoints.filter((entry) => entry?.ok !== false && entry?.payload);
    const endpointAudits = usableEndpoints.map((entry) => verifyCollectorAttestation(
      entry?.collectorAttestation ?? entry?.collectorProvenance?.collectorAttestation,
      { trustRegistry: registry, payload: entry.payload },
    ));
    const collectorEvidence = summarizeTrustedMarketCollectorEvidence(snapshot, {
      trustRegistry: registry,
    });
    const parsedMatches = matchesFromSportteryRelaySnapshot({
      payload: snapshot,
      entries: usableEndpoints,
    });
    const hadRows = parsedMatches.filter((match) => match?.oddsMarketProvenance);
    const hhadRows = parsedMatches.filter((match) => match?.handicapOddsMarketProvenance);
    const strictHadRows = hadRows.filter((match) => isStrictMarketSourceProvenance(
      match.oddsMarketProvenance,
      { trustRegistry: registry },
    ));
    const strictHhadRows = hhadRows.filter((match) => isStrictMarketSourceProvenance(
      match.handicapOddsMarketProvenance,
      { trustRegistry: registry },
    ));
    const embeddedStrictHadRows = hadRows.filter((match) => (
      match?.oddsMarketProvenance?.strict?.eligible === true
    ));
    const embeddedStrictHhadRows = hhadRows.filter((match) => (
      match?.handicapOddsMarketProvenance?.strict?.eligible === true
    ));
    const marketAudits = [
      ...hadRows.map((match) => normalizeMarketSourceProvenance(
        match.oddsMarketProvenance,
        { trustRegistry: registry },
      )),
      ...hhadRows.map((match) => normalizeMarketSourceProvenance(
        match.handicapOddsMarketProvenance,
        { trustRegistry: registry },
      )),
    ].filter(Boolean);
    const blockers = [
      ...(endpointAudits.some((audit) => audit.eligible)
        ? []
        : ["no-trusted-signed-endpoint"]),
      ...(strictHadRows.length > 0 ? [] : ["no-strict-had-market"]),
      ...(strictHhadRows.length > 0 ? [] : ["no-strict-hhad-market"]),
      ...(embeddedStrictHadRows.length > 0 ? [] : ["sync-parser-dropped-strict-had-trust"]),
      ...(embeddedStrictHhadRows.length > 0 ? [] : ["sync-parser-dropped-strict-hhad-trust"]),
      ...(collectorEvidence.trustedCollectorCount > 0
        ? []
        : ["trusted-collector-independence-domain-missing"]),
    ];
    const partialSource = Number(snapshot?.summary?.errors || 0) > 0;
    const strictReady = blockers.length === 0;

    console.log(JSON.stringify({
      ok: strictReady,
      status: strictReady ? (partialSource ? "strict-ready-partial-source" : "strict-ready") : "watch",
      verifier: "collector-attestation-runtime-v1",
      snapshotPath,
      registryPath,
      capturedAt: snapshot?.capturedAt || null,
      sourceCycleId: snapshot?.sourceCycleId || null,
      endpoints: endpoints.length,
      usableEndpoints: usableEndpoints.length,
      signedEndpoints: endpointAudits.filter((audit) => audit.attestation).length,
      trustedSignedEndpoints: endpointAudits.filter((audit) => audit.eligible).length,
      parsedMatches: parsedMatches.length,
      markets: {
        HAD: {
          rows: hadRows.length,
          strict: strictHadRows.length,
          embeddedStrict: embeddedStrictHadRows.length,
        },
        HHAD: {
          rows: hhadRows.length,
          strict: strictHhadRows.length,
          embeddedStrict: embeddedStrictHhadRows.length,
        },
      },
      providerClockRows: parsedMatches.filter((match) => (
        match?.oddsMarketProvenance?.timing?.providerObservedAt
        || match?.handicapOddsMarketProvenance?.timing?.providerObservedAt
      )).length,
      collectorKeys: [...new Set(endpointAudits.map((audit) => audit.keyId).filter(Boolean))],
      collectorFingerprints: [...new Set(endpointAudits
        .map((audit) => audit.keyFingerprint)
        .filter(Boolean))],
      collectorEvidence,
      endpointBlockers: countBy(endpointAudits.flatMap((audit) => audit.blockers)),
      marketBlockers: countBy(marketAudits.flatMap((audit) => audit.strict.blockers)),
      sourceErrors: Number(snapshot?.summary?.errors || 0),
      sourceErrorClasses: snapshot?.summary?.errorClasses || {},
      blockers,
    }, null, 2));
    if (strictMode && !strictReady) process.exitCode = 1;
  } catch (error) {
    fail(error?.message || String(error));
  }
}
