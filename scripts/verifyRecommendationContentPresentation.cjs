const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'outputs', 'recommendation-ui-20260912');
const clone = value => JSON.parse(JSON.stringify(value));
const checks = [];
const check = (name, ok) => checks.push({ name, ok: Boolean(ok) });
const visibleText = html => html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const sourceAddress = /https?:\/\/|www\.|leisu\.com|500\.com|sporttery\.cn|audit-source\.example|\/srv\/collector|\\\\/i;

function makeFixtures() {
  const payload = JSON.parse(fs.readFileSync(path.join(root, 'public/data/matches-current.json'), 'utf8'));
  const seed = (Array.isArray(payload) ? payload : payload.matches).find(row => row.predictions?.length);
  assert.ok(seed, 'A real-shaped local match sample is required');
  const now = Date.now();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const make = (id, status, resultStatus) => {
    const match = clone(seed);
    const kickoff = new Date(now + (status === 'SCHEDULED' ? 3 : -4) * 3600000).toISOString();
    const capturedAt = new Date(Date.parse(kickoff) - 3600000).toISOString();
    const prediction = {
      marketType: 'BEST', oddsPoolCode: 'HAD', handicapLine: '0', tipCode: '2',
      tipLabel: { zh: '客胜', en: 'Away Win' }, odds: 2.45, trustScore: 43,
      recommendationAction: 'reference', recommendationTier: 'posterior-reference',
      explanation: { zh: '赛前分析来自 https://audit-source.example/match；阵容未公布，证据不足。', en: 'Pre-match analysis from https://audit-source.example/match; lineup missing and evidence incomplete.' },
      analysisItems: [{ zh: '500.com 赔率参考；关键阵容未知。', en: '500.com odds reference; key lineup unknown.' }],
      riskTags: [{ zh: '伤停信息不足', en: 'Injury information incomplete' }],
      visibilityStatus: 'FREE', resultStatus: resultStatus || 'PENDING',
    };
    Object.assign(match, {
      id: `sporttery_${id}`, sourceMatchId: String(id), eventVersion: kickoff, kickoffTime: kickoff,
      status, effectiveStatus: status, sourceStatus: status,
      homeTeamName: `样例主队${id}`, awayTeamName: `样例客队${id}`,
      homeTeamNameEn: `Sample Home ${id}`, awayTeamNameEn: `Sample Away ${id}`,
      homeTeamLogo: undefined, awayTeamLogo: undefined,
      businessDate: today, matchDate: today, kickoffDate: today,
      matchNo: `样例${id}`, sourceUrl: 'https://audit-source.example/collector',
      source: 'sporttery', sourceObservedAt: new Date(now - 60000).toISOString(),
      odds: { odds1: 2.80, oddsX: 3.20, odds2: 2.45 }, oddsSource: 'sporttery:had', oddsUpdatedAt: new Date(now - 60000).toISOString(),
      handicapOdds: { odds1: 5.30, oddsX: 3.90, odds2: 1.43 }, handicapLine: '-1', handicapOddsSource: 'sporttery:hhad',
      predictions: [prediction],
      predictionMeta: { generatedAt: capturedAt, cutoffTime: kickoff },
      archivedPreMatchPrediction: status === 'SCHEDULED' ? undefined : {
        version: 'archived-pre-match-prediction-v1', source: 'immutable-pre-match-prediction-snapshot',
        sourceMatchId: String(id), kickoffTime: kickoff, eventVersion: kickoff, capturedAt,
        cutoffTime: kickoff, marketEvidenceScope: 'result-pool', prediction: clone(prediction),
      },
      postMatchReview: resultStatus ? {
        predictionReview: { rows: [{ ...prediction, resultStatus, performanceTrack: 'reference', reviewRole: 'reference' }] },
      } : undefined,
      resultDisposition: undefined, resultProvenance: undefined, resultSource: undefined,
      resultUpdatedAt: undefined, externalSignals: undefined, gptPrediction: undefined,
      probabilityModel: undefined, liveRecommendation: undefined,
      scoreHome: status === 'FINISHED' ? (resultStatus === 'WON' ? 0 : 2) : undefined,
      scoreAway: status === 'FINISHED' ? (resultStatus === 'WON' ? 1 : 0) : undefined,
    });
    return match;
  };
  return [make(990001, 'SCHEDULED'), make(990002, 'FINISHED', 'WON'), make(990003, 'FINISHED', 'LOST'), make(990004, 'PENDING_RESULT')];
}

async function main() {
  const { createServer } = await import('vite');
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'football-content-ui-'));
  let vite;
  try {
    vite = await createServer({ root, configFile: false, cacheDir, plugins: [{ name: 'native-collector-diagnostics', enforce: 'pre',
        resolveId(id) { if (id === 'football-collector-diagnostics') return '\0test-native-diagnostics'; },
        load(id) {
          if (id !== '\0test-native-diagnostics') return;
          const file = path.join(root, 'src/services/apiFootballDiagnostics.cjs');
          const names = Object.keys(require(file));
          return "import { createRequire } from 'node:module'; const mod = createRequire(" + JSON.stringify(__filename) + ")(" + JSON.stringify(file) + ");\n" + names.map(name => 'export const ' + name + ' = mod.' + name + ';').join('\n');
        }
      }],
      appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
    const { PredictionsList } = await vite.ssrLoadModule('/src/pages/PredictionsList.tsx');
    const { MatchDetail } = await vite.ssrLoadModule('/src/pages/MatchDetail.tsx');
    const { AppContext } = await vite.ssrLoadModule('/src/context/AppContextCore.ts');
    const { MemoryRouter } = await import('react-router-dom');
    const { sourceNeutralText } = await vite.ssrLoadModule('/src/components/predictions/sourceNeutralText.ts');
    const fixtures = makeFixtures();
    const before = JSON.stringify(fixtures);
    const render = (element, matches = fixtures, language = 'zh') => renderToStaticMarkup(
      React.createElement(MemoryRouter, null, React.createElement(AppContext.Provider, { value: {
        language, matches, dataSync: { currentLoaded: true, historyLoaded: true, historyLoading: false,
          currentCount: matches.length, historyCount: 0, totalCount: matches.length, updatedAt: new Date().toISOString() },
      } }, element))
    );
    fs.mkdirSync(output, { recursive: true });
    const listHtml = render(React.createElement(PredictionsList, { viewMode: 'analysis', onSelectMatch() {} }));
    const listText = visibleText(listHtml);
    check('main list retains the fixture identities, selected SP and details action', fixtures.every(m => listText.includes(m.homeTeamName)) && listText.includes('2.45') && /详情/.test(listText));
    check('won and lost reference recommendations remain visible', /命中/.test(listText) && /未命中/.test(listText) && /参考/.test(listText));
    check('list has no source labels, confidence evidence, or model and collection dashboards', !/数据源状态|系统与模型说明|采集切换策略|500数据|500\.com|证据完整度|校准样本|模型概率|来源：/.test(listText));
    check('list never renders collection addresses', !sourceAddress.test(listText));
    check('compact page preserves actionable date and league controls', /date-toolbar/.test(listHtml) && /filters-panel/.test(listHtml) && /league-stack/.test(listHtml));
    const pendingHtml = render(React.createElement(PredictionsList, { viewMode: 'analysis', onSelectMatch() {} }), [fixtures[3]]);
    const pendingCard = pendingHtml.match(/<article[^>]*data-match-event-key=[\s\S]*?<\/article>/)?.[0] || pendingHtml;
    check('unsettled archived pick is pending and never given a won/lost badge', /待.*赛果|待结算|结算中|Awaiting/.test(visibleText(pendingCard)) && !/result-status[^>]*>[^<]*(?:命中|未命中)/.test(pendingCard));
    const fixtureHtml = render(React.createElement(PredictionsList, { viewMode: 'fixtures', onSelectMatch() {} }));
    check('fixtures route also retains SP without provider descriptions', visibleText(fixtureHtml).includes('2.45') && !/500\.com|来源：|数据源状态/.test(visibleText(fixtureHtml)));
    const details = {};
    for (const tab of ['overview', 'evidence', 'probability', 'history']) {
      const html = render(React.createElement(MatchDetail, { matchId: fixtures[0].id, initialTab: tab, onBack() {} }));
      details[tab] = html;
      check(`detail ${tab} has no visible provider address`, !sourceAddress.test(visibleText(html)));
    }
    check('confidence and freshness facts are in match analysis instead of its overview', details.evidence.includes('recommendation-evidence-breakdown') && !details.overview.includes('recommendation-evidence-breakdown') && visibleText(details.evidence).includes('数据与分析'));
    check('presentation changes leave raw provenance and frozen sample inputs unchanged', JSON.stringify(fixtures) === before && fixtures[0].sourceUrl.includes('audit-source.example'));
    if (typeof sourceNeutralText === 'function') {
      for (const text of ['来自 https://audit-source.example/private；未公布阵容', '500.com 数据不足，SP 2.45', 'www.leisu.com 缺少伤停', '源路径 /srv/collector/feed.json，等待更新', String.raw`源路径 \\collector-host\private\evidence.json；未公布阵容，SP 2.45`]) {
        const result = sourceNeutralText(text, 'zh');
        check(`source text redaction: ${text.split(' ')[0]}`, !sourceAddress.test(result));
      }
      check('redaction preserves meaningful odds and missing-data status', sourceNeutralText('500.com 数据不足，SP 2.45', 'zh').includes('2.45') && sourceNeutralText('500.com 数据不足，SP 2.45', 'zh').includes('数据不足'));
      check('UNC redaction removes the complete host and path while preserving player names and SP',
        sourceNeutralText(String.raw`源路径 \\collector-host\private\evidence.json；若昂·佩德罗伤停未取得，SP 2.45`, 'zh') === '源路径 赛前数据；若昂·佩德罗伤停未取得，SP 2.45');
    }
    fs.writeFileSync(path.join(output, 'fixtures.preview.json'), JSON.stringify({ sampleOnly: true, matches: fixtures }, null, 2));
    fs.writeFileSync(path.join(output, 'list-preview.fragment.html'), listHtml);
    for (const [tab, html] of Object.entries(details)) fs.writeFileSync(path.join(output, `detail-${tab}.fragment.html`), html);
    const result = { ok: checks.every(c => c.ok), checkedAt: new Date().toISOString(), sampleOnly: true, productionWritten: false, checks };
    fs.writeFileSync(path.join(output, 'presentation-checks.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } finally {
    await vite?.close();
    const resolved = path.resolve(cacheDir), allowed = path.resolve(os.tmpdir()) + path.sep;
    if (resolved.startsWith(allowed) && path.basename(resolved).startsWith('football-content-ui-')) fs.rmSync(resolved, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
