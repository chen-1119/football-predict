'use strict';
// Disposable Unix peer-authenticated PostgreSQL cluster. Never uses a production
// socket, user, database, lock, credential, or application source tree.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process'),a=require('node:assert/strict');
function verify(){
 a.equal(process.platform,'linux');a.equal(process.getuid(),0);a.equal(process.env.CI,'true');a.equal(process.env.BASELINE_PEER_FIXTURE,'isolated');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'football-baseline-peer-')),data=path.join(dir,'data'),socket=path.join(dir,'socket'),lock=path.join(dir,'lock'),fixture=path.join(dir,'peer.cjs'),bin='/usr/lib/postgresql/16/bin';
 fs.chmodSync(dir,0o755);for(const p of [data,socket])fs.mkdirSync(p,{mode:0o755});
 const pgUid=Number(cp.execFileSync('/usr/bin/id',['-u','postgres'],{encoding:'utf8'})),pgGid=Number(cp.execFileSync('/usr/bin/id',['-g','postgres'],{encoding:'utf8'}));for(const p of [data,socket])fs.chownSync(p,pgUid,pgGid);
 const run=(file,args)=>{const r=cp.spawnSync(file,args,{encoding:'utf8',timeout:30000,maxBuffer:1048576});a.equal(r.status,0,r.stderr||r.stdout);return r.stdout;};
 const pg=(command,args)=>run('/usr/sbin/runuser',['-u','postgres','--',bin+'/'+command,...args]);
 let started=false;
 try{
  pg('initdb',['-D',data,'--auth-local=peer','--auth-host=reject','--no-locale','--encoding=UTF8']);
  pg('pg_ctl',['-D',data,'-l',path.join(data,'server.log'),'-o',"-c listen_addresses='' -c unix_socket_directories='"+socket+"' -p 5432 -c shared_buffers=16MB -c max_connections=10",'-w','start']);started=true;
  pg('psql',['-h',socket,'-d','postgres','-v','ON_ERROR_STOP=1','-c','CREATE ROLE nobody LOGIN; CREATE TABLE peer_probe(v integer); GRANT SELECT ON peer_probe TO nobody;']);
  const store=path.resolve(__dirname,'../server/postgresStore.cjs'),uid=Number(run('/usr/bin/id',['-u','nobody']).trim()),gid=Number(run('/usr/bin/id',['-g','nobody']).trim());
  // Three named fixture substitutions; production retains its fixed football
  // account, installed source path, and Node executable without override flags.
  const original=fs.readFileSync(path.join(__dirname,'baselineReadonlyPeer.cjs'),'utf8');let source=original;const substitutions=[["'-u','football'","'-u','nobody'"],['/opt/football-predict/server/postgresStore.cjs',store],['/opt/node-v22.22.1/bin/node',process.execPath]];
  for(const [from,to]of substitutions){a.equal(source.split(from).length,2);source=source.replace(from,to);}let inverse=source;for(const[from,to]of substitutions.slice().reverse())inverse=inverse.replace(to,from);a.equal(inverse,original);fs.writeFileSync(fixture,source,{mode:0o644});fs.writeFileSync(lock,'',{mode:0o644});
  const url='postgresql://nobody@/postgres?host='+encodeURIComponent(socket);
  const code=`const fs=require('node:fs'),a=require('node:assert/strict'),cp=require('node:child_process'),store=require(${JSON.stringify(store)}),m=require(${JSON.stringify(fixture)});(async()=>{const url=${JSON.stringify(url)},rootPool=store.createPostgresPool({connectionString:url,ssl:false,max:1,min:0});await a.rejects(rootPool.connect(),e=>e.code==='28000'&&/Peer authentication/.test(e.message));await rootPool.end();const st=fs.statSync(${JSON.stringify(lock)}),fd=fs.readdirSync('/proc/self/fd').map(Number).find(n=>{try{return fs.fstatSync(n).ino===st.ino&&/FLOCK\\s+ADVISORY\\s+WRITE/.test(fs.readFileSync('/proc/self/fdinfo/'+n,'utf8'))}catch{return false}});a(Number.isInteger(fd));const options={connectionString:url,sslMode:'disable',uid:${uid},gid:${gid},fd,lock:{device:String(st.dev),inode:String(st.ino)}};const pool=m.createReadonlyPeerPool(options);try{const c=await pool.connect();await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const r=await c.query("SELECT current_user AS role,current_database() AS db,current_setting('transaction_read_only') AS readonly");a.deepEqual(r.rows,[{role:'nobody',db:'postgres',readonly:'on'}]);a.equal((await c.query('SELECT count(*)::integer AS count FROM peer_probe')).rows[0].count,0);a.equal(cp.spawnSync('/usr/bin/flock',['-n','-E','75',${JSON.stringify(lock)},'/usr/bin/true']).status,75);await a.rejects(c.query('INSERT INTO peer_probe VALUES (1)'),/BASELINE_PEER/);}finally{await pool.end();}const bad=m.createReadonlyPeerPool({...options,uid:${uid}+1});try{await a.rejects(bad.connect(),/BASELINE_PEER/);}finally{await bad.end();}console.log(JSON.stringify({ok:true,rootPeerRejected:true,actualPrivilegeDrop:true,readonlySnapshot:true,sqlWriteRejected:true,wrongUidRejected:true,inheritedExclusiveLock:true,productionWrites:0}));})().catch(e=>{console.error(e);process.exitCode=1;});`;
  const result=run('/usr/bin/flock',['--no-fork','--exclusive',lock,process.execPath,'-e',code]);const v=JSON.parse(result.trim());a.equal(v.ok,true);return v;
 }finally{
  if(started)pg('pg_ctl',['-D',data,'-m','fast','-w','stop']);
  a(fs.realpathSync(dir)===dir&&path.dirname(dir)===os.tmpdir()&&path.basename(dir).startsWith('football-baseline-peer-'));fs.rmSync(dir,{recursive:true});
 }
}
if(require.main===module){try{console.log(JSON.stringify(verify()));}catch(e){console.error(e);process.exitCode=1;}}
module.exports={verify};
