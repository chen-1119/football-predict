'use strict';

// Read-only public-page evidence capture. No cookies, challenge execution,
// redirects, source-store writes, or invented provider publication clocks.
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const {createHash} = require('node:crypto');
const {epochNanoseconds} = require('../src/services/prematchV3Clock.cjs');
const VERSION = 'prematch-ah-public-capture-v1';
const LANDING_URL = 'https://trade.500.com/jczq/?playid=312&g=2';
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_MATCHES = 24;
const sha = value => createHash('sha256').update(value).digest('hex');
const fail = code => Object.assign(new Error(code), {code});
const decodeEntities = text => String(text || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const plain = text => decodeEntities(String(text || '').replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style\b[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
function attrs(html) {
  return Object.fromEntries([...String(html).matchAll(/([a-z][\w-]*)\s*=\s*(["'])(.*?)\2/gi)]
    .map(match => [match[1].toLowerCase(), decodeEntities(match[3])]));
}
function allowedUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash) throw fail('AH_SOURCE_URL_REJECTED');
  if (url.href === LANDING_URL || (url.hostname === 'odds.500.com' && !url.search
    && /^\/fenxi\/yazhi-[1-9]\d*\.shtml$/.test(url.pathname))) return url.href;
  throw fail('AH_SOURCE_URL_REJECTED');
}
function blockedHtml(html) {
  return /__tst_status|Security Verification|captcha\.eo\.gtimg\.com|Protected by Tencent Cloud EdgeOne|确认您是真人|正在验证连接安全性|访问过于频繁|安全策略拦截/i.test(html);
}
function parseTradeFixtures(html) {
  if (blockedHtml(html)) return [];
  const fixtures = [], seen = new Map();
  for (const match of String(html).matchAll(/<tr\b([^>]*class\s*=\s*(["'])[^"']*\bbet-tb-tr\b[^"']*\2[^>]*)>([\s\S]*?)<\/tr>/gi)) {
    if(match[0].includes('\uFFFD')) continue;
    const a = attrs(match[1]), body = match[3];
    if (!/^[1-9]\d*$/.test(a['data-id'] || '') || !/^[1-9]\d*$/.test(a['data-fixtureid'] || '')) continue;
    const kickoffTime = `${a['data-matchdate']}T${a['data-matchtime']}:00+08:00`;
    if (epochNanoseconds(kickoffTime) === null) continue;
    const endpoints = [];
    for (const link of body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
      const href = attrs(link[1]).href;
      if (plain(link[2]) !== '亚' || !href) continue;
      try { endpoints.push(allowedUrl(new URL(href, LANDING_URL).href)); } catch { /* unapproved link is not followed */ }
    }
    const endpoint = [...new Set(endpoints)];
    if (endpoint.length !== 1 || !endpoint[0].endsWith(`yazhi-${a['data-fixtureid']}.shtml`)) continue;
    const fixture = {sourceMatchId:a['data-id'], fixtureId:a['data-fixtureid'], infoMatchId:a['data-infomatchid'] || null,
      homeTeamName:a['data-homesxname'] || null, awayTeamName:a['data-awaysxname'] || null,
      homeTeamId:a['data-homeid'] || null, awayTeamId:a['data-awayid'] || null,
      kickoffTime, asianHandicapUrl:endpoint[0]};
    const encoded = JSON.stringify(fixture);
    if (seen.has(fixture.sourceMatchId) && seen.get(fixture.sourceMatchId) !== encoded) throw fail('AH_FIXTURE_CONFLICT');
    if (!seen.has(fixture.sourceMatchId)) fixtures.push(fixture);
    seen.set(fixture.sourceMatchId, encoded);
    if (fixtures.length > MAX_MATCHES) throw fail('AH_FIXTURE_LIMIT');
  }
  return fixtures;
}
function parseAsianHandicapFacts(html) {
  if (blockedHtml(html)) return {state:'blocked', reason:'source-security-challenge', rows:[]};
  const rows = [];
  for (const match of String(html).matchAll(/<tr\s+class=["']tr[12]["'][^>]*xls=["']row["'][\s\S]*?(?=<tr\s+class=["']tr[12]["'][^>]*xls=["']row["']|<\/table>\s*(?:<div|<\/div|$)|$)/gi)) {
    if(match[0].includes('\uFFFD')) continue;
    const block = match[0];
    const companyElement = [...block.matchAll(/<[^>]*\bclass=["'][^"']*\btb_plgs\b[^"']*["'][^>]*>/gi)]
      .map(item => attrs(item[0])).find(item => item.title);
    const lines = [...block.matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)]
      .map(item => ({attributes:attrs(item[1]), text:plain(item[2])}));
    const lineCells = lines.filter(item => Object.hasOwn(item.attributes, 'ref'));
    const waters = lines.filter(item => item.attributes.width === '58').map(item => item.text);
    if (!companyElement || lineCells.length !== 2 || waters.length !== 4) continue;
    const numeric = value => /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value) ? Number(value) : null;
    if ([...waters, ...lineCells.map(item => item.attributes.ref)].some(value => numeric(value) === null)) continue;
    rows.push({company:companyElement.title,
      current:{pageLineText:lineCells[0].text, pageRefValue:numeric(lineCells[0].attributes.ref),
        rawHomeWater:numeric(waters[0]), rawAwayWater:numeric(waters[1])},
      initial:{pageLineText:lineCells[1].text, pageRefValue:numeric(lineCells[1].attributes.ref),
        rawHomeWater:numeric(waters[2]), rawAwayWater:numeric(waters[3])},
      providerObservedAt:null, oddsFormat:null, homeLineConvention:null,
      sourceClaim:'page-labelled-initial-and-current', completeTimeline:false, formalEligible:false});
    if (rows.length > 200) throw fail('AH_COMPANY_LIMIT');
  }
  return {state:rows.length ? 'partial' : 'unavailable', reason:rows.length
    ? 'provider-clock-odds-format-and-signed-home-convention-unverified' : 'asian-table-not-present', rows};
}
function fetchPage(value, {request=https.request, now=()=>new Date().toISOString(), timeoutMs=15000, maxBytes=MAX_BYTES}={}) {
  const url = allowedUrl(value);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000 || !Number.isSafeInteger(maxBytes)
    || maxBytes < 1 || maxBytes > MAX_BYTES) return Promise.reject(fail('AH_REQUEST_BUDGET'));
  const startedAt = now();
  if (epochNanoseconds(startedAt) === null) return Promise.reject(fail('AH_CLOCK'));
  return new Promise((resolve,reject) => {
    let req, res, complete=false, count=0;
    const chunks=[];
    const finish = (error, result) => {
      if (complete) return; complete=true; clearTimeout(deadline);
      if (error) { req?.destroy(); res?.destroy(); reject(error); } else resolve(result);
    };
    const deadline=setTimeout(()=>finish(fail('AH_SOURCE_TIMEOUT')),timeoutMs);
    try {
      req=request(url,{method:'GET',headers:{'User-Agent':'football-predict/1.0 (public-page collector)',
        Accept:'text/html,application/xhtml+xml','Accept-Encoding':'identity'}},response=>{
        res=response;
        if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') return finish(fail('AH_COMPRESSED_RESPONSE'));
        if (Number(res.headers['content-length']) > maxBytes) return finish(fail('AH_SOURCE_TOO_LARGE'));
        res.on('error',()=>finish(fail('AH_SOURCE_STREAM_ERROR')));
        res.on('aborted',()=>finish(fail('AH_SOURCE_TRUNCATED')));
        res.on('data',chunk=>{
          const bytes=Buffer.from(chunk); count+=bytes.length;
          if (count > maxBytes) return finish(fail('AH_SOURCE_TOO_LARGE'));
          chunks.push(bytes);
        });
        res.on('end',()=>{
          const receivedAt=now(), body=Buffer.concat(chunks);
          if (epochNanoseconds(receivedAt) === null || epochNanoseconds(receivedAt) < epochNanoseconds(startedAt)) return finish(fail('AH_CLOCK'));
          finish(null,{url,startedAt,receivedAt,statusCode:res.statusCode || 0,bytes:body.length,
            rawPayloadHash:sha(body),rawBase64:body.toString('base64'),body});
        });
        res.on('close',()=>{if(!res.complete && !complete) finish(fail('AH_SOURCE_TRUNCATED'));});
      });
      req.on('error',()=>finish(fail('AH_SOURCE_NETWORK_ERROR'))); req.end();
    } catch { finish(fail('AH_SOURCE_NETWORK_ERROR')); }
  });
}
function captureState(page, kind) {
  const html=new TextDecoder('gbk').decode(page.body);
  const replacementCount=[...html.matchAll(/\uFFFD/g)].length;
  const facts=kind === 'asian' ? parseAsianHandicapFacts(html) : null;
  const state=page.statusCode !== 200 ? 'blocked' : blockedHtml(html) ? 'blocked' : facts?.state || (replacementCount ? 'partial' : 'available');
  return {capture:{...page,body:undefined,state,decodedEncoding:'gbk',decodingReplacementCount:replacementCount,
    completeDecodedPage:replacementCount === 0,reason:page.statusCode !== 200 ? `source-http-${page.statusCode}`
    : blockedHtml(html) ? 'source-security-challenge' : facts?.reason || (replacementCount ? 'source-text-encoding-partial' : null)},html,facts};
}
async function collectAsianHandicapPages({input, fetch=fetchPage, now=()=>new Date().toISOString()}={}) {
  if (!input || !Array.isArray(input.matches) || input.matches.length > MAX_MATCHES) throw fail('AH_ONLINE_INPUT');
  const startedAt=now(), captures=[], fixtures=[];
  const landing=captureState(await fetch(LANDING_URL), 'landing'); captures.push(landing.capture);
  const sourceFixtures=['available','partial'].includes(landing.capture.state) ? parseTradeFixtures(landing.html) : [];
  let sourceBlocked=false;
  for (const target of input.matches) {
    const sourceMatchId=String(target.sourceMatchId || target.id || '').replace(/^sporttery_/,'');
    const sameId=sourceFixtures.filter(row=>row.sourceMatchId === sourceMatchId);
    const matched=sameId.length === 1 && epochNanoseconds(sameId[0].kickoffTime) === epochNanoseconds(target.kickoffTime);
    if (!matched) {
      fixtures.push({sourceMatchId,state:'unavailable',reason:!['available','partial'].includes(landing.capture.state)
        ? landing.capture.reason : sameId.length ? 'fixture-kickoff-conflict' : 'current-public-fixture-missing',rows:[]}); continue;
    }
    const fixture={...sameId[0],targetIdentity:{sourceMatchId,homeTeamId:target.homeTeamId || null,awayTeamId:target.awayTeamId || null,
      homeTeamName:target.homeTeamName || null,awayTeamName:target.awayTeamName || null,kickoffTime:target.kickoffTime},
      eventBinding:{method:'same-source-match-id-and-kickoff',teamIdentityVerified:false,
        reason:'provider-team-id-namespace-needs-explicit-entity-mapping'}};
    if(sourceBlocked){
      fixtures.push({...fixture,state:'blocked',reason:'source-host-blocked-after-first-page',requestSkipped:true,rows:[]});continue;
    }
    try {
      const asian=captureState(await fetch(fixture.asianHandicapUrl),'asian'); captures.push(asian.capture);
      sourceBlocked=asian.capture.state === 'blocked';
      fixtures.push({...fixture,captureHash:asian.capture.rawPayloadHash,receivedAt:asian.capture.receivedAt,
        state:asian.capture.state,reason:asian.capture.reason,rows:asian.facts.rows});
    } catch(error) { fixtures.push({...fixture,state:'failed',reason:error.code || 'AH_COLLECTION_FAILED',rows:[]}); }
  }
  const body={version:VERSION,startedAt,finishedAt:now(),inputGeneration:input.generation || null,
    onlineInputObservedAt:input.observedAt || null,onlineInputBinding:{version:input.version || null,
      remoteResponseSha256:input.transport?.remoteResponseSha256 || null},
    productionWrites:0,formalEligible:false,predictionEligible:false,
    captures,fixtures,asianHandicapObservations:[],completeTimeline:false,
    retryPolicy:sourceBlocked ? {blockedHost:'odds.500.com',recommendedBackoffSeconds:21600,
      sourceAccessResolutionRequired:true,automaticRetryPerformed:false} : null,
    summary:{targets:input.matches.length,matchedFixtures:fixtures.filter(row=>row.fixtureId).length,
      capturedCurrentInitial:fixtures.filter(row=>row.rows.length).length,blocked:fixtures.filter(row=>row.state === 'blocked').length,
      failed:fixtures.filter(row=>row.state === 'failed').length,requestedPages:captures.length,
      skippedAfterBlocked:fixtures.filter(row=>row.requestSkipped).length,eligibleV3Observations:0}};
  return {...body,contentHash:sha(JSON.stringify(body))};
}
async function main() {
  if (!/^v22\./.test(process.version)) throw fail('AH_NODE22_REQUIRED');
  const values={};
  for(let i=2;i<process.argv.length;i+=2){
    const key=process.argv[i],value=process.argv[i+1];
    if(!['--input','--output'].includes(key)||values[key]||!value||value.startsWith('--')) throw fail('AH_ARGS');
    values[key]=value;
  }
  if(!values['--input']||!values['--output']) throw fail('AH_ARGS');
  const inputPath=path.resolve(values['--input']), output=path.resolve(values['--output']);
  if(fs.existsSync(output)||!fs.statSync(path.dirname(output)).isDirectory()) throw fail('AH_NEW_OUTPUT_REQUIRED');
  const input=JSON.parse(fs.readFileSync(inputPath,'utf8'));
  const rawPath=path.resolve(path.dirname(inputPath),input.transport?.remoteResponseFile || '');
  if(path.dirname(rawPath)!==path.dirname(inputPath)) throw fail('AH_INPUT_RAW_PATH');
  const {verifyOnlineRead}=require('./readPrematchV3OnlineInputs.cjs');
  if(!verifyOnlineRead(input,{date:input.businessDate,rawResponse:fs.readFileSync(rawPath)})) throw fail('AH_INPUT_BINDING');
  const result=await collectAsianHandicapPages({input});
  fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({output,...result.summary,productionWrites:0,formalEligible:false,contentHash:result.contentHash}));
}
module.exports={VERSION,LANDING_URL,MAX_BYTES,MAX_MATCHES,allowedUrl,blockedHtml,parseTradeFixtures,parseAsianHandicapFacts,
  fetchPage,captureState,collectAsianHandicapPages};
if(require.main===module) main().catch(error=>{console.error(error.code || 'AH_COLLECTION_FAILED');process.exitCode=1;});
