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
    for (const width of [390, 768, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 }, deviceScaleFactor: 1 });
      page.on('pageerror', e => errors.push(e.message));
      await page.goto(`${baseUrl}/scripts/fixtures/review-ui/index.html`);
      await page.locator('[data-review-overview]').waitFor();
      const audit = async label => {
        const issues = await page.evaluate(() => {
          const visible = e => e.checkVisibility() && getComputedStyle(e).position !== 'fixed';
          const overflow = [...document.querySelectorAll('.review-page *')].filter(visible).filter(e => {
            const r = e.getBoundingClientRect(); return r.left < -1 || r.right > innerWidth + 1;
          }).map(e => `${e.tagName}.${e.className}`);
          const truncated = [...document.querySelectorAll('.review-metric-grid strong,.review-metadata dd,.review-window-switch button')].filter(visible).filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.textContent);
          return { pageOverflow: document.documentElement.scrollWidth > innerWidth, overflow, truncated };
        });
        assert.deepEqual(issues, { pageOverflow: false, overflow: [], truncated: [] }, `${width}/${label}: ${JSON.stringify(issues)}`);
        checks.push(`${width}/${label}`);
      };
      await audit('formal-empty');
      await page.getByRole('button', { name: /数据参考/ }).click();
      assert.equal(await page.locator('[data-review-overview-rate]').textContent(), '48.8%');
      await page.screenshot({ path: path.join(outputDir, `review-ui-${width}.png`), fullPage: true });
      await audit('reference-all');
      await page.getByRole('button', { name: 'HHAD 让球', exact: true }).click();
      assert.equal(await page.locator('[data-review-overview-rate]').textContent(), '—');
      await audit('hhad-independent-empty');
      await page.getByRole('button', { name: 'BEST 总账', exact: true }).click();
      assert.equal(await page.locator('[data-review-overview-rate]').textContent(), '48.8%');
      await audit('best-combined-explicit');
      await page.getByRole('button', { name: 'HAD 胜平负', exact: true }).click();
      await page.getByRole('button', { name: '近 7 天', exact: true }).click();
      assert.equal(await page.locator('[data-review-overview-rate]').textContent(), '46.2%');
      await audit('reference-7d');
      await page.getByRole('button', { name: '近 30 天', exact: true }).click();
      assert.ok(await page.getByText('（不足完整窗口）', { exact: false }).count());
      await audit('reference-30d-partial');
      await page.getByRole('button', { name: '本版本', exact: true }).click();
      assert.equal(await page.locator('[data-review-overview-rate]').textContent(), '—');
      const disclosure = page.locator('.review-evidence-gaps summary');
      await disclosure.focus(); await page.keyboard.press('Enter');
      assert.equal(await page.locator('.review-evidence-gaps').getAttribute('open'), '');
      await audit('version-missing-keyboard-open');
      await page.getByRole('button', { name: /研究影子/ }).click();
      await audit('shadow-long-version');
      const legacy = page.locator('.review-legacy-summary summary');
      await legacy.focus(); await page.keyboard.press('Space');
      assert.equal(await page.locator('.review-legacy-summary').getAttribute('open'), '');
      await audit('legacy-keyboard-open');
      await page.goto(`${baseUrl}/scripts/fixtures/review-ui/index.html?mode=missing`);
      await page.locator('[data-review-overview]').waitFor();
      await audit('missing-all');
      await page.goto(`${baseUrl}/scripts/fixtures/review-ui/index.html?lang=en`);
      await page.locator('[data-review-overview]').waitFor();
      await audit('english-formal');
      await page.close();
    }
    assert.deepEqual(errors, []);
    const report = { ok: true, checkedAt: new Date().toISOString(), surface: 'real HitAndWin TSX with synthetic context; not production data', checks, runtimeErrors: errors };
    fs.writeFileSync(path.join(outputDir, 'review-ui-browser-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
