'use strict';
// Exercise the actual validator with in-memory file overlays; no real writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const file = path.join(__dirname, 'validateData.cjs');
const source = fs.readFileSync(file, 'utf8');
const baseRequire = createRequire(file);
const archivePath = path.resolve(__dirname, '../outputs/synthetic-validation-archive.json');
const startedAtMs = Date.now();
const publicDir = path.resolve(__dirname, '../public');
const fixtureMatch = {
  id:'sporttery_991980', sourceMatchId:'991980', source:'sporttery',
  sourceUrl:'https://webapi.sporttery.cn/gateway/jc/football/getMatchListV1.qry',
  status:'SCHEDULED', kickoffTime:'2026-09-08T12:00:00.000Z',
  homeTeamColor:'#112233', awayTeamColor:'#445566', predictions:[],scoreHome:null,scoreAway:null,
};
// Scope-contract mutations need two deterministic rows, not 22 parses of the
// entire production history. Full public-file validation is retained below in
// both scopes. These fixtures never escape the in-memory filesystem overlay.
const fixtureFiles = new Map([
  [path.join(publicDir,'data','matches-current.json'), JSON.stringify([fixtureMatch])],
  [path.join(publicDir,'data','matches-history.json'), JSON.stringify([{...fixtureMatch,
    id:'sporttery_991981',sourceMatchId:'991981',status:'FINISHED',kickoffTime:'2026-09-06T12:00:00.000Z',scoreHome:1,scoreAway:1}])],
  [path.join(publicDir,'data','sync-meta.json'),JSON.stringify({files:{archivedUnsettled:14},currentListPolicy:{
    version:'kickoff-retention-v1',evaluatedAt:'2026-09-07T12:00:00.000Z',archivedUnsettled:14,unsettledRetentionHours:48}})],
]);
let checks = 0;
let fullPublicFileRuns = 0, fixtureDataReads = 0;
function run({ publicOnly = false, archive = null, count = 14, policyCount = count, omitCounts = false, badScore = false, officialHistory = false, scorePatch = null, fullPublicFiles = false } = {}) {
  const io = Object.create(fs), messages = [];
  let payload = null, exitCode = 0, archiveReads = 0;
  if(fullPublicFiles) fullPublicFileRuns++;
  io.existsSync = p => path.resolve(p) === archivePath ? archive !== null : fullPublicFiles ? fs.existsSync(p) : fixtureFiles.has(path.resolve(p));
  io.statSync = p => {
    if(fullPublicFiles) return fs.statSync(p);
    assert.ok(fixtureFiles.has(path.resolve(p)),'unexpected fixture stat');
    return {size:Buffer.byteLength(fixtureFiles.get(path.resolve(p)))};
  };
  io.readFileSync = (p, ...args) => {
    if (path.resolve(p) === archivePath) { archiveReads++; return JSON.stringify(archive); }
    if(!fullPublicFiles) {assert.ok(fixtureFiles.has(path.resolve(p)),'unexpected fixture read');fixtureDataReads++;}
    const raw = fullPublicFiles ? fs.readFileSync(p, ...args) : fixtureFiles.get(path.resolve(p));
    if (String(p).replaceAll('\\', '/').endsWith('/public/data/sync-meta.json')) {
      const meta = JSON.parse(raw); meta.files.archivedUnsettled = count;
      meta.currentListPolicy.archivedUnsettled = policyCount;
      if (omitCounts) { delete meta.files.archivedUnsettled; delete meta.currentListPolicy.archivedUnsettled; }
      return JSON.stringify(meta);
    }
    if ((badScore || scorePatch) && String(p).replaceAll('\\', '/').endsWith('/public/data/matches-history.json')) {
      const rows = JSON.parse(raw); assert.ok(rows.length);
      if(badScore) rows[0].scoreHome = null;
      if(scorePatch) Object.assign(rows[0],scorePatch);
      if(officialHistory) Object.assign(rows[0], {oddsSource:'sporttery:HAD',oddsSourceUrl:fixtureMatch.sourceUrl,odds:{odds1:2.1,oddsX:3.2,odds2:3.4}});
      return JSON.stringify(rows);
    }
    return raw;
  };
  const stop = {};
  const proc = { env: { ...process.env, UNRESOLVED_MATCH_ARCHIVE_PATH: archivePath },
    argv: ['node', file, ...(publicOnly ? ['--public-distribution'] : [])],
    exit: code => { exitCode = code; throw stop; } };
  const fn = vm.runInNewContext(`(function(require,__dirname,process,console){${source}\n})`, {});
  try { fn(name => ['fs', 'node:fs'].includes(name) ? io : baseRequire(name), __dirname, proc,
    { error: s => messages.push(s), log: s => { payload = JSON.parse(s); } });
  } catch (e) { if (e !== stop) throw e; }
  return { exitCode, payload, messages: messages.join('\n'), archiveReads };
}
const verify = (name, test) => { test(); checks++; };
verify('default server validation rejects missing private archive', () => {
  const r = run(); assert.equal(r.exitCode, 1); assert.match(r.messages, /must match the private unresolved archive/);
});
verify('explicit public scope validates without claiming private verification', () => {
  const r = run({ publicOnly: true }); assert.equal(r.exitCode, 0, r.messages);
  assert.equal(r.payload.validationScope, 'public-distribution'); assert.equal(r.payload.privateArchiveVerified, false);
  assert.equal(r.payload.currentListPolicy.archivedUnsettled, null); assert.equal(r.payload.currentListPolicy.declaredArchivedUnsettled, 14);
});
verify('public build never reads an accidentally present private file', () => {
  const r = run({ publicOnly: true, archive: [{ status: 'FINISHED' }] }); assert.equal(r.exitCode, 0, r.messages); assert.equal(r.archiveReads, 0);
});
for (const publicOnly of [true, false]) verify(`absent counters cannot become zero / ${publicOnly}`, () => {
  const r = run({ publicOnly, omitCounts: true }); assert.equal(r.exitCode, 1); assert.match(r.messages, /explicit equal non-negative/);
});
for (const count of [null, '', '14', -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
  for (const publicOnly of [true, false]) verify(`invalid archive counter ${JSON.stringify(count)} / ${publicOnly}`, () => {
    const r = run({ publicOnly, count }); assert.equal(r.exitCode, 1); assert.match(r.messages, /explicit equal non-negative/);
  });
}
verify('public archive counters must agree', () => {
  const r = run({ publicOnly: true, count: 14, policyCount: 13 }); assert.equal(r.exitCode, 1); assert.match(r.messages, /explicit equal non-negative/);
});
verify('public scope still rejects a missing finished score', () => {
  const r = run({ publicOnly: true, badScore: true }); assert.equal(r.exitCode, 1); assert.match(r.messages, /score/i);
});
for(const publicOnly of [true,false]) {
  for(const officialHistory of [true,false]) {
    for(const side of ['scoreHome','scoreAway']) {
      for(const value of [null,'','1',-1,0.5]) verify(`all FINISHED scores are strict / ${publicOnly}/${officialHistory}/${side}/${JSON.stringify(value)}`,()=>{
        const r=run({publicOnly,count:0,archive:[],officialHistory,scorePatch:{[side]:value}});
        assert.equal(r.exitCode,1);assert.match(r.messages,/FINISHED match requires numeric non-negative integer final scores/);
      });
    }
    verify(`real 0-0 final is valid / ${publicOnly}/${officialHistory}`,()=>{
      const r=run({publicOnly,count:0,archive:[],officialHistory,scorePatch:{scoreHome:0,scoreAway:0}});assert.equal(r.exitCode,0,r.messages);
    });
  }
  verify(`scheduled fixture retains null scores / ${publicOnly}`,()=>{
    const r=run({publicOnly,count:0,archive:[]});assert.equal(r.exitCode,0,r.messages);assert.equal(r.payload.statuses.SCHEDULED,1);
  });
}
verify('server still inspects malformed private rows', () => {
  const r = run({ count: 1, archive: [{ id: 'synthetic-unresolved-invalid', status: 'FINISHED' }] });
  assert.equal(r.exitCode, 1); assert.equal(r.archiveReads, 1); assert.match(r.messages, /archive must not retain FINISHED/);
});
verify('valid empty server archive remains zero, not unavailable', () => {
  const r = run({ count: 0, archive: [] }); assert.equal(r.exitCode, 0, r.messages);
  assert.equal(r.payload.privateArchiveVerified, true); assert.equal(r.payload.currentListPolicy.archivedUnsettled, 0);
});
verify('Pages uses explicit public scope while default npm task stays strict', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  assert.equal(pkg.scripts['validate:data'], 'node scripts/validateData.cjs');
  assert.equal(pkg.scripts['validate:data:public'], 'node scripts/validateData.cjs --public-distribution');
  assert.match(fs.readFileSync(path.join(__dirname, '../.github/workflows/deploy.yml'), 'utf8'), /npm run validate:data:public/);
});
verify('complete actual public data still passes public-scope validation', () => {
  const r=run({publicOnly:true,fullPublicFiles:true});assert.equal(r.exitCode,0,r.messages);
  assert.equal(r.payload.privateArchiveVerified,false);assert.equal(r.archiveReads,0);assert.ok(r.payload.count>0);
});
verify('complete actual public data still passes server-scope validation with isolated archive', () => {
  const r=run({fullPublicFiles:true,count:0,archive:[]});assert.equal(r.exitCode,0,r.messages);
  assert.equal(r.payload.privateArchiveVerified,true);assert.equal(r.archiveReads,1);assert.ok(r.payload.count>0);
});
assert.equal(fullPublicFileRuns,2);assert.equal(fixtureDataReads,201);
console.log(JSON.stringify({ ok: true, checks, productionDataTouched: false,
  fullPublicFileRuns, fixtureDataReads, strictFinishedScoreCases:46, elapsedMs:Date.now()-startedAtMs,
  scope:'actual validator; bounded scope fixtures plus two complete public-file passes; private archive is isolated',
}, null, 2));
