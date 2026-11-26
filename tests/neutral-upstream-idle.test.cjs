'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
test('upstream idle sockets expire before the Node listener without weakening maintenance isolation',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../deploy/light-server/nginx-http-common.conf'),'utf8');
 const upstream=/upstream football_node\s*\{([\s\S]*?)\}/.exec(source)?.[1];assert(upstream);
 const seconds=Number(/keepalive_timeout\s+(\d+)s;/.exec(upstream)?.[1]);
 assert(seconds>0&&seconds*1000<http.createServer().keepAliveTimeout);
 assert(upstream.includes('keepalive 64;'));assert(upstream.includes('server 127.0.0.1:8788 max_fails=1 fail_timeout=1s;'));assert(upstream.includes('server 127.0.0.1:8787 backup;'));
 assert(source.includes('listen 127.0.0.1:8787;'));assert(source.includes('RELEASE_MAINTENANCE'));
});
