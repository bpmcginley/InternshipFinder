// Local policy capture only: fresh Edge contexts, no external requests or provider calls.
const { chromium } = require('playwright-core');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(process.argv[2]);
const phase = process.argv[3];
if (!['before', 'after'].includes(phase)) throw new Error('Expected before or after');
const output = __dirname;
const origin = 'http://127.0.0.1:40225';
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png' };
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.EDGE_BINARY, headless: true });
  const measurements = [];
  for (const width of [1280, 375]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme, deviceScaleFactor: 1, locale: 'en-US', timezoneId: 'America/New_York' });
    const page = await context.newPage();
    const errors = [], blocked = [];
    page.on('pageerror', e => errors.push(e.message));
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin || route.request().method() !== 'GET') {
        blocked.push(url.origin); return route.abort();
      }
      const relative = url.pathname === '/privacy' ? 'privacy.html' : decodeURIComponent(url.pathname.slice(1));
      const file = path.resolve(root, relative);
      if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: 'Not found' });
      await route.fulfill({ status: 200, contentType: mime[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
    });
    await page.goto(origin + '/privacy', { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    const count = page.locator('li').filter({ hasText: 'Because Cloudflare only samples visits' });
    const name = `${phase}-${width}-${theme}`;
    await page.screenshot({ path: path.join(output, `${name}-full.png`), fullPage: true });
    await count.screenshot({ path: path.join(output, `${name}-counts.png`) });
    const bounds = await count.boundingBox();
    const layout = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, date: document.querySelector('.meta').textContent, text: document.querySelector('[data-counter-disclosure]')?.textContent || null }));
    if (layout.document > width || errors.length) throw new Error(JSON.stringify({ width, theme, layout, errors }));
    measurements.push({ width, theme, bounds, ...layout, errors, blockedOrigins: [...new Set(blocked)] });
    await context.close();
  }
  await browser.close();
  fs.writeFileSync(path.join(output, `${phase}-measurements.json`), JSON.stringify(measurements, null, 2) + '\n');
})().catch(e => { console.error(e); process.exitCode = 1; });
