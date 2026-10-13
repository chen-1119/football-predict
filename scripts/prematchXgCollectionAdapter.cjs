'use strict';
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');
const {TextDecoder} = require('node:util');
const {stableHash} = require('../src/services/webConsensusEvidence.cjs');
const {epochNanoseconds: clock} = require('../src/services/prematchV3Clock.cjs');
const VERSION = 'prematch-observed-xg-html-pilot-v1';
const MAPPING_VERSION = 'prematch-xg-provider-entity-review-v1';
const MAX_BYTES = 2 * 1024 * 1024, MAX_SECONDS = 15;
// These public match links were discovered from current source pages/search.
// This pilot never calls a provider API or searches an unlimited match list.
const PILOT = Object.freeze([
  {url: 'https://www.fotmob.com/matches/england-vs-croatia/2viayw', home: 'Croatia', away: 'England', kickoffAt: '2026-10-03T16:00:00.000Z'},
  {url: 'https://www.fotmob.com/matches/czechia-vs-croatia/2vkax6', home: 'Czechia', away: 'Croatia', kickoffAt: '2026-09-26T18:45:00.000Z'},
  {url: 'https://www.fotmob.com/matches/chicago-fire-fc-vs-charlotte-fc/bailzapa', home: 'Charlotte FC', away: 'Chicago Fire FC', kickoffAt: '2026-09-26T23:30:00.000Z'},
  {url: 'https://www.fotmob.com/matches/dc-united-vs-vancouver-whitecaps/motnkwx', home: 'Vancouver Whitecaps', away: 'DC United', kickoffAt: '2026-09-27T02:30:00.000Z'},
]);
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const id = v => typeof v === 'string' && v.trim() ? v.trim() : Number.isSafeInteger(v) && v >= 0 ? String(v) : null;
const sha = b => createHash('sha256').update(b).digest('hex');
const stamp = body => ({...body, contentHash: stableHash(body)});
const number = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 30 ? v : null;

function publicMatchUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && u.hostname === 'www.fotmob.com' && !u.port && !u.username && !u.password
      && !u.search && !u.hash && /^(?:\/en-GB)?\/matches\/[a-z0-9-]+\/[a-z0-9]+$/.test(u.pathname);
  } catch {return false;}
}
function parseObservedXgPage(bytes, expected) {
  const reject = reason => ({status: 'unavailable', reason, observed: false, formalEligible: false});
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_BYTES) return reject('body-size-invalid');
  let page;
  try {
    const html = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
    const all = [...html.matchAll(/<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/gi)];
    if (all.length !== 1) return reject('public-ssr-match-payload-missing');
    page = JSON.parse(all[0][1]).props?.pageProps;
  } catch {return reject('public-ssr-match-payload-invalid');}
  const general = page?.general, header = page?.header, status = header?.status;
  if (!object(general) || !object(status) || !Array.isArray(header.teams) || header.teams.length !== 2) return reject('match-identity-missing');
  const home = general.homeTeam, away = general.awayTeam;
  if (!id(general.matchId) || !id(home?.id) || !id(away?.id) || id(home.id) === id(away.id)
    || typeof home.name !== 'string' || typeof away.name !== 'string' || clock(general.matchTimeUTCDate) === null
    || clock(status.utcTime) !== clock(general.matchTimeUTCDate)) return reject('match-identity-or-clock-invalid');
  if (expected && (home.name !== expected.home || away.name !== expected.away || clock(general.matchTimeUTCDate) !== clock(expected.kickoffAt))) return reject('public-pair-page-now-points-to-another-event');
  if (header.teams.some((team, i) => id(team?.id) !== id([home, away][i].id) || team?.name !== [home, away][i].name
    || !Number.isSafeInteger(team.score) || team.score < 0 || team.score > 30)) return reject('header-team-conflict');
  if (general.gender !== 'male') return reject('team-category-not-senior-male-pilot');
  if (general.finished !== true || status.finished !== true || status.started !== true || status.cancelled !== false || status.awarded !== false
    || status.reason?.shortKey !== 'fulltime_short' || status.reason?.longKey !== 'finished') return reject('not-confirmed-provider-full-time');
  const periods = page?.content?.stats?.Periods, halves = status.halfs;
  if (!object(halves) || !halves.firstHalfStarted || !halves.secondHalfStarted || !halves.secondHalfEnded
    || halves.firstExtraHalfStarted !== '' || halves.secondExtraHalfStarted !== '' || status.whoLostOnPenalties !== null
    || !object(periods) || Object.keys(periods).some(v => !['All', 'FirstHalf', 'SecondHalf'].includes(v))) return reject('ninety-minute-scope-unverified-or-extra-time');
  if (!object(periods.All) || !Array.isArray(periods.All.stats)) return reject('all-period-statistics-missing');
  const found = []; let invalidXgRow = false;
  function visit(value) {
    if (!object(value)) return;
    // The source also uses this key/title for a section heading (type:title)
    // and a containing group; neither is a numeric match measurement.
    if (value.key === 'expected_goals' && value.title === 'Expected goals (xG)' && value.type === 'text') {
      const pair = value.rawStats?.map?.(v => number(v?.value));
      if (Array.isArray(pair) && pair.length === 2 && pair.every(v => v !== null)) found.push(pair);
      else invalidXgRow = true;
    }
    for (const item of Array.isArray(value.stats) ? value.stats : []) visit(item);
  }
  periods.All.stats.forEach(visit);
  if (invalidXgRow) return reject('all-period-xg-row-invalid');
  if (!found.length) return reject('observed-all-period-xg-missing');
  if (new Set(found.map(v => JSON.stringify(v))).size !== 1) return reject('all-period-xg-conflict');
  const shots = page.content?.shotmap?.shots;
  if (!Array.isArray(shots) || !shots.length || shots.some(v => !['FirstHalf', 'SecondHalf'].includes(v.period)
    || ![id(home.id), id(away.id)].includes(id(v.teamId)))) return reject('observed-shot-events-missing-or-wrong-period');
  if (shots.some(v => v.isOwnGoal !== true && (number(v.expectedGoals) === null || v.expectedGoals > 1))) return reject('shot-xg-probability-invalid');
  const sums = [home.id, away.id].map(teamId => {
    const rows = shots.filter(v => id(v.teamId) === id(teamId) && v.isOwnGoal !== true);
    return rows.length && rows.every(v => number(v.expectedGoals) !== null) ? rows.reduce((sum, v) => sum + v.expectedGoals, 0) : null;
  });
  if (sums.some((v, i) => v !== null && Math.abs(v - found[0][i]) > 0.025)) return reject('shot-sum-and-xg-statistics-conflict');
  return {status: 'observed', observed: true, provider: 'FotMob', providerMatchId: id(general.matchId),
    kickoffAt: general.matchTimeUTCDate, competitionAsDisplayed: general.leagueName || null, competitionProviderId: id(general.leagueId),
    home: {providerTeamId: id(home.id), nameAsDisplayed: home.name, goals: header.teams[0].score, observedXg: found[0][0]},
    away: {providerTeamId: id(away.id), nameAsDisplayed: away.name, goals: header.teams[1].score, observedXg: found[0][1]},
    xgFieldPath: 'publicHTML.__NEXT_DATA__.props.pageProps.content.stats.Periods.All.stats[expected_goals].rawStats',
    measurementMeaning: 'provider post-match shot-quality xG; not pre-match goal-rate lambda or normalized odds',
    durationScope: 'provider FT plus explicit empty extra-time-start fields, no penalties, and regulation-only periods',
    shotEvidence: {shotCount: shots.length, teamShotXgSums: sums},
    providerEndedAtAsDisplayed: halves.gameEnded || null, endedAt: null,
    sourcePublishedAt: null, sourceVerification: 'unverified', formalEligible: false};
}

function requestPublicMatchPage(url) {
  if (!PILOT.some(v => v.url === url)) return Promise.reject(new Error('XG_URL_NOT_IN_PILOT'));
  const startedAt = new Date().toISOString(), deadline = Date.now() + MAX_SECONDS * 1000;
  const redirects = [];
  return new Promise((resolve, reject) => {
    let activeRequest;
    const timer = setTimeout(() => activeRequest?.destroy(new Error('XG_TIMEOUT')), MAX_SECONDS * 1000);
    const failed = error => {clearTimeout(timer); reject(error);};
    function fetchPage(target) {
      if (!publicMatchUrl(target) || Date.now() >= deadline) return failed(new Error('XG_REDIRECT_OR_BUDGET'));
      activeRequest = https.get(target, {headers: {'Accept': 'text/html', 'Accept-Encoding': 'identity', 'User-Agent': 'football-research-collector/1.0'}}, response => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          response.resume();
          let next;
          try {if (!response.headers.location) throw new Error('missing-location'); next = new URL(response.headers.location, target).href;}
          catch {return failed(new Error('XG_REDIRECT_REJECTED'));}
          if (redirects.length >= 2 || !publicMatchUrl(next)) return failed(new Error('XG_REDIRECT_REJECTED'));
          redirects.push({from: target, to: next, httpStatus: response.statusCode, receivedAt: new Date().toISOString()});
          return fetchPage(next);
        }
        const chunks = []; let size = 0;
        response.on('data', part => {size += part.length; if (size > MAX_BYTES) activeRequest.destroy(new Error('XG_BODY_SIZE')); else chunks.push(part);});
        response.on('error', failed);
        response.on('end', () => {clearTimeout(timer); resolve({bytes: Buffer.concat(chunks), startedAt, receivedAt: new Date().toISOString(),
          requestedUrl: url, finalUrl: target, redirects, httpStatus: response.statusCode,
          contentType: response.headers['content-type'] || null, httpDate: response.headers.date || null});});
      });
      activeRequest.on('error', failed);
      activeRequest.setTimeout(Math.max(1, deadline - Date.now()), () => activeRequest.destroy(new Error('XG_TIMEOUT')));
    }
    fetchPage(url);
  });
}
async function collectObservedXgPilot({outputDir, targetProviderNames} = {}) {
  if (typeof outputDir !== 'string' || !path.isAbsolute(outputDir)) throw new Error('XG_OUTPUT_DIRECTORY');
  if (targetProviderNames !== undefined && (!Array.isArray(targetProviderNames) || !targetProviderNames.length
    || targetProviderNames.some(v => typeof v !== 'string' || !PILOT.some(p => p.home === v || p.away === v)))) throw new Error('XG_TARGET_PROVIDER_NAMES');
  const selected = targetProviderNames === undefined ? PILOT : PILOT.filter(v => targetProviderNames.includes(v.home) || targetProviderNames.includes(v.away));
  fs.mkdirSync(outputDir, {recursive: true});
  const receipts = [], failures = [];
  for (const expected of selected) {
    try {
      const response = await requestPublicMatchPage(expected.url);
      const facts = response.httpStatus === 200 && /^text\/html(?:\s*;|$)/i.test(response.contentType || '')
        ? parseObservedXgPage(response.bytes, expected) : {status: 'unavailable', reason: `source-http-or-content-type:${response.httpStatus}`, observed: false, formalEligible: false};
      const filename = `xg-${response.receivedAt.replace(/[^0-9]/g, '')}-${randomUUID().slice(0, 8)}`;
      const body = {version: VERSION, requestedUrl: response.requestedUrl, finalUrl: response.finalUrl, redirects: response.redirects,
        expectedEvent: expected, requestStartedAt: response.startedAt, collectorObservedAt: response.receivedAt, receivedAt: response.receivedAt,
        clockBasis: 'collector-response-body-completed', sourcePublishedAt: null, httpStatus: response.httpStatus,
        contentType: response.contentType, httpDate: response.httpDate, rawRelativePath: `${filename}.html`,
        rawPayloadHash: sha(response.bytes), rawPayloadBytes: response.bytes.length, facts, factsHash: stableHash(facts),
        sourceVerification: 'unverified', formalEligible: false, productionWrites: 0};
      const receipt = stamp(body), receiptRelativePath = `${filename}.json`;
      fs.writeFileSync(path.join(outputDir, receipt.rawRelativePath), response.bytes, {flag: 'wx'});
      fs.writeFileSync(path.join(outputDir, receiptRelativePath), JSON.stringify(receipt, null, 2) + '\n', {flag: 'wx'});
      receipts.push({receiptRelativePath, receipt});
    } catch (error) {failures.push({url: expected.url, observedAt: new Date().toISOString(), error: error.message, observed: false});}
  }
  const report = stamp({version: VERSION, generatedAt: new Date().toISOString(), maximumPages: PILOT.length, selectedPages: selected.length,
    actualReceipts: receipts.length, observedMatches: receipts.filter(v => v.receipt.facts.status === 'observed').length,
    receipts, failures, productionWrites: 0, sourceVerification: 'unverified', formalEligible: false});
  const outputPath = path.join(outputDir, `xg-pilot-${Date.now()}-${randomUUID().slice(0, 8)}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
  return {report, outputPath};
}
function verifyObservedXgReceipt(receipt, bytes) {
  try {
    if (!object(receipt) || receipt.version !== VERSION || receipt.productionWrites !== 0 || receipt.formalEligible !== false
      || receipt.sourceVerification !== 'unverified' || receipt.clockBasis !== 'collector-response-body-completed' || receipt.sourcePublishedAt !== null
      || !PILOT.some(v => v.url === receipt.requestedUrl && stableHash(v) === stableHash(receipt.expectedEvent))
      || !publicMatchUrl(receipt.finalUrl) || !Array.isArray(receipt.redirects) || receipt.redirects.length > 2
      || receipt.httpStatus !== 200 || !/^text\/html(?:\s*;|$)/i.test(receipt.contentType || '')
      || !Buffer.isBuffer(bytes) || receipt.rawPayloadBytes !== bytes.length || receipt.rawPayloadHash !== sha(bytes)) return false;
    let previous = receipt.requestedUrl;
    let priorRedirect = clock(receipt.requestStartedAt);
    for (const step of receipt.redirects) {
      if (step.from !== previous || !publicMatchUrl(step.to) || ![301, 302, 303, 307, 308].includes(step.httpStatus)) return false;
      const observed = clock(step.receivedAt);
      if (priorRedirect === null || observed === null || observed < priorRedirect || observed > clock(receipt.receivedAt)) return false;
      priorRedirect = observed;
      previous = step.to;
    }
    if (previous !== receipt.finalUrl) return false;
    const {contentHash, ...body} = receipt;
    const start = clock(receipt.requestStartedAt), known = clock(receipt.collectorObservedAt);
    return start !== null && known !== null && start <= known && known - start <= BigInt(MAX_SECONDS) * 1000000000n
      && clock(receipt.receivedAt) === known && stableHash(body) === contentHash
      && stableHash(parseObservedXgPage(bytes, receipt.expectedEvent)) === receipt.factsHash && stableHash(receipt.facts) === receipt.factsHash;
  } catch {return false;}
}
function adaptObservedXgReceipt({receipt, bytes, event, side, asOf, reviewedProviderMapping} = {}) {
  const reject = reason => ({status: 'blocked', reason, teamObservations: [], formalEligible: false});
  if (!verifyObservedXgReceipt(receipt, bytes) || receipt.facts.status !== 'observed') return reject('observed-source-receipt-invalid-or-unavailable');
  if (!object(event) || !['home', 'away'].includes(side) || !id(event.sourceMatchId) || !id(event.homeTeamId) || !id(event.awayTeamId)
    || id(event.homeTeamId) === id(event.awayTeamId)) return reject('target-event-identity-missing');
  if (event.status !== 'SCHEDULED' || event.isOnSale === false || ['CLOSED', 'STOPPED', 'SUSPENDED'].includes(String(event.saleStatus || '').toUpperCase())) return reject('target-event-or-sale-ineligible');
  const known = clock(receipt.receivedAt), at = clock(asOf), cutoff = clock(event.cutoffAt), kickoff = clock(event.eventVersion), prior = clock(receipt.facts.kickoffAt);
  if (at === null || cutoff === null || kickoff === null || prior === null || known > at || at >= cutoff || cutoff > kickoff || prior >= known || prior >= kickoff) return reject('source-or-target-knowledge-clock-invalid');
  if (['kickoffTime', 'kickoffAt'].some(key => event[key] != null && event[key] !== '' && clock(event[key]) !== kickoff)
    || (event.cutoffTime != null && event.cutoffTime !== '' && clock(event.cutoffTime) !== cutoff)) return reject('target-event-clock-alias-conflict');
  const mapping = reviewedProviderMapping;
  if (!object(mapping)) return reject('provider-team-review-missing');
  const {contentHash, ...body} = mapping;
  if (mapping.version !== MAPPING_VERSION || mapping.sourceVerification !== 'unverified' || mapping.formalEligible !== false
    || stableHash(body) !== contentHash || mapping.sourceReceiptHash !== receipt.contentHash
    || mapping.sourceMatchId !== id(event.sourceMatchId) || clock(mapping.eventVersion) !== kickoff
    || mapping.siteTeamId !== id(event[`${side}TeamId`]) || mapping.siteTeamName !== event[`${side}TeamName`]
    || !mapping.siteTeamName || clock(mapping.reviewedAt) === null || clock(mapping.reviewedAt) < known || clock(mapping.reviewedAt) > at) return reject('provider-team-review-binding-invalid');
  const providerSide = ['home', 'away'].find(s => receipt.facts[s].providerTeamId === mapping.providerTeamId && receipt.facts[s].nameAsDisplayed === mapping.providerTeamName);
  if (!providerSide) return reject('provider-team-review-exact-name-or-id-conflict');
  const target = receipt.facts[providerSide], opponent = receipt.facts[providerSide === 'home' ? 'away' : 'home'];
  const source = {provider: 'FotMob', endpoint: receipt.finalUrl, receiptHash: receipt.contentHash, rawPayloadHash: receipt.rawPayloadHash};
  const row = {sourceMatchId: `fotmob:${receipt.facts.providerMatchId}`, eventVersion: receipt.facts.kickoffAt,
    teamId: mapping.siteTeamId, providerObservedAt: receipt.collectorObservedAt, receivedAt: receipt.receivedAt,
    clockBasis: receipt.clockBasis, sourcePublishedAt: null, source,
    identityMappingHash: mapping.contentHash, identityMappingReviewedAt: mapping.reviewedAt,
    status: 'FINISHED', observed: true, observedXgFor: target.observedXg, observedXgAgainst: opponent.observedXg};
  return {status: 'captured', sourceReceiptHash: receipt.contentHash, providerMappingHash: mapping.contentHash, formalEligible: false,
    teamObservations: [{family: 'xg', side, sourceMatchId: id(event.sourceMatchId), eventVersion: event.eventVersion, teamId: mapping.siteTeamId,
      providerObservedAt: receipt.collectorObservedAt, receivedAt: receipt.receivedAt, clockBasis: receipt.clockBasis, sourcePublishedAt: null,
      identityMappingHash: mapping.contentHash, identityMappingReviewedAt: mapping.reviewedAt,
      source, data: {rows: [row]}}]};
}
function combineObservedXgReceipts({items, event, side, asOf} = {}) {
  const rejected = [], rows = [], receipts = [], seen = new Set();
  for (const input of Array.isArray(items) ? items : []) {
    const adapted = adaptObservedXgReceipt({...input, event, side, asOf});
    if (adapted.status !== 'captured') {rejected.push({sourceReceiptHash: input.receipt?.contentHash || null, reason: adapted.reason}); continue;}
    const row = adapted.teamObservations[0].data.rows[0], key = `${row.sourceMatchId}|${clock(row.eventVersion)}`;
    if (seen.has(key)) {rejected.push({sourceReceiptHash: adapted.sourceReceiptHash, reason: 'duplicate-prior-event-not-another-sample'}); continue;}
    seen.add(key); rows.push(row); receipts.push(adapted.sourceReceiptHash);
  }
  if (!rows.length) return {status: 'unavailable', teamObservations: [], rejected, sampleCount: 0, formalEligible: false};
  rows.sort((a, b) => a.sourceMatchId.localeCompare(b.sourceMatchId));
  const latest = rows.reduce((a, b) => clock(a.receivedAt) >= clock(b.receivedAt) ? a : b).receivedAt;
  const latestReview = rows.reduce((a, b) => clock(a.identityMappingReviewedAt) >= clock(b.identityMappingReviewedAt) ? a : b).identityMappingReviewedAt;
  const mappingHashes = [...new Set(rows.map(row => row.identityMappingHash))].sort();
  // Raw acquisition clocks describe the last response, while the separate
  // identity review clock gates when all bound team identities are known.
  // Each prior-match row retains both its raw receipt and review clocks.
  const source = {provider: 'FotMob', endpoint: 'https://www.fotmob.com/',
    receiptHash: stableHash({version: VERSION, sourceReceiptHashes: [...new Set(receipts)].sort()}), rawPayloadHash: null};
  return {status: rejected.length ? 'partial' : 'captured', rejected, sampleCount: rows.length, formalEligible: false,
    sourceReceiptHashes: [...new Set(receipts)].sort(), teamObservations: [{family: 'xg', side, sourceMatchId: id(event.sourceMatchId),
      eventVersion: event.eventVersion, teamId: id(event[`${side}TeamId`]), providerObservedAt: latest, receivedAt: latest,
      identityMappingHash: stableHash({version: MAPPING_VERSION, identityMappingHashes: mappingHashes}), identityMappingReviewedAt: latestReview,
      clockBasis: 'latest-first-seen-clock-of-bound-prior-match-responses', sourcePublishedAt: null, source, data: {rows}}]};
}
module.exports = {VERSION, MAPPING_VERSION, MAX_BYTES, MAX_SECONDS, PILOT, publicMatchUrl, parseObservedXgPage,
  requestPublicMatchPage, collectObservedXgPilot, verifyObservedXgReceipt, adaptObservedXgReceipt, combineObservedXgReceipts};
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--output-dir') {console.error('Usage: node scripts/prematchXgCollectionAdapter.cjs --output-dir <absolute-private-directory>'); process.exitCode = 1;}
  else collectObservedXgPilot({outputDir: args[1]}).then(({report, outputPath}) => console.log(JSON.stringify({outputPath,
    observedMatches: report.observedMatches, actualReceipts: report.actualReceipts, failures: report.failures, productionWrites: 0})))
    .catch(error => {console.error(JSON.stringify({ok: false, error: error.message, productionWrites: 0})); process.exitCode = 1;});
}
