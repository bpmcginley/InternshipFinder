// Run with NODE_PATH pointing to isolated playwright-core, pngjs and jsqr installs.
// Uses a fresh headless Edge context, local files only, and an invented campus label.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core'), { PNG } = require('pngjs'), jsQR = require('jsqr');
const root = path.resolve(__dirname, '../../../..');
const types = { '.html': 'text/html', '.js': 'application/javascript', '.woff2': 'font/woff2', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.searchParams.has('before')) {
    res.writeHead(404, { 'Content-Type': 'text/html' });
    return res.end('<!doctype html><title>404</title><h1>Not found</h1><p>This page does not exist in the baseline.</p>');
  }
  const file = path.resolve(root, 'docs', '.' + decodeURIComponent(url.pathname));
  if (!file.startsWith(path.join(root, 'docs') + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'text/plain' });
  res.end(fs.readFileSync(file));
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  try {
    for (const width of [1280, 375]) for (const colorScheme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width, height: 960 }, colorScheme });
      const blocked = [], errors = [];
      await context.route('**/*', route => {
        if (route.request().url().startsWith(origin + '/')) return route.continue();
        blocked.push(route.request().url()); return route.abort();
      });
      const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
      await page.goto(origin + '/flyer.html?before=1');
      await page.screenshot({ path: path.join(__dirname, `before-${width}-${colorScheme}.png`), fullPage: true });
      await page.goto(origin + '/flyer.html');
      await page.locator('#print:not([disabled])').waitFor();
      await page.locator('#campus').fill('Example University');
      await page.evaluate(() => document.fonts.ready);
      assert.equal(await page.locator('#campus-line').innerText(), 'For students at Example University');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      const qrBytes = await page.locator('#qr').screenshot();
      const png = PNG.sync.read(qrBytes);
      const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
      assert.equal(decoded?.data, 'https://internscout.org/?utm_source=flyer-exampleuniversit&utm_medium=print');
      await page.screenshot({ path: path.join(__dirname, `after-${width}-${colorScheme}.png`), fullPage: true });
      await page.locator('#campus').fill('<img src=x onerror=alert(1)>');
      assert.equal(await page.locator('#campus-line img').count(), 0);
      await page.locator('#campus').fill('Example University');
      await page.evaluate(() => { window.print = () => { window.printPressed = true; dispatchEvent(new Event('beforeprint')); }; });
      await page.locator('#print').click();
      assert.equal(await page.evaluate(() => window.printPressed), true);
      assert.deepEqual(errors, []); assert.deepEqual(blocked, []);
      if (width === 1280 && colorScheme === 'light') {
        await page.emulateMedia({ media: 'print' });
        await page.pdf({ path: path.join(root, '.validation/flyer.pdf'), preferCSSPageSize: true, printBackground: true });
        await page.screenshot({ path: path.join(__dirname, 'print.png'), fullPage: true });
      }
      await context.close();
    }
    console.log('4 browser cases passed: QR decoded independently, no overflow, injection, page error or external request; print action passed.');
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
