const assert = require("assert/strict");

const { mergeMarketSignal, parseRows, requireUsableRows } = require("./sync500Data.cjs");

const updatedAt = "2026-07-20T16:20:00.000Z";
const fixture = `
  <table>
    <tr class="unrelated-row" data-id="ignored">
      <td><p data-type="nspf" data-value="3" data-sp="9.99"></p></td>
    </tr>
    <tr class="bet-tb-tr bet-tb-end"
      data-id="2040568"
      data-fixtureid="1362711"
      data-infomatchid="165121"
      data-processdate="2026-07-20"
      data-matchnum="周一203"
      data-matchdate="2026-07-21"
      data-matchtime="01:00"
      data-buyendtime="2026-07-20 22:00:00"
      data-homesxname="埃夫斯堡"
      data-awaysxname="布雷达布利克"
      data-simpleleague="欧冠"
      data-rangqiu="1">
      <td>
        <p class="betbtn" data-type="nspf" data-value="3" data-sp="7.25"></p>
        <p class="betbtn" data-type="nspf" data-value="1" data-sp="5.60"></p>
        <p class="betbtn" data-type="nspf" data-value="0" data-sp="1.23"></p>
        <p class="betbtn" data-type="spf" data-value="3" data-sp="3.23"></p>
        <p class="betbtn" data-type="spf" data-value="1" data-sp="3.98"></p>
        <p class="betbtn" data-type="spf" data-value="0" data-sp="1.76"></p>
      </td>
    </tr>
    <tr data-id="2040569" class="active bet-tb-tr" data-matchdate="2026-07-21"
      data-matchtime="02:00" data-homesxname="主队" data-awaysxname="客队">
      <td>
        <p data-type="nspf" data-value="3" data-sp="2.50"></p>
        <p data-type="nspf" data-value="1" data-sp="3.15"></p>
        <p data-type="nspf" data-value="0" data-sp="2.43"></p>
      </td>
    </tr>
    <tr class="bet-tb-trailer" data-id="false-positive">
      <td>
        <p data-type="nspf" data-value="3" data-sp="2.00"></p>
        <p data-type="nspf" data-value="1" data-sp="3.00"></p>
        <p data-type="nspf" data-value="0" data-sp="4.00"></p>
      </td>
    </tr>
    <tr class="bet-tb-tr" data-id="incomplete-odds">
      <td>
        <p data-type="nspf" data-value="3" data-sp="2.00"></p>
        <p data-type="nspf" data-value="1" data-sp="3.00"></p>
      </td>
    </tr>
  </table>
`;

const rows = parseRows(fixture, updatedAt);
assert.equal(rows.length, 2, "class tokens parse while fake tokens and incomplete prices stay excluded");
assert.deepEqual(rows[0].keys, [
  "2040568",
  "1362711",
  "165121",
  "2026-07-20:周一203",
  "2026-07-21:埃夫斯堡:布雷达布利克",
]);
assert.equal(rows[0].signal.updatedAt, updatedAt);
assert.equal(rows[0].signal.sourceMatchId, "2040568");
assert.equal(rows[0].signal.kickoffTime, "2026-07-21T01:00:00+08:00");
assert.deepEqual(rows[0].signal.bookmakerOdds.had, {
  odds1: 7.25,
  oddsX: 5.6,
  odds2: 1.23,
});
assert.deepEqual(rows[0].signal.bookmakerOdds.hhad, {
  odds1: 3.23,
  oddsX: 3.98,
  odds2: 1.76,
});
assert.equal(rows[1].signal.sourceMatchId, "2040569");
assert.deepEqual(rows[1].signal.bookmakerOdds.had, {
  odds1: 2.5,
  oddsX: 3.15,
  odds2: 2.43,
});
const retainedResult = mergeMarketSignal({
  source: "500.com:details",
  sourceMatchId: "2040568",
  fixtureId: "retained-fixture-id",
  kickoffTime: "2026-07-21T01:00:00+08:00",
  bookmakerOdds: {
    had: { odds1: 8, oddsX: 6, odds2: 1.2 },
  },
  fiveHundred: {
    rank: { home: { fifaRank: 10 }, away: { fifaRank: 30 } },
    result: { status: "FINISHED", scoreHome: 1, scoreAway: 2 },
  },
  lineups: { source: "fixture-cache", summary: { en: "preserve me" } },
}, { ...rows[0].signal, fixtureId: undefined });
assert.deepEqual(
  retainedResult.bookmakerOdds.had,
  rows[0].signal.bookmakerOdds.had,
  "the newest market prices still replace the matching odds component",
);
assert.equal(retainedResult.sourceMatchId, "2040568", "market refresh keeps top-level identity");
assert.equal(retainedResult.fixtureId, "retained-fixture-id", "missing market identity cannot erase cached identity");
assert.deepEqual(
  retainedResult.fiveHundred.result,
  { status: "FINISHED", scoreHome: 1, scoreAway: 2 },
  "market refresh must not erase a collected final score",
);
assert.equal(retainedResult.fiveHundred.rank.home.fifaRank, 10, "market refresh keeps detail components");
assert.equal(retainedResult.lineups.summary.en, "preserve me", "market refresh keeps unrelated enrichments");
assert.ok(retainedResult.source.includes("500.com:details"));
assert.ok(retainedResult.source.includes("500.com:jczq"));
assert.throws(
  () => requireUsableRows([]),
  /preserving the last known snapshot/,
  "a future 200-response parser drift must fail closed instead of publishing fresh 0/0 metadata",
);

console.log(JSON.stringify({
  ok: true,
  verifier: "500-data-parser",
  rows: rows.length,
  classTokens: ["bet-tb-tr", "bet-tb-end"],
  resultPreservedAcrossMarketRefresh: true,
}, null, 2));
