"use strict";
// Root publisher -> inherited private IPC -> unprivileged postgres OS account.
// No login role, password, TCP listener, shell SQL or public command socket.
// Pool ownership is deliberately single-session, matching the bounded mirror.
const assert = require("node:assert/strict"), { spawn } = require("node:child_process");
const CHILD = String.raw`
"use strict";
const { Client } = require('/opt/football-predict/node_modules/pg');
if (process.platform !== 'linux' || process.getuid() !== 0 || typeof process.send !== 'function') process.exit(70);
process.setgroups([]); process.setgid('postgres'); process.setuid('postgres');
let client, busy = false, initialized = false, ending = false;
const send = value => { if (process.connected) process.send(value); };
const close = async () => { if (ending) return; ending = true; try { await client?.end(); } finally { process.exit(0); } };
process.once('disconnect',close);
process.on('message',async message=>{
 if (busy || ending || !Number.isSafeInteger(message?.id)) { process.exit(71); return; }
 busy=true;
 try {
  if (message.op==='open') {
   if (initialized || !/^(postgres|football|football_release_[a-f0-9]{12}_[0-9]{1,10})$/.test(message.database)) throw Error('invalid database transport initialization');
   initialized=true;
   client=new Client({host:'/var/run/postgresql',user:'postgres',database:message.database,ssl:false,connectionTimeoutMillis:5000,application_name:'football-signed-native-publisher'});
   await client.connect();client.on('error',()=>process.exit(72));
   const row=(await client.query("SELECT current_database() AS database,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,(SELECT system_identifier::text FROM pg_control_system()) AS cluster_id,pg_backend_pid() AS pid")).rows[0];
   send({id:message.id,ok:true,value:row});
  } else if (message.op==='query') {
   if (!client || typeof message.sql!=='string' || !Array.isArray(message.values)) throw Error('invalid database transport query');
   const result=await client.query(message.sql,message.values);
   const simple=r=>({rows:r.rows,rowCount:r.rowCount,command:r.command});
   send({id:message.id,ok:true,value:Array.isArray(result)?result.map(simple):simple(result)});
  } else if (message.op==='end') {
   await new Promise(resolve=>process.send({id:message.id,ok:true,value:null},resolve));await close();
  }
  else throw Error('invalid database transport operation');
 } catch(error) { send({id:message.id,ok:false,error:{message:error.message,code:error.code}}); }
 finally { busy=false; }
});
`;
class NativeReleasePostgresPool {
  constructor({ database, databaseOid, clusterId }) {
    assert.equal(process.platform, "linux"); assert.equal(process.getuid(), 0);
    assert.match(database, /^(postgres|football|football_release_[a-f0-9]{12}_[0-9]{1,10})$/);
    assert.match(databaseOid, /^[1-9][0-9]{0,9}$/); assert.match(clusterId, /^[0-9]{10,20}$/);
    this.expected = { database, oid: databaseOid, cluster_id: clusterId }; this.child = null; this.nextId = 0;
    this.pending = null; this.borrowed = false; this.closed = false; this.ready = null;
  }
  request(op, fields = {}, timeoutMs = 130000) {
    assert.equal(this.pending, null, "single database session already has an active query");
    assert.ok(this.child?.connected, "database IPC disconnected");
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending = null; this.child.kill("SIGKILL"); this.closed = true;
        reject(new Error("native database IPC deadline exceeded; recovery must inspect actual state"));
      }, timeoutMs);
      this.pending = { id, resolve, reject, timer };
      this.child.send({ id, op, ...fields }, error => {
        if (error && this.pending?.id === id) { clearTimeout(timer); this.pending = null; reject(error); }
      });
    });
  }
  async initialize() {
    assert.equal(this.closed, false, "database transport is closed");
    if (this.ready) return this.ready;
    this.ready = (async () => {
      this.child = spawn("/opt/node-v22.22.1/bin/node", ["--max-old-space-size=192", "-e", CHILD], {
        env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, stdio: ["ignore", "ignore", "pipe", "ipc"], serialization: "advanced",
      });
      let stderr = ""; this.child.stderr.on("data", bytes => { stderr = (stderr + bytes).slice(-1000); });
      this.exited = new Promise(resolve => this.child.once("close", (code, signal) => {
        this.closed = true;
        if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(new Error("native database child stopped: " + String(code ?? signal) + " " + stderr)); this.pending = null; }
        resolve();
      }));
      this.child.once("error", error => { if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(error); this.pending = null; } });
      this.child.on("message", response => {
        const pending = this.pending;
        if (!pending || pending.id !== response?.id) { this.closed = true; this.child.kill("SIGKILL"); return; }
        clearTimeout(pending.timer); this.pending = null;
        if (response.ok) pending.resolve(response.value);
        else { const error = new Error(response.error?.message || "native database query failed"); error.code = response.error?.code; pending.reject(error); }
      });
      const actual = await this.request("open", { database: this.expected.database }, 10000);
      for (const key of Object.keys(this.expected)) assert.equal(actual[key], this.expected[key], "native database transport identity changed: " + key);
      this.backendPid = actual.pid;
    })();
    try { return await this.ready; } catch (error) { this.closed = true; this.child?.kill("SIGKILL"); throw error; }
  }
  async connect() {
    await this.initialize(); assert.equal(this.borrowed, false, "native database session already borrowed"); this.borrowed = true;
    let released = false;
    return { query: async (sql, values = []) => { assert.equal(released, false); return this.request("query", { sql, values }); },
      release: error => { assert.equal(released, false); released = true; this.borrowed = false;
        if (error) { this.closed = true; this.child.kill("SIGKILL"); } } };
  }
  async query(sql, values = []) {
    const client = await this.connect(); try { return await client.query(sql, values); } finally { client.release(); }
  }
  async end() {
    assert.equal(this.borrowed, false, "release native database session before closing pool");
    // A peer that acknowledged end must also exit. Bound that final drain and
    // reap only this pool's child if the PostgreSQL close handshake stalls.
    const reap = this.child ? setTimeout(() => this.child.kill("SIGKILL"), 10000) : null;
    try {
      if (this.child && !this.closed && this.child.connected) {
        try { await this.request("end", {}, 10000); } finally { await this.exited; }
      } else if (this.exited) await this.exited;
    } finally { if (reap) clearTimeout(reap); this.closed = true; }
  }
}
module.exports = { NativeReleasePostgresPool };
