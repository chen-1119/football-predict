"use strict";
const KEY = "football-postgres-projection-sync-v1";
// Preparation owns a pre-existing 600s contention budget. Keep one bounded
// FIFO position through ordinary 20s+ view transactions, without starting a
// snapshot or changing the default nonblocking worker admission.
const MAX_WAIT_MS = 60000;
function receiptBarrierState() { return { held: false, acquisitionUncertain: false, configurationUncertain: false }; }
function validateReceiptWait(waitMs) {
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > MAX_WAIT_MS) throw new Error("invalid bounded receipt read wait");
  return waitMs;
}
async function acquireReceiptReadBarrier(client, state, waitMs = 0) {
  validateReceiptWait(waitMs);
  if (!state || state.held || state.acquisitionUncertain || state.configurationUncertain) throw new Error("receipt read state must be fresh");
  if (waitMs === 0) {
    state.acquisitionUncertain = true;
    const acquired = await client.query("SELECT pg_try_advisory_lock_shared(hashtext($1)) AS acquired", [KEY]);
    if (typeof acquired?.rows?.[0]?.acquired !== "boolean") throw new Error("receipt read lock reply unavailable");
    state.acquisitionUncertain = false;
    if (acquired.rows[0]?.acquired !== true) throw new Error("native receipt read barrier busy; retry after projection completes");
    state.held = true;
    return;
  }
  // Only deployment preparation opts into this bounded server-side queue.
  // BEGIN remains after lock acquisition: never pin a pre-writer RR snapshot.
  // Every ordinary worker retains its original nonblocking behavior.
  const previous = (await client.query("SHOW lock_timeout")).rows[0]?.lock_timeout;
  if (typeof previous !== "string" || previous.length > 100) throw new Error("receipt read timeout state unavailable");
  state.configurationUncertain = true;
  await client.query("SELECT set_config($1,$2,false)", ["lock_timeout", `${waitMs}ms`]);
  try {
    state.acquisitionUncertain = true;
    const acquired = await client.query("SELECT pg_advisory_lock_shared(hashtext($1)),true AS acquired", [KEY]);
    if (acquired?.rows?.[0]?.acquired !== true) throw new Error("receipt read lock reply unavailable");
    state.held = true;
    state.acquisitionUncertain = false;
  } catch (error) {
    // A server-confirmed lock timeout grants no lock. Other lost replies keep
    // the uncertain flag so the owner discards the entire connection.
    if (error.code === "55P03") {
      state.acquisitionUncertain = false;
      throw new Error("native receipt read barrier busy; retry after projection completes", { cause: error });
    }
    throw error;
  } finally {
    await client.query("SELECT set_config($1,$2,false)", ["lock_timeout", previous]);
    state.configurationUncertain = false;
  }
}
module.exports = { KEY, MAX_WAIT_MS, receiptBarrierState, validateReceiptWait, acquireReceiptReadBarrier };
