'use strict';
function readOnlyPool(pool) {
  if (!pool?.connect || !pool?.end) throw new Error('Dedicated PostgreSQL pool required');
  return {
    async connect() {
      const client = await pool.connect();
      try { await client.query('SET default_transaction_read_only=on'); return client; }
      catch (error) { client.release(error); throw error; }
    },
    async query(...args) {
      const client = await this.connect();
      try { return await client.query(...args); } finally { client.release(); }
    },
    end() { return pool.end(); },
  };
}
module.exports = { readOnlyPool };
