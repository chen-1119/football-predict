'use strict';

const VERSION='had-direction-selection-v1';
const CODES=Object.freeze(['1','X','2']);
const EPS=1e-12;
const RULES=Object.freeze({
  draw:Object.freeze({minProbability:.27,maxLeaderDeficit:.09,minEdge:.035,minExpectedValue:.04,minEdgeAdvantage:.02,minExpectedValueAdvantage:.03,maxOdds:4.2,maxFavoriteProbability:.50}),
  upset:Object.freeze({minProbability:.28,maxLeaderDeficit:.10,minEdge:.04,minExpectedValue:.055,minEdgeAdvantage:.025,minExpectedValueAdvantage:.04,maxOdds:4.2}),
});
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const normalize=value=>{
  if(!value||typeof value!=='object')return null;
  const p=Object.fromEntries(CODES.map(c=>[c,Number(value[c])]));
  if(CODES.some(c=>!finite(p[c])||p[c]<0||p[c]>1))return null;
  const total=CODES.reduce((s,c)=>s+p[c],0);
  if(Math.abs(total-1)>.02||total<=0)return null;
  return Object.fromEntries(CODES.map(c=>[c,p[c]/total]));
};
const oddsVector=value=>{
  if(!value||typeof value!=='object')return null;
  const q=Object.fromEntries(CODES.map(c=>[c,Number(value[c])]));
  return CODES.every(c=>finite(q[c])&&q[c]>1)?q:null;
};
function devig(quoteOdds){
  const q=oddsVector(quoteOdds);if(!q)return null;
  const total=CODES.reduce((s,c)=>s+1/q[c],0);
  return Object.fromEntries(CODES.map(c=>[c,(1/q[c])/total]));
}
function uniqueTop(values){
  if(!values)return null;
  const ranked=CODES.slice().sort((a,b)=>values[b]-values[a]||CODES.indexOf(a)-CODES.indexOf(b));
  return values[ranked[0]]-values[ranked[1]]>EPS?ranked[0]:null;
}
function favoriteCodes(fair){
  if(!fair)return[];
  const top=Math.max(...CODES.map(c=>fair[c]));
  return CODES.filter(c=>Math.abs(fair[c]-top)<=EPS);
}
function marketRole(code,favorites){
  if(favorites.includes(code))return 'favorite';
  return code==='X'?'draw':'nonfavorite';
}
function metrics(probabilities,quoteOdds,fair,code,leaderCode){
  const p=probabilities[code],leaderProbability=probabilities[leaderCode];
  const edge=p-fair[code],ev=p*quoteOdds[code]-1;
  return {
    code,modelProbability:p,marketProbability:fair[code],odds:quoteOdds[code],
    probabilityEdge:edge,expectedValue:ev,leaderDeficit:leaderProbability-p,
  };
}
function qualifiedDraw(row,leader,fair){
  const r=RULES.draw,favoriteProbability=Math.max(...CODES.map(c=>fair[c]));
  return row.modelProbability>=r.minProbability
    &&row.leaderDeficit<=r.maxLeaderDeficit+EPS
    &&row.probabilityEdge>=r.minEdge-EPS
    &&row.expectedValue>=r.minExpectedValue-EPS
    &&row.probabilityEdge-leader.probabilityEdge>=r.minEdgeAdvantage-EPS
    &&row.expectedValue-leader.expectedValue>=r.minExpectedValueAdvantage-EPS
    &&row.odds<=r.maxOdds+EPS
    &&favoriteProbability<=r.maxFavoriteProbability+EPS;
}
function qualifiedUpset(row,leader){
  const r=RULES.upset;
  return row.modelProbability>=r.minProbability
    &&row.leaderDeficit<=r.maxLeaderDeficit+EPS
    &&row.probabilityEdge>=r.minEdge-EPS
    &&row.expectedValue>=r.minExpectedValue-EPS
    &&row.probabilityEdge-leader.probabilityEdge>=r.minEdgeAdvantage-EPS
    &&row.expectedValue-leader.expectedValue>=r.minExpectedValueAdvantage-EPS
    &&row.odds<=r.maxOdds+EPS;
}
function selectHadDirection(probabilitiesInput,quoteOddsInput){
  const probabilities=normalize(probabilitiesInput),quoteOdds=oddsVector(quoteOddsInput);
  if(!probabilities||!quoteOdds)return null;
  const fair=devig(quoteOdds),leaderCode=uniqueTop(probabilities);
  if(!leaderCode)return null;
  const favorites=favoriteCodes(fair);
  const all=Object.fromEntries(CODES.map(code=>[code,metrics(probabilities,quoteOdds,fair,code,leaderCode)]));
  const leader=all[leaderCode];
  const overrides=[];
  for(const code of CODES){
    if(code===leaderCode)continue;
    const row=all[code],role=marketRole(code,favorites);
    if(code==='X'&&qualifiedDraw(row,leader,fair)){
      overrides.push({...row,category:'balanced-draw',marketRole:role,
        edgeAdvantage:row.probabilityEdge-leader.probabilityEdge,expectedValueAdvantage:row.expectedValue-leader.expectedValue});
    }else if(code!=='X'&&role==='nonfavorite'&&qualifiedUpset(row,leader)){
      overrides.push({...row,category:'upset-signal',marketRole:role,
        edgeAdvantage:row.probabilityEdge-leader.probabilityEdge,expectedValueAdvantage:row.expectedValue-leader.expectedValue});
    }
  }
  overrides.sort((a,b)=>b.edgeAdvantage-a.edgeAdvantage||b.expectedValueAdvantage-a.expectedValueAdvantage
    ||b.modelProbability-a.modelProbability||CODES.indexOf(a.code)-CODES.indexOf(b.code));
  const selected=overrides[0]||null,tipCode=selected?.code||leaderCode;
  return {
    version:VERSION,
    mode:selected?'market-edge-override':'model-leader',
    category:selected?.category||(marketRole(leaderCode,favorites)==='favorite'?'favorite-leader':leaderCode==='X'?'draw-leader':'nonfavorite-leader'),
    tipCode,
    modelLeaderCode:leaderCode,
    marketFavoriteCodes:favorites,
    marketRole:marketRole(tipCode,favorites),
    selected:{
      ...all[tipCode],
      edgeAdvantage:all[tipCode].probabilityEdge-leader.probabilityEdge,
      expectedValueAdvantage:all[tipCode].expectedValue-leader.expectedValue,
    },
    leader:structuredClone(leader),
    outcomes:Object.fromEntries(CODES.map(code=>[code,structuredClone(all[code])])),
    overrideCandidates:overrides.map(row=>({code:row.code,category:row.category,marketRole:row.marketRole,
      modelProbability:row.modelProbability,probabilityEdge:row.probabilityEdge,expectedValue:row.expectedValue,
      leaderDeficit:row.leaderDeficit,edgeAdvantage:row.edgeAdvantage,expectedValueAdvantage:row.expectedValueAdvantage})),
    thresholds:structuredClone(RULES),
    validation:'prospective-guarded-unvalidated',
  };
}
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
function validHadDirectionSelection(value,probabilities,quoteOdds){
  if(!value||value.version!==VERSION)return false;
  const expected=selectHadDirection(probabilities,quoteOdds);
  return Boolean(expected&&JSON.stringify(stable(expected))===JSON.stringify(stable(value)));
}
module.exports={VERSION,CODES,RULES,devig,uniqueTop,favoriteCodes,marketRole,selectHadDirection,validHadDirectionSelection};
