"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require(process.env.REVIEW_QA_PLAYWRIGHT_MODULE || "playwright");
(async () => {
  const filename = path.resolve(process.argv[2] || "");
  if (process.argv.length !== 3 || !fs.existsSync(filename)) throw new Error("expected generated private HTML report");
  const browser = await chromium.launch({ headless: true, ...(process.env.REVIEW_QA_CHROMIUM_EXECUTABLE ? { executablePath: process.env.REVIEW_QA_CHROMIUM_EXECUTABLE } : {}) });
  const checks = [], errors = [], network = [];
  try {
    for (const width of [390, 768, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      page.on("pageerror", error => errors.push(error.message));
      page.on("request", request => { if (!request.url().startsWith("file:")) network.push(request.url()); });
      await page.goto(pathToFileURL(filename).href);
      assert.equal(await page.locator("svg").count(), 9);
      assert.equal(await page.locator("details").count(), 9);
      const audit = async label => {
        const state = await page.evaluate(() => ({
          overflow: document.documentElement.scrollWidth > innerWidth,
          badLabels: [...document.querySelectorAll("svg text")].filter(e => {
            const b = e.getBoundingClientRect(), svg = e.ownerSVGElement.getBoundingClientRect();
            return b.left < svg.left - 1 || b.right > svg.right + 1 || b.top < svg.top - 1 || b.bottom > svg.bottom + 1
              || parseFloat(getComputedStyle(e).fontSize) * svg.width / 340 < 11;
          }).map(e => e.textContent),
          badMarks: [...document.querySelectorAll(".calibrated-mark,.raw-mark")].filter(e => {
            const b = e.getBoundingClientRect(), svg = e.ownerSVGElement.getBoundingClientRect();
            return b.left < svg.left || b.right > svg.right || b.top < svg.top || b.bottom > svg.bottom;
          }).length,
        }));
        assert.deepEqual(state, { overflow: false, badLabels: [], badMarks: 0 });
        checks.push(`${width}/${label}`);
      };
      await audit("all-nine-plots-and-readable-labels");
      const details = page.locator("details").first();
      assert.equal(await details.getAttribute("open"), null);
      await details.locator("summary").focus(); await page.keyboard.press("Enter");
      assert.equal(await details.getAttribute("open"), "");
      assert.equal(await details.locator("tbody tr").count(), 10);
      await audit("keyboard-exact-bin-table");
      await page.locator("section").nth(1).screenshot({ path: path.join(__dirname, `../outputs/calibration-A-${width}.png`) });
      await page.locator("section").nth(3).screenshot({ path: path.join(__dirname, `../outputs/calibration-C-${width}.png`) });
      await page.evaluate(() => document.querySelectorAll("details").forEach(d => d.open = true));
      await audit("all-tables-open-without-page-overflow");
      await page.close();
    }
    assert.deepEqual(errors, []); assert.deepEqual(network, []);
    console.log(JSON.stringify({ ok: true, input: filename, checks, runtimeErrors: errors, externalRequests: network }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
