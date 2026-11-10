// Synthetic local artifacts only. NODE_PATH: isolated playwright-core; EDGE_BINARY: local Edge.
// Pass artifact directory and before/after. Config is the existing employer-funnel unit-test fixture.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const root = path.resolve(process.argv[2]), phase = process.argv[3];
const cfg = { enabled: true, prices: { one: { cents: 2900, public_body_cents: 1500 },
  three: { cents: 6900, public_body_cents: 3500 } }, days: 30, field_cap: 5,
  max_start_days: 90, terms_version: '2026-10-19' };
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.EDGE_BINARY, headless: true });
  const report = [];
  for (const width of [1280, 375]) for (const colorScheme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme,
      locale: 'en-US', timezoneId: 'America/New_York', deviceScaleFactor: 1, serviceWorkers: 'block' });
    await context.addInitScript(() => {
      const OriginalDate = Date;
      window.Date = class extends OriginalDate {
        constructor(...args) { super(...(args.length ? args : ['2026-11-10T12:00:00Z'])); }
        static now() { return new OriginalDate('2026-11-10T12:00:00Z').valueOf(); }
      };
    });
    const blocked = [], errors = [], mutations = [], mockCalls = [];
    await context.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (request.method() !== 'GET') { mutations.push(request.method()); return route.abort(); }
      if (url.pathname === '/employer/config') {
        mockCalls.push(url.pathname);
        return route.fulfill({ json: cfg }); // No provider connection is made.
      }
      if (url.hostname !== '127.0.0.1') { blocked.push(url.origin); return route.abort(); }
      const file = path.join(root, url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname);
      assert.ok(file.startsWith(root + path.sep));
      if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: 'Not found' });
      return route.fulfill({ body: fs.readFileSync(file), contentType: {
        '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
        '.woff2': 'font/woff2', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
      }[path.extname(file)] || 'application/octet-stream' });
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    for (const [name, url] of [['bose', '/internships/at/bose/'], ['stress', '/synthetic-employer-entry.html']]) {
      await page.goto('http://127.0.0.1:4178' + url); await page.evaluate(() => document.fonts.ready);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
      await page.screenshot({ path: path.join(__dirname, `${phase}-${name}-full-${width}-${colorScheme}.png`), fullPage: true });
      const offer = page.locator('.employer-offer'), link = offer.locator('[data-employer-entry="employer"]');
      assert.equal(await link.count(), 1);
      await link.focus(); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
      assert.equal(await link.evaluate(el => document.activeElement === el), true);
      assert.equal(await offer.locator('script, img').count(), 0);
      if (name === 'bose') await page.screenshot({ path: path.join(__dirname, `${phase}-bose-entry-${width}-${colorScheme}.png`) });
      const bounds = await link.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
      report.push({ name, width, colorScheme, documentWidth: width, keyboardReachable: true,
        linkText: await link.textContent(), linkHeight: bounds.height, linkWidth: bounds.width,
        destination: await link.getAttribute('href') });
      if (phase === 'after' && name === 'bose') {
        assert.equal(await link.textContent(), 'Work at Bose? See how students find your roles, and feature them.');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => document.getElementById('co-q')?.value === 'Bose');
        await page.waitForFunction(() => document.querySelectorAll('#role-list input').length > 0);
        assert.equal(await page.locator('#company').inputValue(), 'Bose');
        assert.equal(await page.locator('#role-list input:checked').count(), 0);
        assert.equal(await page.locator('#terms').isChecked(), false);
        assert.ok(page.url().endsWith('/employers/buy/?company=bose'));
        await page.screenshot({ path: path.join(__dirname, `after-prefill-${width}-${colorScheme}.png`) });
        report.push({ width, colorScheme, companyPrefilled: 'Bose', checkedRoles: 0,
          termsChecked: false, checkoutOpened: false });
      }
    }
    assert.deepEqual(errors, []); assert.deepEqual(mutations, []);
    assert.ok(blocked.every(host => host === 'https://static.cloudflareinsights.com'));
    assert.equal(mockCalls.length, phase === 'after' ? 1 : 0);
    report.push({ width, colorScheme, locallyMockedConfigReads: mockCalls.length,
      externalRequestsAllowed: 0, nonGetRequests: 0, blockedExistingBeacons: blocked.length });
    await context.close();
  }
  await browser.close();
  fs.writeFileSync(path.join(__dirname, `${phase}-measurements.json`), JSON.stringify(report, null, 2) + '\n');
  console.log(`${phase}: employer entry/stress at both widths/themes verified`);
})().catch(error => { console.error(error); process.exitCode = 1; });
