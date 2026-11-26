'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const policy=require('../scripts/recommendationPlatform/reviewedAnalysis.cjs');
const evidence=require('../scripts/recommendationPlatform/reviewedResearchEvidence.cjs');
const decision=require('../scripts/recommendationPlatform/reviewedResearchDecision.cjs');
const fixture=require('./fixtures/reviewed-research.cjs');
test('dual-source core and current availability qualify while predicted XI remains explicit',()=>{
 const value=fixture.setup(),assessment=evidence.assess(value.packets[0],value.context.asOf);
 assert.equal(assessment.coreComplete,true);assert.equal(assessment.availabilityComplete,true);assert.equal(assessment.lineupsConfirmed,false);assert.equal(assessment.comboEligible,true);
 assert.ok(assessment.limitations.includes('lineup:home:not-confirmed'));assert.equal(assessment.modelProbability,null);assert.equal(assessment.expectedValue,null);
});
test('complete raw bytes and exact excerpts are retained, deterministic and immutable',()=>{
 const {inputs}=fixture.setup(),before=JSON.stringify(inputs[0]),packet=evidence.create(inputs[0]);
 assert.equal(JSON.stringify(inputs[0]),before);assert.equal(packet.contentHash,evidence.create(inputs[0]).contentHash);
 for(const source of packet.sources)assert.equal(policy.sha(Buffer.from(source.rawBase64,'base64')),source.rawSha256);
});
function paddedSource(source,bytes){
 const original=Buffer.from(source.rawBase64,'base64'),raw=Buffer.concat([original,Buffer.alloc(bytes-original.length,32)]);
 return {...source,rawBase64:raw.toString('base64'),rawBytes:raw.length,rawSha256:policy.sha(raw)};
}
test('a complete 1.55 MiB original is retained locally without slicing or transport admission claims',()=>{
 const value=fixture.setup().inputs[0];value.sources[0]=paddedSource(value.sources[0],Math.ceil(1.55*1024*1024));
 const packet=evidence.create(value);assert.equal(packet.sources[0].rawBase64,value.sources[0].rawBase64);
 assert.ok(Buffer.byteLength(JSON.stringify(packet))>1024*1024);assert.equal(packet.formalEligible,false);
 assert.equal(packet.sources[0].rawSha256,policy.sha(Buffer.from(packet.sources[0].rawBase64,'base64')));
});
test('source raw boundary remains 2 MiB and total sealed packet remains 4 MiB',()=>{
 const value=fixture.setup().inputs[0];value.sources[0]=paddedSource(value.sources[0],evidence.MAX_SOURCE_BYTES);
 assert.equal(evidence.create(value).sources[0].rawBytes,evidence.MAX_SOURCE_BYTES);
 value.sources[0]=paddedSource(value.sources[0],evidence.MAX_SOURCE_BYTES+1);assert.throws(()=>evidence.create(value),/RAW_/);
 value.sources[0]=paddedSource(fixture.setup().inputs[0].sources[0],evidence.MAX_SOURCE_BYTES);
 value.sources[1]=paddedSource(value.sources[1],evidence.MAX_SOURCE_BYTES);assert.throws(()=>evidence.create(value),/HASH_BOUND/);
});
for(const [name,change] of [
 ['raw tamper',value=>{value.sources[0].rawBase64=Buffer.from('changed').toString('base64');}],
 ['excerpt drift',value=>{value.observations[0].excerpt.text='invented';}],
 ['future publication',value=>{value.sources[0].publishedAt=fixture.stamp(fixture.NOW+1);}],
 ['future event',value=>{value.observations[0].eventAt=fixture.stamp(fixture.NOW+1);}],
 ['source received after review',value=>{value.sources[0].receivedAt=fixture.stamp(fixture.NOW);}],
 ['wrong publisher host',value=>{value.sources[0].url='https://unknown.example.test/';}],
 ['publication clock without literal source support',value=>{value.sources[0].publishedAt=fixture.stamp(fixture.NOW-7200000);}],
 ['false original provenance',value=>{value.sources[1].originPublisherId='official-a';value.sources[1].originUrl=value.sources[0].url;}],
 ['duplicate source',value=>{value.sources.push(value.sources[0]);}],
 ['duplicate observation',value=>{value.observations.push(value.observations[0]);}],
 ['postkickoff history',value=>{value.observations[0].value.matches[0].kickoff=fixture.stamp(fixture.NOW+86400000);}],
 ['shootout used as HAD result',value=>{value.observations[0].value.matches[0].resultBasis='penalty-shootout';}],
 ['unrelated team history',value=>{value.observations[0].value.matches[0].home='Different club';}],
 ['only four last-five games',value=>{value.observations[0].value.matches.pop();}],
 ['fake probability input',value=>{value.modelProbability=.8;}],
])test('reject '+name,()=>{const value=fixture.setup().inputs[0];change(value);assert.throws(()=>evidence.create(value));});
for(const [name,change] of [
 ['syndication',value=>{value.sources[1].provenance='syndicated';value.sources[1].originPublisherId='official-a';value.sources[1].originUrl=value.sources[0].url;value.sources[1].originId=value.sources[0].originId;}],
 ['common editorial owner',value=>{value.sourceRegistry[1].editorialGroup='owner-a';value.sourceRegistry[1].publisherId='same-owner-b';value.sources[1].publisherId='same-owner-b';value.sources[1].originPublisherId='same-owner-b';}],
 ['common origin identifier',value=>{value.sources[1].originId=value.sources[0].originId;}],
 ['unknown provenance',value=>{Object.assign(value.sources[1],{provenance:'unknown',originPublisherId:null,originUrl:null,originId:null});}],
])test(name+' is not an independent second source',()=>{
 const value=fixture.setup().inputs[0];change(value);const result=evidence.assess(evidence.create(value),fixture.stamp(fixture.NOW));
 assert.equal(result.independentSourceCount,1);assert.equal(result.coreComplete,false);assert.equal(result.directionEligible,false);assert.equal(result.comboEligible,false);
});
test('missing or incomplete injury research downgrades a direction and excludes combinations',()=>{
 const value=fixture.setup().inputs[0];value.observations=value.observations.filter(item=>item.kind!=='availability');
 const packet=evidence.create(value),assessment=evidence.assess(packet,fixture.stamp(fixture.NOW));
 assert.equal(assessment.directionEligible,true);assert.equal(assessment.comboEligible,false);assert.ok(assessment.limitations.includes('availability:home:incomplete'));
});
test('one original club or league report is sufficient for availability, not dual-source statistics',()=>{
 const value=fixture.setup().inputs[0];value.observations=value.observations.filter(item=>item.sourceId!=='statistics-b'||item.kind!=='availability');
 const result=evidence.assess(evidence.create(value),fixture.stamp(fixture.NOW));assert.equal(result.availabilityComplete,true);assert.equal(result.comboEligible,true);
});
test('recent retrieval does not refresh an old injury article',()=>{
 const value=fixture.setup().inputs[0];for(const source of value.sources){
  const old=source.publishedAt;source.publishedAt=fixture.stamp(fixture.NOW-4*86400000);
  const raw=Buffer.from(Buffer.from(source.rawBase64,'base64').toString().replace(old,source.publishedAt));
  source.rawBase64=raw.toString('base64');source.rawSha256=policy.sha(raw);source.rawBytes=raw.length;source.publicationExcerpt=fixture.excerpt(raw,source.publishedAt);
 }
 const result=evidence.assess(evidence.create(value),fixture.stamp(fixture.NOW));assert.equal(result.availabilityComplete,false);assert.equal(result.comboEligible,false);
});
test('fresh capture of an old season file cannot hide a newer completed fixture',()=>{
 const value=fixture.setup().inputs[0];for(const item of value.observations.filter(item=>item.kind==='schedule'))item.value.lastCompletedKickoff=fixture.stamp(fixture.NOW-86400000);
 fixture.rebuildRaw(value);
 const result=evidence.assess(evidence.create(value),fixture.stamp(fixture.NOW));assert.equal(result.coreComplete,false);assert.equal(result.comboEligible,false);
 assert.equal(result.fields.find(field=>field.key==='last-five:home').status,'latest-schedule-unverified');
});
test('unknown latest schedule leaves last-five completeness unproved',()=>{
 const value=fixture.setup().inputs[0];value.observations=value.observations.filter(item=>item.kind!=='schedule');
 const result=evidence.assess(evidence.create(value),fixture.stamp(fixture.NOW));assert.equal(result.coreComplete,false);assert.equal(result.comboEligible,false);
});
test('table preceding the latest completed league match cannot claim current standings',()=>{
 const value=fixture.setup().inputs[0];for(const item of value.observations.filter(item=>item.kind==='standings'))item.value.asOf=fixture.stamp(fixture.NOW-30*86400000);
 fixture.rebuildRaw(value);
 const result=evidence.assess(evidence.create(value),fixture.stamp(fixture.NOW));assert.equal(result.coreComplete,false);assert.equal(result.comboEligible,false);
 assert.equal(result.fields.find(field=>field.key==='standings:home').status,'latest-schedule-unverified');
});
test('sources disagreeing about a normalized fact are not counted as corroboration',()=>{
 const value=fixture.setup().inputs[0];value.observations.find(item=>item.kind==='standings'&&item.side==='home'&&item.sourceId==='statistics-b').value.rank=3;
 fixture.rebuildRaw(value);
 const result=evidence.assess(evidence.create(value),fixture.stamp(fixture.NOW));assert.equal(result.hasConflict,true);assert.equal(result.directionEligible,false);
});

test('independent capture clocks and provider-local match ids do not create false fact conflicts',()=>{
 const value=fixture.setup().inputs[0];
 for(const item of value.observations.filter(item=>item.sourceId==='statistics-b')){
  if(item.value.asOf)item.value.asOf=fixture.stamp(fixture.NOW-10000);
  if(item.value.matches)for(const row of item.value.matches)row.id='other-provider:'+row.id;
  if(item.kind==='lineup')item.value.players.reverse();
 }
 fixture.rebuildRaw(value);const before=JSON.stringify(value),packet=evidence.create(value),result=evidence.assess(packet,fixture.stamp(fixture.NOW));
 assert.equal(result.hasConflict,false);assert.equal(result.coreComplete,true);assert.equal(result.comboEligible,true);
 assert.equal(result.fields.find(field=>field.key==='standings:home').value.asOf,fixture.stamp(fixture.NOW-10000));
 assert.equal(JSON.stringify(value),before);assert.ok(packet.observations.some(item=>item.value.matches?.some(row=>row.id.startsWith('other-provider:'))));
});

test('agreement on standings does not refresh the older independent observation',()=>{
 const value=fixture.setup().inputs[0];
 value.observations.find(item=>item.kind==='standings'&&item.side==='home'&&item.sourceId==='statistics-b').value.asOf=fixture.stamp(fixture.NOW-30*86400000);
 fixture.rebuildRaw(value);const result=evidence.assess(evidence.create(value),fixture.stamp(fixture.NOW));
 assert.equal(result.hasConflict,false);assert.equal(result.coreComplete,false);assert.equal(result.comboEligible,false);
 assert.equal(result.fields.find(field=>field.key==='standings:home').status,'latest-schedule-unverified');
});

for(const [label,change] of [
 ['score',item=>{item.value.matches[0].score=[4,0];}],
 ['opponent',item=>{item.value.matches[0].away='Different opponent';}],
 ['kickoff',item=>{item.value.matches[0].kickoff=fixture.stamp(fixture.NOW-4*86400000);}],
 ['scope',item=>{item.value.scope='all-competitive';}],
])test('semantic comparison still rejects conflicting '+label,()=>{
 const value=fixture.setup().inputs[0];change(value.observations.find(item=>item.kind==='last-five'&&item.side==='home'&&item.sourceId==='statistics-b'));
 fixture.rebuildRaw(value);const result=evidence.assess(evidence.create(value),fixture.stamp(fixture.NOW));
 assert.equal(result.hasConflict,true);assert.equal(result.directionEligible,false);assert.equal(result.comboEligible,false);
});

test('availability list order is not a disagreement, but player status is',()=>{
 const value=fixture.setup().inputs[0];for(const item of value.observations.filter(item=>item.kind==='availability'&&item.side==='home')){
  item.value.players=[{name:'Player A',status:'doubtful'},{name:'Player B',status:'suspended'}];
  if(item.sourceId==='statistics-b')item.value.players.reverse();
 }
 fixture.rebuildRaw(value);assert.equal(evidence.assess(evidence.create(value),fixture.stamp(fixture.NOW)).availabilityComplete,true);
 value.observations.find(item=>item.kind==='availability'&&item.side==='home'&&item.sourceId==='statistics-b').value.players[0].status='available';
 fixture.rebuildRaw(value);const result=evidence.assess(evidence.create(value),fixture.stamp(fixture.NOW));
 assert.equal(result.hasConflict,true);assert.equal(result.availabilityComplete,false);
});
test('unreviewed first XI cannot become confirmed solely from two nonofficial copies',()=>{
 const value=fixture.setup().inputs[0];value.sourceRegistry[0].role='statistics';value.sourceRegistry[0].publisherId='statistics-a';value.sources[0].publisherId='statistics-a';value.sources[0].originPublisherId='statistics-a';
 for(const item of value.observations.filter(item=>item.kind==='lineup'))item.value.status='confirmed';
 fixture.rebuildRaw(value);
 const result=evidence.assess(evidence.create(value),fixture.stamp(fixture.NOW));assert.equal(result.lineupsConfirmed,false);
});
test('editing both normalized standings cannot leave the preserved original facts unchanged',()=>{
 const value=fixture.setup().inputs[0];for(const item of value.observations.filter(item=>item.kind==='standings'&&item.side==='home'))item.value.rank=1;
 assert.throws(()=>evidence.create(value),/FACT_VALUE_BINDING/);
});
for(const kind of ['standings','availability','lineup','schedule'])test('home '+kind+' cannot masquerade as away facts with the same original source',()=>{
 const value=fixture.setup().inputs[0];
 for(const source of value.sources){const home=value.observations.find(item=>item.kind===kind&&item.side==='home'&&item.sourceId===source.id);
  const away=value.observations.find(item=>item.kind===kind&&item.side==='away'&&item.sourceId===source.id);away.value=structuredClone(home.value);away.excerpt=structuredClone(home.excerpt);}
 assert.throws(()=>evidence.create(value),/FACT_SUBJECT_BINDING/);
});
for(const [name,change] of [
 ['same name different ordered team ids',value=>{value.event.orderedTeamIds=[99,100];}],
 ['different target fixture',value=>{value.event.eventId='987654321';}],
 ['different kickoff',value=>{value.event.kickoff=fixture.stamp(fixture.NOW+3*86400000);}],
 ['old target season',value=>{value.competition.season='2025';}],
 ['different competition',value=>{value.competition.league='Other league';}],
])test('original typed subjects reject '+name,()=>{
 const value=fixture.setup().inputs[0];change(value);assert.throws(()=>evidence.create(value),/FACT_SUBJECT_BINDING/);
});
test('an arbitrary literal HTML sentence is not a verified typed fact',()=>{
 const value=fixture.setup().inputs[0];value.observations[0].excerpt=value.sources[0].publicationExcerpt;
 assert.throws(()=>evidence.create(value),/TYPED_FACT_REQUIRED/);
});
for(const host of ['official-a.test','www.official-a.test','news.official-a.test'])test('same host family cannot claim independent editorial owners: '+host,()=>{
 const value=fixture.setup().inputs[0];value.sourceRegistry[1].hosts=[host];
 value.sources[1].url='https://'+host+'/different-article';value.sources[1].originUrl=value.sources[1].url;
 assert.throws(()=>evidence.create(value),/HOST_OWNER_CONFLICT/);
});
for(const [name,change] of [
 ['invented publisher',value=>{value.sourceRegistry[0].publisherId='invented';}],
 ['self awarded official role',value=>{value.sourceRegistry[1].role='official-club';}],
 ['self awarded independent owner',value=>{value.sourceRegistry[1].editorialGroup='invented';}],
 ['unapproved sibling host',value=>{value.sourceRegistry[1].hosts=['unknown.test'];}],
])test('server-owned publisher directory rejects '+name,()=>{
 const value=fixture.setup().inputs[0];change(value);assert.throws(()=>evidence.create(value),/PUBLISHER_UNAPPROVED/);
});
test('production publisher directory is fixed and contains no synthetic test publishers',()=>{
 const file=require.resolve('../scripts/recommendationPlatform/reviewedResearchPublishers.cjs'),context={module:{exports:{}}};
 require('node:vm').runInNewContext(require('node:fs').readFileSync(file,'utf8'),context);
 const rows=Array.from(context.module.exports);assert.equal(rows.length,5);assert.ok(Object.isFrozen(context.module.exports));
 assert.deepEqual(rows.find(item=>item.publisherId==='api-football').hosts.join(','),'api-football.com,api-sports.io');
 assert.ok(rows.every(item=>!item.hosts.some(host=>host.endsWith('.test'))));
});
test('existing immutable store preserves source bytes and loads only exact acknowledged-time packets',async()=>{
 const value=fixture.setup(),client=fixture.fakeClient();
 for(const packet of value.packets){const first=await evidence.archive(client,packet,value.context.asOf);const again=await evidence.archive(client,packet,value.context.asOf);
  assert.equal(first.payloadSha256,again.payloadSha256);assert.equal(first.commitAcknowledged,false);assert.equal(first.published,false);}
 const draft=decision.prepare({directions:value.directions,evidence:value.packets},value.context);
 const loaded=await evidence.loadForDraft(client,draft,value.context.asOf);assert.deepEqual(loaded[value.packets[0].event.eventId],[value.packets[0]]);
 assert.equal(client.queries.filter(sql=>sql.startsWith('INSERT')).length,2);assert.ok(client.queries.every(sql=>!sql.includes('UPDATE')&&!sql.includes('DELETE')));
 client.rows.delete(draft.research.evidenceKeys[0]);await assert.rejects(evidence.loadForDraft(client,draft,value.context.asOf),/STORED_BOUND/);
});
test('stored raw corruption cannot be loaded even if the normalized facts look unchanged',async()=>{
 const value=fixture.setup(),client=fixture.fakeClient();for(const packet of value.packets)await evidence.archive(client,packet,value.context.asOf);
 const draft=decision.prepare({directions:value.directions,evidence:value.packets},value.context),row=client.rows.get(draft.research.evidenceKeys[0]);
 row.payload_json=row.payload_json.replace('Synthetic league','Different league');row.payload_bytes=Buffer.byteLength(row.payload_json);row.payload_sha256=policy.sha(row.payload_json);
 await assert.rejects(evidence.loadForDraft(client,draft,value.context.asOf),/HASH_BOUND/);
});
test('storage cannot backdate knowledge before the packet was created',async()=>{
 const value=fixture.setup(),client=fixture.fakeClient();for(const packet of value.packets)await evidence.archive(client,packet,value.context.asOf);
 const draft=decision.prepare({directions:value.directions,evidence:value.packets},value.context),row=client.rows.get(draft.research.evidenceKeys[0]);
 row.updated_at=fixture.stamp(fixture.NOW-5000);await assert.rejects(evidence.loadForDraft(client,draft,value.context.asOf),/STORED_IDENTITY/);
});
