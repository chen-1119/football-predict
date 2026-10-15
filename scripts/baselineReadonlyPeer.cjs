'use strict';
// Fixed privilege drop for the signed root preparation reader. The private
// candidate stays in the root process; only its bounded SELECTs cross the pipe.
const cp=require('node:child_process'),a=require('node:assert/strict');
function peerReader(uid,gid,lock,storeModule){
 const fs=require('node:fs'),a=require('node:assert/strict');
 const check=()=>{a.equal(process.getuid(),uid);a.equal(process.getgid(),gid);a(uid>0&&gid>0);const s=fs.readFileSync('/proc/self/status','utf8');a.match(s,/^CapEff:\s+0+$/m);a.match(s,/^CapAmb:\s+0+$/m);const st=fs.fstatSync(3);a.equal(String(st.dev),lock.device);a.equal(String(st.ino),lock.inode);a.match(fs.readFileSync('/proc/self/fdinfo/3','utf8'),/lock:\s+\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+-?\d+\s+/);};
 let pool,client,buffer='',bytes=0,count=0,totalOut=0,chain=Promise.resolve(),closing=false;
 const send=v=>{const s=JSON.stringify(v)+'\n';totalOut+=Buffer.byteLength(s);a(Buffer.byteLength(s)<=16*1024*1024&&totalOut<=64*1024*1024);process.stdout.write(s);};
 const fail=async code=>{if(closing)return;closing=true;try{await client?.query('ROLLBACK');}catch{}client?.release();await pool?.end().catch(()=>{});process.stderr.write(/^[A-Z0-9_]{1,60}$/.test(code||'')?code:'BASELINE_PEER_READER_FAILED');process.exitCode=1;process.stdin.destroy();};
 (async()=>{check();pool=require(storeModule).createPostgresPool({max:1,min:0});client=await pool.connect();send({id:0,ready:true});
  process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{bytes+=Buffer.byteLength(chunk);buffer+=chunk;if(bytes>1048576||Buffer.byteLength(buffer)>131072){void fail('BASELINE_PEER_INPUT_BOUND');return;}
   let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);chain=chain.then(async()=>{if(closing)return;check();const q=JSON.parse(line);a(Number.isSafeInteger(q.id)&&q.id===++count&&count<=256);
    if(q.close===true){a.deepEqual(Object.keys(q).sort(),['close','id']);await client.query('ROLLBACK');client.release();client=null;await pool.end();closing=true;send({id:q.id,closed:true});process.stdin.destroy();return;}
    a.deepEqual(Object.keys(q).sort(),['args','id','sql']);a(typeof q.sql==='string'&&Buffer.byteLength(q.sql)<=65536&&Array.isArray(q.args));
    const control=["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY","SET LOCAL statement_timeout='10000ms'",'ROLLBACK'];
    a(control.includes(q.sql)||(/^SELECT\b/i.test(q.sql.trim())&&!/\b(?:INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|COPY|CALL|DO)\b/i.test(q.sql)),'SELECT-only peer reader');
    const r=await client.query(q.sql,q.args);check();send({id:q.id,rows:r.rows,rowCount:r.rowCount});
   }).catch(e=>fail(e.code));}
  });process.stdin.once('end',()=>{if(!closing)void chain.then(()=>fail('BASELINE_PEER_EARLY_END'));});process.stdin.once('error',()=>{if(!closing)void fail('BASELINE_PEER_INPUT_ERROR');});
 })().catch(e=>fail(e.code));
}
function createReadonlyPeerPool({connectionString,sslMode,uid,gid,fd,lock}){
 a.equal(process.platform,'linux');a.equal(process.getuid(),0);a(typeof connectionString==='string'&&connectionString.length>0&&connectionString.length<8192);a(Number.isSafeInteger(fd)&&fd>=3);a(Number.isSafeInteger(uid)&&uid>0);a(Number.isSafeInteger(gid)&&gid>0);
 const code='('+peerReader.toString()+')('+[uid,gid,lock,'/opt/football-predict/server/postgresStore.cjs'].map(v=>JSON.stringify(v)).join(',')+');';
 const child=cp.spawn('/usr/sbin/runuser',['-u','football','--','/opt/node-v22.22.1/bin/node','-e',code],{env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',FOOTBALL_POSTGRES_URL:connectionString,...(sslMode?{FOOTBALL_POSTGRES_SSL_MODE:sslMode}:{})},stdio:['pipe','pipe','pipe',fd]});
 let buffer='',total=0,stderr='',nextId=0,pending=null,failed=null,closed=false,connected=false;
 let readyResolve,readyReject;const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
 const fail=error=>{if(failed)return;failed=error;readyReject(error);if(pending){pending.reject(error);pending=null;}child.kill('SIGTERM');};
 const timer=setTimeout(()=>fail(Error('BASELINE_PEER_DEADLINE')),60000);
 const exited=new Promise(resolve=>child.once('close',(code,signal)=>{clearTimeout(timer);if(!closed)fail(Error('BASELINE_PEER_EXIT_'+String(code)+'_'+String(signal)+' '+stderr));resolve();}));
 child.once('error',e=>fail(Error('BASELINE_PEER_SPAWN_'+e.code)));child.stderr.setEncoding('utf8');child.stderr.on('data',s=>{stderr=(stderr+s).slice(0,512);});
 child.stdout.setEncoding('utf8');child.stdout.on('data',s=>{try{total+=Buffer.byteLength(s);buffer+=s;a(total<=64*1024*1024&&Buffer.byteLength(buffer)<=16*1024*1024);let end;while((end=buffer.indexOf('\n'))>=0){const v=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);if(v.id===0){a.equal(v.ready,true);readyResolve();}else{a(pending&&pending.id===v.id);const p=pending;pending=null;if(v.closed)closed=true;p.resolve(v);}}}catch{fail(Error('BASELINE_PEER_OUTPUT_BOUND_OR_IDENTITY'));}});
 const request=async body=>{await ready;if(failed)throw failed;a(!pending&&!closed);const id=++nextId;return new Promise((resolve,reject)=>{pending={id,resolve,reject};const raw=JSON.stringify({id,...body})+'\n';if(Buffer.byteLength(raw)>131072){fail(Error('BASELINE_PEER_REQUEST_BOUND'));return;}child.stdin.write(raw,error=>{if(error)fail(Error('BASELINE_PEER_WRITE'));});});};
 return{async connect(){a(!connected);connected=true;await ready;return{query:(sql,args=[])=>request({sql,args}),release(){}};},async end(){try{if(!failed&&!closed)await request({close:true});}finally{child.stdin.end();await exited;}}};
}
module.exports={createReadonlyPeerPool,peerReader};
