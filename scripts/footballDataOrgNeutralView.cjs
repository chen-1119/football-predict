'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const collector = require('./collectFootballDataOrgResearch.cjs');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const escape = value => String(value ?? '未核实').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
function teamHistory(matches, teamId, kickoff) {
  const accepted = matches.historyAccepted.filter(row => row.orderedProviderTeamIds.includes(teamId) && row.kickoff < kickoff);
  const acceptedIds = new Set(accepted.map(row => row.providerMatchId));
  const quarantine = matches.quarantined.filter(row => !row.attributionReliable || row.orderedProviderTeamIds.includes(teamId));
  const uncertain = quarantine.some(row => !row.attributionReliable || !row.kickoffReliable || row.status !== 'FINISHED');
  const excluded = matches.rows.filter(row => row.status === 'FINISHED' && !acceptedIds.has(row.id) && row.utcDate < kickoff && [row.homeTeam.id, row.awayTeam.id].includes(teamId)).map(row => ({ providerMatchId: row.id, kickoff: row.utcDate, missing: true }));
  const slots = [...accepted, ...excluded, ...quarantine.filter(row => row.kickoffReliable && row.kickoff < kickoff).map(row => ({ ...row, missing: true }))].sort((left, right) => Date.parse(right.kickoff) - Date.parse(left.kickoff)).slice(0, 5);
  return { teamId, scope: '本赛季本联赛；不含杯赛与其他赛事', complete: !uncertain && slots.length === 5 && slots.every(row => !row.missing), uncertain, slots: uncertain ? [] : slots };
}
function summarize(report, directory) {
  const leagues = report.competitions.map(competition => {
    if (!competition.sourceReceipts) return { code: competition.code, status: competition.status, reason: competition.reason, fixtures: [], standings: [] };
    const receipt = competition.sourceReceipts.find(item => new URL(item.url).pathname.endsWith('/matches'));
    if (!receipt || !/^\d{3}\.body$/.test(receipt.rawName)) throw Error('MATCH_RECEIPT_MISSING');
    const raw = fs.readFileSync(path.join(directory, receipt.rawName));
    if (sha(raw) !== receipt.sha256) throw Error('RAW_HASH_MISMATCH');
    const matches = collector.inspectMatches(JSON.parse(raw), competition.code, competition.season, Date.parse(receipt.receivedAt), report.config.businessDate);
    return { code: competition.code, status: competition.status, quarantined: matches.quarantined.length,
      standings: competition.standings, acceptedResults: matches.historyAccepted.length,
      fixtures: matches.discoveredFixtures.map(fixture => ({ ...fixture, injuries: '未采集；不能解释为无人伤停', lineups: '未核实', histories: fixture.orderedProviderTeamIds.map(teamId => teamHistory(matches, teamId, fixture.kickoff)) })) };
  });
  return { schema: 'neutral-sports-data-v1', businessDate: report.config.businessDate, collectedAt: report.finishedAt, startedAt: report.startedAt, requests: report.requests,
    complete: report.ok, leagues, missing: ['K 联赛、J 联赛、澳超、挪超不在此免费采集范围', '近况仅本赛季本联赛，缺独立第二来源和跨赛事近况', '伤停、停赛及确认首发尚未自动采集', '未与官方赛程逐场完成球队 ID、主客顺序及开球时间绑定'], source: 'football-data.org', publicationWrites: 0 };
}
function render(data, reportSha256, observedAt = new Date().toISOString()) {
  const fixtures = data.leagues.flatMap(league => league.fixtures.map(fixture => ({ ...fixture, league: league.code })));
  const stale = Date.parse(observedAt) - Date.parse(data.collectedAt) > 2 * 3600000;
  const history = item => item.uncertain ? '排序未核实' : item.slots.map(row => row.missing ? '缺失/隔离' : `${row.kickoff.slice(0, 10)} ${row.orderedProviderTeamIds.join('—')} ${row.score.join(':')}`).join('；');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>生产体育数据核验</title><style>body{font:16px/1.6 system-ui;margin:30px;color:#172b4d;background:#f5f7fb}main{max-width:1400px;margin:auto}section{background:white;padding:20px;margin:18px 0;border-radius:12px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #d9e1ed;padding:9px;text-align:left}h1{margin:0}.warn{color:#a23a00}small{overflow-wrap:anywhere}summary{cursor:pointer;font-weight:600}</style><main><h1>生产体育数据核验</h1><p>独立采集服务 · 只读实时回执 · 不生成投注或预测 · 不修改历史原件</p><section><b>${escape(data.businessDate)}：${fixtures.length} 场来源赛程，${data.leagues.length} 个联赛，${data.requests} 次请求</b><p>采集完成：${escape(data.collectedAt)} · 页面读取：${escape(observedAt)}</p><p class="warn">${stale ? '数据已超 2 小时，需检查自动采集。' : '数据时效在 2 小时内。'} ${data.complete ? '本轮结构校验通过，仍非独立交叉核验。' : '部分数据冲突或缺失，不能声称完整。'}</p><small>原报告 SHA-256：${escape(reportSha256)}</small><ul>${data.missing.map(item => `<li>${escape(item)}</li>`).join('')}</ul></section><section><h2>今日赛程与球队近况</h2><p>时间为北京时间；近况比分按主队—客队顺序，数字为来源球队 ID。近 5 场仅限本赛季本联赛，缺失占位不会用第 6 场顶替。</p><table><tr><th>联赛 / 来源场次</th><th>开球 / 状态</th><th>主队 — 客队</th><th>近况与积分</th><th>伤停 / 首发</th></tr>${fixtures.map(fixture => `<tr><td>${escape(fixture.league)} / ${fixture.providerMatchId}</td><td>${escape(new Date(fixture.kickoff).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }))}<br>${escape(fixture.status)}</td><td>${escape(fixture.names.join(' — '))}</td><td>${fixture.histories.map((item, index) => { const standing = data.leagues.find(league => league.code === fixture.league).standings.find(row => row.providerTeamId === item.teamId); return `<details><summary>${index ? '客' : '主'}：${standing ? `第 ${standing.rank} 名 / ${standing.points} 分 / ${standing.played} 场` : '积分未核实'}；近 5 ${item.complete ? '来源记录齐全' : '不完整'}</summary>${escape(history(item))}</details>`; }).join('')}</td><td>${escape(fixture.injuries)}<br>首发：${escape(fixture.lineups)}</td></tr>`).join('')}</table></section><section><h2>联赛数据与完整积分表</h2>${data.leagues.map(league => `<details><summary>${escape(league.code)}：${escape(league.status)}；隔离 ${league.quarantined ?? 0} 行；已接受赛果 ${league.acceptedResults ?? 0} 场</summary>${league.reason ? `<p>${escape(league.reason)}</p>` : ''}<table><tr><th>排名</th><th>球队</th><th>比赛</th><th>积分</th></tr>${league.standings.map(row => `<tr><td>${row.rank}</td><td>${escape(row.name)}</td><td>${row.played}</td><td>${row.points}</td></tr>`).join('')}</table></details>`).join('')}</section><p>Data provided by <a href="https://www.football-data.org/">football-data.org</a>。此页面不是现有网站的比赛详情页，也不代表数据已进入模型。</p></main></html>`;
}
module.exports = { sha, teamHistory, summarize, render };
