// Local synthetic golden artifacts; fresh Edge contexts; all external requests blocked.
// Set NODE_PATH to isolated playwright-core and EDGE_BINARY, then pass artifact path and phase.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const root = path.resolve(process.argv[2]), phase = process.argv[3];
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.EDGE_BINARY, headless: true });
  const report = [];
  for (const width of [1280, 375]) for (const colorScheme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme,
      locale: 'en-US', timezoneId: 'America/New_York', deviceScaleFactor: 1, serviceWorkers: 'block' });
    const blocked = [], errors = [];
    await context.addInitScript(() => Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async text => { window.__copiedSnippet = text; } },
    })); // Browser-memory test clipboard; does not change the user's clipboard.
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
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
    for (const [name, url] of [['field', '/internships/mechanical-engineering/'], ['compare', '/compare/']]) {
      await page.goto('http://127.0.0.1:4178' + url);
      await page.evaluate(() => document.fonts.ready);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
      if (name === 'field') await page.screenshot({ path: path.join(__dirname, `${phase}-${name}-full-${width}-${colorScheme}.png`), fullPage: true });
      await page.locator('footer').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(__dirname, `${phase}-${name}-footer-${width}-${colorScheme}.png`) });
      const dimensions = [];
      if (phase === 'after') {
        const links = page.locator('footer .distribution-links a');
        assert.equal(await links.count(), 2);
        assert.equal(await links.nth(0).getAttribute('href'), 'https://github.com/bpmcginley/internships-every-major');
        assert.equal(await links.nth(1).getAttribute('href'), '/widget/builder.html');
        for (const link of [links.nth(0), links.nth(1), ...(name === 'field' ? [page.locator('.widget-follow a')] : [])]) {
          const bounds = await link.boundingBox(); assert.ok(bounds.height >= 44);
          assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
          await link.focus(); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
          assert.equal(await link.evaluate(el => el === document.activeElement), true);
          dimensions.push({ text: await link.textContent(), height: bounds.height, width: bounds.width });
        }
        if (name === 'field') {
          await page.keyboard.press('Enter');
          await page.waitForFunction(() => !document.getElementById('field').disabled);
          assert.equal(await page.locator('#field').inputValue(), 'mechanical');
          const snippet = await page.locator('#snippet').inputValue();
          assert.ok(snippet.includes('https://internscout.org/widget/?field=mechanical&amp;limit=8'));
          await page.locator('#copy').click();
          assert.equal(await page.evaluate(() => window.__copiedSnippet), snippet);
          assert.equal(await page.locator('#copy-status').textContent(), 'Code copied.');
          assert.ok((await page.locator('#preview').getAttribute('src')).includes('field=mechanical'));
          await page.screenshot({ path: path.join(__dirname, `after-builder-${width}-${colorScheme}.png`), fullPage: true });
        }
      }
      report.push({ name, width, colorScheme, documentWidth: width, dimensions,
        keyboardReachable: phase === 'after', builderAndCopyVerified: phase === 'after' && name === 'field' });
    }
    assert.deepEqual(errors, []);
    assert.ok(blocked.every(host => host === 'https://static.cloudflareinsights.com'));
    report.push({ width, colorScheme, blockedExistingBeaconRequests: blocked.length, externalRequestsAllowed: 0 });
    await context.close();
  }
  await browser.close();
  fs.writeFileSync(path.join(__dirname, `${phase}-measurements.json`), JSON.stringify(report, null, 2) + '\n');
  console.log(`${phase}: field/compare at 1280/375 light/dark verified`);
})().catch(error => { console.error(error); process.exitCode = 1; });
