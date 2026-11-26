'use strict';
// For immutable research append operations only. The projection writer's
// existing exclusive barrier still excludes these transactions. Concurrent
// repeatable-read consumers may keep reading their prior committed snapshot.
// No timeout, isolation level, release lock or publication gate is changed.
const PROJECTION_KEY='football-postgres-projection-sync-v1';
const APPEND_KEY='football-research-immutable-append-v1';
async function acquireResearchAppendLock(client,{independentOfficial=false}={}) {
  if(typeof client?.query!=='function'||typeof independentOfficial!=='boolean')throw Error('RESEARCH_APPEND_LOCK_INPUT');
  // Legacy native-backed decisions retain the original exclusive barrier.
  const command=independentOfficial?'SELECT pg_advisory_xact_lock_shared(hashtext($1))':'SELECT pg_advisory_xact_lock(hashtext($1))';
  await client.query(command,[PROJECTION_KEY]);
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[APPEND_KEY]);
}
module.exports={PROJECTION_KEY,APPEND_KEY,acquireResearchAppendLock};
