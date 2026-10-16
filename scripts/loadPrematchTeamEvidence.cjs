'use strict';

const sources = require('./teamEvidenceSources.cjs');
const store = require('./teamEvidenceStore.cjs');
const {createPostgresPool} = require('../server/postgresStore.cjs');
const {eligibleEvent} = require('../src/services/teamEvidencePrematchBridge.cjs');
const {epochNanoseconds: clock} = require('../src/services/prematchV3Clock.cjs');

async function loadPrematchTeamEvidence({matches, asOf, pool: suppliedPool} = {}) {
  const result = {version: 'prematch-stored-team-evidence-read-v1', asOf, storage: 'postgres',
    formalEligible: false, status: 'no-supported-events', events: [], receipts: [], blockers: [], productionWrites: 0};
  if (clock(asOf) === null || !Array.isArray(matches) || matches.length > 512) {
    return {...result, status: 'blocked', blockers: ['team-evidence-input-invalid']};
  }
  const targets = matches.map(m => eligibleEvent(m, asOf)).filter(e => e?.leagueName === '韩国职业联赛');
  if (!targets.length) return result;
  if (targets.length > 32) return {...result, status: 'blocked', blockers: ['team-evidence-event-bound']};
  let pool, client;
  const fail = code => { result.events = []; result.status = 'blocked'; result.blockers.push(code); };
  try {
    pool = suppliedPool || createPostgresPool({applicationName: 'football-prematch-team-evidence-read',
      max: 1, min: 0, connectionTimeoutMillis: 5000, queryTimeoutMillis: 7000});
    client = await pool.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query('SET LOCAL statement_timeout = 5000');
    await client.query('SET LOCAL lock_timeout = 1000');
    const plans = sources.plans(targets, asOf).filter(p => p.kind !== 'history');
    const packets = [];
    for (const plan of plans) {
      const head = await store.read(client, 'team-evidence-head-' + plan.id);
      if (!head) { result.receipts.push({sourceId: plan.id, status: 'missing'}); continue; }
      try {
        const {contentHash, ...body} = head.payload;
        sources.check(contentHash === sources.hash(body) && body.version === 'team-evidence-head-v1'
          && body.sourceId === plan.id && clock(head.updatedAt) !== null
          && clock(head.updatedAt) + 999999n < clock(asOf), 'HEAD_BINDING_OR_CLOCK');
        const packet = await store.readPacket(client, body.key, asOf);
        sources.check(packet.sourceId === plan.id && packet.createdAt === body.receivedAt
          && clock(packet.createdAt) !== null && clock(packet.createdAt) <= clock(asOf)
          && clock(asOf) - clock(packet.createdAt) <= 21600000000000n, 'HEAD_PACKET_OR_FRESHNESS');
        packets.push(packet);
        result.receipts.push({sourceId: plan.id, status: 'read', key: body.key,
          packetHash: packet.contentHash, headPayloadSha256: head.payloadSha256, receivedAt: packet.createdAt});
      } catch (error) {
        result.receipts.push({sourceId: plan.id, status: 'blocked',
          reason: /^TEAM_EVIDENCE_[A-Z_0-9]+$/.test(error?.code || '') ? error.code : 'team-evidence-packet-read-invalid'});
      }
    }
    // Missing or corrupt snapshots do not erase other sources. Event adoption
    // independently requires an exact fixture and its standings below.
    for (const event of targets) result.events.push({eventIdentity: [event.sourceMatchId, event.eventVersion,
      event.homeTeamId, event.awayTeamId, event.cutoffAt], packets});
    result.status = packets.length ? 'read' : 'missing';
  } catch { fail('team-evidence-read-transaction-failed'); }
  finally {
    if (client) {
      try { await client.query('ROLLBACK'); } catch { fail('team-evidence-rollback-failed'); }
      try { client.release(result.blockers.length ? true : undefined); } catch { fail('team-evidence-release-failed'); }
    }
    if (pool && !suppliedPool) { try { await pool.end(); } catch { fail('team-evidence-pool-close-failed'); } }
  }
  return result;
}

module.exports = {loadPrematchTeamEvidence};
