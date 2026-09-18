'use strict';
const {createRuntime}=require('./runtime.cjs');
const {postgresPorts}=require('./repository.cjs');

/** One process per lane. Notifications are hints; a periodic check handles
 * disconnects, lost notifications, time-based cutoffs and missed starts. */
async function run({lane='publish',watch=false}={}) {
  if(!['publish','settlement'].includes(lane))throw new Error('Unsupported lane');
  const {createPostgresPool}=require('../../server/postgresStore.cjs');
  const pool=createPostgresPool({max:2,applicationName:`football-recommendations-${lane}`});
  const runtime=createRuntime(postgresPorts(pool));
  const cycle=()=>lane==='publish'?runtime.publishingCycle():runtime.settlementCycle();
  if(!watch){try{return await cycle();}finally{await pool.end();}}
  let stopped=false,timer,listener=null,running=false,dirty=false,lastWake='';
  const notify=()=>{dirty=true;if(!running)void tick();};
  async function listen(){
    if(stopped||listener)return;
    try{
      const client=await pool.connect();listener=client;
      client.on('notification',notify);
      client.on('error',()=>{client.removeListener('notification',notify);if(listener===client){listener=null;client.release(true);} });
      await client.query('LISTEN football_recommendation_input');
    }catch{if(listener){listener.release(true);listener=null;}}
  }
  async function tick(){
    if(stopped||running)return;
    running=true;dirty=false;if(timer)clearTimeout(timer);
    try{
      await listen();
      const wake=await pool.query('SELECT revision FROM football.recommendation_input_clock WHERE id=1');
      const revision=String(wake.rows[0]?.revision||'0');
      // Publication always re-evaluates clocks. Settlement may also receive a
      // correction without generation change, so it is never permanently skipped.
      const result=await cycle();lastWake=revision;
      console.log(JSON.stringify({lane,inputRevision:lastWake,...result}));
    }catch(error){console.error(JSON.stringify({lane,errorCode:error.code||'WORKER_FAILED'}));}
    finally{running=false;if(!stopped)timer=setTimeout(tick,dirty?1000:30000);}
  }
  const stop=async()=>{
    stopped=true;if(timer)clearTimeout(timer);
    if(listener){listener.removeListener('notification',notify);listener.release(true);listener=null;}
    await pool.end();
  };
  process.once('SIGTERM',()=>void stop());process.once('SIGINT',()=>void stop());
  await tick();
  return {watching:true,lane};
}
module.exports={run};
