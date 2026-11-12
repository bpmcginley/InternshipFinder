// Local synthetic output only. Run with: node capture.cjs BUILD_SITE before|after.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(path.join(process.env.TEMP, 'internscout-product-capture-tools/node_modules/playwright-core'));
const [site, phase, standingSite = site] = process.argv.slice(2);
assert(site && ['before', 'after'].includes(phase));
const targets = [['hub', '/internships/']];
if (phase === 'after') targets.push(
  ['season', '/internships/summer-2027/software-engineering/'],
  ['standing', '/internships/for-sophomores/denver/'],
);
(async () => {
  const browser = await chromium.launch({executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true});
  const report = [];
  for (const width of [1280, 375]) for (const colorScheme of ['light', 'dark']) {
    const context = await browser.newContext({viewport: {width, height: 1000}, colorScheme, hasTouch: width === 375, reducedMotion: 'reduce'});
    const blocked = [];
    let activeSite = site;
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== 'http://local.test') { blocked.push(url.origin); return route.abort(); }
      let name = decodeURIComponent(url.pathname).replace(/^\//, '');
      if (!name || name.endsWith('/')) name += 'index.html';
      const file = path.resolve(activeSite, name);
      assert(file.startsWith(path.resolve(activeSite) + path.sep));
      if (!fs.existsSync(file)) return route.fulfill({status: 404, body: 'Not found'});
      const ext = path.extname(file);
      const type = {'.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.woff2':'font/woff2', '.xml':'application/xml'}[ext] || 'application/octet-stream';
      await route.fulfill({body: fs.readFileSync(file), contentType: type});
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    for (const [name, url] of targets) {
      activeSite = name === 'standing' ? standingSite : site;
      await page.goto('http://local.test' + url);
      await page.evaluate(() => document.fonts.ready);
      assert.equal(await page.locator('h1').count(), 1);
      const bounds = await page.evaluate(() => ({width: innerWidth, scroll: document.documentElement.scrollWidth}));
      assert(bounds.scroll <= width + 1, JSON.stringify(bounds));
      await page.screenshot({path: path.join(__dirname, `${phase}-${name}-${width}-${colorScheme}.png`)});
      // Native keyboard traversal must reach a visible link; no application is opened.
      await page.keyboard.press('Tab');
      const focus = await page.evaluate(() => ({tag: document.activeElement.tagName, rect: document.activeElement.getBoundingClientRect().toJSON()}));
      assert.equal(focus.tag, 'A');
      assert(focus.rect.width > 0 && focus.rect.height > 0);
      report.push({phase, name, width, colorScheme, bounds, heading: await page.locator('h1').textContent()});
      if (phase === 'after' && name === 'hub') {
        const first = page.locator('section.rel').filter({hasText: 'Selected terms and class years'}).locator('a').first();
        const href = await first.getAttribute('href');
        await first.focus();
        await page.keyboard.press('Enter');
        await page.waitForURL('http://local.test' + href);
        assert.equal(await page.locator('h1').count(), 1);
        report.push({width, colorScheme, keyboardPilotNavigation: href});
      }
      if (phase === 'after' && name !== 'hub' && width === 375) {
        const cta = await page.locator('main a.cta').first().boundingBox();
        assert(cta.height >= 44);
        report.push({name, width, colorScheme, primaryTargetHeight: cta.height});
      }
    }
    assert.deepEqual(errors, []);
    report.push({width, colorScheme, blockedExternalOrigins: [...new Set(blocked)], externalAllowed: 0});
    await context.close();
  }
  await browser.close();
  console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
