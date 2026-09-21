'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const manifest=require('../src/assets/team-badges/manifest.json');
const catalog=require('../src/services/teamCrestCatalog.json');

test('every verified club source has an intact bundled PNG with matching attribution',()=>{
 const assets=new Map(manifest.assets.map(asset=>[asset.key,asset]));
 assert.equal(assets.size,manifest.assets.length);
 for(const entry of catalog){
  const asset=assets.get(entry.key);
  assert.ok(asset,entry.key+' missing bundled image');
  assert.equal(asset.url,entry.logoUrl);
  assert.equal(asset.sourceUrl,entry.sourceUrl);
 }
 const module=fs.readFileSync(path.join(root,'src/services/teamBadgeAssets.ts'),'utf8');
 for(const asset of manifest.assets){
  assert.match(asset.file,/^[a-z0-9-]+\.png$/);
  const bytes=fs.readFileSync(path.join(root,'src/assets/team-badges',asset.file));
  assert.equal(bytes.length,asset.bytes,asset.key+' byte length');
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),asset.sha256,asset.key+' SHA256');
  assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  assert.equal(bytes.readUInt32BE(16),asset.width);
  assert.equal(bytes.readUInt32BE(20),asset.height);
  assert.ok(module.includes('../assets/team-badges/'+asset.file));
 }
});

test('club aliases are unique after display normalization',()=>{
 const aliases=new Map();
 for(const entry of catalog)for(const alias of entry.aliases){
  const key=alias.trim().toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,'').replace(/[·.()（）'’\-_/]/g,'');
  assert.ok(!aliases.has(key)||aliases.get(key)===entry.key,alias+' maps to two clubs');
  aliases.set(key,entry.key);
 }
});
