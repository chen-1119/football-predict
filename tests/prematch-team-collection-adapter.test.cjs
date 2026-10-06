'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const adapter = require('../scripts/prematchTeamCollectionAdapter.cjs');
const {stableHash} = require('../src/services/webConsensusEvidence.cjs');
const {buildPrematchTeamSnapshot} = require('../src/services/prematchTeamEvidenceV3.cjs');
const sha = b => createHash('sha256').update(b).digest('hex');
// Synthetic markup exercises parser/knowledge boundaries, never model accuracy.
function markup({year = '2026', selectedYear = year, duplicate = false, rosterDate = `${year}년09월21일`, release = '2026-09-27'} = {}) {
  const players = Array.from({length: 11}, (_, i) => `<li><a onclick="view_player('${duplicate && i === 10 ? 1 : i + 1}')"><p class="name">${i + 1}. 선수${i}<br/>PLAYER ${i}</p>${i === 0 && release ? `<p class="release">소집제외:${release}</p>` : ''}<p class="profile"><br/>2000.01.01<br/>180Cm / 75Kg<br/>클럽 ${i}</p><p class="position mf">MF</p></a></li>`).join('');
  return Buffer.from(`<select><option value="8128" selected>${rosterDate} 남자 축구 국가대표팀 9월, 10월 평가전 소집명단</option></select><select><option selected value="${selectedYear}">${selectedYear}</option></select><div class="soccer_list"><ul class="conts">${players}</ul></div><table class="soccer-match-list"><tr><td><ul onclick="layer_popup_national_result('11043')"><li class="korea">남자 국가대표팀<span>0</span></li><li class="away">베네수엘라<span>0</span></li></ul><em>10. 02 금요일 20:00</em></td></tr></table>`);
}
function receiptFor(bytes, observed = '2026-10-06T07:30:00.123456Z') {
  const facts = adapter.parseKfaNationalPage(bytes);
  const body = {version: adapter.VERSION, endpoint: adapter.SOURCE_URL, requestStartedAt: '2026-10-06T07:29:59Z', collectorObservedAt: observed,
    receivedAt: observed, clockBasis: 'collector-response-body-completed', sourcePublishedAt: null,
    sourcePublicationClockStatus: 'not-provided-by-page', httpStatus: 200, rawPayloadHash: sha(bytes), rawPayloadBytes: bytes.length,
    rawRelativePath: 'synthetic.html', facts, factsHash: stableHash(facts), sourceVerification: 'unverified', productionWrites: 0, formalEligible: false};
  return {...body, contentHash: stableHash(body)};
}
const event = {sourceMatchId: '2041812', eventVersion: '2026-10-06T19:00:00+08:00', cutoffAt: '2026-10-06T19:00:00+08:00',
  homeTeamId: 'synthetic-home', awayTeamId: 'synthetic-away', homeTeamName: '韩国', awayTeamName: '乌兹别克斯坦', teamCategory: 'senior-men'};
const run = (receipt, bytes, extras = {}) => adapter.adaptKfaTeamFacts({receipt, bytes, event, side: 'home', asOf: '2026-10-06T07:31:00Z', ...extras});

test('official call-up facts preserve IDs and withdrawal wording without making an XI or an injury diagnosis', () => {
  const facts = adapter.parseKfaNationalPage(markup());
  assert.equal(facts.players.length, 11);
  assert.equal(facts.players[0].providerPlayerId, '1');
  assert.equal(facts.players[0].withdrawalDateAsDisplayed, '2026-09-27');
  assert.equal(facts.players[0].withdrawalReason, null);
  assert.equal(facts.sourcePublishedAt, null);
  assert.equal(facts.confirmedLineup, null);
  assert.equal(facts.observedXg, null);
  assert.equal(facts.history[0].endedAt, null);
  assert.match(facts.history[0].resultMeaning, /ninety-minute-duration-unverified/);
});
test('raw bytes, parsed fact hash, and collector clocks are replayed', () => {
  const bytes = markup(), receipt = receiptFor(bytes);
  assert.equal(adapter.verifyKfaTeamFacts(receipt, bytes), true);
  assert.equal(adapter.verifyKfaTeamFacts(receipt, Buffer.concat([bytes, Buffer.from(' ')])), false);
  assert.equal(adapter.verifyKfaTeamFacts({...receipt, sourcePublishedAt: receipt.receivedAt}, bytes), false);
  const altered = structuredClone(receipt); altered.facts.players[0].nameAsDisplayed = 'changed';
  const {contentHash, ...body} = altered; altered.contentHash = stableHash(body);
  assert.equal(adapter.verifyKfaTeamFacts(altered, bytes), false);
});
test('current withdrawal observation uses real first-seen time and remains impact partial in V3', () => {
  const bytes = markup(), receipt = receiptFor(bytes), adapted = run(receipt, bytes);
  assert.equal(adapted.status, 'captured');
  assert.equal(adapted.teamObservations.length, 1);
  const observation = adapted.teamObservations[0];
  assert.equal(observation.providerObservedAt, receipt.collectorObservedAt);
  assert.equal(observation.clockBasis, 'collector-response-body-completed');
  assert.equal(observation.sourcePublishedAt, null);
  assert.equal(observation.data.players[0].contributionPer90.attack, null);
  const snapshot = buildPrematchTeamSnapshot({event, asOf: '2026-10-06T07:31:00Z', observations: adapted.teamObservations});
  assert.equal(snapshot.observations.length, 1);
  assert.equal(snapshot.sides.home.injuries.features.knownUnavailablePlayers, 1);
  assert.equal(snapshot.sides.home.injuries.features.knownUnavailableAttackGapPer90, null);
  assert.equal(snapshot.sides.home.injuries.status, 'partial');
  assert.equal(snapshot.sides.home.roster.confirmed.status, 'unknown');
  assert.equal(snapshot.formalEligible, false);
});
test('a future withdrawal date is retained as source text and never counted as current absence', () => {
  const bytes = markup({release: '2026-10-07'}), receipt = receiptFor(bytes);
  const adapted = run(receipt, bytes);
  assert.equal(adapted.rawSquadPlayers, 11);
  assert.equal(adapted.explicitWithdrawals, 0);
  assert.deepEqual(adapted.teamObservations, []);
});
test('name/category mismatches and other sides cannot receive Korean senior facts', () => {
  const bytes = markup(), receipt = receiptFor(bytes);
  for (const changed of [{homeTeamName: '韩国U23'}, {homeTeamName: '韩国女足'}, {teamCategory: 'women'}, {teamCategory: null}]) {
    assert.equal(run(receipt, bytes, {event: {...event, ...changed}}).status, 'blocked');
  }
  assert.equal(run(receipt, bytes, {side: 'away'}).status, 'blocked');
});
test('observations after as-of or at the exact cutoff are rejected without rounding', () => {
  const bytes = markup(), receipt = receiptFor(bytes);
  assert.equal(run(receipt, bytes, {asOf: '2026-10-06T07:30:00.123455999Z'}).status, 'blocked');
  assert.equal(run(receipt, bytes, {asOf: event.cutoffAt}).status, 'blocked');
  assert.equal(run(receipt, bytes, {asOf: '2026-10-06T07:30:00.123456Z'}).status, 'captured');
});
test('old official camp, invalid annual filter, duplicate players, invalid dates and non-UTF8 fail closed', () => {
  const bytes = markup({year: '2025', release: '2025-09-27'}), receipt = receiptFor(bytes);
  assert.equal(run(receipt, bytes).reason, 'roster-camp-not-bound-to-event-month');
  assert.throws(() => adapter.parseKfaNationalPage(markup({selectedYear: '2025'})), /KFA_ROSTER_YEAR/);
  assert.throws(() => adapter.parseKfaNationalPage(markup({duplicate: true})), /KFA_PLAYER_ROW/);
  assert.throws(() => adapter.parseKfaNationalPage(markup({rosterDate: '2026년02월30일'})), /KFA_ROSTER_DATE/);
  assert.throws(() => adapter.parseKfaNationalPage(Buffer.from([0xff])), /encoded data/);
});
test('no withdrawal response is not treated as a fully healthy team or a zero injury effect', () => {
  const bytes = markup({release: null}), receipt = receiptFor(bytes), adapted = run(receipt, bytes);
  assert.deepEqual(adapted.teamObservations, []);
  assert.equal(adapted.medicalInjuryDiagnosisKnown, false);
  assert.equal(adapted.historyModelEligible, false);
});

function faMarkup({current = 9, juvenile = true, missingGroup = false} = {}) {
  const groups = [['Goalkeepers', ['Player One', 'Player Two']], ['Defenders', ['Ezri Konsa', "Nico O'Reilly", 'Player Three']],
    ['Midfielders', ['Alex Scott', 'Player Four', 'Player Five']], ['Forwards', ['Player Six', 'Player Seven', 'Player Eight']]];
  const list = groups.filter(v => !missingGroup || v[0] !== 'Goalkeepers').map(([label, names]) => `${label}: ${names.map(n => `${n} (Club)`).join(', ')}<br/>`).join('<br/>');
  const squad = Buffer.from(`<h1>England squad named for September and October window</h1><div class="rte-content rte-content--normal"><p>${list}</p></div>`);
  const updates = Buffer.from(`<h1>Squad update: Scott and Konsa withdrawn</h1><div class="rte-content rte-content--normal"><p><strong>10am, Monday 5 October</strong></p><p>Ezri Konsa and Alex Scott have been ruled out of Tuesday&rsquo;s UEFA Nations League meeting with Czechia at Wembley.</p><p>Thomas Tuchel will continue with a squad of ${current} players.</p><p>2.30pm, Sunday 4 October</p><p>Rico Lewis has been added to the England squad ahead of Tuesday&rsquo;s UEFA Nations League fixture against Czechia at Wembley Stadium.</p>${juvenile ? '<p>9am, Sunday 4 October</p><p>Max Dowman has withdrawn from the England MU19s squad due to injury</p>' : ''}<p>2.30pm, Thursday 1 October</p><p>Nico O'Reilly has returned to Manchester City and will play no part in the forthcoming UEFA Nations League fixtures.</p></div>`);
  return [squad, updates];
}
function faReceipt(pages) {
  const rawPages = pages.map((b, i) => ({endpoint: [adapter.ENGLAND_SQUAD_URL, adapter.ENGLAND_UPDATE_URL][i], kind: ['squad', 'updates'][i],
    requestStartedAt: i ? '2026-10-06T07:30:02Z' : '2026-10-06T07:30:00Z', collectorObservedAt: i ? '2026-10-06T07:30:03Z' : '2026-10-06T07:30:01Z',
    receivedAt: i ? '2026-10-06T07:30:03Z' : '2026-10-06T07:30:01Z', httpStatus: 200, rawRelativePath: `fa-${i}.html`, rawPayloadHash: sha(b), rawPayloadBytes: b.length}));
  const facts = adapter.parseEnglandTeamPages(...pages);
  const body = {version: adapter.ENGLAND_VERSION, collectorObservedAt: rawPages[1].receivedAt, receivedAt: rawPages[1].receivedAt,
    clockBasis: 'collector-response-bodies-completed', sourcePublishedAt: null, sourcePublicationClockStatus: 'visible-display-time-without-zone',
    rawPages, facts, factsHash: stableHash(facts), sourceVerification: 'unverified', productionWrites: 0, formalEligible: false};
  return {...body, contentHash: stableHash(body)};
}
const faEvent = {...event, sourceMatchId: '2041817', homeTeamName: '英格兰', awayTeamName: '捷克',
  eventVersion: '2026-10-07T02:45:00+08:00', cutoffAt: '2026-10-06T22:00:00+08:00'};
const faAdapt = (receipt, rawPages, extra = {}) => adapter.adaptEnglandTeamFacts({receipt, rawPages, event: faEvent, side: 'home', asOf: '2026-10-06T07:31:00Z', ...extra});

test('FA source paragraphs preserve name-only senior availability, ignore juvenile exits and reconcile current count', () => {
  const facts = adapter.parseEnglandTeamPages(...faMarkup());
  assert.equal(facts.players.length, 11);
  assert.equal(facts.withdrawals.length, 3);
  assert.equal(facts.currentSquadCountAsDisplayed, 9);
  assert.equal(facts.additions[0].nameAsDisplayed, 'Rico Lewis');
  assert.equal(facts.withdrawals.some(v => v.nameAsDisplayed === 'Max Dowman'), false);
  assert.equal(facts.withdrawals[0].sourceDisplayTime, '10am, Monday 5 October');
  assert.equal(facts.withdrawals[0].providerPlayerId, null);
  assert.equal(facts.withdrawals[0].medicalDiagnosis, null);
  assert.equal(facts.sourcePublishedAt, null);
  assert.equal(facts.confirmedLineup, null);
});
test('FA name keys cannot silently become V3 player IDs or a model injury count', () => {
  const pages = faMarkup(), receipt = faReceipt(pages), adapted = faAdapt(receipt, pages);
  assert.equal(adapter.verifyEnglandTeamFacts(receipt, pages), true);
  assert.equal(adapted.status, 'captured');
  assert.equal(adapted.explicitWithdrawals, 3);
  assert.deepEqual(adapted.teamObservations, []);
  assert.equal(adapted.teamFacts.players[0].providerPlayerId, null);
  assert.equal(adapted.teamFacts.players[0].contributionPer90.attack, null);
  assert.equal(adapted.sourcePublishedAt, null);
});
test('FA fact parser rejects incomplete position groups and contradictory current count', () => {
  assert.throws(() => adapter.parseEnglandTeamPages(...faMarkup({missingGroup: true})), /FA_SQUAD_ROWS/);
  assert.throws(() => adapter.parseEnglandTeamPages(...faMarkup({current: 22})), /FA_CURRENT_SQUAD_COUNT_CONFLICT/);
  const pages = faMarkup(); pages[1] = Buffer.from(pages[1].toString().replace('Squad update:', 'Unknown article:'));
  assert.throws(() => adapter.parseEnglandTeamPages(...pages), /FA_ARTICLE_IDENTITY/);
});
test('FA source receipt replay detects page mutation, order swaps and invented player identity', () => {
  const pages = faMarkup(), receipt = faReceipt(pages);
  assert.equal(adapter.verifyEnglandTeamFacts(receipt, [pages[1], pages[0]]), false);
  assert.equal(adapter.verifyEnglandTeamFacts(receipt, [pages[0], Buffer.concat([pages[1], Buffer.from(' ')])]), false);
  const modified = structuredClone(receipt); modified.facts.players[0].providerPlayerId = 'invented';
  modified.factsHash = stableHash(modified.facts); const {contentHash, ...body} = modified; modified.contentHash = stableHash(body);
  assert.equal(adapter.verifyEnglandTeamFacts(modified, pages), false);
});
test('FA two responses must both be actually known before as-of and cutoff', () => {
  const pages = faMarkup(), receipt = faReceipt(pages);
  assert.equal(faAdapt(receipt, pages, {asOf: '2026-10-06T07:30:02.999999999Z'}).status, 'blocked');
  assert.equal(faAdapt(receipt, pages, {asOf: '2026-10-06T07:30:03Z'}).status, 'captured');
  assert.equal(faAdapt(receipt, pages, {asOf: faEvent.cutoffAt}).status, 'blocked');
});
test('FA evidence never crosses England category or event month boundaries', () => {
  const pages = faMarkup(), receipt = faReceipt(pages);
  for (const changed of [{teamCategory: 'under-21'}, {homeTeamName: '英格兰U21'}, {homeTeamName: '英格兰女足'}]) {
    assert.equal(faAdapt(receipt, pages, {event: {...faEvent, ...changed}}).status, 'blocked');
  }
  assert.equal(faAdapt(receipt, pages, {side: 'away'}).status, 'blocked');
  assert.equal(faAdapt(receipt, pages, {event: {...faEvent, eventVersion: '2026-11-07T02:45:00+08:00', cutoffAt: '2026-11-06T22:00:00+08:00'}, asOf: '2026-10-06T07:31:00Z'}).status, 'blocked');
});
