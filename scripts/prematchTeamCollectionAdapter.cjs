'use strict';
// Official KFA facts remain distinct from an XI, an injury diagnosis, player
// impact estimates, and formal source admission. Nothing writes production.
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');
const {TextDecoder} = require('node:util');
const {stableHash} = require('../src/services/webConsensusEvidence.cjs');
const {epochNanoseconds} = require('../src/services/prematchV3Clock.cjs');
const SOURCE_URL = 'https://www.kfa.or.kr/national/?act=nt_man';
const ENGLAND_SQUAD_URL = 'https://www.englandfootball.com/articles/2026/Sep/18/england-mens-senior-squad-announcement-september-october-20261809';
const ENGLAND_UPDATE_URL = 'https://www.englandfootball.com/articles/2026/Sep/21/england-men-september-october-2026-squad-updates';
const ENGLAND_VERSION = 'england-senior-team-facts-v1';
const VERSION = 'kfa-national-team-facts-v1';
const MAX_BYTES = 2 * 1024 * 1024;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const sha = v => createHash('sha256').update(v).digest('hex');
const clock = v => epochNanoseconds(v);
const entity = v => typeof v === 'string' && v.trim() ? v.trim() : Number.isSafeInteger(v) && v >= 0 ? String(v) : null;
const decodeEntities = text => text.replace(/&#(x[a-f0-9]+|\d+);/gi, (raw, value) => {
  const code = value[0].toLowerCase() === 'x' ? parseInt(value.slice(1), 16) : Number(value);
  return code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : raw;
}).replace(/&(nbsp|amp|quot|apos|lt|gt|rsquo|lsquo|rdquo|ldquo|eacute);/gi, (raw, name) => ({nbsp: ' ', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', eacute: 'é'})[name.toLowerCase()] || raw);
const plainText = html => decodeEntities(html.replace(/<!--[\s\S]*?-->/g, '').replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, ' ')).split('\n').map(v => v.replace(/\s+/g, ' ').trim()).filter(Boolean);
const element = (html, tag, className) => new RegExp(`<${tag}\\b[^>]*class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(html)?.[1] || null;

function parseKfaNationalPage(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_BYTES) throw new Error('KFA_BODY_SIZE');
  const html = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  if (/访问验证|access denied|forbidden|captcha/i.test(html.slice(0, 2000))) throw new Error('KFA_BLOCK_PAGE');
  const selected = [...html.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)]
    .filter(row => /\bselected\b/i.test(row[1]));
  const rosterOption = selected.filter(row => /소집명단/.test(plainText(row[2]).join(' ')));
  if (rosterOption.length !== 1) throw new Error('KFA_ROSTER_SELECTION');
  const selectedId = /\bvalue=["']([1-9]\d*)["']/.exec(rosterOption[0][1])?.[1];
  const rosterLabel = plainText(rosterOption[0][2]).join(' ');
  const date = /^(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/.exec(rosterLabel);
  const annual = selected.filter(row => /^\d{4}$/.test(plainText(row[2]).join(' ')));
  if (!selectedId || !date || annual.length !== 1 || plainText(annual[0][2])[0] !== date[1]) throw new Error('KFA_ROSTER_YEAR');
  const sourceRosterDate = `${date[1]}-${date[2].padStart(2, '0')}-${date[3].padStart(2, '0')}`;
  if (!clock(`${sourceRosterDate}T00:00:00+09:00`)) throw new Error('KFA_ROSTER_DATE');
  const section = /<div\b[^>]*class=["']soccer_list["'][^>]*>([\s\S]*?)<table\b[^>]*class=["']soccer-match-list["']/.exec(html)?.[1];
  if (!section) throw new Error('KFA_ROSTER_SECTION');
  const list = /<ul\b[^>]*class=["']conts["'][^>]*>([\s\S]*?)<\/ul>/.exec(section)?.[1];
  if (!list) throw new Error('KFA_PLAYER_LIST');
  const players = [], ids = new Set();
  for (const match of list.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
    const body = match[1], playerId = /\bview_player\(['"]([1-9]\d*)['"]\)/.exec(body)?.[1];
    const nameLines = plainText(element(body, 'p', 'name') || '');
    const position = plainText(element(body, 'p', 'position') || '').join(' ');
    if (position === 'Coach') continue;
    const named = /^(?:(\d{1,3})\.\s*)?(.+)$/.exec(nameLines[0] || '');
    if (!playerId || ids.has(playerId) || !named || !nameLines[1] || !['FW', 'MF', 'DF', 'GK'].includes(position)) throw new Error('KFA_PLAYER_ROW');
    ids.add(playerId);
    const profile = plainText(element(body, 'p', 'profile') || '');
    const releaseText = plainText(element(body, 'p', 'release') || '').join(' ') || null;
    const releaseMatch = releaseText && /^소집제외:(\d{4}-\d{2}-\d{2})$/.exec(releaseText);
    if (releaseText && (!releaseMatch || !clock(`${releaseMatch[1]}T00:00:00+09:00`))) throw new Error('KFA_RELEASE_ROW');
    players.push({providerPlayerId: playerId, nameAsDisplayed: named[2], latinNameAsDisplayed: nameLines[1],
      jerseyAsDisplayed: named[1] || null, positionAsDisplayed: position,
      clubAsDisplayed: profile.at(-1) || null, withdrawalDateAsDisplayed: releaseMatch?.[1] || null,
      availability: releaseMatch ? 'out-of-current-call-up' : 'called-up; current-fitness-unknown',
      withdrawalReason: null, expectedMinutes: null, contributionPer90: {attack: null, defense: null},
      replacementPer90: {attack: null, defense: null}});
  }
  if (players.length < 11 || players.length > 60) throw new Error('KFA_SQUAD_SIZE');
  const history = [];
  const table = /<table\b[^>]*class=["']soccer-match-list["'][^>]*>([\s\S]*?)<\/table>/.exec(html)?.[1];
  if (!table) throw new Error('KFA_HISTORY_SECTION');
  for (const row of table.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)) {
    const body = row[1], providerEventId = /\blayer_popup_national_result\(['"]([1-9]\d*)['"]\)/.exec(body)?.[1];
    if (!providerEventId) continue;
    const homeBody = element(body, 'li', 'korea'), awayBody = element(body, 'li', 'away');
    const score = v => /<span\b[^>]*>\s*(\d{1,2})\s*<\/span>/i.exec(v || '')?.[1];
    const timeText = plainText(/<em\b[^>]*>([\s\S]*?)<\/em>/i.exec(body)?.[1] || '').join(' ');
    const time = /^(\d{2})\.\s*(\d{2})\s+[\S]+\s+(\d{2}):(\d{2})$/.exec(timeText);
    const kickoffAt = time ? `${date[1]}-${time[1]}-${time[2]}T${time[3]}:${time[4]}:00+09:00` : null;
    if (!homeBody || !awayBody || score(homeBody) === undefined || score(awayBody) === undefined || !clock(kickoffAt)) throw new Error('KFA_HISTORY_ROW');
    history.push({providerEventId, kickoffAt, teamNameAsDisplayed: plainText(homeBody.replace(/<span\b[^>]*>[\s\S]*?<\/span>/gi, '')).join(' '),
      opponentAsDisplayed: plainText(awayBody.replace(/<span\b[^>]*>[\s\S]*?<\/span>/gi, '')).join(' '),
      goalsForAsDisplayed: Number(score(homeBody)), goalsAgainstAsDisplayed: Number(score(awayBody)),
      resultMeaning: 'official-history-displayed-score; ninety-minute-duration-unverified',
      endedAt: null, playerMinutes: null, xg: null});
  }
  if (!history.length || new Set(history.map(v => v.providerEventId)).size !== history.length) throw new Error('KFA_HISTORY_ROWS');
  return {version: VERSION, provider: 'KFA', endpoint: SOURCE_URL, teamScope: 'Korea Republic senior men',
    providerRosterId: selectedId, rosterLabel, sourceRosterDate, sourcePublishedAt: null,
    squadType: 'official-call-up; not-confirmed-XI; not-projected-XI', players, history,
    confirmedLineup: null, injuries: null, observedXg: null, sourceVerification: 'unverified', formalEligible: false};
}

function requestTeamPage(endpoint) {
  if (![SOURCE_URL, ENGLAND_SQUAD_URL, ENGLAND_UPDATE_URL].includes(endpoint)) return Promise.reject(new Error('TEAM_SOURCE_URL_NOT_ALLOWED'));
  const startedAt = new Date().toISOString();
  return new Promise((resolve, reject) => {
    let absoluteTimeout;
    const failed = error => {clearTimeout(absoluteTimeout); reject(error);};
    const request = https.get(endpoint, {headers: {'Accept': 'text/html', 'User-Agent': 'football-research-collector/1.0'}}, response => {
      if (response.statusCode !== 200) {response.resume(); return failed(new Error(`KFA_HTTP_${response.statusCode}`));}
      if (!/^text\/html(?:\s*;|$)/i.test(response.headers['content-type'] || '')) {response.resume(); return failed(new Error('KFA_CONTENT_TYPE'));}
      const chunks = []; let size = 0;
      response.on('data', part => {size += part.length; if (size > MAX_BYTES) request.destroy(new Error('KFA_BODY_SIZE')); else chunks.push(part);});
      response.on('error', failed);
      response.on('end', () => {clearTimeout(absoluteTimeout); resolve({bytes: Buffer.concat(chunks), startedAt, receivedAt: new Date().toISOString(),
        httpStatus: response.statusCode, headers: {contentType: response.headers['content-type'], date: response.headers.date || null,
          lastModified: response.headers['last-modified'] || null}});});
    });
    absoluteTimeout = setTimeout(() => request.destroy(new Error('KFA_TIMEOUT')), 15000);
    request.setTimeout(15000, () => request.destroy(new Error('KFA_TIMEOUT')));
    request.on('error', failed);
  });
}
function requestKfaPage() {return requestTeamPage(SOURCE_URL);}

function englandArticle(bytes, kind) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_BYTES) throw new Error('FA_BODY_SIZE');
  const html = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  const title = plainText(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] || '').join(' ');
  const expected = kind === 'squad' ? /^England squad named for September and October window$/ : /^Squad update: .+ withdrawn$/;
  if (!expected.test(title)) throw new Error('FA_ARTICLE_IDENTITY');
  const blocks = [...html.matchAll(/<div\b[^>]*class=["']rte-content rte-content--normal["'][^>]*>([\s\S]*?)<\/div>/gi)].map(v => v[1]);
  if (!blocks.length) throw new Error('FA_ARTICLE_BODY');
  const paragraphs = blocks.flatMap(v => [...v.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map(row => plainText(row[1]).join('\n'))).filter(Boolean);
  return {title, paragraphs};
}
function englandNameKey(name) {return `fa-displayed-name:${name.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim()}`;}
function splitNames(value) {
  return value.replace(/\band\b/g, ',').split(',').map(v => v.trim()).filter(Boolean);
}
function parseEnglandTeamPages(squadBytes, updateBytes) {
  const squad = englandArticle(squadBytes, 'squad'), update = englandArticle(updateBytes, 'updates');
  const text = squad.paragraphs.join('\n'), players = [], seen = new Set();
  for (const row of text.split('\n')) {
    const group = /^(Goalkeepers|Defenders|Midfielders|Forwards):\s*(.+)$/.exec(row);
    if (!group) continue;
    for (const found of group[2].matchAll(/([\p{L}.'’\-\s]+?)\s*\(([^()]+)\)/gu)) {
      const name = found[1].trim();
      if (!name || seen.has(name)) throw new Error('FA_PLAYER_DUPLICATE');
      seen.add(name); players.push({providerPlayerId: null, sourceNameKey: englandNameKey(name), nameAsDisplayed: name,
        clubAsDisplayed: found[2].trim(), positionGroupAsDisplayed: group[1], availability: 'called-up; current-fitness-unknown',
        expectedMinutes: null, contributionPer90: {attack: null, defense: null}, replacementPer90: {attack: null, defense: null}});
    }
  }
  if (players.length < 11 || players.length > 40 || new Set(players.map(v => v.positionGroupAsDisplayed)).size !== 4) throw new Error('FA_SQUAD_ROWS');
  const withdrawals = [], updates = [], additions = [];
  let sourceDisplayTime = null;
  for (const paragraph of update.paragraphs) {
    // Times are visible article text, not zoned publication clocks. Never infer
    // publicationAt from them or from the article's original URL date.
    if (/^\d+(?:\.\d+)?(?:am|pm),\s+(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+\d+\s+(?:September|October)$/.test(paragraph)) {
      sourceDisplayTime = paragraph; continue;
    }
    const explicit = /^(.+?) have(?: all)? been ruled out of (?:Tuesday’s UEFA Nations League meeting with Czechia at Wembley|England’s forthcoming UEFA Nations League fixtures)\./.exec(paragraph);
    if (explicit) {
      const names = splitNames(explicit[1]);
      if (names.length < 2 || names.length > 5 || names.some(v => /MU\d|under-/i.test(v))) throw new Error('FA_WITHDRAWAL_SCOPE');
      for (const name of names) withdrawals.push({providerPlayerId: null, sourceNameKey: englandNameKey(name), nameAsDisplayed: name,
        availability: 'out-of-current-senior-call-up', sourceDisplayTime, medicalDiagnosis: null,
        medicalCauseStatus: /due to respective injury issues/.test(paragraph) ? 'provider-explicit-injury-issues; diagnosis-unspecified' : 'further-assessment; medical-cause-unspecified'});
    }
    const returned = /^([\p{L}.'’\-\s]+?) has returned to .+? and will play no part in the forthcoming UEFA Nations League fixtures\./u.exec(paragraph);
    if (returned) withdrawals.push({providerPlayerId: null, sourceNameKey: englandNameKey(returned[1]), nameAsDisplayed: returned[1],
      availability: 'out-of-current-senior-call-up', sourceDisplayTime, medicalDiagnosis: null, medicalCauseStatus: 'further-assessment; medical-cause-unspecified'});
    const addition = /^([\p{L}.'’\-\s]+?) has been added to the England squad ahead of Tuesday’s UEFA Nations League fixture against Czechia at Wembley Stadium\./u.exec(paragraph);
    if (addition) additions.push({providerPlayerId: null, sourceNameKey: englandNameKey(addition[1]), nameAsDisplayed: addition[1], sourceDisplayTime});
    const count = /with a squad of (\d+) players\./.exec(paragraph);
    if (count) updates.push({currentSquadCountAsDisplayed: Number(count[1]), sourceDisplayTime});
  }
  if (!withdrawals.length || new Set(withdrawals.map(v => v.sourceNameKey)).size !== withdrawals.length) throw new Error('FA_WITHDRAWALS_MISSING_OR_DUPLICATE');
  const knownNames = new Set([...players.map(v => v.sourceNameKey), ...additions.map(v => v.sourceNameKey)]);
  const currentNames = new Set([...knownNames].filter(name => !withdrawals.some(v => v.sourceNameKey === name)));
  const displayed = updates[0]?.currentSquadCountAsDisplayed ?? null;
  if (displayed !== null && displayed !== currentNames.size) throw new Error('FA_CURRENT_SQUAD_COUNT_CONFLICT');
  return {version: ENGLAND_VERSION, provider: 'England FA', teamScope: 'England senior men', sourcePublishedAt: null,
    sourcePages: [{endpoint: ENGLAND_SQUAD_URL, title: squad.title}, {endpoint: ENGLAND_UPDATE_URL, title: update.title}],
    campYear: 2026, campMonths: [9, 10], squadType: 'official-call-up; not-confirmed-XI; not-projected-XI',
    announcedSquadListCount: players.length, currentSquadCountAsDisplayed: displayed, players, withdrawals, additions,
    playerIdentityStatus: 'displayed-name-only; no-stable-provider-player-id', confirmedLineup: null, observedXg: null,
    sourceVerification: 'unverified', formalEligible: false};
}

async function collectEnglandTeamFacts({outputDir} = {}) {
  if (typeof outputDir !== 'string' || !path.isAbsolute(outputDir)) throw new Error('FA_OUTPUT_DIRECTORY');
  const squadResponse = await requestTeamPage(ENGLAND_SQUAD_URL);
  const updateResponse = await requestTeamPage(ENGLAND_UPDATE_URL);
  const facts = parseEnglandTeamPages(squadResponse.bytes, updateResponse.bytes);
  const basename = `england-team-${updateResponse.receivedAt.replace(/[^0-9]/g, '')}-${randomUUID().slice(0, 8)}`;
  const rawPages = [{...squadResponse, endpoint: ENGLAND_SQUAD_URL, kind: 'squad'}, {...updateResponse, endpoint: ENGLAND_UPDATE_URL, kind: 'updates'}];
  const body = {version: ENGLAND_VERSION, collectorObservedAt: updateResponse.receivedAt, receivedAt: updateResponse.receivedAt,
    clockBasis: 'collector-response-bodies-completed', sourcePublishedAt: null, sourcePublicationClockStatus: 'visible-display-time-without-zone',
    rawPages: rawPages.map(v => ({endpoint: v.endpoint, kind: v.kind, requestStartedAt: v.startedAt,
      collectorObservedAt: v.receivedAt, receivedAt: v.receivedAt, httpStatus: v.httpStatus, responseHeaders: v.headers,
      rawRelativePath: `${basename}-${v.kind}.html`, rawPayloadHash: sha(v.bytes), rawPayloadBytes: v.bytes.length})),
    facts, factsHash: stableHash(facts), sourceVerification: 'unverified', productionWrites: 0, formalEligible: false};
  const receipt = {...body, contentHash: stableHash(body)};
  fs.mkdirSync(outputDir, {recursive: true});
  for (let i = 0; i < rawPages.length; i++) fs.writeFileSync(path.join(outputDir, receipt.rawPages[i].rawRelativePath), rawPages[i].bytes, {flag: 'wx'});
  const outputPath = path.join(outputDir, `${basename}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(receipt, null, 2) + '\n', {flag: 'wx'});
  return {receipt, outputPath};
}
function verifyEnglandTeamFacts(receipt, rawPages) {
  try {
    if (!object(receipt) || receipt.version !== ENGLAND_VERSION || receipt.clockBasis !== 'collector-response-bodies-completed'
      || receipt.sourcePublishedAt !== null || receipt.sourcePublicationClockStatus !== 'visible-display-time-without-zone'
      || receipt.productionWrites !== 0 || receipt.formalEligible !== false || receipt.sourceVerification !== 'unverified'
      || !Array.isArray(receipt.rawPages) || receipt.rawPages.length !== 2 || !Array.isArray(rawPages) || rawPages.length !== 2) return false;
    const {contentHash, ...body} = receipt;
    if (contentHash !== stableHash(body)) return false;
    for (let i = 0; i < 2; i++) {
      const page = receipt.rawPages[i], bytes = rawPages[i];
      if (page.endpoint !== [ENGLAND_SQUAD_URL, ENGLAND_UPDATE_URL][i] || page.kind !== ['squad', 'updates'][i]
        || page.httpStatus !== 200 || !Buffer.isBuffer(bytes) || page.rawPayloadHash !== sha(bytes) || page.rawPayloadBytes !== bytes.length
        || clock(page.requestStartedAt) === null || clock(page.collectorObservedAt) === null
        || clock(page.receivedAt) !== clock(page.collectorObservedAt) || clock(page.requestStartedAt) > clock(page.receivedAt)) return false;
    }
    return stableHash(parseEnglandTeamPages(...rawPages)) === receipt.factsHash && stableHash(receipt.facts) === receipt.factsHash
      && clock(receipt.collectorObservedAt) === clock(receipt.rawPages[1].collectorObservedAt)
      && clock(receipt.receivedAt) === clock(receipt.collectorObservedAt)
      && clock(receipt.rawPages[0].collectorObservedAt) <= clock(receipt.rawPages[1].requestStartedAt);
  } catch {return false;}
}
function adaptEnglandTeamFacts({receipt, rawPages, event, side, asOf} = {}) {
  const reject = reason => ({status: 'blocked', reason, teamObservations: [], formalEligible: false});
  if (!verifyEnglandTeamFacts(receipt, rawPages)) return reject('source-receipt-invalid');
  if (!object(event) || !['home', 'away'].includes(side) || event.teamCategory !== 'senior-men'
    || !entity(event.sourceMatchId) || !entity(event.homeTeamId) || !entity(event.awayTeamId)
    || entity(event.homeTeamId) === entity(event.awayTeamId)
    || !['英格兰', 'England'].includes(event[`${side}TeamName`])) return reject('team-event-binding-incomplete');
  const observed = clock(receipt.collectorObservedAt), now = clock(asOf), cutoff = clock(event.cutoffAt), kickoff = clock(event.eventVersion);
  if (now === null || cutoff === null || kickoff === null || observed > now || now >= cutoff || cutoff > kickoff
    || now - observed > 6n * 3600n * 1000000000n) return reject('event-knowledge-clock-invalid');
  const utcDate = new Date(Number(kickoff / 1000000n));
  if (utcDate.getUTCFullYear() !== receipt.facts.campYear || !receipt.facts.campMonths.includes(utcDate.getUTCMonth() + 1)) return reject('roster-camp-not-bound-to-event-month');
  return {status: 'captured', teamObservations: [], sourceFactsHash: receipt.factsHash, sourceReceiptHash: receipt.contentHash,
    sourceMatchId: entity(event.sourceMatchId), eventVersion: event.eventVersion, teamId: entity(event[`${side}TeamId`]), side,
    rawSquadPlayers: receipt.facts.announcedSquadListCount, currentSquadCountAsDisplayed: receipt.facts.currentSquadCountAsDisplayed,
    explicitWithdrawals: receipt.facts.withdrawals.length, confirmedLineupPlayers: 0,
    playerIdentityStatus: 'displayed-name-only; V3 player-identity requirement not met', sourcePublishedAt: null,
    providerObservedAt: receipt.collectorObservedAt, receivedAt: receipt.receivedAt, clockBasis: receipt.clockBasis,
    teamFacts: receipt.facts, formalEligible: false,
    knowledgePolicy: 'public response first-seen now; no publisher clock or stable player id invented; no historical backdating'};
}

async function collectKfaTeamFacts({outputDir} = {}) {
  if (typeof outputDir !== 'string' || !path.isAbsolute(outputDir)) throw new Error('KFA_OUTPUT_DIRECTORY');
  const response = await requestKfaPage();
  const facts = parseKfaNationalPage(response.bytes);
  const basename = `kfa-national-${response.receivedAt.replace(/[^0-9]/g, '')}-${randomUUID().slice(0, 8)}`;
  const receiptBody = {version: VERSION, endpoint: SOURCE_URL, requestStartedAt: response.startedAt,
    collectorObservedAt: response.receivedAt, receivedAt: response.receivedAt, clockBasis: 'collector-response-body-completed',
    sourcePublishedAt: null, sourcePublicationClockStatus: 'not-provided-by-page', httpStatus: response.httpStatus,
    responseHeaders: response.headers, rawPayloadHash: sha(response.bytes), rawPayloadBytes: response.bytes.length,
    rawRelativePath: `${basename}.html`, facts, factsHash: stableHash(facts),
    sourceVerification: 'unverified', productionWrites: 0, formalEligible: false};
  const receipt = {...receiptBody, contentHash: stableHash(receiptBody)};
  fs.mkdirSync(outputDir, {recursive: true});
  fs.writeFileSync(path.join(outputDir, receipt.rawRelativePath), response.bytes, {flag: 'wx'});
  const outputPath = path.join(outputDir, `${basename}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(receipt, null, 2) + '\n', {flag: 'wx'});
  return {receipt, outputPath};
}

function verifyKfaTeamFacts(receipt, bytes) {
  try {
    if (!object(receipt) || receipt.version !== VERSION || receipt.endpoint !== SOURCE_URL || receipt.httpStatus !== 200
      || receipt.clockBasis !== 'collector-response-body-completed' || receipt.sourcePublishedAt !== null
      || receipt.sourcePublicationClockStatus !== 'not-provided-by-page' || receipt.productionWrites !== 0
      || receipt.formalEligible !== false || receipt.sourceVerification !== 'unverified'
      || !Buffer.isBuffer(bytes) || receipt.rawPayloadHash !== sha(bytes) || receipt.rawPayloadBytes !== bytes.length) return false;
    const {contentHash, ...body} = receipt;
    if (stableHash(body) !== contentHash || stableHash(parseKfaNationalPage(bytes)) !== receipt.factsHash
      || stableHash(receipt.facts) !== receipt.factsHash) return false;
    const start = clock(receipt.requestStartedAt), observed = clock(receipt.collectorObservedAt), received = clock(receipt.receivedAt);
    return start !== null && observed !== null && received !== null && start <= observed && observed === received;
  } catch {return false;}
}

function adaptKfaTeamFacts({receipt, bytes, event, side, asOf} = {}) {
  const reject = reason => ({status: 'blocked', reason, teamObservations: [], formalEligible: false});
  if (!verifyKfaTeamFacts(receipt, bytes)) return reject('source-receipt-invalid');
  if (!object(event) || !['home', 'away'].includes(side) || !entity(event.sourceMatchId)
    || !entity(event.homeTeamId) || !entity(event.awayTeamId) || entity(event.homeTeamId) === entity(event.awayTeamId)) return reject('event-binding-incomplete');
  // Binding is explicit and inspectable. Do not assign Korean facts to a name
  // selected by fuzzy matching, an U23 side, a women's side, or another team.
  if (event.teamCategory !== 'senior-men' || !['韩国', '韩国男足', 'Korea Republic', 'South Korea', '대한민국'].includes(event[`${side}TeamName`])) return reject('team-name-not-exact-korea-senior-men');
  const observed = clock(receipt.collectorObservedAt), now = clock(asOf), cutoff = clock(event.cutoffAt), kickoff = clock(event.eventVersion);
  if (now === null || cutoff === null || kickoff === null || observed > now || now >= cutoff || cutoff > kickoff) return reject('event-knowledge-clock-invalid');
  if (now - observed > 6n * 3600n * 1000000000n) return reject('source-observation-stale');
  const label = receipt.facts.rosterLabel;
  const months = [...label.matchAll(/(\d{1,2})월/g)].map(v => Number(v[1]));
  const eventKst = new Date(Number(kickoff / 1000000n) + 9 * 3600000);
  if (eventKst.getUTCFullYear() !== Number(receipt.facts.sourceRosterDate.slice(0, 4))
    || !months.includes(eventKst.getUTCMonth() + 1) || kickoff < clock(`${receipt.facts.sourceRosterDate}T00:00:00+09:00`)) return reject('roster-camp-not-bound-to-event-month');
  const withdrawals = receipt.facts.players.filter(v => v.withdrawalDateAsDisplayed
    && clock(`${v.withdrawalDateAsDisplayed}T00:00:00+09:00`) <= observed);
  const observations = withdrawals.length ? [{family: 'injuries', side, sourceMatchId: entity(event.sourceMatchId), eventVersion: event.eventVersion,
    teamId: entity(event[`${side}TeamId`]), providerObservedAt: receipt.collectorObservedAt, receivedAt: receipt.receivedAt,
    clockBasis: receipt.clockBasis, sourcePublishedAt: null,
    source: {provider: 'KFA', endpoint: SOURCE_URL, receiptHash: receipt.contentHash, rawPayloadHash: receipt.rawPayloadHash},
    data: {contributionMetric: {attack: null, defense: null}, availabilityMeaning: 'explicit-withdrawal-from-current-call-up; medical-cause-unknown',
      players: withdrawals.map(v => ({playerId: `kfa:${v.providerPlayerId}`, availability: 'out', expectedMinutes: null,
        contributionPer90: {attack: null, defense: null}, replacementPer90: {attack: null, defense: null}}))}}] : [];
  return {status: 'captured', teamObservations: observations, sourceFactsHash: receipt.factsHash,
    sourceReceiptHash: receipt.contentHash, rawSquadPlayers: receipt.facts.players.length, confirmedLineupPlayers: 0,
    explicitWithdrawals: withdrawals.length, medicalInjuryDiagnosisKnown: false,
    historyRows: receipt.facts.history.length, historyModelEligible: false, formalEligible: false,
    knowledgePolicy: 'collectorObservedAt is first-seen public response completion; sourcePublishedAt remains unknown; no historical backdating'};
}
module.exports = {VERSION, SOURCE_URL, MAX_BYTES, parseKfaNationalPage, requestKfaPage, collectKfaTeamFacts, verifyKfaTeamFacts, adaptKfaTeamFacts,
  ENGLAND_VERSION, ENGLAND_SQUAD_URL, ENGLAND_UPDATE_URL, parseEnglandTeamPages, collectEnglandTeamFacts, verifyEnglandTeamFacts, adaptEnglandTeamFacts};
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--output-dir') {console.error('Usage: node scripts/prematchTeamCollectionAdapter.cjs --output-dir <absolute-private-directory>'); process.exitCode = 1;}
  else collectKfaTeamFacts({outputDir: args[1]}).then(({receipt, outputPath}) => console.log(JSON.stringify({outputPath,
    receivedAt: receipt.receivedAt, rawPayloadHash: receipt.rawPayloadHash, rosterPlayers: receipt.facts.players.length,
    explicitWithdrawals: receipt.facts.players.filter(v => v.withdrawalDateAsDisplayed).length,
    historyRows: receipt.facts.history.length, sourcePublishedAt: null, productionWrites: 0, formalEligible: false})))
    .catch(error => {console.error(JSON.stringify({ok: false, error: error.message, productionWrites: 0})); process.exitCode = 1;});
}
