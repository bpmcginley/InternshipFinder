// Local synthetic email preview; all browser requests are blocked.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require(path.join(process.env.CAPTURE_TOOLS, 'node_modules/playwright-core'));
const label = 'Internships for every major on GitHub';
const url = 'https://github.com/bpmcginley/internships-every-major';
(async () => {
  const browser = await chromium.launch({headless: true,
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
  try {
    for (const phase of ['before', 'after']) for (const width of [1280, 375]) {
      const context = await browser.newContext({viewport: {width, height: 1000},
        colorScheme: 'light', locale: 'en-US', deviceScaleFactor: 1});
      const requests = [];
      await context.route('**/*', route => { requests.push(route.request().url()); return route.abort(); });
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.setContent(fs.readFileSync(path.join(__dirname, `${phase}.html`), 'utf8'));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.equal(await page.getByRole('link', {name: 'Unsubscribe', exact: true}).getAttribute('href'), '{{ unsubscribe_url }}');
      assert.equal(await page.getByText('[POSTAL ADDRESS REQUIRED BEFORE SENDING]', {exact: true}).count(), 1);
      const link = page.getByRole('link', {name: label, exact: true});
      assert.equal(await link.count(), phase === 'after' ? 1 : 0);
      if (phase === 'after') {
        assert.equal(await link.getAttribute('href'), url);
        await link.focus();
        assert.equal(await link.evaluate(el => el === document.activeElement), true);
        await page.keyboard.press('Tab');
        assert.equal(await page.getByRole('link', {name: 'Unsubscribe', exact: true}).evaluate(el => el === document.activeElement), true);
        await page.evaluate(() => document.activeElement.blur());
      }
      await page.screenshot({path: path.join(__dirname, `${phase}-${width}-light.png`), fullPage: true});
      assert.deepEqual(errors, []);
      assert.deepEqual(requests, []);
      console.log(JSON.stringify({phase, width, pageErrors: errors.length, requests: requests.length}));
      await context.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
