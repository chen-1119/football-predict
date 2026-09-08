"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const identity = require("../server/frontendReleaseIdentity.cjs");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const runtimeSha256 = hash("full-runtime"), frontendSha256 = hash("frontend-request");

function verifyFrontendReleaseIdentity() {
  const checks = [], skipped = [];
  const check = (name, fn) => { fn(); checks.push({ name, ok: true }); };
  const withFixture = fn => {
    const fixture = identity.createFrontendReleaseIdentityFixture();
    const write = (file, bytes) => { fs.writeFileSync(file, bytes, { mode: 0o644 }); fs.chmodSync(file, 0o644); };
    const index = Buffer.from("<!doctype html><p>frontend one</p>\n");
    const state = { version: identity.VERSION, kind: "full", phase: "accepted", runtimeSha256, runtimeSequence: 711,
      frontendSha256: runtimeSha256, frontendSequence: 711, indexSha256: hash(index),
      distTreeHash: hash("accumulated-dist-one"), acceptanceSha256: hash("root-acceptance-one") };
    const publish = next => {
      if (next.phase === "accepted" && /^[a-f0-9]{64}$/.test(next.acceptanceSha256 || "")) {
        const receipt = next.kind === "frontend-only" ? {
          version: "frontend-readonly-acceptance-v1", transactionId: "a".repeat(24), runtimeSha256: next.runtimeSha256, runtimeSequence: next.runtimeSequence,
          frontendSha256: next.frontendSha256, frontendSequence: next.frontendSequence, indexSha256: next.indexSha256, distTreeHash: next.distTreeHash,
          authorizationSha256: hash("root-authorization"), checkedAt: "2026-09-08T00:00:00.000Z", checks: { index: true, assets: true, health: true, protected: true, services: true },
        } : { version: "frontend-full-baseline-acceptance-v1", runtimeSha256: next.runtimeSha256, runtimeSequence: next.runtimeSequence,
          indexSha256: next.indexSha256, distTreeHash: next.distTreeHash, checkedAt: "2026-09-08T00:00:00.000Z", checks: { runtimeMarkers: true, health: true, sourceBaseline: true } };
        const bytes = Buffer.from(JSON.stringify(receipt) + "\n"); write(fixture.paths.acceptance, bytes); next.acceptanceSha256 = hash(bytes);
      }
      write(fixture.paths.projection, JSON.stringify(next, null, 2) + "\n");
    };
    write(fixture.paths.runtimeMarker, runtimeSha256 + "\n"); write(fixture.paths.acceptedRuntimeMarker, runtimeSha256 + "\n");
    write(fixture.paths.index, index); publish(state);
    try { fn({ ...fixture, write, index, state, publish }); }
    finally { fixture.dispose(); }
  };

  check("accepted full state matches both runtime markers and exact current index bytes", () => withFixture(f => {
    assert.deepEqual(f.read(), { ...f.state, available: true, consistent: true });
    assert.deepEqual(Object.keys(f.read()).sort(), [...identity.STATE_FIELDS, "available", "consistent"].sort());
  }));
  check("frontend pending and accepted projections are reread immediately without the health cache", () => withFixture(f => {
    assert.equal(f.read().kind, "full");
    const next = { ...f.state, kind: "frontend-only", phase: "pending", frontendSha256, frontendSequence: 712, acceptanceSha256: null };
    f.publish(next); assert.deepEqual(f.read(), { ...next, available: true, consistent: true });
    next.phase = "accepted"; next.acceptanceSha256 = hash("root-accepted-ui");
    f.publish(next); assert.deepEqual(f.read(), { ...next, available: true, consistent: true });
    assert.equal(fs.readFileSync(f.paths.runtimeMarker, "utf8").trim(), runtimeSha256);
    assert.equal(fs.readFileSync(f.paths.acceptedRuntimeMarker, "utf8").trim(), runtimeSha256);
  }));
  check("pending never carries acceptance and accepted never lacks a root receipt commitment", () => withFixture(f => {
    for (const change of [{ phase: "pending" }, { acceptanceSha256: null }, { acceptanceSha256: "accepted" }]) {
      f.publish({ ...f.state, ...change }); assert.equal(f.read().available, false);
    }
  }));
  check("missing unknown and sensitive fields are rejected rather than exposed", () => withFixture(f => {
    for (const field of identity.STATE_FIELDS) {
      const next = { ...f.state }; delete next[field]; f.publish(next); assert.equal(f.read().available, false, field);
    }
    f.publish({ ...f.state, environment: "private-value" });
    assert.equal(f.read().available, false); assert.equal(JSON.stringify(f.read()).includes("private-value"), false);
  }));
  check("version kind phase hashes and sequences have a closed schema", () => withFixture(f => {
    for (const change of [
      { version: "v2" }, { kind: "ui" }, { phase: "complete" }, { runtimeSha256: runtimeSha256.toUpperCase() },
      { frontendSha256: "a".repeat(63) }, { indexSha256: null }, { distTreeHash: "unknown" },
      { runtimeSequence: 0 }, { runtimeSequence: "711" }, { frontendSequence: 711.5 },
      { frontendSequence: Number.MAX_SAFE_INTEGER + 1 },
    ]) { f.publish({ ...f.state, ...change }); assert.equal(f.read().available, false, JSON.stringify(change)); }
  }));
  check("full and UI kinds cannot misrepresent the global runtime frontend identity order", () => withFixture(f => {
    for (const change of [{ frontendSha256 }, { frontendSequence: 712 },
      { kind: "frontend-only", frontendSha256, frontendSequence: 711 },
      { kind: "frontend-only", frontendSequence: 712 },
    ]) { f.publish({ ...f.state, ...change }); assert.equal(f.read().available, false); }
  }));
  check("duplicate and escaped duplicate JSON keys cannot overwrite signed identity semantics", () => withFixture(f => {
    const raw = JSON.stringify(f.state);
    for (const member of ['"kind":"full"', '"k\\u0069nd":"full"', '"__proto__":null']) {
      f.write(f.paths.projection, raw.replace("{", "{" + member + ",")); assert.equal(f.read().available, false);
    }
    f.write(f.paths.projection, raw.replace('"full"', '{"nested":"full"}')); assert.equal(f.read().available, false);
  }));
  check("malformed oversized BOM and non UTF-8 projection bytes fail closed", () => withFixture(f => {
    for (const bytes of [Buffer.alloc(0), Buffer.from("{"), Buffer.from("[]"), Buffer.from("null"),
      Buffer.from("x".repeat(identity.MAX_STATE_BYTES + 1)), Buffer.from("\ufeff" + JSON.stringify(f.state)),
      Buffer.concat([Buffer.from(JSON.stringify(f.state)), Buffer.from([0xff])]),
    ]) { f.write(f.paths.projection, bytes); assert.equal(f.read().available, false); }
  }));
  check("each runtime marker must match state runtime rather than the UI request", () => withFixture(f => {
    f.publish({ ...f.state, kind: "frontend-only", frontendSha256, frontendSequence: 712 });
    for (const file of [f.paths.runtimeMarker, f.paths.acceptedRuntimeMarker]) {
      f.write(file, frontendSha256 + "\n"); assert.equal(f.read().consistent, false);
      f.write(file, runtimeSha256 + "\n"); assert.equal(f.read().consistent, true);
    }
    const highBytes = Buffer.from(runtimeSha256 + "\n"); highBytes[0] |= 128;
    f.write(f.paths.runtimeMarker, highBytes); assert.equal(f.read().consistent, false);
  }));
  check("same length index mutations immediately invalidate identity until root updates the projection", () => withFixture(f => {
    const changed = Buffer.from(f.index.toString().replace("one", "two"));
    assert.equal(changed.length, f.index.length); f.write(f.paths.index, changed);
    assert.equal(f.read().available, true); assert.equal(f.read().consistent, false);
    f.publish({ ...f.state, indexSha256: hash(changed) }); assert.equal(f.read().consistent, true);
  }));
  check("atomic projection and index replacements do not reuse previous identity", () => withFixture(f => {
    const nextIndex = path.join(f.paths.app, "index.next"), nextProjection = path.join(f.paths.app, "projection.next");
    const bytes = Buffer.from("<p>atomic new entry</p>"); f.write(nextIndex, bytes); fs.renameSync(nextIndex, f.paths.index);
    assert.equal(f.read().consistent, false);
    const state = { ...f.state, kind: "frontend-only", frontendSha256, frontendSequence: 712, indexSha256: hash(bytes) };
    f.publish(state);
    f.write(nextProjection, JSON.stringify(state)); fs.renameSync(nextProjection, f.paths.projection);
    assert.deepEqual(f.read(), { ...state, available: true, consistent: true });
  }));
  check("rollback receipt and accumulated tree changes do not invent a new frontend version", () => withFixture(f => {
    f.publish({ ...f.state, distTreeHash: hash("old-plus-retained-new-assets"), acceptanceSha256: hash("root-rollback") });
    const result = f.read(); assert.equal(result.consistent, true);
    assert.equal(result.frontendSha256, runtimeSha256); assert.equal(result.frontendSequence, 711);
    assert.notEqual(result.distTreeHash, f.state.distTreeHash);
  }));
  check("missing projection yields no identity and missing index or marker cannot be consistent", () => withFixture(f => {
    fs.unlinkSync(f.paths.projection); assert.equal(f.read().available, false); f.publish(f.state);
    for (const file of [f.paths.index, f.paths.runtimeMarker, f.paths.acceptedRuntimeMarker]) {
      const original = fs.readFileSync(file); fs.unlinkSync(file); assert.equal(f.read().consistent, false); f.write(file, original);
    }
  }));
  check("oversized and nonregular entrypoints cannot validate the published index hash", () => withFixture(f => {
    f.write(f.paths.index, Buffer.alloc(identity.MAX_INDEX_BYTES + 1, 65)); assert.equal(f.read().consistent, false);
    fs.unlinkSync(f.paths.index); fs.mkdirSync(f.paths.index); assert.equal(f.read().consistent, false); fs.rmdirSync(f.paths.index);
  }));
  check("hardlinked projection and index are rejected", () => withFixture(f => {
    for (const file of [f.paths.projection, f.paths.index]) {
      const alias = path.join(f.paths.app, "hardlink-alias"); fs.linkSync(file, alias);
      assert.equal(f.read().consistent, false); fs.unlinkSync(alias); assert.equal(f.read().consistent, true);
    }
  }));
  check("accepted state requires exact raw root receipt bytes and all checks bound to state index and tree", () => withFixture(f => {
    const valid = fs.readFileSync(f.paths.acceptance), value = JSON.parse(valid);
    for (const bytes of [Buffer.concat([valid, Buffer.from(" ")]), Buffer.from(JSON.stringify({ ...value, distTreeHash: hash("wrong-tree") })),
      Buffer.from(JSON.stringify({ ...value, checks: { ...value.checks, health: false } })),
      Buffer.from(JSON.stringify(value).replace("{", '{"version":"frontend-full-baseline-acceptance-v1",'))]) {
      f.write(f.paths.acceptance, bytes); assert.equal(f.read().consistent, false);
      const state = { ...f.state, acceptanceSha256: hash(bytes) }; f.write(f.paths.projection, JSON.stringify(state));
      // Pure whitespace is valid if the exact new bytes are root committed.
      assert.equal(f.read().consistent, bytes.equals(Buffer.concat([valid, Buffer.from(" ")])));
    }
    fs.unlinkSync(f.paths.acceptance); assert.equal(f.read().consistent, false);
  }));
  check("rollback proof retains previous accepted frontend identity and cannot accept the failed new candidate", () => withFixture(f => {
    const previous = { ...f.state, kind: "frontend-only", frontendSha256, frontendSequence: 712 }; f.publish(previous);
    const receipt = { version: "frontend-rollback-acceptance-v1", transactionId: "b".repeat(24), authorizationSha256: hash("failed-ui-authorization"),
      previousState: previous, indexSha256: previous.indexSha256, distTreeHash: hash("retained-assets-tree"), retainedAssetsSha256: hash("retained-rows"),
      retainedAssetCount: 2, newFrontendAccepted: false };
    const bytes = Buffer.from(JSON.stringify(receipt) + "\n"), state = { ...previous, distTreeHash: receipt.distTreeHash, acceptanceSha256: hash(bytes) };
    f.write(f.paths.acceptance, bytes); f.write(f.paths.projection, JSON.stringify(state)); const observed = f.read();
    assert.equal(observed.consistent, true);
    assert.equal(identity.frontendIdentityMatchesCandidate(observed, { releaseKind: "frontend-only", sha256: frontendSha256, releaseSequence: 712 }), true);
    assert.equal(identity.frontendIdentityMatchesCandidate(observed, { releaseKind: "frontend-only", sha256: hash("failed-candidate"), releaseSequence: 713 }), false);
    receipt.previousState.frontendSequence++; const badBytes = Buffer.from(JSON.stringify(receipt));
    f.write(f.paths.acceptance, badBytes); f.write(f.paths.projection, JSON.stringify({ ...state, acceptanceSha256: hash(badBytes) }));
    assert.equal(f.read().consistent, false);
  }));
  check("symlink or junction ancestors cannot redirect the identity reader", () => withFixture(f => {
    const dist = path.dirname(f.paths.index), alternate = path.join(f.root, "alternate-dist");
    fs.renameSync(dist, alternate);
    try {
      fs.symlinkSync(alternate, dist, process.platform === "win32" ? "junction" : "dir");
      assert.equal(f.read().available, false);
    } finally {
      if (fs.existsSync(dist)) fs.unlinkSync(dist); fs.renameSync(alternate, dist);
    }
  }));
  if (process.platform !== "win32") {
    check("wrong POSIX modes and writable ancestors are rejected using real filesystem metadata", () => withFixture(f => {
      for (const file of [f.paths.projection, f.paths.index, f.paths.runtimeMarker, f.paths.acceptedRuntimeMarker]) {
        fs.chmodSync(file, 0o664); assert.equal(f.read().consistent, false); fs.chmodSync(file, 0o644);
      }
      fs.chmodSync(f.paths.app, 0o777); assert.equal(f.read().available, false); fs.chmodSync(f.paths.app, 0o755);
    }));
    check("direct symlink files cannot redirect root published state or bytes", () => withFixture(f => {
      for (const file of [f.paths.projection, f.paths.index, f.paths.runtimeMarker, f.paths.acceptedRuntimeMarker]) {
        const alternate = path.join(f.root, "alias-target"); fs.renameSync(file, alternate); fs.symlinkSync(alternate, file);
        assert.equal(f.read().consistent, false); fs.unlinkSync(file); fs.renameSync(alternate, file);
      }
    }));
    if (process.getuid() === 0) check("non root owner files and directories are rejected using real chown", () => withFixture(f => {
      for (const file of [f.paths.projection, f.paths.index, f.paths.runtimeMarker, f.paths.acceptedRuntimeMarker, f.paths.app]) {
        fs.chownSync(file, 65534, 65534); assert.equal(f.read().consistent, false); fs.chownSync(file, 0, 0);
      }
    }));
    else skipped.push("actual wrong-owner chown requires root Linux fixture; no ownership exemption tested");
  } else skipped.push("Windows fixtures exercise real files but cannot prove POSIX permissions, root ownership or direct symlink rejection");
  check("production paths are fixed and fixture creation cannot be redirected to any caller path", () => {
    assert.throws(() => identity.readFrontendReleaseIdentity({ app: "/tmp" }), /fixed/);
    assert.throws(() => identity.createFrontendReleaseIdentityFixture({ app: identity.PRODUCTION_PATHS.app }), /no-paths/);
    assert.equal(identity.PRODUCTION_PATHS.rootState, "/var/lib/football-release/frontend-state.json");
    assert.equal(identity.PRODUCTION_PATHS.projection, "/opt/football-predict/.frontend-release-state.json");
  });
  return { ok: true, checks: checks.length, results: checks, skipped, productionWrites: 0,
    healthServiceOrRecommendationStatusModified: false, fullDistTreeRecomputed: false,
    rootAcceptanceReceiptVerified: true };
}

if (require.main === module) {
  try { console.log(JSON.stringify(verifyFrontendReleaseIdentity(), null, 2)); }
  catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}
module.exports = { verifyFrontendReleaseIdentity };
