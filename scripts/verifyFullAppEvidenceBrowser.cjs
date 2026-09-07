'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.REVIEW_QA_PLAYWRIGHT_MODULE || 'playwright');
const fixture = require('./fixtures/fullAppEvidence.cjs');
const baseUrl = process.env.REVIEW_QA_BASE_URL || 'http://127.0.0.1:5197';
const outputDir = path.resolve(__dirname, '../outputs');
(async () => {
  const browser = await chromium.launch({ ...(process.env.REVIEW_QA_CHROMIUM_EXECUTABLE ? { executablePath: process.env.REVIEW_QA_CHROMIUM_EXECUTABLE } : {}), headless: true });
  const checks = [], errors = [], unexpectedRequests = [], researchLayout = [];
  fs.mkdirSync(outputDir, { recursive: true });
  try {
    for (const width of [390, 768, 1440]) {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, deviceScaleFactor: 1 });
      let mode = 'complete';
      await context.addInitScript(() => {
        localStorage.setItem('football_access_session', JSON.stringify({ token: 'synthetic-local-browser-only', codeId: 'qa-only', issuedAt: '2026-09-07T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z' }));
        localStorage.setItem('nerdy_lang', 'zh');
      });
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/api/v1/events') return route.fulfill({ status: 200, contentType: 'text/event-stream',
          headers: { 'access-control-allow-origin': '*' }, body: ': synthetic-only heartbeat; no production events\n\n' });
        const body = fixture.response(url.pathname, mode);
        if (body !== undefined) return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
        if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/data/')) {
          unexpectedRequests.push(url.pathname); return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"synthetic-route-not-defined"}' });
        }
        if (url.origin !== new URL(baseUrl).origin) { unexpectedRequests.push(`${url.origin}${url.pathname}`); return route.abort(); }
        return route.continue();
      });
      const page = await context.newPage();
      page.on('pageerror', e => errors.push(e.message));
      await page.clock.setFixedTime(new Date(fixture.now));
      const audit = async label => {
        const issues = await page.evaluate(() => {
          const bar = document.querySelector('.app-topbar')?.getBoundingClientRect();
          const main = document.querySelector('#main-content')?.getBoundingClientRect();
          const truncated = [...document.querySelectorAll('[data-summary-state],.review-metadata dd,.review-metric-grid strong,[data-review-exclusion] dd')]
            .filter(e => e.checkVisibility()).filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.textContent);
          return { pageOverflow: document.documentElement.scrollWidth > innerWidth, headerOverlap: !!(bar && main && main.top < bar.bottom - 1), truncated,
            routeError: !!document.querySelector('.route-error') };
        });
        assert.deepEqual(issues, { pageOverflow: false, headerOverlap: false, truncated: [], routeError: false }, `${width}/${label}: ${JSON.stringify(issues)}`);
        checks.push(`${width}/${label}`);
      };
      await page.goto(`${baseUrl}/review`);
      await page.locator('[data-review-overview]').waitFor();
      await page.getByRole('button', { name: /数据参考/ }).click();
      await page.waitForFunction(() => document.querySelector('[data-review-overview-rate]')?.textContent === '50.0%');
      await page.waitForFunction(() => document.querySelector('.review-fixture-grid')?.children.length === 2);
      await audit('review-full-shell');
      await page.screenshot({ path: path.join(outputDir, `full-app-review-${width}.png`), fullPage: true });
      const exclusionPanel = page.locator('[data-review-exclusions]');
      assert.equal(await exclusionPanel.getAttribute('open'), null);
      await exclusionPanel.locator('summary').focus(); await page.keyboard.press('Enter');
      assert.equal(await exclusionPanel.getAttribute('open'), '');
      assert.match(await page.locator('[data-review-exclusion="conflictingEvent"] dd').textContent(), /2.*场赛事/);
      assert.match(await page.locator('[data-review-exclusion="duplicateEvent"] dd').textContent(), /3.*条记录/);
      await page.getByRole('button', { name: '近 7 天', exact: true }).click();
      assert.match(await page.locator('[data-review-exclusion="beforeStart"] dd').textContent(), /7.*条记录/);
      assert.equal(await page.locator('[data-review-overview-rate]').textContent(), '50.0%');
      assert.ok((await exclusionPanel.textContent()).includes('不随上方时间或玩法筛选变化'));
      await page.evaluate(() => window.scrollTo(0, 0)); await audit('whole-input-exclusions-keyboard-open');
      await page.screenshot({ path: path.join(outputDir, `full-app-review-exclusions-${width}.png`), fullPage: true });
      for (const routePath of ['/fixtures', '/predictions', '/match/sporttery_991010']) {
        await page.goto(`${baseUrl}${routePath}`);
        await page.getByText('合成验收主队长名称足球俱乐部', { exact: false }).first().waitFor();
        await page.locator('.route-loading').waitFor({ state: 'detached' });
        await audit(routePath);
        if (routePath === '/predictions') {
          const research = page.locator('[data-testid="research-audit-disclosure"]');
          assert.equal(await research.getAttribute('open'), null);
          await page.waitForFunction(() => document.querySelector('[data-testid="model-governance-panel"]')?.getAttribute('data-model-scorecard-version') === 'synthetic-full-app-evidence-v1');
          assert.equal(await page.locator('[data-testid="model-governance-panel"]').getAttribute('data-model-formal-recommendation-rows'), '');
          assert.equal(await page.locator('[data-testid="benchmark-hit-rate-audit"]').getAttribute('data-audit-settled'), '');
          assert.ok((await research.locator('summary').textContent()).includes('正式统计未提供'));
          const collapsedHeight = await page.evaluate(() => document.documentElement.scrollHeight);
          await research.locator('summary').focus(); await page.keyboard.press('Enter');
          assert.equal(await research.getAttribute('open'), '');
          assert.equal(await page.locator('[data-testid="benchmark-shadow-track"]').isVisible(), true);
          await page.evaluate(() => window.scrollTo(0, 0)); await audit('research-keyboard-open');
          const expandedHeight = await page.evaluate(() => document.documentElement.scrollHeight);
          assert.ok(expandedHeight > collapsedHeight);
          researchLayout.push({ width, collapsedHeight, expandedHeight });
          await research.locator('summary').focus(); await page.keyboard.press('Space');
          assert.equal(await research.getAttribute('open'), null);
          await page.evaluate(() => window.scrollTo(0, 0));
        }
        const summary = page.locator('.data-adoption-details summary').first();
        if (routePath.startsWith('/match/')) {
          await summary.waitFor(); await summary.focus(); await page.keyboard.press('Enter');
          await page.evaluate(() => window.scrollTo(0, 0));
          await audit('detail-gaps-open');
        }
        await page.screenshot({ path: path.join(outputDir, `full-app-${routePath.split('/')[1]}-${width}.png`), fullPage: true });
      }
      mode = 'mutable-home';
      for (const pathname of ['/fixtures', '/predictions', '/match/sporttery_991010']) {
        const received = page.waitForResponse(r => r.url().includes(pathname.startsWith('/match/') ? '/matches/sporttery_991010' : '/matches/current') && r.status() === 200);
        await page.goto(`${baseUrl}${pathname}`);
        const responseBody = await (await received).json();
        assert.equal((responseBody.match || responseBody.rows[0]).predictions[0].tipCode, '1', 'the new private candidate must actually arrive');
        const label = page.locator(pathname.startsWith('/match/') ? '.recommendation-overview-main' : '.decision-card .decision-label').first();
        await label.waitFor();
        const actualLabel = await label.textContent();
        if (!actualLabel.includes('平局')) await page.screenshot({ path: path.join(outputDir, `frozen-reference-failure-${width}-${pathname.split('/')[1]}.png`), fullPage: true });
        assert.ok(actualLabel.includes('平局'), `${width}${pathname}: same public record must not become private home win; actual=${actualLabel}`);
        assert.equal(await page.locator(`.data-adoption-details__identity strong[title="${fixture.current.predictionMeta.publicReferenceDecision.contentHash}"]`).count(), 1);
        await audit(`frozen-reference-survives-private-change${pathname}`);
      }
      mode = 'exclusion-incomplete';
      await page.goto(`${baseUrl}/review`);
      await page.locator('[data-review-overview]').waitFor();
      await page.getByRole('button', { name: /数据参考/ }).click();
      await page.waitForFunction(() => document.querySelector('[data-review-overview-rate]')?.textContent === '50.0%');
      await page.locator('[data-review-exclusions] summary').focus(); await page.keyboard.press('Enter');
      assert.match(await page.locator('[data-review-exclusion="conflictingEvent"] dd').textContent(), /—/);
      assert.match(await page.locator('[data-review-exclusion="invalidDate"] dd').textContent(), /0.*条记录/);
      assert.ok((await page.locator('[data-review-exclusions]').textContent()).includes('1 项未识别口径'));
      await page.evaluate(() => window.scrollTo(0, 0)); await audit('incomplete-exclusions-never-zero-or-hidden');
      mode = 'formal-zero';
      await page.goto(`${baseUrl}/predictions`);
      await page.waitForFunction(() => document.querySelector('[data-testid="benchmark-hit-rate-audit"]')?.getAttribute('data-audit-settled') === '0');
      assert.ok((await page.locator('[data-testid="research-audit-disclosure"] summary').textContent()).includes('正式已结算 0 场'));
      await audit('formal-zero-is-not-missing');
      mode = 'missing';
      await page.goto(`${baseUrl}/review`);
      await page.locator('[data-review-overview]').waitFor();
      await audit('review-empty');
      await context.close();
    }
    assert.deepEqual(errors, []); assert.deepEqual(unexpectedRequests, []);
    const report = { ok: true, checkedAt: new Date().toISOString(), scope: 'real main.tsx AppProvider routes Navbar and global styles; isolated synthetic HTTP data, not production', checks, researchLayout, runtimeErrors: errors, unexpectedRequests };
    fs.writeFileSync(path.join(outputDir, 'full-app-evidence-browser-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
