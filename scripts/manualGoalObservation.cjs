"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { strictInstant } = require("../src/services/strictInstant.cjs");

const VERSION = "manual-goal-observation-v1";
const ROOT = path.resolve(__dirname, "..");
const DEFAULT_STORE = path.resolve(process.env.SERVER_STORE_DIR || path.join(ROOT, "server-data"), "manual-goal-observations");
const MATCH_FILES = ["matches-current.json", "matches-history.json"].map(name => path.join(ROOT, "public", "data", name));
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const canonical = value => JSON.stringify(value, (_key, entry) => {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
  return Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]]));
});
const fail = message => { throw new Error(message); };
const time = value => strictInstant(value) ? Date.parse(value) : NaN;
const clean = value => typeof value === "string" ? value.trim() : "";
const number = value => typeof value === "number" && Number.isFinite(value);

function loadMatches(files = MATCH_FILES) {
  const rows = files.flatMap(file => {
    const rows = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(rows)) fail(`match file is not an array: ${file}`);
    return rows;
  });
  const unique = new Map();
  for (const row of rows) {
    const key = JSON.stringify([row.id, row.sourceMatchId, row.kickoffTime, row.homeTeamName, row.awayTeamName]);
    if (!unique.has(key)) unique.set(key, row);
  }
  return [...unique.values()];
}

function listCurrent(file = MATCH_FILES[0]) {
  const rows = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(rows)) fail("current match file is not an array");
  return rows.map(row => ({ matchId: row.id, kickoffTime: row.kickoffTime,
    homeTeamName: row.homeTeamName, awayTeamName: row.awayTeamName, status: row.status }));
}

function matchedEvent(identity, matches) {
  if (!identity || typeof identity !== "object" || !clean(identity.matchId)
    || !clean(identity.sourceMatchId) || !strictInstant(identity.kickoffTime)
    || !clean(identity.homeTeamName) || !clean(identity.awayTeamName)) fail("complete match identity is required");
  const found = matches.filter(row => row.id === identity.matchId
    && String(row.sourceMatchId || "") === identity.sourceMatchId
    && time(row.kickoffTime) === time(identity.kickoffTime)
    && row.homeTeamName === identity.homeTeamName
    && row.awayTeamName === identity.awayTeamName);
  if (found.length !== 1) fail("match identity did not match exactly one local event");
  return found[0];
}

function template(matchId, kind, matches = loadMatches()) {
  if (!["result", "xg", "total-odds"].includes(kind)) fail("kind must be result, xg or total-odds");
  const found = matches.filter(row => row.id === matchId);
  if (found.length !== 1) fail("match id did not match exactly one local event");
  const row = found[0];
  return {
    version: VERSION, kind,
    match: { matchId: row.id, sourceMatchId: String(row.sourceMatchId), kickoffTime: row.kickoffTime,
      homeTeamName: row.homeTeamName, awayTeamName: row.awayTeamName },
    sourceUrl: "https://example.org/match/replace-me",
    sourceLabel: "请填写页面或机构名称",
    values: kind === "result" ? { home: null, away: null }
      : kind === "xg" ? { home: null, away: null }
        : { bookmaker: "请填写公司", line: 2.5, over: null, under: null },
  };
}

function evidenceBytes(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size < 12 || stat.size > 10 * 1024 * 1024) fail("evidence must be a 12 B–10 MiB image or PDF");
  const bytes = fs.readFileSync(file);
  const type = bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) ? "png"
    : bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex")) ? "jpg"
      : bytes.subarray(0, 4).toString() === "%PDF" ? "pdf"
        : bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP" ? "webp" : null;
  if (!type) fail("evidence must be PNG, JPEG, WebP or PDF");
  return { bytes, type, sha256: digest(bytes) };
}

function normalize(input, matches, now) {
  if (!input || input.version !== VERSION || !["result", "xg", "total-odds"].includes(input.kind)) fail("invalid observation version or kind");
  if (!strictInstant(now)) fail("invalid system receipt clock");
  const match = matchedEvent(input.match, matches);
  const sourceLabel = clean(input.sourceLabel), sourceUrl = clean(input.sourceUrl);
  if (!sourceLabel || sourceLabel.length > 120) fail("source label is required (max 120 characters)");
  let url;
  try { url = new URL(sourceUrl); } catch { fail("source URL must be HTTPS"); }
  if (url.protocol !== "https:" || url.username || url.password) fail("source URL must be HTTPS without embedded credentials");
  if ([...url.searchParams.keys()].some(key => /(?:token|api[_-]?key|secret|password|auth)/i.test(key))) {
    fail("remove credentials from the source URL");
  }
  url.hash = "";
  const values = input.values;
  if (!values || typeof values !== "object" || Array.isArray(values)) fail("values object is required");
  const kickoff = time(match.kickoffTime), receipt = time(now);
  if (input.kind === "result") {
    if (receipt <= kickoff || ![values.home, values.away].every(value => Number.isInteger(value) && value >= 0 && value <= 20)) fail("result requires post-kickoff receipt and integer scores 0–20");
    if (match.status === "FINISHED" && Number.isInteger(match.scoreHome)
      && (match.scoreHome !== values.home || match.scoreAway !== values.away)) fail("result conflicts with local final score");
  }
  if (input.kind === "xg" && (receipt <= kickoff || ![values.home, values.away].every(value => number(value) && value >= 0 && value <= 8))) {
    fail("xG requires post-kickoff receipt and both observed values 0–8");
  }
  if (input.kind === "total-odds" && (!clean(values.bookmaker) || clean(values.bookmaker).length > 120
    || !number(values.line) || values.line < 0.5 || values.line > 7.5 || values.line * 4 !== Math.round(values.line * 4)
    || ![values.over, values.under].every(value => number(value) && value > 1 && value <= 101))) {
    fail("total odds require a bookmaker, quarter-goal line and both decimal prices above 1");
  }
  const normalizedValues = input.kind === "total-odds"
    ? { bookmaker: clean(values.bookmaker), line: values.line, over: values.over, under: values.under }
    : { home: values.home, away: values.away };
  const buyEnd = time(match.buyEndTime);
  const beforeDecisionEnd = (!match.buyEndTime || Number.isFinite(buyEnd))
    && receipt < Math.min(kickoff, Number.isFinite(buyEnd) ? buyEnd : Infinity);
  return { version: VERSION, kind: input.kind, match: {
    matchId: match.id, sourceMatchId: String(match.sourceMatchId), kickoffTime: match.kickoffTime,
    homeTeamName: match.homeTeamName, awayTeamName: match.awayTeamName,
  }, sourceUrl: url.toString(), sourceLabel, values: normalizedValues,
  receivedAt: now, preMatchCaptured: input.kind === "total-odds" && beforeDecisionEnd,
  predictionEligible: false, authority: "manual-reference-only" };
}

function capture({ input, evidencePath, matches = loadMatches(), storeDir = DEFAULT_STORE, now = new Date().toISOString() }) {
  const body = normalize(input, matches, now);
  const image = evidenceBytes(evidencePath);
  const identityHash = digest(canonical({ kind: body.kind, match: body.match, sourceUrl: body.sourceUrl,
    sourceLabel: body.sourceLabel, values: body.values, evidenceSha256: image.sha256 }));
  const observations = path.join(storeDir, "observations");
  const evidence = path.join(storeDir, "evidence");
  fs.mkdirSync(observations, { recursive: true, mode: 0o700 });
  fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
  const recordFile = path.join(observations, `${identityHash}.json`);
  if (fs.existsSync(recordFile)) {
    const existing = JSON.parse(fs.readFileSync(recordFile, "utf8"));
    const { contentHash, ...content } = existing;
    if (existing.identityHash !== identityHash || contentHash !== digest(canonical(content))) fail("stored observation hash mismatch");
    return { status: "duplicate", record: existing };
  }
  const imageFile = path.join(evidence, `${image.sha256}.${image.type}`);
  try { fs.writeFileSync(imageFile, image.bytes, { flag: "wx", mode: 0o600 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  if (digest(fs.readFileSync(imageFile)) !== image.sha256) fail("stored evidence hash mismatch");
  const record = { ...body, evidence: { sha256: image.sha256, type: image.type, bytes: image.bytes.length }, identityHash };
  record.contentHash = digest(canonical(record));
  try { fs.writeFileSync(recordFile, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = JSON.parse(fs.readFileSync(recordFile, "utf8"));
    const { contentHash, ...content } = existing;
    if (existing.identityHash !== identityHash || contentHash !== digest(canonical(content))) fail("concurrent observation hash mismatch");
    return { status: "duplicate", record: existing };
  }
  return { status: "captured", record };
}

function report(storeDir = DEFAULT_STORE) {
  const dir = path.join(storeDir, "observations");
  const summary = { total: 0, result: 0, xg: 0, totalOdds: 0, preMatchTotalOdds: 0, lastReceivedAt: null,
    predictionEligible: 0 };
  if (!fs.existsSync(dir)) return summary;
  for (const file of fs.readdirSync(dir).filter(name => /^[0-9a-f]{64}\.json$/.test(name))) {
    const row = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    const { contentHash, ...content } = row;
    if (digest(canonical(content)) !== contentHash || row.identityHash !== file.slice(0, 64)) fail(`corrupt observation: ${file}`);
    const evidenceFile = path.join(storeDir, "evidence", `${row.evidence?.sha256}.${row.evidence?.type}`);
    if (!fs.existsSync(evidenceFile) || digest(fs.readFileSync(evidenceFile)) !== row.evidence.sha256) fail(`missing or corrupt evidence: ${file}`);
    summary.total += 1;
    if (row.kind === "result") summary.result += 1;
    if (row.kind === "xg") summary.xg += 1;
    if (row.kind === "total-odds") summary.totalOdds += 1;
    if (row.preMatchCaptured === true) summary.preMatchTotalOdds += 1;
    if (row.predictionEligible === true) summary.predictionEligible += 1;
    if (!summary.lastReceivedAt || time(row.receivedAt) > time(summary.lastReceivedAt)) summary.lastReceivedAt = row.receivedAt;
  }
  return summary;
}

function args(argv) {
  const [action, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i]?.startsWith("--") || !rest[i + 1]) fail("expected --file/--evidence/--match-id/--kind options");
    options[rest[i].slice(2)] = rest[i + 1];
  }
  return { action, options };
}

if (require.main === module) {
  try {
    const { action, options } = args(process.argv.slice(2));
    if (action === "template") {
      const output = `${JSON.stringify(template(options["match-id"], options.kind), null, 2)}\n`;
      if (options.out) {
        fs.writeFileSync(options.out, output, { flag: "wx", mode: 0o600 });
        process.stdout.write(`template created: ${options.out}\n`);
      } else process.stdout.write(output);
    } else if (action === "list") {
      process.stdout.write(`${JSON.stringify(listCurrent(), null, 2)}\n`);
    } else if (action === "capture" && options.file && options.evidence) {
      const input = JSON.parse(fs.readFileSync(options.file, "utf8"));
      const captured = capture({ input, evidencePath: options.evidence });
      process.stdout.write(`${JSON.stringify({ status: captured.status, identityHash: captured.record.identityHash,
        receivedAt: captured.record.receivedAt, predictionEligible: false, preMatchCaptured: captured.record.preMatchCaptured })}\n`);
    } else if (action === "report") {
      process.stdout.write(`${JSON.stringify(report(), null, 2)}\n`);
    } else fail("usage: list | template --match-id ID --kind result|xg|total-odds [--out capture.json] | capture --file input.json --evidence proof.png | report");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { VERSION, listCurrent, template, capture, report, normalize, matchedEvent };
