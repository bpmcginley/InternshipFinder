// Synthetic local builds only: node capture.cjs BUILD_SITE before|after.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(path.join(process.env.TEMP, 'internscout-product-capture-tools/node_modules/playwright-core'));
const [site, phase] = process.argv.slice(2);
assert(site && ['before', 'after'].includes(phase));
const cases = [['hub', '/internships/for/']];
if (phase === 'after') cases.push(
  ['populated', '/internships/for/computer-science-majors/weekly/'],
  ['empty', '/internships/for/accounting-majors/weekly/'],
  ['unmapped', '/internships/for/exploratory-undeclared-majors/weekly/'],
  ['long-name', '/internships/for/operations-and-information-management-majors/weekly/'],
);
let browser;
(async () => {
  browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const report = [];
  for (const width of [1280, 375]) for (const colorScheme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme, hasTouch: width === 375, reducedMotion: 'reduce' });
    const blocked = [];
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== 'http://local.test') { blocked.push(url.origin); return route.abort(); }
      let name = decodeURIComponent(url.pathname).replace(/^\//, '');
      if (!name || name.endsWith('/')) name += 'index.html';
      const file = path.resolve(site, name);
      assert(file.startsWith(path.resolve(site) + path.sep));
      if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: 'Not found' });
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream';
      await route.fulfill({ body: fs.readFileSync(file), contentType: type });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    for (const [name, url] of cases) {
      await page.goto('http://local.test' + url);
      await page.evaluate(() => document.fonts.ready);
      const bounds = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
      assert(bounds.scroll <= width + 1);
      assert.equal(await page.locator('h1').count(), 1);
      await page.screenshot({ path: path.join(__dirname, `${phase}-${name}-${width}-${colorScheme}.png`), fullPage: name === 'hub' });
      if (name === 'hub') {
        const links = page.locator('main a[href$="/weekly/"]');
        assert.equal(await links.count(), phase === 'after' ? 80 : 0);
        if (phase === 'after') {
          const link = links.first();
          const href = await link.getAttribute('href');
          const size = await link.boundingBox();
          if (width === 375) assert(size.height >= 44);
          await link.focus();
          await page.keyboard.press('Enter');
          await page.waitForURL('http://local.test' + href);
          assert.equal(await page.locator('h1').count(), 1);
          report.push({ width, colorScheme, keyboardWeeklyNavigation: href, targetHeight: size.height });
        }
      } else {
        assert.equal(await page.locator('meta[name="robots"]').getAttribute('content'), 'noindex, follow');
        assert.equal(await page.locator('link[rel="canonical"]').getAttribute('href'), 'https://internscout.org' + url);
        assert.equal(await page.locator('a[href="feed.xml"],form').count(), 0);
        const text = await page.locator('main p.lede').innerText();
        if (name === 'populated') assert(text.startsWith('28 open student roles'));
        if (name === 'empty' || name === 'long-name') assert(text.startsWith('0 open student roles'));
        if (name === 'unmapped') assert(text.includes('no direct field mapping'));
        await page.locator('main a.cta').focus();
        const target = await page.locator('main a.cta').getAttribute('href');
        await page.keyboard.press('Enter');
        await page.waitForURL('http://local.test' + target);
        assert.equal(await page.locator('h1').count(), 1);
        report.push({ name, width, colorScheme, lead: text, keyboardBrowseDestination: target });
      }
      report.push({ phase, name, width, colorScheme, bounds });
    }
    assert.deepEqual(errors, []);
    report.push({ width, colorScheme, externalAllowed: 0, blockedExternalOrigins: [...new Set(blocked)] });
    await context.close();
  }
  await browser.close();
  fs.writeFileSync(path.join(__dirname, `${phase}-report.json`), JSON.stringify(report, null, 2) + '\n');
})().catch(async error => { console.error(error); if (browser) await browser.close(); process.exitCode = 1; });
