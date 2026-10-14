'use strict';
// Local input admission before signing/sequence reservation. The actual tar
// member and its original release checks still run independently afterwards.
const fs=require('node:fs'),crypto=require('node:crypto');
const MODEL_EVALUATION_ENTRY='public/data/model-evaluation.json';
const EXPECTED_MODEL_EVALUATION_VERSION='rolling-backtest-v19';
const EXPECTED_WALK_FORWARD_VERSION='walk-forward-promotion-validation-v3';
const EXPECTED_WALK_FORWARD_PROTOCOL='nested-expanding-window-candidate-selection-v2';
function inspectModelEvaluationFile(file){
 let fd;
 try{
  const before=fs.lstatSync(file);
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size<1||before.size>8*1024*1024)throw Error('non-plain or out-of-bounds model evaluation input');
  fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
  const opened=fs.fstatSync(fd),bytes=fs.readFileSync(fd),after=fs.fstatSync(fd),current=fs.lstatSync(file);
  const stamp=s=>[s.dev,s.ino,s.nlink,s.size,s.mtimeMs,s.ctimeMs].join(':');
  if(stamp(before)!==stamp(opened)||stamp(opened)!==stamp(after)||stamp(after)!==stamp(current)||bytes.length!==opened.size)throw Error('model evaluation input changed during read');
  const parsed=JSON.parse(bytes.toString('utf8'));
  if(parsed?.ok!==true||parsed.version!==EXPECTED_MODEL_EVALUATION_VERSION
   ||parsed.walkForwardValidation?.version!==EXPECTED_WALK_FORWARD_VERSION
   ||parsed.walkForwardValidation?.protocolVersion!==EXPECTED_WALK_FORWARD_PROTOCOL)throw Error('model evaluation input version or validation contract is invalid');
  return {ok:true,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),version:parsed.version};
 }catch(e){return {ok:false,error:String(e.code||e.message)};}finally{if(fd!==undefined)fs.closeSync(fd);}
}
module.exports={MODEL_EVALUATION_ENTRY,EXPECTED_MODEL_EVALUATION_VERSION,EXPECTED_WALK_FORWARD_VERSION,EXPECTED_WALK_FORWARD_PROTOCOL,inspectModelEvaluationFile};
