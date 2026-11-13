// Offline synthetic artifact capture. Argument is build.py's private output root.
const { chromium } = require(process.env.PLAYWRIGHT_CORE);
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
(async () => {
  const root = path.resolve(process.argv[2]);
  let stage = 'before';
  const types = {'.html':'text/html', '.mjs':'text/javascript', '.js':'text/javascript', '.css':'text/css', '.woff2':'font/woff2', '.png':'image/png'};
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const rel = pathname.endsWith('/') ? pathname + 'index.html' : pathname;
    const file = path.join(root, stage, rel);
    if (!file.startsWith(path.join(root, stage) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {res.writeHead(404).end(); return;}
    res.writeHead(200, {'Content-Type':types[path.extname(file)] || 'application/octet-stream'});
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({executablePath:process.env.EDGE_PATH, headless:true});
  const evidence = [];
  try {
    for (const width of [1280,375]) for (const colorScheme of ['light','dark']) for (const current of ['before','after']) {
      stage = current;
      const context = await browser.newContext({viewport:{width,height:1100},colorScheme});
      let external = 0, posts = 0;
      await context.route('**/*', route => {
        const request = route.request();
        if (request.method() !== 'GET') posts++;
        if (!request.url().startsWith(origin + '/')) {external++;return route.abort();}
        return route.continue();
      });
      const page = await context.newPage();
      await page.goto(origin + '/internships/at/booz-allen/?nocount=1');
      await page.evaluate(() => document.fonts.ready);
      if (current === 'after') await page.locator('[data-follow-company-key] > button').waitFor();
      else assert.equal(await page.locator('[data-follow-company-key]').count(),0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),false);
      await page.screenshot({path:path.join(__dirname,`${current}-${width}-${colorScheme}.png`)});
      if (current === 'after') {
        const toggle=page.locator('[data-follow-company-key] > button');
        await toggle.focus(); await page.keyboard.press('Enter');
        assert.equal(await page.locator('input[type=email]').evaluate(e => e === document.activeElement),true);
        await page.screenshot({path:path.join(__dirname,`after-open-${width}-${colorScheme}.png`)});
        await page.keyboard.press('Escape');
        assert.equal(await toggle.evaluate(e => e === document.activeElement),true);
        assert.equal(await toggle.getAttribute('aria-expanded'),'false');
      }
      assert.equal(posts,0);
      evidence.push({current,width,colorScheme,externalBlocked:external,posts,overflow:false});
      await context.close();
    }
    fs.writeFileSync(path.join(__dirname,'browser-results.json'),JSON.stringify(evidence,null,2)+'\n');
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => {console.error(error);process.exitCode=1;});
