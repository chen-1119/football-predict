'use strict';
const VERSION = 'coherent-market-primary-v1';
const CODES = ['1', 'X', '2'];
const near = (a,b) => Math.abs(a-b) <= 1e-6;
const vector = p => p && CODES.every(c => Number.isFinite(p[c]) && p[c]>=0 && p[c]<=1)
  && near(CODES.reduce((s,c)=>s+p[c],0),1);
const top = p => CODES.reduce((best,c)=>p[c]>p[best]+1e-12?c:best,CODES[0]);
function conflicts(had,hhad,line) {
  const lo=Math.max(had==='1'?1:had==='X'?0:-Infinity,hhad==='1'?1-line:hhad==='X'?-line:-Infinity);
  const hi=Math.min(had==='2'?-1:had==='X'?0:Infinity,hhad==='2'?-1-line:hhad==='X'?-line:Infinity);
  return lo>hi;
}
/** Pick the greatest unconditional marginal first. The other market is selected
 * by joint mass inside that anchor, never by an incompatible marginal leader.
 * Stable ties prefer HAD, then 1/X/2. Conditional shares are explanatory only. */
function selectCoherentPrimary(probabilities, handicapProbabilities, joint, line, handicapAvailable) {
  if(!vector(probabilities))return null;
  const hadLeader=top(probabilities);
  if(!handicapAvailable)return {version:VERSION,anchorMarket:'HAD',anchorCode:hadLeader,
    anchorProbability:probabilities[hadLeader],hadCode:hadLeader,hhadCode:null,
    jointProbability:null,companionConditionalProbability:null,jointProbabilities:null};
  if(!Number.isSafeInteger(line)||line===0||!vector(handicapProbabilities)||!joint
    ||CODES.some(a=>!joint[a]||CODES.some(b=>!Number.isFinite(joint[a][b])||joint[a][b]<0
      ||(conflicts(a,b,line)&&joint[a][b]>1e-12)))
    ||CODES.some(a=>!near(CODES.reduce((s,b)=>s+joint[a][b],0),probabilities[a]))
    ||CODES.some(b=>!near(CODES.reduce((s,a)=>s+joint[a][b],0),handicapProbabilities[b])))return null;
  const hhadLeader=top(handicapProbabilities);
  const anchorMarket=handicapProbabilities[hhadLeader]>probabilities[hadLeader]+1e-12?'HHAD':'HAD';
  const anchorCode=anchorMarket==='HAD'?hadLeader:hhadLeader;
  const companionMass=Object.fromEntries(CODES.map(c=>[c,anchorMarket==='HAD'?joint[anchorCode][c]:joint[c][anchorCode]]));
  const companionCode=top(companionMass);
  const hadCode=anchorMarket==='HAD'?anchorCode:companionCode;
  const hhadCode=anchorMarket==='HHAD'?anchorCode:companionCode;
  const jointProbability=joint[hadCode][hhadCode];
  if(!(jointProbability>0)||conflicts(hadCode,hhadCode,line))return null;
  const anchorProbability=anchorMarket==='HAD'?probabilities[anchorCode]:handicapProbabilities[anchorCode];
  return {version:VERSION,anchorMarket,anchorCode,anchorProbability,hadCode,hhadCode,
    jointProbability,companionConditionalProbability:jointProbability/anchorProbability,jointProbabilities:joint};
}
function validCoherentPrimary(value,p,hp,line,available) {
  const canonical=v=>JSON.stringify(v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(canonical(v[k]))])):v);
  try{return canonical(value)===canonical(selectCoherentPrimary(p,hp,value?.jointProbabilities,line,available));}catch{return false;}
}
module.exports={VERSION,selectCoherentPrimary,validCoherentPrimary,conflicts};
