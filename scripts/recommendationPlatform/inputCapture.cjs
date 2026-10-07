'use strict';
const {hash,time}=require('../../src/services/publishedForecastPolicy.cjs');
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const canonicalInstant=v=>typeof v==='string'&&Number.isFinite(time(v))&&new Date(time(v)).toISOString()===v;
const exactKeys=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)
  &&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const boundedText=v=>typeof v==='string'&&v.length>0&&Buffer.byteLength(v,'utf8')<=255&&v===v.trim()&&!/[\x00-\x1f\x7f]/.test(v);
// Capture metadata is a replay aid, not a new source, signature verifier or
// model-admission credential. Original quote/model validation still applies.
function validInputCapture(capture,publishedAt){
  // V1 frozen records retain exactly their original validator. V2 extends the
  // capture with a bounded signed-HAD audit; metadata is never admission proof.
  if(capture?.version==='current-input-capture-v2'){
    try{if(Buffer.byteLength(JSON.stringify(capture),'utf8')>32768)return false;}catch{return false;}
    if(!exactKeys(capture,['version','startedAt','capturedAt','currentHash','marketSignalHash','joinedInputHash','officialHandicap','officialHad']))return false;
    const {officialHad,...base}=capture;
    return validInputCapture({...base,version:'current-input-capture-v1'},publishedAt)
      &&require('./liveOfficialHad.cjs').validOfficialHadAudit(officialHad,capture.capturedAt);
  }
  try{if(Buffer.byteLength(JSON.stringify(capture),'utf8')>16384)return false;}catch{return false;}
  if(!exactKeys(capture,['version','startedAt','capturedAt','currentHash','marketSignalHash','joinedInputHash','officialHandicap'])
    ||capture.version!=='current-input-capture-v1'
    ||!canonicalInstant(capture.startedAt)||!canonicalInstant(capture.capturedAt)
    ||time(capture.startedAt)>time(capture.capturedAt)||time(capture.capturedAt)>time(publishedAt)
    ||!Number.isFinite(time(publishedAt))
    ||!['currentHash','marketSignalHash','joinedInputHash'].every(k=>digest(capture[k])))return false;
  const audit=capture.officialHandicap;
  if(!exactKeys(audit,['version','asOf','snapshotHash','status','endpoints','reasonCounts','samples'])
    ||audit.version!=='official-handicap-input-audit-v1'||audit.asOf!==capture.capturedAt
    ||(audit.snapshotHash!==null&&!digest(audit.snapshotHash))
    ||!['source-unavailable','source-cycle-conflict','source-verified'].includes(audit.status)
    ||!audit.endpoints||Object.keys(audit.endpoints).sort().join(',')!=='calculator,current'
    ||!audit.reasonCounts||Array.isArray(audit.reasonCounts)||typeof audit.reasonCounts!=='object'
    ||Object.keys(audit.reasonCounts).length>16||!Array.isArray(audit.samples)||audit.samples.length>32)return false;
  const reasons=new Set(['not-open-prospective-input','event-missing-or-ambiguous','event-identity-conflict','event-not-selling',
    'hhad-pool-unavailable','hhad-market-invalid','cutoff-crossed-or-invalid','input-quote-newer-than-snapshot','hhad-applied']);
  if(Object.entries(audit.reasonCounts).some(([k,v])=>!reasons.has(k)||!Number.isSafeInteger(v)||v<0)
    ||audit.samples.some(v=>!exactKeys(v,['sourceMatchId','reason'])||(v.sourceMatchId!==''&&!boundedText(v.sourceMatchId))||!reasons.has(v.reason)))return false;
  const endpointReasons=new Set(['endpoint-missing-or-ambiguous','endpoint-contract-invalid','endpoint-cycle-invalid','endpoint-clock-invalid',
    'endpoint-acquired-after-asof','endpoint-expired','collector-attestation-invalid','endpoint-payload-invalid','endpoint-row-limit','verified']);
  for(const e of Object.values(audit.endpoints)){
    const keys=['reason','receivedAt','requestedAt','sourceCycleId','collectorSignatureVerified','payloadHash','commitmentHash','rows'];
    if(!e||typeof e!=='object'||Array.isArray(e)||Object.keys(e).some(k=>!keys.includes(k))||!endpointReasons.has(e.reason)
      ||['receivedAt','requestedAt'].some(k=>e[k]!==undefined&&e[k]!==null&&!canonicalInstant(e[k]))
      ||(e.sourceCycleId!==undefined&&e.sourceCycleId!==null&&!boundedText(e.sourceCycleId))
      ||['payloadHash','commitmentHash'].some(k=>e[k]!==undefined&&!digest(e[k]))
      ||(e.collectorSignatureVerified!==undefined&&e.collectorSignatureVerified!==true)
      ||(e.rows!==undefined&&(!Number.isSafeInteger(e.rows)||e.rows<0||e.rows>512)))return false;
    if(e.reason==='verified'&&(!digest(e.payloadHash)||!digest(e.commitmentHash)||e.collectorSignatureVerified!==true
      ||!Number.isSafeInteger(e.rows)||!boundedText(e.sourceCycleId)||!canonicalInstant(e.receivedAt)||!canonicalInstant(e.requestedAt)
      ||time(e.requestedAt)>time(e.receivedAt)
      ||time(e.receivedAt)>time(capture.capturedAt)))return false;
  }
  if(audit.status==='source-verified'&&(Object.values(audit.endpoints).some(e=>e.reason!=='verified')
    ||audit.endpoints.calculator.sourceCycleId!==audit.endpoints.current.sourceCycleId))return false;
  return true;
}
function captureBinding(capture,publishedAt){
  if(capture===undefined||capture===null)return {};
  if(!validInputCapture(capture,publishedAt))throw Object.assign(new Error('Input capture invalid'),{code:'INPUT_CAPTURE_INVALID'});
  return {inputCaptureHash:hash(capture)};
}
module.exports={validInputCapture,captureBinding};
