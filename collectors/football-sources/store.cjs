'use strict';
const {identity,hash}=require('./core.cjs');
async function transaction(pool,fn){const c=await pool.connect();try{await c.query('BEGIN');const result=await fn(c);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}}
function repository(pool){return {
  async getCache(key){return (await pool.query('SELECT payload FROM football_sources.cache WHERE key=$1',[key])).rows[0]?.payload||null;},
  async caches(){return (await pool.query('SELECT payload FROM football_sources.cache ORDER BY received_at DESC LIMIT 400')).rows.map(r=>r.payload);},
  async reserve(provider,now,policy){return transaction(pool,async c=>{
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['football-sources-budget:'+provider]);
    const stamp=new Date(now),day=stamp.toISOString().slice(0,10);
    await c.query("INSERT INTO football_sources.quota(provider,utc_day,used,next_at) VALUES($1,$2,0,'epoch') ON CONFLICT DO NOTHING",[provider,day]);
    const q=(await c.query('SELECT * FROM football_sources.quota WHERE provider=$1 FOR UPDATE',[provider])).rows[0];
    if(new Date(q.next_at).getTime()>now)return {allowed:false,reason:'cooldown'};
    const used=new Date(q.utc_day).toISOString().slice(0,10)===day?q.used:0;
    if(used>=policy.daily)return {allowed:false,reason:'daily-budget-exhausted'};
    await c.query('UPDATE football_sources.quota SET utc_day=$2,used=$3,next_at=$4 WHERE provider=$1',[provider,day,used+1,new Date(now+policy.delayMs)]);
    return {allowed:true};
  });},
  async failure(provider,started,finished,state,nextAt){return transaction(pool,async c=>{
    await c.query('UPDATE football_sources.quota SET next_at=GREATEST(next_at,$2) WHERE provider=$1',[provider,new Date(nextAt)]);
    await c.query('INSERT INTO football_sources.attempts(provider,started_at,finished_at,state) VALUES($1,$2,$3,$4)',[provider,new Date(started),new Date(finished),state]);
  });},
  async save(cache,raw,attempt){return transaction(pool,async c=>{
    if(raw!==null)await c.query('INSERT INTO football_sources.raw_receipts(hash,provider,received_at,raw_body) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[cache.rawHash,cache.provider,cache.receivedAt,raw]);
    await c.query(`INSERT INTO football_sources.cache(key,provider,received_at,expires_at,payload) VALUES($1,$2,$3,$4,$5::jsonb)
      ON CONFLICT(key) DO UPDATE SET received_at=EXCLUDED.received_at,expires_at=EXCLUDED.expires_at,payload=EXCLUDED.payload
      WHERE football_sources.cache.received_at<=EXCLUDED.received_at`,[cache.key,cache.provider,cache.receivedAt,cache.expiresAt,JSON.stringify(cache)]);
    await c.query('INSERT INTO football_sources.attempts(provider,started_at,finished_at,state) VALUES($1,$2,$3,$4)',[attempt.provider,new Date(attempt.started),new Date(attempt.finished),attempt.state]);
  });},
  async current(){return (await pool.query("SELECT payload FROM football.match_snapshots WHERE dataset='current'")).rows.map(r=>r.payload);},
  async saveView(match,view){const ident=identity(match);if(!ident)throw new Error('invalid-view-identity');return transaction(pool,async c=>{
    // Compare the whole event identity again, not just the source ID. A change
    // during collection cannot be served under a reused ID: readView repeats
    // this identity check. No UPDATE privilege on the core match table is needed.
    const rows=(await c.query("SELECT payload FROM football.match_snapshots WHERE dataset='current' AND payload->>'id'=$1",[match.id])).rows;
    if(rows.length!==1||hash(identity(rows[0].payload))!==hash(ident))return false;
    await c.query(`INSERT INTO football_sources.match_views(match_id,event_version,input_hash,checked_at,payload) VALUES($1,$2,$3,$4,$5::jsonb)
      ON CONFLICT(match_id) DO UPDATE SET event_version=EXCLUDED.event_version,input_hash=EXCLUDED.input_hash,checked_at=EXCLUDED.checked_at,payload=EXCLUDED.payload
      WHERE football_sources.match_views.checked_at<=EXCLUDED.checked_at`,[match.id,ident.eventVersion,hash(ident),view.generatedAt,JSON.stringify(view)]);
    return true;
  });},
  async readView(match){const ident=identity(match);if(!ident)return null;const row=(await pool.query('SELECT input_hash,payload FROM football_sources.match_views WHERE match_id=$1',[match.id])).rows[0];return row?.input_hash===hash(ident)?row.payload:null;},
};}
module.exports={repository,transaction};
