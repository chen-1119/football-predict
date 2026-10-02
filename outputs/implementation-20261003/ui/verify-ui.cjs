'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), http = require('node:http');
const crypto = require('node:crypto'), assert = require('node:assert/strict'), { execFileSync, spawnSync } = require('node:child_process');
const ts = require('typescript'), React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
const { chromium } = require('C:/Users/86188/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root = path.resolve(__dirname, '../../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const compile = (source, imports) => {
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX } }).outputText, { module, exports: module.exports, Date, Intl,
    require: id => id === 'react/jsx-runtime' ? require(id) : id.endsWith('.css') ? {} : imports(id) });
  return module.exports;
};
const fixtureFile = 'tests/fixtures/recommendation-detail-20260922.json';
const fixtureBytes = fs.readFileSync(path.join(root, fixtureFile)), fixture = JSON.parse(fixtureBytes);
const prior = JSON.parse(read('outputs/ui-trust-detail-20261002/source-evidence.json'));
assert.equal(sha(fixtureBytes), prior.preview.sha256);
const readBase = file => execFileSync('git', ['show', `295a173d117cb:${file}`], { cwd: root, encoding: 'utf8' });
const detail = compile(read('src/services/publishedDetailPresentation.ts'), () => ({}));
const label = compile(read('src/services/publishedMatchRecommendation.ts'), () => ({}));
const readiness = compile(read('src/services/recommendationReadinessPresentation.ts'), () => ({}));
const status = require(path.join(root, 'src/services/publishedRecommendationStatus.cjs'));
const imports = id => id.endsWith('/publishedDetailPresentation') ? detail : id.endsWith('/publishedMatchRecommendation') ? label
  : id.endsWith('/recommendationReadinessPresentation') ? readiness : id.endsWith('/publishedRecommendationStatus.cjs') ? status : {};
const current = compile(read('src/components/predictions/RecommendationEvidenceFacts.tsx'), imports).RecommendationEvidenceFacts;
const before = compile(readBase('src/components/predictions/RecommendationEvidenceFacts.tsx'), imports).RecommendationEvidenceFacts;
const render = (Component, match, decision, quality) => renderToStaticMarkup(React.createElement(Component,
  { match, language: 'zh', publishedDecision: decision, selectionQuality: quality, supplementaryModel: false }));
function page(body, phase, synthetic = false) {
  const style = read('src/styles/recommendation-evidence.css') + (phase === 'before'
    ? readBase('src/styles/published-evidence-snapshot.css') : read('src/styles/published-evidence-snapshot.css'));
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>推荐资格展示验收</title><style>:root{--bg-card:0 0% 100%;--text-primary:166 29% 19%;--text-muted:160 12% 35%;--text-secondary:160 12% 35%}*{box-sizing:border-box}body{margin:0;padding:16px;background:#f4f7f6;font:14px/1.6 system-ui,sans-serif;color:#233e36}main{max-width:940px;margin:auto}h1{font-size:22px}h2{font-size:18px}article{background:white;padding:20px;border:1px solid #d5e2dd;border-radius:14px;margin:16px 0;min-width:0}code{overflow-wrap:anywhere}${style}</style><main><h1>${synthetic ? '合成边界案例' : '线上冻结记录回放'} · ${phase === 'before' ? '改前' : '候选'}</h1><p>${synthetic ? '以下状态仅用于验证UI边界，不代表真实采集成功或模型晋级。' : '来源：2026年9月22日线上记录，输入已按既有回执哈希核验。并非今天的新推荐或登录后整页验收。'}</p>${body}</main></html>`;
}
for (const phase of ['before', 'after']) {
  const Component = phase === 'before' ? before : current;
  const body = fixture.fixtures.map(({ match, row }) => `<article><h2>${match.homeTeamName} vs ${match.awayTeamName}</h2>${render(Component, match, row.decision, row.selectionQuality)}</article>`).join('');
  fs.writeFileSync(path.join(__dirname, phase + '.html'), page(body, phase));
}
const d = { ...fixture.fixtures[0].row.decision, modelValidation: 'unvalidated' };
const scenarios = [
  { title: '合成：等待发布资料', decision: null, quality: null },
  { title: '合成：输入证据不足，保留冻结概率供参考', decision: d, quality: { status: 'watch', qualified: false,
    reasons: ['input-evidence-unavailable', 'team-samples-insufficient', 'internal=https://secret.test?token=DO_NOT_RENDER'] } },
  { title: '合成：参考筛选通过，正式资格仍未验证', decision: d, quality: { status: 'reference-qualified', qualified: true, reasons: [], expectedValue: .1 } },
];
fs.writeFileSync(path.join(__dirname, 'states.html'), page(scenarios.map(item => `<article><h2>${item.title}</h2>${render(current, {}, item.decision, item.quality)}</article>`).join(''), 'after', true));
const tests = spawnSync(process.execPath, ['--test', 'tests/recommendation-readiness-presentation.test.cjs', 'tests/published-evidence-snapshot.test.cjs', 'tests/prematch-collection-panel.test.cjs'], { cwd: root, encoding: 'utf8' });
fs.writeFileSync(path.join(__dirname, 'tests.txt'), tests.stdout + tests.stderr);
assert.equal(tests.status, 0, tests.stderr);
const sourceEvidence = { checkedAt: new Date().toISOString(), fixture: { file: fixtureFile, sha256: sha(fixtureBytes),
  observedAt: fixture.observedAt, source: fixture.source, decisionIds: fixture.fixtures.map(item => item.row.decision.decisionId),
  matchesPriorReceipt: true, currentOnlineCapture: false, sourceAuthenticity: prior.preview.sourceAuthenticity },
  tests: { runtime: process.version, passed: Number(/# pass (\d+)/.exec(tests.stdout)[1]), failed: 0 },
  scope: 'Production component with recorded inputs; synthetic alternate states separately labeled. Not an authenticated full-page or physical-phone acceptance.',
  productionWrites: 0, probabilitiesChanged: false, modelPromotionGranted: false };
fs.writeFileSync(path.join(__dirname, 'source-evidence.json'), JSON.stringify(sourceEvidence, null, 2) + '\n');
(async () => {
  const server = http.createServer((req, res) => {
    const name = (req.url || '').slice(1);
    if (!['before.html', 'after.html', 'states.html'].includes(name)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' }); res.end(fs.readFileSync(path.join(__dirname, name)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const checks = [], contrasts = [], errors = [];
  try {
    for (const width of [320, 390, 768, 1440]) {
      const tab = await browser.newPage({ viewport: { width, height: 844 } });
      tab.on('pageerror', error => errors.push(error.message));
      for (const name of ['before', 'after', 'states']) {
        await tab.goto(base + '/' + name + '.html');
        const audit = async state => {
          const sizes = await tab.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
            outside: [...document.querySelectorAll('main *')].filter(element => element.checkVisibility())
              .filter(element => { const box = element.getBoundingClientRect(); return box.left < -1 || box.right > innerWidth + 1; })
              .map(element => element.tagName + '.' + element.className) }));
          assert(sizes.scrollWidth <= width); assert.deepEqual(sizes.outside, []);
          checks.push({ page: name, width, state, ...sizes });
        };
        await audit('closed');
        if (name !== 'before') {
          const content = await tab.locator('main').innerText();
          assert(!content.includes('DO_NOT_RENDER')); assert(!content.includes('可发布推荐'));
          if (name === 'after') assert.equal(await tab.locator('[data-outcome]').count(), 6);
          else {
            assert.equal(await tab.locator('[data-display-stage="waiting-for-data"]').count(), 1);
            assert.equal(await tab.locator('[data-formal-status="model-unvalidated"]').count(), 2);
          }
          const contrast = await tab.evaluate(() => {
            const rgb = value => value.match(/[\d.]+/g).map(Number);
            const luminance = rgb => rgb.slice(0, 3).map(c => { const v = c / 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; })
              .reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0);
            return [...document.querySelectorAll('.published-evidence-readiness span,.published-evidence-readiness strong,.published-evidence-readiness b,.published-evidence-readiness p,.published-evidence-readiness li')]
              .filter(element => element.checkVisibility()).map(element => {
                let background = element;
                while (background && getComputedStyle(background).backgroundColor === 'rgba(0, 0, 0, 0)') background = background.parentElement;
                const foreground = getComputedStyle(element).color, bg = background ? getComputedStyle(background).backgroundColor : 'rgb(255,255,255)';
                const a = luminance(rgb(foreground)), b = luminance(rgb(bg));
                return { text: element.textContent.slice(0, 80), foreground, background: bg, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
              });
          });
          assert(contrast.every(item => item.ratio >= 4.5)); contrasts.push({ page: name, width, elements: contrast });
          const summary = tab.getByText('冻结版本与 SP 来源', { exact: true }).first();
          await summary.focus(); await tab.keyboard.press('Enter');
          await audit('keyboard-expanded');
          assert.equal(await tab.locator('.published-evidence-snapshot__version[open]').count(), 1);
          if ([390, 1440].includes(width)) await tab.screenshot({ path: path.join(__dirname, `${name}-${width}-expanded.png`), fullPage: true });
          await tab.keyboard.press('Space');
        }
        if ([390, 1440].includes(width)) await tab.screenshot({ path: path.join(__dirname, `${name}-${width}.png`), fullPage: true });
      }
      await tab.close();
    }
    assert.deepEqual(errors, []);
    const receipt = { checkedAt: new Date().toISOString(), checks, errors, contrastElements: contrasts.reduce((sum, item) => sum + item.elements.length, 0),
      minimumContrast: Math.min(...contrasts.flatMap(item => item.elements.map(element => element.ratio))), source: sourceEvidence,
      authenticatedFullPage: false, physicalPhone: false, deployed: false };
    fs.writeFileSync(path.join(__dirname, 'browser-validation.json'), JSON.stringify(receipt, null, 2) + '\n');
    fs.writeFileSync(path.join(__dirname, 'contrast-validation.json'), JSON.stringify(contrasts, null, 2) + '\n');
    console.log(JSON.stringify({ ok: true, checks: checks.length, tests: sourceEvidence.tests, minContrast: receipt.minimumContrast, errors }));
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
