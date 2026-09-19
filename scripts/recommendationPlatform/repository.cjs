'use strict';
const { hash } = require('../../src/services/publishedForecastPolicy.cjs');

class Repository {
  constructor(client) { this.client=client; }
  async current() { return (await this.client.query("SELECT payload FROM football.match_snapshots WHERE dataset='current'")).rows.map(r=>r.payload); }
  async currentInputs(now) {
    const current=await this.current();
    const signals=await require('../../collectors/market/signalBridge.cjs').readMarketSignalRows(this.client,{allowEmpty:true});
    return require('./currentInputs.cjs').joinCurrentMarket(current,signals,now);
  }
  async publication() { const {readPostgresPublicationIdentity}=require('../../server/postgresProjectionStore.cjs'); const value=await readPostgresPublicationIdentity(this.client); if(!value.available)throw Object.assign(new Error('Publication unavailable'),{code:'SOURCE_UNAVAILABLE'});return value.publication; }
  async insertDecision(d) {
    const last=(await this.client.query(`SELECT payload FROM football.recommendation_decisions
      WHERE source_match_id=$1 AND event_version=$2 ORDER BY sequence DESC LIMIT 1`,[d.sourceMatchId,d.eventVersion])).rows[0]?.payload;
    if(last && (Date.parse(d.modelGeneratedAt)<Date.parse(last.modelGeneratedAt) || Date.parse(d.quoteObservedAt)<Date.parse(last.quoteObservedAt)))
      throw Object.assign(new Error('Regressed decision input'),{code:'DECISION_INPUT_REGRESSION'});
    await this.client.query(`INSERT INTO football.recommendation_decisions(id,source_match_id,event_version,business_date,published_at,cutoff_at,input_hash,payload)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT(id) DO NOTHING`,[d.decisionId,d.sourceMatchId,d.eventVersion,d.businessDate,d.publishedAt,d.cutoffTime,d.inputHash,JSON.stringify(d)]);
    const row=(await this.client.query('SELECT payload FROM football.recommendation_decisions WHERE id=$1',[d.decisionId])).rows[0];
    if(!row)throw new Error('Decision read-back failed');return row.payload;
  }
  async decisions(ids) {if(!ids.length)return [];return (await this.client.query('SELECT payload FROM football.recommendation_decisions WHERE id=ANY($1::text[])',[ids])).rows.map(r=>r.payload);}
  async latest() { return (await this.client.query(`SELECT DISTINCT ON (source_match_id,event_version) payload
    FROM football.recommendation_decisions ORDER BY source_match_id,event_version,sequence DESC`)).rows.map(r=>r.payload); }
  async frozenCombos(date) {
    const sql='SELECT payload FROM football.recommendation_combo_records';
    return (await this.client.query(date?sql+' WHERE business_date=$1 ORDER BY size':sql+' ORDER BY business_date DESC,size',date?[date]:[])).rows.map(r=>r.payload);
  }
  async insertCombo(c) {
    const cutoff=new Date(Math.min(...c.legs.map(l=>Date.parse(l.cutoffTime)))).toISOString();
    const added=await this.client.query(`INSERT INTO football.recommendation_combo_records(id,business_date,size,frozen_at,cutoff_at,payload)
      VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(business_date,size) DO NOTHING RETURNING id`,[c.id,c.businessDate,c.size,c.frozenAt,cutoff,JSON.stringify(c)]);
    if(!added.rows.length)return false;
    for(let index=0;index<c.decisionIds.length;index++)await this.client.query('INSERT INTO football.recommendation_combo_legs(combo_id,ordinal,decision_id) VALUES($1,$2,$3)',[c.id,index+1,c.decisionIds[index]]);
    return true;
  }
  async resultHeads() {
    return (await this.client.query(`SELECT e.payload FROM football.recommendation_result_heads h
      JOIN football.recommendation_result_events e ON e.id=h.event_id`)).rows.map(r=>r.payload);
  }
  async history() {
    // Restrict returned history to events we actually published. No unrelated
    // historical prediction/strategy validation runs in this lane.
    return (await this.client.query(`SELECT m.payload FROM football.match_snapshots m
      WHERE m.dataset IN ('current','history') AND EXISTS (
        SELECT 1 FROM football.recommendation_decisions d
        WHERE d.source_match_id=COALESCE(NULLIF(m.payload->>'sourceMatchId',''),regexp_replace(m.payload->>'id','^sporttery_',''))
      )`)).rows.map(r=>r.payload);
  }
  async appendResult(e) {
    await this.client.query(`INSERT INTO football.recommendation_result_events(id,source_match_id,event_version,observed_at,payload)
      VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(id) DO NOTHING`,[e.eventId,e.sourceMatchId,e.eventVersion,e.observedAt,JSON.stringify(e)]);
    await this.client.query(`INSERT INTO football.recommendation_result_heads(source_match_id,event_version,event_id) VALUES($1,$2,$3)
      ON CONFLICT(source_match_id,event_version) DO UPDATE SET event_id=EXCLUDED.event_id`,[e.sourceMatchId,e.eventVersion,e.eventId]);
  }
  async lane(lane) {return (await this.client.query('SELECT payload FROM football.recommendation_lanes WHERE lane=$1',[lane])).rows[0]?.payload || null;}
  async lanes() {return Object.fromEntries((await this.client.query('SELECT lane,payload FROM football.recommendation_lanes')).rows.map(r=>[r.lane,r.payload]));}
  async saveLane(lane,payload) {await this.client.query(`INSERT INTO football.recommendation_lanes(lane,payload) VALUES($1,$2::jsonb)
    ON CONFLICT(lane) DO UPDATE SET payload=EXCLUDED.payload,updated_at=clock_timestamp()`,[lane,JSON.stringify(payload)]);}
  async issue(lane,issue) {
    const id=hash([lane,issue]);await this.client.query(`INSERT INTO football.recommendation_issues(id,lane,payload) VALUES($1,$2,$3::jsonb)
      ON CONFLICT(id) DO UPDATE SET last_seen_at=clock_timestamp(),occurrences=football.recommendation_issues.occurrences+1`,[id,lane,JSON.stringify(issue)]);
  }
  async savepoint(action) {
    await this.client.query('SAVEPOINT recommendation_item');
    try {const value=await action();await this.client.query('RELEASE SAVEPOINT recommendation_item');return {value};}
    catch(error){await this.client.query('ROLLBACK TO SAVEPOINT recommendation_item');await this.client.query('RELEASE SAVEPOINT recommendation_item');
      if(['40001','40P01'].includes(error.code))throw error;return {error};}
  }
  async saveView(center) {
    // Merge only the new center. Old consumers keep their last legacy record,
    // and a settlement write cannot erase a newer publication-lane payload.
    await this.client.query(`INSERT INTO football.daily_featured_combo_state(id,payload) VALUES(1,$1::jsonb)
      ON CONFLICT(id) DO UPDATE SET payload=(CASE WHEN jsonb_typeof(football.daily_featured_combo_state.payload)='object' THEN football.daily_featured_combo_state.payload ELSE '{}'::jsonb END) || EXCLUDED.payload`,[JSON.stringify({recommendationCenter:center})]);
  }
}
function postgresPorts(pool, clock=Date.now) {
  const {withPostgresTransaction}=require('../../server/postgresStore.cjs');
  return {clock,async transaction(lane,action){
    for(let attempt=0;attempt<3;attempt++){
      try{return await withPostgresTransaction(pool,async client=>{
        await client.query("SELECT set_config('lock_timeout','3000',true),set_config('statement_timeout','20000',true)");
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`recommendation-center:${lane}`]);
        return action(new Repository(client));
      });}catch(error){if(!['40001','40P01'].includes(error.code)||attempt===2)throw error;}
    }
  }};
}
module.exports={Repository,postgresPorts};
