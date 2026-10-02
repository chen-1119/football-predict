const fs=require('node:fs'),crypto=require('node:crypto'),assert=require('node:assert/strict'),path=require('node:path');
const source='C:/Users/86188/.codex/worktrees/football-release-oct02/football/outputs/online-validation-20261002';
const receipt=JSON.parse(fs.readFileSync(path.join(source,'online-validation-inputs-receipt.json'),'utf8'));
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const file=receipt.files.find(x=>x.name==='matches-current.json'),sha=hash(path.join(source,file.name));assert.equal(sha,file.sha256);
const capture=require('./live-public-capture.json');assert.equal(capture.responses['/api/public/overview'].matches[0].businessDate,'2026-09-30');
fs.writeFileSync(path.join(__dirname,'source-evidence.json'),JSON.stringify({verifiedAt:new Date().toISOString(),previewSource:'Fresh read-only public HTTP capture',capturedAt:capture.capturedAt,captureSha256:hash(path.join(__dirname,'live-public-capture.json')),underlyingPublication:receipt.publication,onlineExport:{path:path.join(source,file.name),sha256:sha,hashVerified:true,usedAsPreview:false},businessDate:'2026-09-30',notNewOctober2Data:true,privateDataRead:false},null,2));console.log('Source provenance verified');
