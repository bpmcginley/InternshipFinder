// Local synthetic artifact only. Set NODE_PATH for isolated playwright-core and EDGE_BINARY.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const root = path.resolve(process.argv[2]), phase = process.argv[3] || 'after';
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.EDGE_BINARY, headless: true });
  const report = [];
  for (const width of [1280, 375]) for (const colorScheme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme,
      locale: 'en-US', timezoneId: 'America/New_York', deviceScaleFactor: 1 });
    const blocked = [], errors = [];
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname !== '127.0.0.1') { blocked.push(url.origin); return route.abort(); }
      const file = path.join(root, url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname);
      assert.ok(file.startsWith(root + path.sep));
      if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: 'Not found' });
      return route.fulfill({ body: fs.readFileSync(file), contentType: {
        '.html': 'text/html', '.js': 'text/javascript', '.woff2': 'font/woff2',
        '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
      }[path.extname(file)] || 'application/octet-stream' });
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    for (const [name, url] of [['tracker', '/internships/summer-2027/open/'],
      ['pay', '/internships/highest-paying/'], ['compare', '/compare/']]) {
      await page.goto('http://127.0.0.1:4178' + url); await page.evaluate(() => document.fonts.ready);
      const measure = await page.evaluate(() => ({
        documentWidth: document.documentElement.scrollWidth,
        headerHeight: document.querySelector('header').getBoundingClientRect().height,
        nav: [...document.querySelectorAll('header nav a')].filter(a => a.getClientRects().length).map(a => ({
          text: a.textContent, height: a.getBoundingClientRect().height, top: a.getBoundingClientRect().top,
        })),
        tables: [...document.querySelectorAll('.tablewrap')].map(w => ({ client: w.clientWidth, scroll: w.scrollWidth })),
        rowCount: document.querySelectorAll('tbody tr').length,
        headerCount: document.querySelectorAll('thead th').length,
      }));
      assert.equal(measure.documentWidth, width);
      if (width === 375) {
        assert.deepEqual(measure.nav.map(a => a.text), ['Dashboard', 'Browse', 'Auto-Apply (free)']);
        assert.ok(measure.nav.every(a => a.height >= 44));
        assert.equal(new Set(measure.nav.map(a => a.top)).size, 1);
        assert.ok(measure.tables.every(t => t.scroll <= t.client));
        for (const href of ['/about/', '/pricing/', '/compare/', '/employers/'])
          assert.equal(await page.locator(`footer a[href="${href}"]`).isVisible(), true);
        if (name !== 'compare') assert.equal(await page.locator('footer a[href="/digest/"]').isVisible(), true);
      }
      const cdp = await context.newCDPSession(page), ax = await cdp.send('Accessibility.getFullAXTree');
      const roles = ax.nodes.filter(n => !n.ignored).map(n => n.role?.value);
      assert.equal(roles.filter(r => r === 'table').length, measure.tables.length);
      assert.equal(roles.filter(r => r === 'columnheader').length, measure.headerCount);
      assert.equal(roles.filter(r => r === 'rowheader').length, measure.rowCount);
      await cdp.detach();
      await page.screenshot({ path: path.join(__dirname, `${phase}-${name}-${width}-${colorScheme}.png`), fullPage: true });
      const wrapper = page.locator('.tablewrap').first(); await wrapper.focus();
      assert.equal(await wrapper.evaluate(e => e === document.activeElement && e.getAttribute('aria-label').length > 0), true);
      report.push({ name, width, colorScheme, ...measure, tableRoles: measure.tables.length,
        columnHeaderRoles: measure.headerCount, rowHeaderRoles: measure.rowCount });
      if (name === 'tracker' && colorScheme === 'light') {
        await page.evaluate(() => {
          document.querySelector('tbody tr th a').textContent = 'SyntheticInternationalLaboratory';
          document.querySelector('tbody tr td .cell-value').textContent = 'By Sep 17, 2026';
        });
        if (width === 375) assert.equal(await wrapper.evaluate(e => e.scrollWidth <= e.clientWidth), true);
        await page.screenshot({ path: path.join(__dirname, `${phase}-tracker-long-name-stress-${width}-light.png`), fullPage: true });
      }
    }
    assert.deepEqual(errors, []);
    assert.ok(blocked.every(host => host === 'https://static.cloudflareinsights.com'));
    await context.close();
  }
  await browser.close();
  fs.writeFileSync(path.join(__dirname, `${phase}-measurements.json`), JSON.stringify(report, null, 2) + '\n');
  console.log('All 12 layouts, accessibility trees, keyboard regions and two long-name stress cases passed.');
})().catch(error => { console.error(error); process.exit(1); });
