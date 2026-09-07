"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { syncOfficialClubResults, loadSourceManifest, buildEvidenceRecord, parseOfficialClubPage } = require("./syncOfficialClubResults.cjs");

async function verifyOfficialClubReceiptClocks() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "football-club-receipt-test-"));
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const manifest = loadSourceManifest();
  const fixtures = manifest.sources.map(source => ({ id: `sporttery_${source.sourceMatchId}`,
    sourceMatchId: source.sourceMatchId, kickoffTime: source.providerKickoffTime,
    eventVersion: source.providerKickoffTime, status: "PENDING_RESULT" }));
  const bodies = [
    "<title>BK Häcken - AIK Herr | Allsvenskan | 27 juli 2026</title><span>Spelad match</span><span>19:00</span><span>0<!-- --> - <!-- -->0</span>",
    "<title>Kamp: Rosenborg - Fredrikstad / Rosenborg</title><table><tr><td>Dato</td><td>27. juli 2026</td></tr><tr><td>Avspark</td><td>19:00</td></tr><tr><td>Sluttresultat</td><td>4 - 0</td></tr></table>",
  ];
  const currentFile = path.join(directory, "current.json");
  const historyFile = path.join(directory, "history.json");
  const outputFile = path.join(directory, "results.json");
  const start = Date.parse("2026-07-30T00:00:00Z");
  let clock = start, calls = 0, checks = 0;
  const iso = value => new Date(value).toISOString();
  const options = { manifest, currentFile, historyFile, outputFile };
  const responseFor = (index, extra = {}) => ({ url: manifest.sources[index].sourceUrl, html: bodies[index],
    responseSha256: crypto.createHash("sha256").update(bodies[index]).digest("hex"), ...extra });
  const save = value => fs.writeFileSync(outputFile, JSON.stringify(value));
  try {
    fs.writeFileSync(currentFile, JSON.stringify(fixtures));
    fs.writeFileSync(historyFile, "[]");
    Date.now = () => clock;
    globalThis.fetch = async url => {
      const index = manifest.sources.findIndex(source => source.sourceUrl === url);
      assert.ok(index >= 0, "unexpected URL must never reach a network");
      calls++;
      clock += 1000; // Headers arrive before the complete body.
      return { ok: true, status: 200, url, arrayBuffer: async () => {
        clock += index === 0 ? 14000 : 24000;
        return Buffer.from(bodies[index]);
      } };
    };
    const first = await syncOfficialClubResults(options);
    assert.equal(calls, 2);
    assert.equal(first.summary.matched, 2);
    assert.equal(first.matches["2040641"].observedAt, iso(start + 15000), "first result receipt must follow complete body, not batch start"); checks++;
    assert.equal(first.matches["2040642"].observedAt, iso(start + 40000), "sequential sources need independent completion clocks"); checks++;
    assert.equal(first.checkedAt, iso(start + 40000), "batch check is completed after source requests"); checks++;
    assert.equal(first.matches["2040641"].scoreHome, 0); checks++;

    const second = await syncOfficialClubResults(options);
    assert.equal(second.matches["2040641"].observedAt, iso(start + 55000));
    assert.equal(second.matches["2040641"].firstObservedAt, first.matches["2040641"].firstObservedAt);
    assert.equal(second.matches["2040641"].resultRevision, first.matches["2040641"].resultRevision); checks++;

    // No clock may be fabricated for caller-supplied offline responses.
    globalThis.fetch = async () => { throw new Error("unexpected network fallback"); };
    for (const receivedAt of [undefined, null, true, "2026-09-31T00:00:00Z", "2026-07-30 00:00:00"]) {
      save(second);
      const result = await syncOfficialClubResults({ ...options, responses: Object.fromEntries(manifest.sources.map((source, index) =>
        [source.sourceMatchId, responseFor(index, { receivedAt })])) });
      assert.equal(result.summary.matched, 0);
      assert.equal(result.summary.rejected, 2);
      assert.deepEqual(result.matches, second.matches, "bad receipt preserves previous evidence without refreshing its time"); checks++;
    }
    save(second);
    const backward = await syncOfficialClubResults({ ...options, responses: Object.fromEntries(manifest.sources.map((source, index) =>
      [source.sourceMatchId, responseFor(index, { receivedAt: iso(start - 1000) })])) });
    assert.equal(backward.summary.matched, 0);
    assert.deepEqual(backward.matches, second.matches, "clock rollback cannot replace newer result evidence"); checks++;

    const one = manifest.sources[0], fixture = fixtures[0], parsed = parseOfficialClubPage(bodies[0], one);
    for (const firstObservedAt of ["1900-01-01T00:00:00Z", "2026-07-31T00:00:00Z", "2026-07-30 00:00:00", true]) {
      const previous = { ...second.matches[one.sourceMatchId], firstObservedAt };
      const next = buildEvidenceRecord(fixture, one, parsed, responseFor(0), iso(start + 100000), previous);
      assert.equal(next.firstObservedAt, previous.observedAt, "invalid first clock must not propagate; retain only validated previous observation"); checks++;
    }
    const transportOrder = await syncOfficialClubResults({ ...options, responses: Object.fromEntries(manifest.sources.map((source, index) =>
      [source.sourceMatchId, responseFor(index, { receivedAt: iso(start + 100000), requestStartedAt: iso(start + 200000) })])) });
    assert.equal(transportOrder.summary.matched, 0);
    assert.deepEqual(transportOrder.matches, second.matches); checks++;
    for (const requestStartedAt of [null, true, "2026-09-31T00:00:00Z"]) {
      const result = await syncOfficialClubResults({ ...options, responses: Object.fromEntries(manifest.sources.map((source, index) =>
        [source.sourceMatchId, responseFor(index, { receivedAt: iso(start + 100000), requestStartedAt })])) });
      assert.equal(result.summary.matched, 0);
      assert.deepEqual(result.matches, second.matches); checks++;
    }
    assert.throws(() => buildEvidenceRecord(fixture, one, { ...parsed, scoreHome: 1 }, responseFor(0),
      iso(start), second.matches[one.sourceMatchId]), /moved backwards/,
    "an older receipt cannot masquerade as a score correction"); checks++;

    clock = start + 200000;
    globalThis.fetch = async url => {
      calls++;
      if (url === manifest.sources[0].sourceUrl) throw new Error("synthetic upstream failure");
      return { ok: true, status: 200, url, arrayBuffer: async () => {
        clock += 3000;
        return Buffer.from(bodies[1]);
      } };
    };
    const partial = await syncOfficialClubResults(options);
    assert.equal(partial.summary.matched, 1);
    assert.equal(partial.summary.rejected, 1);
    assert.deepEqual(partial.matches["2040641"], second.matches["2040641"], "failed fetch never refreshes retained evidence");
    assert.equal(partial.matches["2040642"].observedAt, iso(start + 203000)); checks++;
    return { ok: true, verifier: "official-club-receipt-clocks-v1", checks, syntheticInput: true,
      mockedFetchCalls: calls, networkCalls: 0, productionDataTouched: false };
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
module.exports = { verifyOfficialClubReceiptClocks };
if (require.main === module) verifyOfficialClubReceiptClocks()
  .then(result => console.log(JSON.stringify(result, null, 2)))
  .catch(error => { console.error(error); process.exitCode = 1; });
