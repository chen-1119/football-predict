'use strict';
const assert = require('node:assert/strict');

function shanghaiInstant(year, month, day, hour, minute) {
  const parts = [year, month, day, hour, minute].map(Number);
  if (!parts.every(Number.isInteger)) return null;
  [year, month, day, hour, minute] = parts;
  if (year < 0 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  const wall = new Date(0);
  wall.setUTCFullYear(year, month - 1, day);
  wall.setUTCHours(hour, minute, 0, 0);
  // Reject calendar rollover before converting the displayed Beijing time.
  if (wall.getUTCFullYear() !== year || wall.getUTCMonth() !== month - 1 || wall.getUTCDate() !== day) return null;
  return new Date(wall.getTime() - 8 * 3600000).toISOString();
}

function normalizeLeagueRows(rows, sourceUrl) {
  if (!Array.isArray(rows) || typeof sourceUrl !== 'string' ||
      !/^https:\/\/www\.leisu\.com\/data\/zuqiu\/comp-[1-9]\d*$/.test(sourceUrl) || /\s/.test(sourceUrl)) return [];
  const candidates = [];
  for (const row of rows) {
    if (!row || typeof row.text !== 'string' || typeof row.href !== 'string') continue;
    const values = row.text.split(/\r?\n/).map(x => x.trim()).filter(x => x && !/^\[\d+\]$/.test(x));
    const date = /^(\d{2})\/(\d{2})\/(\d{2})$/.exec(values[0] || '');
    const time = /^(\d{2}):(\d{2})$/.exec(values[1] || '');
    const link = /^https:\/\/live\.leisu\.com\/shujufenxi-([1-9]\d*)$/.exec(row.href);
    // Actual upcoming fixture rows: date, time, home, vs, away, -, 分析, 直播, 历史.
    if (!link || link[0] !== row.href || !date || !time || values.length !== 9 ||
        values[3] !== 'vs' || !values[2] || !values[4] || values[2] === values[4] ||
        values[5] !== '-' || values[6] !== '分析' || values[7] !== '直播' || values[8] !== '历史') continue;
    const kickoffUtc = shanghaiInstant(2000 + Number(date[1]), date[2], date[3], time[1], time[2]);
    if (!kickoffUtc) continue;
    candidates.push({providerMatchId:link[1],homeName:values[2],awayName:values[4],kickoffUtc,sourceUrl});
  }
  return candidates;
}

// Read only DOM nodes actually rendered by the normal page. No cookies, runtime
// stores, signature emulation, intercepted responses or anti-detection patches.
function readRenderedDocument() {
  const visible = e => e && e.getClientRects().length > 0;
  const text = e => e?.innerText?.trim() || '';
  const cleanName = value => value.replace(/^\[[^\]]+\]\s*/, '').replace(/\s*\[[^\]]+\]$/, '').trim();
  const team = (analysisSelector, detailSelector) => {
    const e = document.querySelector(analysisSelector) || document.querySelector(detailSelector);
    return { name: cleanName(text(e)), href: e?.href || e?.querySelector('a')?.href || '' };
  };
  const home = team('.first-team .team-name-wrapper', '.team-home .name a');
  const away = team('.second-team .team-name-wrapper', '.team-away .name a');
  const headerText = text(document.querySelector('.team-center'));
  const injuryTables = Array.from(document.querySelectorAll('table')).filter(t => visible(t) &&
    text(t).includes('影响场数') && text(t).includes('归队时间')).map(table => ({
    teamName: cleanName(text(table.closest('.box-panel')?.querySelector('a[href*="team-"]'))),
    rows: Array.from(table.querySelectorAll('tr')).filter(row => row.querySelector('a[href*="player-"]')).map(row => {
      const a = row.querySelector('a[href*="player-"]');
      return {name:text(a),href:a.href,cells:Array.from(row.cells).map(text)};
    })
  }));
  const lineupRoot = document.querySelector('.children.lineup');
  const lineups = Array.from(document.querySelectorAll('.children.lineup ul.list')).filter(visible).map(list => {
    const parent = list.parentElement;
    const firstIcon = list.querySelector('a.user-icon[id]');
    const side = firstIcon?.id.startsWith('home') ? 'home' : firstIcon?.id.startsWith('away') ? 'away' : null;
    const description = text(parent).split('\n').map(s=>s.trim()).filter(Boolean);
    const result = {side,name:description[0] || '',formation:null,coach:null,starters:[],substitutes:[]};
    result.formation = description.find(s=>s.includes('阵型'))?.split(':')[0].trim() || null;
    result.coach = description.find(s=>s.includes('教练'))?.split(':')[0].trim() || null;
    let bench = false;
    for (const row of Array.from(list.children)) {
      if (text(row) === '替补阵容') {bench=true;continue;}
      const a = row.querySelector('a.name');
      if (!a) continue;
      result[bench?'substitutes':'starters'].push({id:/player-(\d+)$/.exec(a.href)?.[1] || null,
        name:text(a),jersey:text(row.querySelector('span.numb'))});
    }
    return result;
  });
  const loginVisible = Array.from(document.querySelectorAll('a,button')).some(e=>visible(e)&&/^登录$/.test(text(e)));
  const shortPageText = text(document.body).slice(0,1500);
  return {url:location.href,title:document.title,home,away,headerText,injuryTables,lineups,loginVisible,
    lineupText:visible(lineupRoot)?text(lineupRoot).slice(0,200):'',
    errorText:(!home.name || !away.name)?shortPageText:''};
}

function classifyView(view, task, httpStatus) {
  if (!view || typeof view !== 'object' || !task || typeof task !== 'object' || !task.fixture || typeof task.fixture !== 'object') {
    return {status:'parse_error',data:null,reason:'invalid-view-or-task'};
  }
  if ([401,403,405,429].includes(httpStatus) || /\/403(?:$|[/?#])/.test(view.url) ||
      /^(?:403|405|ERROR\s*403)|Forbidden|访问被阻断|访问被拦截|访问验证/i.test(view.title+' '+view.errorText)) {
    return {status:'blocked',data:null,reason:'source-block-page'};
  }
  if(!Number.isInteger(httpStatus)||httpStatus<200||httpStatus>=300) return {status:'parse_error',data:null,reason:'non-success-http-status'};
  let expected, actual;
  try { expected = new URL(task.sourceUrl); actual = new URL(view.url); }
  catch { return {status:'parse_error',data:null,reason:'invalid-source-url'}; }
  if(actual.origin!==expected.origin || actual.pathname!==expected.pathname) return {status:'conflict',data:null,reason:'unexpected-source-url'};
  if(!view.home?.name || !view.away?.name) return {status:view.loginVisible?'login_required':'parse_error',data:null,reason:'missing-match-header'};
  const date = /(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/.exec(typeof view.headerText === 'string' ? view.headerText : '');
  const kickoffUtc = date ? shanghaiInstant(date[1],date[2],date[3],date[4],date[5]) : null;
  if(!kickoffUtc) return {status:'parse_error',data:null,reason:'invalid-source-kickoff'};
  const providerHome=task.providerHomeName || task.fixture.homeName;
  const providerAway=task.providerAwayName || task.fixture.awayName;
  if(view.home.name!==providerHome || view.away.name!==providerAway || kickoffUtc!==task.fixture.kickoffUtc) {
    return {status:'conflict',data:null,reason:'source-team-or-kickoff-mismatch'};
  }
  const data = {providerMatchId:task.providerMatchId,homeName:task.fixture.homeName,awayName:task.fixture.awayName,
    sourceHomeName:view.home.name,sourceAwayName:view.away.name,kickoffUtc,sourcePublishedAt:null};
  if(task.kind==='injuries') {
    if(!Array.isArray(view.injuryTables) || view.injuryTables.length!==2) return {status:'parse_error',data:null,reason:'injury-tables-not-complete'};
    data.injuries=[];
    const sides=new Set();
    for(const table of view.injuryTables) {
      if(!table || !Array.isArray(table.rows)) return {status:'parse_error',data:null,reason:'invalid-injury-table'};
      const side=table.teamName===providerHome?'home':table.teamName===providerAway?'away':null;
      if(!side || sides.has(side)) return {status:'conflict',data:null,reason:'injury-team-mismatch'};
      sides.add(side);
      for(const row of table.rows) {
        if(!row || !Array.isArray(row.cells)) return {status:'parse_error',data:null,reason:'invalid-injury-row'};
        const id=/player-(\d+)$/.exec(row.href)?.[1];
        if(!id || !row.name || row.cells.length!==6 || !row.cells[2]) return {status:'parse_error',data:null,reason:'invalid-injury-row'};
        data.injuries.push({side,name:row.name,providerPlayerId:id,reasonAsDisplayed:row.cells[2],
          positionAsDisplayed:row.cells[1]||null,returnDateAsDisplayed:row.cells[4]||null});
      }
    }
    return data.injuries.length ? {status:'available',data} : {status:'source_empty',data:null,reason:'source-has-no-injury-rows'};
  }
  if(task.kind!=='lineup') return {status:'parse_error',data:null,reason:'unsupported-observation-kind'};
  if(!Array.isArray(view.lineups)) return {status:'parse_error',data:null,reason:'invalid-lineup-list'};
  if(!view.lineups.length && /暂无数据/.test(view.lineupText)) return {status:'source_empty',data:null,reason:'source-lineup-empty'};
  if(view.lineups.length!==2) return {status:'parse_error',data:null,reason:'lineup-not-complete'};
  data.teams=view.lineups;
  const ids=new Set(), sides=new Set();
  for(const team of data.teams) {
    if(!team || !Array.isArray(team.starters) || !Array.isArray(team.substitutes)) return {status:'parse_error',data:null,reason:'invalid-lineup-team'};
    if(!['home','away'].includes(team.side)||sides.has(team.side)||team.name!==(team.side==='home'?providerHome:providerAway)) return {status:'conflict',data:null,reason:'lineup-team-mismatch'};
    sides.add(team.side);
    if(team.starters.length!==11) return {status:'parse_error',data:null,reason:'incomplete-starting-eleven'};
    for(const p of [...team.starters,...team.substitutes]) {
      if(!p||!/^\d+$/.test(p.id||'')||!p.name||!p.jersey||ids.has(p.id)) return {status:'parse_error',data:null,reason:'invalid-or-duplicate-lineup-player'};
      ids.add(p.id);
    }
  }
  data.teams=data.teams.map(team=>({...team,sourceName:team.name,name:team.side==='home'?data.homeName:data.awayName}));
  return {status:'available',data};
}

async function openBrowser(profileDir,headless=true) {
  const {chromium}=require('playwright');
  const context=await chromium.launchPersistentContext(profileDir,{headless,locale:'zh-CN',timezoneId:'Asia/Shanghai',
    viewport:{width:1440,height:1000},timeout:30000});
  // Establish the site's normal visitor session before opening deep links.
  // Production returns 405 for a fresh direct league navigation, whereas
  // navigating from the public home page initializes the required session.
  try {
    const page=await context.newPage();
    try {
      await page.goto('https://www.leisu.com/',{waitUntil:'load',timeout:30000});
      await page.waitForLoadState('networkidle',{timeout:5000}).catch(()=>{});
    }
    finally { await page.close(); }
    return context;
  } catch(error) { await context.close().catch(()=>{});throw error; }
}

async function collectTask(context,task) {
  assert.ok(['injuries','lineup'].includes(task.kind));
  assert.match(task.providerMatchId,/^\d+$/);
  const canonical=`https://live.leisu.com/${task.kind==='injuries'?'shujufenxi':'detail'}-${task.providerMatchId}`;
  assert.equal(task.sourceUrl,canonical);
  const page=await context.newPage();
  try {
    const response=await page.goto(task.sourceUrl,{waitUntil:'domcontentloaded',timeout:30000});
    const httpStatus=response?.status()||0;
    if(![401,403,405,429].includes(httpStatus)) {
      await page.locator('.team-center').first().waitFor({state:'visible',timeout:15000}).catch(()=>{});
      if(task.kind==='lineup' && await page.getByText('球队阵容',{exact:true}).count()) {
        await page.getByText('球队阵容',{exact:true}).click({timeout:10000});
        await page.locator('.children.lineup').waitFor({state:'visible',timeout:15000}).catch(()=>{});
        await page.waitForFunction(()=>document.querySelectorAll('.children.lineup ul.list').length===2 ||
          /暂无数据/.test(document.querySelector('.children.lineup')?.innerText||''),{},{timeout:15000}).catch(()=>{});
      }
      if(task.kind==='injuries') await page.waitForFunction(()=>Array.from(document.querySelectorAll('table')).filter(t=>t.innerText.includes('影响场数')).length===2,{},{timeout:15000}).catch(()=>{});
    }
    const view=await page.evaluate(readRenderedDocument);
    return {receivedAt:new Date().toISOString(),httpStatus,...classifyView(view,task,httpStatus)};
  } catch(error) {
    return {receivedAt:new Date().toISOString(),status:'parse_error',data:null,reason:error.name==='TimeoutError'?'page-timeout':'page-read-failed'};
  } finally {await page.close();}
}

async function collectLeague(context,sourceUrl) {
  assert.match(sourceUrl,/^https:\/\/www\.leisu\.com\/data\/zuqiu\/comp-[1-9]\d*$/);
  let page,httpStatus=0;
  const result=(status,reason,candidates=[])=>({receivedAt:new Date().toISOString(),httpStatus,status,reason,candidates});
  try{
    page=await context.newPage();
    const response=await page.goto(sourceUrl,{waitUntil:'domcontentloaded',timeout:30000});
    httpStatus=response?.status()||0;
    // An unreadable error document must not erase the authoritative HTTP code.
    if([401,403,405,429].includes(httpStatus))return result('blocked','source-block-page');
    if(httpStatus<200||httpStatus>=300)return result('parse_error','non-success-http-status');
    const title=await page.title();
    if(/^(?:403|405|ERROR\s*403)|Forbidden|访问被阻断|访问被拦截|访问验证/i.test(title)||/\/403(?:$|[/?#])/.test(page.url()))return result('blocked','source-block-page');
    if(/\/login(?:$|[/?#])/.test(page.url())||/登录|sign\s*in|log\s*in/i.test(title))return result('login_required','source-login-page');
    if(page.url()!==sourceUrl)return result('conflict','unexpected-source-url');
    // The public HTML contains the fixture rows. Hydration can erase them
    // when a later optional API request fails. Parse that actual response
    // without executing scripts; fixture identity and kickoff checks still apply.
    const html=await response.text();
    if(html.length<=4*1024*1024){
      const initialRows=await page.evaluate(html=>Array.from(new DOMParser().parseFromString(html,'text/html').querySelectorAll('tr, .tr'))
        .filter(r=>r.querySelector('a[href*="shujufenxi-"]')).map(r=>({cells:Array.from(r.children).map(c=>c.textContent.trim()),
          href:r.querySelector('a[href*="shujufenxi-"]').getAttribute('href')})),html);
      const initialCandidates=normalizeLeagueCells(initialRows,sourceUrl);
      if(initialCandidates.length)return result('available',null,initialCandidates);
    }
    await page.locator('a[href*="shujufenxi-"]').first().waitFor({state:'visible',timeout:15000}).catch(()=>{});
    const rows=await page.evaluate(()=>Array.from(document.querySelectorAll('tr, .tr')).filter(r=>r.getClientRects().length>0&&r.querySelector('a[href*="shujufenxi-"]')).map(r=>({text:r.innerText,href:r.querySelector('a[href*="shujufenxi-"]').href})));
    if(!Array.isArray(rows)||!rows.length)return result('parse_error','league-rows-missing');
    const candidates=normalizeLeagueRows(rows,sourceUrl);
    return candidates.length?result('available',null,candidates):result('parse_error','invalid-league-rows');
  }catch(error){return result('parse_error',error?.name==='TimeoutError'?'page-timeout':'page-read-failed');}
  finally{if(page)await page.close().catch(()=>{});}
}

function normalizeLeagueCells(rows,sourceUrl){
  if(!Array.isArray(rows))return [];
  const normalized=[];
  for(const row of rows){
    const c=row?.cells;if(!Array.isArray(c)||c.length!==6||c.some(x=>typeof x!=='string'))continue;
    const time=/^(\d{2}\/\d{2}\/\d{2})\s*(\d{2}:\d{2})$/.exec(c[0]);
    if(!time||c[2]!=='vs'||c[4]!=='-'||!/^分析\s+直播\s+历史$/.test(c[5]))continue;
    const home=c[1].replace(/\[\d+\]/g,'').trim(),away=c[3].replace(/\[\d+\]/g,'').trim();
    normalized.push({href:row.href,text:[time[1],time[2],home,c[2],away,c[4],...c[5].split(/\s+/)].join('\n')});
  }
  return normalizeLeagueRows(normalized,sourceUrl);
}
module.exports={readRenderedDocument,classifyView,openBrowser,collectTask,collectLeague,normalizeLeagueRows,normalizeLeagueCells};
