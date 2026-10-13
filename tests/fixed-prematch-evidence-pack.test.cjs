'use strict';
const {test}=require('node:test'),a=require('node:assert/strict');
const {compareQuote,buildPack}=require('../scripts/fixedPrematchEvidencePack.cjs');
const asOf='2026-10-10T08:00:00Z',event={eventId:'12',teams:['A','B'],kickoff:'2026-10-10T22:00:00+08:00',matchNum:'周六012'};
const q={h:'2',d:'3',a:'4',goalLine:'-1'};
const row=()=>({observed_at:asOf,quote:{source:'500.com:jczq',sourceMatchId:'12',homeTeamName:'A',awayTeamName:'B',matchNo:'周六012',kickoffTime:event.kickoff,pool:'had',handicapLine:null,odds1:2,oddsX:3,odds2:4}});
test('same event price comparison reports agreement without model probability',()=>{const x=compareQuote(event,q,'HAD',[row()],asOf);a.equal(x.status,'agree');a.equal(x.independentUpstreamProven,false);});
test('price differences remain differences',()=>{const r=row();r.quote.odds1=2.1;a.equal(compareQuote(event,q,'HAD',[r],asOf).status,'price-difference');});
test('reversed teams and wrong match number rejected',()=>{for(const patch of [{homeTeamName:'B',awayTeamName:'A'},{matchNo:'周日012'},{kickoffTime:'2026-10-11T22:00:00+08:00'}]){const r=row();Object.assign(r.quote,patch);a.equal(compareQuote(event,q,'HAD',[r],asOf).status,'identity-conflict');}});
test('HHAD line mismatch rejected',()=>{const r=row();r.quote.pool='hhad';r.quote.handicapLine=1;a.equal(compareQuote(event,q,'HHAD',[r],asOf).status,'identity-conflict');});
test('future and stale observation cannot be fresh',()=>{for(const t of ['2026-10-10T08:01:00Z','2026-10-10T07:44:59Z']){const r=row();r.observed_at=t;a.equal(compareQuote(event,q,'HAD',[r],asOf).status,'stale-or-invalid-clock');}});
test('missing and ambiguous are explicit',()=>{a.equal(compareQuote(event,q,'HAD',[],asOf).status,'missing');a.equal(compareQuote(event,q,'HAD',[row(),row()],asOf).status,'ambiguous');});
test('unsigned endpoint cannot generate a data pack',()=>{a.throws(()=>buildPack({observedAt:asOf,markets:[],snapshot:{endpoints:[{method:'current'}]}},{asOf,businessDate:'2026-10-10',trustRegistry:{}}),/signed current/);});

test('timezone-less quote observation is rejected',()=>{const r=row();r.observed_at='2026-10-10T08:00:00';a.equal(compareQuote(event,q,'HAD',[r],asOf).status,'stale-or-invalid-clock');});
test('stored feature is not claimed as replayed raw history',()=>{const r=row();r.payload={identity:{sourceMatchId:'wrong'}};const v=compareQuote(event,q,'HAD',[r],asOf);a.equal(v.history,null);a.equal(v.historyStatus,'stored-feature-awaiting-raw-history-replay');});
