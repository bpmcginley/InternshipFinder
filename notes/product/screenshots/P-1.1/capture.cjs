const fs = require('node:fs');
const path = require('node:path');
const toolsRoot = process.env.CAPTURE_TOOLS;
if (!toolsRoot) throw new Error('Set CAPTURE_TOOLS to an isolated playwright-core/react/react-dom installation.');
const { chromium } = require(path.join(toolsRoot, 'node_modules/playwright-core'));
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../../../..');
const phase = process.argv[2] || 'before';
const out = path.join(root, 'notes/product/screenshots/P-1.1');
fs.mkdirSync(out, {recursive:true});
const fixturePath = path.join(out, 'public-listings.json');
if (!fs.existsSync(fixturePath)) fs.copyFileSync(path.join(root,'docs/data/first.json'), fixturePath);
const rows = JSON.parse(fs.readFileSync(fixturePath));
const generated_at = '2026-11-10T17:18:04.027713+00:00';
const files = Object.fromEntries(['CT','MA','ME','NH','NJ','NY','RI','VT','remote'].map(k=>[k,{file:`listings/${k}.json`,open:rows.filter(r=>r.state===k).length}]));
(async()=>{
 const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
 for(const width of [1280,375]) for(const colorScheme of ['light','dark']) {
  const ctx=await browser.newContext({viewport:{width,height:1000},colorScheme,deviceScaleFactor:1,locale:'en-US',timezoneId:'America/New_York'});
  await ctx.route('**/*',async route=>{
   const u=new URL(route.request().url()); let file;
   if(u.hostname==='cdn.jsdelivr.net') file=path.join(toolsRoot,'node_modules',u.pathname.includes('react-dom@')?'react-dom/umd/react-dom.production.min.js':'react/umd/react.production.min.js');
   else if(u.hostname!=='127.0.0.1') return route.fulfill({status:200,contentType:'application/json',body:'{}'});
   else {
    const p=decodeURIComponent(u.pathname);
    if(p==='/data/listings/index.json') return route.fulfill({json:{generated_at,files,first:{file:'first.json',rows:12,keys:Object.keys(files),sort:'new'}}});
    if(p==='/data/first.json') return route.fulfill({json:rows});
    if(/^\/data\/listings\/[^/]+\.json$/.test(p)) return route.fulfill({json:rows.filter(r=>p.endsWith('/'+r.state+'.json'))});
    if(p==='/data/stats.json') return route.fulfill({json:{generated_at,open:12}});
    if(p==='/data/placements.json') return route.fulfill({json:[]});
    file=path.join(root,'docs',p==='/'?'index.html':p);
   }
   if(!fs.existsSync(file)) return route.fulfill({status:404,body:''});
   const type={'.html':'text/html','.js':'text/javascript','.json':'application/json','.woff2':'font/woff2','.svg':'image/svg+xml','.png':'image/png'}[path.extname(file)]||'application/octet-stream';
   const body = phase === 'before' && ['app.js','index.html'].includes(path.basename(file)) ? execFileSync('git',['show','3eb55beb:docs/'+path.relative(path.join(root,'docs'),file).replaceAll('\\','/')],{cwd:root}) : fs.readFileSync(file);
   return route.fulfill({body,contentType:type,headers:{'access-control-allow-origin':'*'}});
  });
  const page=await ctx.newPage(); const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.clock.install({time:new Date('2026-11-10T18:00:00Z')});
  await page.goto('http://127.0.0.1:8765/',{waitUntil:'networkidle'});
  await page.waitForSelector('.list .c-co');
  await page.evaluate(()=>document.fonts.ready);
  await page.screenshot({path:path.join(out,`${phase}-${width}-${colorScheme}.png`),fullPage:true});
  console.log(JSON.stringify({phase,width,colorScheme,rows:await page.locator('.list .c-co').count(),overflow:await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),errors}));
  if(phase==='after') {
   const storage = await page.evaluate(()=>JSON.stringify({...localStorage}));
   await page.evaluate(()=>{window.__groupEvents=[]; window.IS.count=e=>window.__groupEvents.push(e);});
   const button=page.getByRole('button',{name:'Show 7 more listings from REGENT'});
   const bounds=await button.boundingBox(); assert.ok(bounds.height>=32);
   await button.evaluate(el=>{el.textContent='7 more from '+ 'International University Research and Engineering '.repeat(5);});
   assert.equal(await page.locator('.tablewrap').evaluate(el=>el.scrollWidth>el.clientWidth),false,'long company label wraps');
   await button.evaluate(el=>{el.textContent='7 more from REGENT';});
   await button.focus(); await page.keyboard.press('Enter');
   await page.waitForFunction(()=>document.querySelectorAll('.list .c-co').length===12);
   await page.waitForFunction(id=>document.activeElement.id==='listing-'+id,rows[3].id);
   assert.match(await page.locator('[aria-live="polite"][aria-atomic="true"]').innerText(),/7 more listings from REGENT shown\. 12 of 12 listings shown\./);
   assert.equal(await page.locator('#list-end').innerText(),'End of the 12 listings shown');
   assert.deepEqual(await page.evaluate(()=>window.__groupEvents),['group_expand']);
   assert.equal(await page.evaluate(()=>JSON.stringify({...localStorage})),storage);
   await page.reload({waitUntil:'networkidle'});
   await page.getByLabel('Sort',{exact:true}).selectOption('company');
   await page.waitForFunction(()=>document.querySelectorAll('.list .c-co').length===12);
   assert.equal(await page.locator('.company-run').count(),0);
   await page.getByLabel('Sort',{exact:true}).selectOption('new');
   await page.getByRole('textbox',{name:'Search',exact:true}).fill('REGENT');
   await page.keyboard.press('Enter');
   await page.waitForFunction(()=>document.querySelectorAll('.list .c-co').length===9);
   assert.equal(await page.locator('.company-run').count(),0);
   console.log(JSON.stringify({width,colorScheme,keyboardFocus:'first revealed listing',announced:'12 of 12 shown',unchangedStorage:true,sortAndSearch:'uncollapsed',buttonHeight:bounds.height}));
  }
  await ctx.close();
 }
 await browser.close();
})().catch(e=>{console.error(e);process.exitCode=1;});
