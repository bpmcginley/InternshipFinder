// Local frozen golden output only: node capture.cjs BUILD_SITE before|after.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(path.join(process.env.TEMP, 'internscout-product-capture-tools/node_modules/playwright-core'));
const [site, phase] = process.argv.slice(2);
assert(site && ['before', 'after'].includes(phase));
const targets = [['field', '/internships/software-engineering/', 29], ['employer', '/internships/at/bose/', 38]];
(async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
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
    page.on('pageerror', error => errors.push(error.message));
    for (const [name, url, count] of targets) {
      await page.goto('http://local.test' + url);
      await page.evaluate(() => document.fonts.ready);
      const lede = page.locator('main p.lede').first();
      const text = await lede.innerText();
      assert(text.includes(`${count} open student roles`));
      assert.equal((text.match(new RegExp(`${count} open student roles`, 'g')) || []).length, 1);
      assert.equal(text.startsWith('As of November 10, 2026, InternScout lists '), phase === 'after');
      assert.equal(await lede.locator('a,button,input,[tabindex]').count(), 0);
      const bounds = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
      assert(bounds.scroll <= width + 1);
      await page.screenshot({ path: path.join(__dirname, `${phase}-${name}-${width}-${colorScheme}.png`) });
      await page.keyboard.press('Tab');
      const focus = await page.evaluate(() => ({ tag: document.activeElement.tagName, href: document.activeElement.getAttribute('href'), rect: document.activeElement.getBoundingClientRect().toJSON() }));
      assert.equal(focus.tag, 'A');
      assert(focus.rect.width > 0 && focus.rect.height > 0);
      if (focus.href && focus.href.startsWith('#')) {
        await page.keyboard.press('Enter');
        assert.equal(await page.evaluate(() => document.activeElement.id), focus.href.slice(1));
      }
      report.push({ phase, name, width, colorScheme, text, bounds, keyboardFirstLink: focus.href });
    }
    assert.deepEqual(errors, []);
    report.push({ width, colorScheme, externalAllowed: 0, blockedExternalOrigins: [...new Set(blocked)] });
    await context.close();
  }
  await browser.close();
  fs.writeFileSync(path.join(__dirname, `${phase}-report.json`), JSON.stringify(report, null, 2) + '\n');
})().catch(error => { console.error(error); process.exitCode = 1; });
