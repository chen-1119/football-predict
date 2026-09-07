'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.REVIEW_QA_PLAYWRIGHT_MODULE || 'playwright');
const baseUrl = process.env.REVIEW_QA_BASE_URL || 'http://127.0.0.1:5197';
const outputDir = path.resolve(__dirname, '../outputs');
(async () => {
  fs.mkdirSync(outputDir, { recursive: true });
  const browser = await chromium.launch({ ...(process.env.REVIEW_QA_CHROMIUM_EXECUTABLE ? { executablePath: process.env.REVIEW_QA_CHROMIUM_EXECUTABLE } : {}), headless: true });
  const checks = [], errors = [];
  try {
    for (const width of [320, 390, 768, 1440]) for (const lang of ['zh', 'en']) for (const mode of ['complete', 'missing', 'collector']) {
      const page = await browser.newPage({ viewport: { width, height: 1000 }, deviceScaleFactor: 1 });
      page.on('pageerror', e => errors.push(e.message));
      await page.goto(`${baseUrl}/scripts/fixtures/data-adoption-ui/index.html?lang=${lang}&mode=${mode}`);
      const summary = page.locator('.data-adoption-details summary');
      try { await summary.waitFor({ timeout: 15000 }); }
      catch (error) { throw new Error(`${width}/${lang}/${mode}: component did not render; runtime errors: ${errors.join(' | ')}`, { cause: error }); }
      const audit = async state => {
        const issues = await page.evaluate(() => {
          const visible = e => e.checkVisibility();
          const outside = [...document.querySelectorAll('main *')].filter(visible).filter(e => {
            const r = e.getBoundingClientRect(); return r.left < -1 || r.right > innerWidth + 1;
          }).map(e => `${e.tagName}.${e.className}`);
          const truncated = [...document.querySelectorAll('[data-summary-state],.data-adoption-details__identity strong')].filter(visible)
            .filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.textContent);
          return { pageOverflow: document.documentElement.scrollWidth > innerWidth, outside, truncated };
        });
        assert.deepEqual(issues, { pageOverflow: false, outside: [], truncated: [] }, `${width}/${lang}/${mode}/${state}`);
        checks.push(`${width}/${lang}/${mode}/${state}`);
      };
      const counts = await page.locator('[data-summary-state]').allTextContents();
      assert.equal(counts.reduce((n, s) => n + Number(s.match(/\d+/)[0]), 0), 12);
      if (mode === 'complete') for (const key of ['conflicting', 'after-decision', 'stale', 'missing', 'unverified', 'not-yet-published']) {
        assert.equal(await page.locator(`[data-summary-state="${key}"]`).count(), 1);
      }
      await audit('closed');
      if (lang === 'zh' && mode === 'complete') await page.screenshot({ path: path.join(outputDir, `data-adoption-${width}-closed.png`), fullPage: true });
      await summary.focus(); await page.keyboard.press('Enter');
      assert.equal(await page.locator('.data-adoption-details').getAttribute('open'), '');
      await audit('keyboard-open');
      if (mode === 'complete') {
        assert.ok((await page.locator('.data-adoption-details').textContent()).includes(lang === 'zh' ? '另有本地文件接收凭据 3 / 4' : 'Separate local file receipts 3/4'));
        assert.ok((await page.locator('.data-adoption-details').textContent()).includes(lang === 'zh' ? '有观测时钟 0 / 4' : 'Observation clocks 0/4'));
      }
      if (mode === 'collector') {
        assert.equal(await page.locator('[data-collector-state]').count(), 3);
        assert.equal(await page.locator('[data-collector-state="clock-rejected"]').count(), 1);
        assert.ok((await page.locator('.collector-diagnostics').textContent()).includes(lang === 'zh' ? '不回填原推荐' : 'does not backfill'));
        if (lang === 'zh') await page.locator('.collector-diagnostics').screenshot({ path: path.join(outputDir, `collector-diagnostics-${width}.png`) });
      }
      if (lang === 'zh' && mode === 'complete') await page.screenshot({ path: path.join(outputDir, `data-adoption-${width}-open.png`), fullPage: true });
      await page.keyboard.press('Space');
      assert.equal(await page.locator('.data-adoption-details').getAttribute('open'), null);
      await page.close();
    }
    assert.deepEqual(errors, []);
    const report = { ok: true, checkedAt: new Date().toISOString(), baseUrl, scope: 'actual DataAdoptionDetails TSX and CSS, synthetic consumer fixtures only', checks, runtimeErrors: errors };
    fs.writeFileSync(path.join(outputDir, 'data-adoption-browser-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
