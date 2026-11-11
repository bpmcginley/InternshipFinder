// Synthetic local extension page: no real extension, account, AI, review or submission action.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {chromium} = require(path.join(process.env.CAPTURE_TOOLS, 'node_modules/playwright-core'));
const root = path.resolve(__dirname, '../../../..'), base = '45ad4c6d';
const phase = process.argv[2] || 'after';
(async () => {
 const browser = await chromium.launch({headless:true, executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 try { for (const width of [1280,375]) for (const colorScheme of ['light','dark']) {
  const context = await browser.newContext({viewport:{width,height:1000},colorScheme});
  const remote = [], errors = [];
  await context.route('**/*', route => {
   const url = new URL(route.request().url());
   if (url.hostname !== '127.0.0.1') {remote.push(url.href); return route.abort();}
   const relative = decodeURIComponent(url.pathname.slice(1));
   const filename = path.join(root, relative);
   if (!relative.startsWith('extension/') || !fs.existsSync(filename)) return route.fulfill({status:404,body:''});
   const body = phase==='before' && ['extension/lib/review.js','extension/sidepanel/sidepanel.js'].includes(relative)
    ? execFileSync('git',['show',`${base}:${relative}`],{cwd:root}) : fs.readFileSync(filename);
   return route.fulfill({body,contentType:filename.endsWith('.js')?'text/javascript':filename.endsWith('.css')?'text/css':filename.endsWith('.html')?'text/html':'font/woff2'});
  });
  await context.addInitScript(({phase}) => {
   const listeners=[];
   const initial={store:{version:3,settings:{onboarded:true,resume_details_ready:true},files:{resume:{name:'SYNTHETIC.txt',b64:'Zml4dHVyZQ=='}},profile:{facts:{}}},
    review_ask:{v:phase==='before'?1:2,filled:2,ids:['fixture-1','fixture-2'],next:phase==='before'?1:0,open:phase==='before',asks:phase==='before'?1:0,done:null},
    queue:{order:['fixture-3'],jobs:{'fixture-3':{id:'fixture-3',company:'Fixture Employer',title:'Synthetic Research Internship',status:'ready_to_submit',summary:'Synthetic fixture: review the sample form. No real application is open.',created:1,apply_url:'https://jobs.example.com/fixture'}}}};
   const data=JSON.parse(sessionStorage.getItem('synthetic-extension')||JSON.stringify(initial));
   const change=(patch)=>{const changes={};for(const [key,value] of Object.entries(patch)){changes[key]={oldValue:data[key],newValue:structuredClone(value)};data[key]=structuredClone(value);}sessionStorage.setItem('synthetic-extension',JSON.stringify(data));listeners.forEach(fn=>fn(changes,'local'));};
   window.fixture={data,change};
   window.chrome={runtime:{sendMessage:async m=>{
    if(m.type==='get_queue')return {queue:structuredClone(data.queue)};
    if(m.type==='review_ask'){const r=await import('/extension/lib/review.js');change({review_ask:r.answer(data.review_ask,m.action)});return {ok:true};}
    throw new Error('Unexpected synthetic message: '+m.type);
   }},storage:{local:{get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(key=>[key,structuredClone(data[key])])),set:async patch=>change(patch),remove:async()=>{}},onChanged:{addListener:fn=>listeners.push(fn)}},tabs:{create(){throw new Error('No external tabs allowed in this preview');}}};
  },{phase});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.goto('http://127.0.0.1:8765/extension/sidepanel/sidepanel.html');
  await page.waitForSelector('#addurl');await page.evaluate(()=>document.fonts.ready);
  const capture=async scenario=>{assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:path.join(__dirname,`${phase}-${width}-${colorScheme}-${scenario}.png`),fullPage:true});};
  assert.equal(await page.locator('.card.review').count(),phase==='before'?1:0);
  await capture('second-fill');
  await page.evaluate(async()=>{const r=await import('/extension/lib/review.js');fixture.change({review_ask:r.recordFill(fixture.data.review_ask,'fixture-3')});});
  await page.waitForFunction(()=>document.querySelector('.card.review .q')?.textContent.includes('3 applications'));await capture('third-fill');
  assert.equal(await page.getByText('Leave a review',{exact:true}).count(),2,'passive link remains beside proactive card');
  await page.locator('.card.review [data-review="later"]').focus();
  await page.evaluate(()=>{const q=structuredClone(fixture.data.queue);q.jobs['fixture-3'].status='working';fixture.change({queue:q});});
  if(phase==='after')assert.equal(await page.locator('nav button[data-tab="queue"]').evaluate(el=>el===document.activeElement),true);
  await page.waitForFunction(()=>!document.querySelector('.card.review'));await page.waitForSelector('.card.working');await capture('working');
  await page.evaluate(()=>{const q=structuredClone(fixture.data.queue);q.jobs['fixture-3'].status='ready_to_submit';fixture.change({queue:q});});
  await page.waitForSelector('.card.review');await page.locator('.card.review [data-review="later"]').click();
  await page.waitForFunction(()=>!document.querySelector('.card.review'));await capture('dismissed');
  await page.reload();await page.waitForSelector('#addurl');assert.equal(await page.locator('.card.review').count(),0);await capture('restart');
  assert.equal(await page.getByText('Leave a review',{exact:true}).count(),1);
  assert.deepEqual(remote,[]);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({phase,width,colorScheme,scenarios:5,remoteRequests:0,pageErrors:0}));
  await context.close();
 }} finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
