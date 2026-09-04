"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  API_ENDPOINT,
  collectWikidataCandidates,
  requestReceipt,
  teamInputsFromMatches,
  validateCandidateStore,
  withExclusiveLock,
} = require("./wikidataEntityCandidates.cjs");

let assertions = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  assertions += 1;
};

const jsonResponse = (payload, status = 200, headers = {}) => ({
  status,
  headers: {
    get(name) {
      return headers[String(name).toLowerCase()] || null;
    },
  },
  async text() { return JSON.stringify(payload); },
});

const matches = [
  {
    id: "sporttery_national",
    sourceMatchId: "national",
    leagueName: "世界杯",
    country: "国际",
    kickoffTime: "2026-07-20T20:00:00.000Z",
    homeTeamId: "team_england",
    homeTeamName: "英格兰",
    homeTeamNameEn: "英格兰",
    awayTeamId: "team_argentina",
    awayTeamName: "阿根廷",
    awayTeamNameEn: "阿根廷",
  },
  {
    id: "sporttery_club",
    sourceMatchId: "club",
    leagueName: "美职",
    country: "美国",
    kickoffTime: "2026-07-21T01:00:00.000Z",
    homeTeamId: "team_montreal",
    homeTeamName: "蒙特利尔CF",
    homeTeamNameEn: "蒙特利尔CF",
    awayTeamId: "team_toronto",
    awayTeamName: "多伦多FC",
    awayTeamNameEn: "多伦多FC",
  },
];

const searchRows = {
  "英格兰国家足球队": [{ id: "Q47762", label: "英格兰足球代表队", description: "男子足球国家代表队", match: { type: "alias", language: "zh", text: "英格兰国家足球队" } }],
  "英格兰": [{ id: "Q21", label: "英格兰", description: "英国构成国", match: { type: "label", language: "zh", text: "英格兰" } }],
  "阿根廷国家足球队": [{ id: "Q79800", label: "阿根廷国家足球队", description: "男子足球国家代表队", match: { type: "label", language: "zh", text: "阿根廷国家足球队" } }],
  "阿根廷": [{ id: "Q414", label: "阿根廷", description: "南美洲国家", match: { type: "label", language: "zh", text: "阿根廷" } }],
  "蒙特利尔CF足球俱乐部": [{ id: "Q206263", label: "蒙特利尔CF", description: "Canadian association football club", match: { type: "alias", language: "zh", text: "蒙特利尔CF足球俱乐部" } }],
  "蒙特利尔CF": [{ id: "Q206263", label: "蒙特利尔CF", description: "Canadian association football club", match: { type: "label", language: "zh", text: "蒙特利尔CF" } }],
  "多伦多FC足球俱乐部": [{ id: "Q1065780", label: "多伦多FC", description: "Canadian association football club", match: { type: "alias", language: "zh", text: "多伦多FC足球俱乐部" } }],
  "多伦多FC": [{ id: "Q1065780", label: "多伦多FC", description: "Canadian association football club", match: { type: "label", language: "zh", text: "多伦多FC" } }],
};

const entity = ({ qid, zh, en, description, country }) => ({
  id: qid,
  type: "item",
  lastrevid: 1234,
  labels: {
    zh: { language: "zh", value: zh },
    en: { language: "en", value: en },
  },
  aliases: {
    zh: [{ language: "zh", value: zh }],
  },
  descriptions: {
    en: { language: "en", value: description },
  },
  claims: {
    P31: [{ mainsnak: { datavalue: { value: { id: "Q6979593" } } } }],
    P17: [{ mainsnak: { datavalue: { value: { id: country } } } }],
    P641: [{ mainsnak: { datavalue: { value: { id: "Q2736" } } } }],
    P856: [{ mainsnak: { datavalue: { value: `https://example.invalid/${qid}` } } }],
  },
});

const detailRows = {
  Q47762: entity({ qid: "Q47762", zh: "英格兰足球代表队", en: "England national football team", description: "men's association football team", country: "Q145" }),
  Q79800: entity({ qid: "Q79800", zh: "阿根廷国家足球队", en: "Argentina national football team", description: "men's association football team", country: "Q414" }),
  Q206263: entity({ qid: "Q206263", zh: "蒙特利尔CF", en: "CF Montréal", description: "Canadian association football club", country: "Q16" }),
  Q1065780: entity({ qid: "Q1065780", zh: "多伦多FC", en: "Toronto FC", description: "Canadian association football club", country: "Q16" }),
  Q21: entity({ qid: "Q21", zh: "英格兰", en: "England", description: "country", country: "Q145" }),
  Q414: entity({ qid: "Q414", zh: "阿根廷", en: "Argentina", description: "country", country: "Q414" }),
};
delete detailRows.Q21.claims.P641;
delete detailRows.Q414.claims.P641;

const requests = [];
const fetchImpl = async (url, options) => {
  const parsed = new URL(String(url));
  requests.push({ url: parsed.href, options });
  check(parsed.origin === "https://www.wikidata.org", "collector only calls official Wikidata origin");
  check(options?.headers?.["User-Agent"]?.includes("football-predict"), "collector sends an informative user agent");
  const action = parsed.searchParams.get("action");
  if (action === "wbsearchentities") {
    return jsonResponse({ search: searchRows[parsed.searchParams.get("search")] || [] }, 200, {
      "content-type": "application/json; charset=utf-8",
      date: "Thu, 16 Jul 2026 08:00:00 GMT",
    });
  }
  if (action === "wbgetentities") {
    const ids = String(parsed.searchParams.get("ids") || "").split("|");
    return jsonResponse({ entities: Object.fromEntries(ids.filter((id) => detailRows[id]).map((id) => [id, detailRows[id]])) }, 200, {
      "content-type": "application/json; charset=utf-8",
      date: "Thu, 16 Jul 2026 08:00:01 GMT",
    });
  }
  throw new Error(`unexpected action ${action}`);
};

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wikidata-entity-candidates-"));

(async () => {
  try {
    const inputs = teamInputsFromMatches({ matches });
    check(inputs.length === 4, "current matches resolve to four unique local entities");
    check(inputs.every((input) => input.names.length === 1), "duplicate Chinese English labels are deduplicated");

    let tick = Date.parse("2026-07-16T08:00:00.000Z");
    const store = await collectWikidataCandidates({
      matches: { matches },
      generatedAt: "2026-07-16T08:00:00.000Z",
      sourceCycleId: "cycle-fixture",
      dataGenerationId: "generation-fixture",
      matchesCurrentSha256: "a".repeat(64),
      fetchImpl,
      now: () => new Date(tick += 1000),
      wait: async () => {},
      delayMs: 0,
      rawDir: path.join(tempDir, "raw"),
    });
    const validation = validateCandidateStore(store);
    check(validation.valid, `non-empty candidate store validates: ${validation.errors.join(",")}`);
    check(store.entities.length === 4, "all local entities are represented in the candidate store");
    check(store.receipts.length === 9, "eight searches and one batched details call are independently committed");
    check(requests.length === 9, "requests are serial and details are batched");
    check(store.policy.automaticPromotionAllowed === false, "store policy permanently disables automatic promotion");
    check(store.entities.every((row) => row.autoPromotable === false), "no entity row is auto-promotable");
    check(store.entities.flatMap((row) => row.candidates).every((candidate) => (
      candidate.reviewState === "quarantined" && candidate.autoPromotable === false
    )), "every discovered candidate remains quarantined");
    const england = store.entities.find((row) => row.localEntityId === "team_england");
    const englandTeam = england.candidates.find((row) => row.providerEntityId === "Q47762");
    const englandCountry = england.candidates.find((row) => row.providerEntityId === "Q21");
    check(englandTeam.footballEvidence && englandTeam.exactContextQuery, "national-team contextual alias is captured as reviewable evidence");
    check(englandTeam.candidateConfidence === 0.95, "exact contextual football candidate receives the highest candidate score");
    check(!englandCountry.footballEvidence && englandCountry.blockers.includes("football-identity-not-established"), "same-name country is explicitly blocked");
    const rawFiles = fs.readdirSync(path.join(tempDir, "raw"));
    check(rawFiles.length === store.receipts.length, "each unique HTTP response has a content-addressed raw artifact");
    for (const receipt of store.receipts) {
      const raw = fs.readFileSync(path.join(tempDir, "raw", `${receipt.rawSha256}.json`));
      check(raw.length === receipt.rawBytes, "raw artifact length matches receipt commitment");
    }

    const tampered = JSON.parse(JSON.stringify(store));
    tampered.entities[0].candidates[0].autoPromotable = true;
    check(!validateCandidateStore(tampered).valid, "candidate self-promotion tamper fails validation");
    const unknownReceipt = JSON.parse(JSON.stringify(store));
    unknownReceipt.entities[0].candidates[0].receiptIds[0] = "f".repeat(64);
    check(!validateCandidateStore(unknownReceipt).valid, "unknown evidence receipt fails closed");
    const payloadTamper = JSON.parse(JSON.stringify(store));
    payloadTamper.receipts[0].rawSha256 = "b".repeat(64);
    check(!validateCandidateStore(payloadTamper).valid, "raw commitment tamper fails closed");

    await assert.rejects(
      () => requestReceipt({ url: "https://evil.invalid/w/api.php?action=wbsearchentities", fetchImpl }),
      (error) => error?.code === "ENDPOINT_UNTRUSTED",
    );
    assertions += 1;

    let maxlagCalls = 0;
    let waits = 0;
    const retried = await requestReceipt({
      url: `${API_ENDPOINT}?action=wbsearchentities&format=json&search=test`,
      fetchImpl: async () => {
        maxlagCalls += 1;
        if (maxlagCalls === 1) return jsonResponse({ error: { code: "maxlag", info: "lagged" } }, 200);
        return jsonResponse({ search: [] }, 200);
      },
      now: () => new Date("2026-07-16T08:00:00.000Z"),
      wait: async () => { waits += 1; },
    });
    check(maxlagCalls === 2 && waits === 1, "Wikimedia maxlag response is backed off and retried");
    check(retried.receipt.httpStatus === 200, "successful retry produces a normal receipt");

    const lockFile = path.join(tempDir, "collector.lock");
    const locked = withExclusiveLock(lockFile, async () => {
      await assert.rejects(
        () => withExclusiveLock(lockFile, async () => null),
        (error) => error?.code === "COLLECTOR_LOCKED",
      );
      assertions += 1;
      return "done";
    });
    check(await locked === "done", "exclusive collector lock protects the candidate store writer");
    check(!fs.existsSync(lockFile), "collector lock is released after success");

    console.log(JSON.stringify({
      ok: true,
      assertions,
      syntheticLocalEntities: store.entities.length,
      syntheticCandidates: store.entities.reduce((sum, row) => sum + row.candidates.length, 0),
      autoPromoted: 0,
      receipts: store.receipts.length,
      rawArtifacts: rawFiles.length,
    }, null, 2));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
