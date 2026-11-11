const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const tools = process.env.CAPTURE_TOOLS;
const {chromium} = require(path.join(tools, 'node_modules/playwright-core'));
const root = path.resolve(__dirname, '../../../..'), phase = process.argv[2] || 'before';
const rows = JSON.parse(fs.readFileSync(path.join(__dirname, 'public-listings.json')));
const date = '2026-11-10T18:00:00Z';
// Public test prices from tests/site/core.test.mjs, not a production configuration response.
const cfg = {providers:[{id:'google',client_id:'fixture',authorize_url:'https://accounts.example/authorize'}],
 payments:{enabled:true,plans:[{plan:'supporter',label:'Supporter',price:'$4/month',multiplier:2},{plan:'pro',label:'Pro',price:'$8/month',multiplier:4}]},
 allowance:{general:{autofill:12},edu:{autofill:25},supporter:{autofill:50},pro:{autofill:100}}};
const files = Object.fromEntries(['CT','MA','ME','NH','NJ','NY','RI','VT','remote'].map(k=>[k,{file:`listings/${k}.json`,open:rows.filter(r=>r.state===k).length}]));
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 try { for(const width of [1280,375]) for(const colorScheme of ['light','dark']) {
  const ctx=await browser.newContext({viewport:{width,height:1000},colorScheme,deviceScaleFactor:1,locale:'en-US',timezoneId:'America/New_York'});
  await routes(ctx);
  const page=await ctx.newPage(), errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.clock.install({time:new Date(date)});
  await page.goto('http://127.0.0.1:8765/',{waitUntil:'networkidle'});
  await page.waitForSelector('.list .c-co'); await page.evaluate(()=>document.fonts.ready);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:path.join(__dirname,`${phase}-${width}-${colorScheme}.png`),fullPage:true});
  if(phase==='after') {
   assert.match(await page.locator('.list .c-co').first().innerText(),/Echo/);
   await choose(page,'Statistics and Data Science');
   assert.match(await page.locator('.list .c-co').first().innerText(),/Mason/,'major immediately changes ranking');
   assert.equal(await page.locator('footer .plansline').count(),1);
   assert.equal(await page.locator('.figures .plansline').count(),0);
   assert.equal(await page.getByRole('button',{name:'Rank for my major',exact:true}).count(),0);
   const p=await profile(page); assert.equal(p.class_year,''); assert.deepEqual(p.states,[]);
   await page.getByRole('combobox',{name:'I study',exact:true}).press('Escape');
   await page.getByRole('combobox',{name:'I study',exact:true}).press('Tab');
   assert.equal(await page.getByRole('combobox',{name:'Class year (optional)',exact:true}).evaluate(el=>el===document.activeElement),true,'Tab reaches optional year');
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   await page.screenshot({path:path.join(__dirname,`after-selected-${width}-${colorScheme}.png`),fullPage:true});
   await page.getByRole('button',{name:'Done',exact:true}).click();
   await page.waitForFunction(()=>document.activeElement.id==='listings');
   await page.reload({waitUntil:'networkidle'});
   assert.deepEqual((await profile(page)).majors,['Statistics and Data Science']);
   assert.equal(await page.locator('.quick-profile').count(),0,'returning profile does not repeat onboarding');
  }
  assert.deepEqual(errors,[]); console.log(JSON.stringify({phase,width,colorScheme,errors}));
  await ctx.close();
 }
 if(phase==='after') await behavior(browser);
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});

async function routes(ctx,{failMajors=false}={}) {
 await ctx.route('**/*',async route=>{
   const u=new URL(route.request().url()); let file;
   if(u.hostname==='cdn.jsdelivr.net') file=path.join(tools,'node_modules',u.pathname.includes('react-dom@')?'react-dom/umd/react-dom.production.min.js':'react/umd/react.production.min.js');
   else if(u.hostname!=='127.0.0.1') return route.fulfill({json:u.pathname==='/config'?cfg:{}});
   else {
    const p=decodeURIComponent(u.pathname);
    if(failMajors&&p==='/data/majors.json')return route.fulfill({status:404,body:''});
    if(p==='/data/listings/index.json')return route.fulfill({json:{generated_at:date,files,first:{file:'first.json',rows:rows.length,keys:Object.keys(files),sort:'new'}}});
    if(p==='/data/first.json')return route.fulfill({json:rows});
    if(/^\/data\/listings\/[^/]+\.json$/.test(p))return route.fulfill({json:rows.filter(r=>p.endsWith('/'+r.state+'.json'))});
    if(p==='/data/stats.json')return route.fulfill({json:{generated_at:date,open:rows.length,new:rows.length}});
    if(p==='/data/placements.json')return route.fulfill({json:[]});
    file=path.join(root,'docs',p==='/'?'index.html':p);
   }
   if(!fs.existsSync(file))return route.fulfill({status:404,body:''});
   const type={'.html':'text/html','.js':'text/javascript','.json':'application/json','.woff2':'font/woff2','.svg':'image/svg+xml','.png':'image/png'}[path.extname(file)]||'application/octet-stream';
   const body=phase==='before'&&['app.js','index.html'].includes(path.basename(file))?execFileSync('git',['show','aef83ea3:docs/'+path.relative(path.join(root,'docs'),file).replaceAll('\\','/')],{cwd:root}):fs.readFileSync(file);
   return route.fulfill({body,contentType:type,headers:{'access-control-allow-origin':'*'}});
 });
}
const profile=page=>page.evaluate(()=>IS.loadProfile());
async function choose(page,major) {
 const input=page.getByRole('combobox',{name:'I study',exact:true});
 await input.fill(major);
 await input.evaluate(el=>{window.__quickInput=el;});
 await input.press('Enter');
 await page.waitForFunction(m=>{const t=document.querySelector('.quick-profile')?.textContent||'';return t.includes('Ranking for ')&&t.includes(m);},major);
 assert.equal(await input.evaluate(el=>el===window.__quickInput&&el===document.activeElement),true,'same combobox keeps focus through first save');
}
async function behavior(browser) {
 async function run(name,opts,body) {
  const ctx=await browser.newContext({viewport:{width:375,height:1000}}), errors=[];
  await routes(ctx,opts);
  if(opts.init)await ctx.addInitScript(opts.init);
  const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));
  if(opts.extension) {
   await ctx.addInitScript(()=>{
    document.addEventListener('DOMContentLoaded',()=>{document.documentElement.dataset.internscout='test';window.postMessage({__internscout:'hello'},location.origin);});
    window.addEventListener('message',e=>{
     const d=e.data;if(e.source!==window||d?.__internscout!=='req')return;
     if(d.msg.type==='profile:get'){window.__profileRequest=d.id;return;}
     const result=d.msg.type==='ping'?{ok:true,onboarded:false}:d.msg.type==='get_queue'?{queue:{order:[],jobs:{}}}:{};
     window.postMessage({__internscout:'res',id:d.id,result},location.origin);
    });
   });
   await page.clock.install({time:new Date(date)});await page.clock.pauseAt(new Date(date));
  }
  await page.goto('http://127.0.0.1:8765/'+(opts.query||''),{waitUntil:'networkidle'});
  await body(page);assert.deepEqual(errors,[]);await ctx.close();console.log(JSON.stringify({case:name,passed:true}));
 }
 await run('filters, statuses, saved searches, optional choices and deletion',{query:'?field=swe&state=NY&company=Zingage&q=Engineer&stage=co_op&status=open&new=1',init:()=>{
  localStorage.setItem('internscout.appstate.v1',JSON.stringify({'1c3412b44f2263f3':'saved'}));
  localStorage.setItem('internscout.saved.v1',JSON.stringify([{name:'fixture search',f:{q:'keep'}}]));
 }},async page=>{
  const before=new URL(page.url()).searchParams;
  const stored=await page.evaluate(()=>[localStorage.getItem('internscout.appstate.v1'),localStorage.getItem('internscout.saved.v1')]);
  assert.equal(await profile(page),null,'landing prefill is not automatically saved');
  await choose(page,'Psychology');
  const after=new URL(page.url()).searchParams;
  for(const [k,v] of before)if(k!=='sort')assert.equal(after.get(k),v,k);
  assert.equal(await page.getByRole('combobox',{name:'Sort',exact:true}).inputValue(),'score');
  assert.deepEqual((await profile(page)).majors,['Psychology'],'choice overrides field-derived major');
  await page.getByRole('combobox',{name:'Class year (optional)',exact:true}).selectOption('junior');
  const states=page.getByRole('combobox',{name:'Preferred states or provinces (optional)',exact:true});
  await states.fill('Massachusetts');await states.press('Enter');await states.press('Escape');
  const saved=await profile(page);assert.equal(saved.class_year,'junior');assert.deepEqual(saved.states,['MA']);
  assert.deepEqual(await page.evaluate(()=>[localStorage.getItem('internscout.appstate.v1'),localStorage.getItem('internscout.saved.v1')]),stored);
  assert.equal(new URL(page.url()).searchParams.get('state'),'NY','explicit state filter survives optional preference');
  await page.getByRole('button',{name:'Open profile setup',exact:true}).click();
  page.on('dialog',d=>d.accept());
  await page.getByRole('button',{name:/Delete my data/}).click();
  await page.waitForSelector('.quick-profile');
  assert.equal(await profile(page),null);assert.doesNotMatch(await page.locator('.quick-profile').innerText(),/Ranking for|Preferences updated/);
 });
 await run('delayed extension import cannot overwrite manual quick choice',{extension:true},async page=>{
  await page.waitForFunction(()=>window.__profileRequest);
  const selected=page.getByRole('checkbox',{name:'Select Echo, Software Engineering Intern',exact:true});
  await selected.check();
  await choose(page,'Psychology');
  await page.evaluate(()=>window.postMessage({__internscout:'res',id:window.__profileRequest,result:{profile:{majors:['Nursing'],class_year:'senior'}}},location.origin));
  await page.waitForTimeout(100);
  assert.deepEqual((await profile(page)).majors,['Psychology']);
  assert.equal(await selected.isChecked(),true,'selected listing stays selected across reranking');
 });
 await run('existing imported profile preferences survive fast partial choices',{extension:true},async page=>{
  await page.waitForFunction(()=>window.__profileRequest);
  await page.evaluate(()=>window.postMessage({__internscout:'res',id:window.__profileRequest,result:{profile:{majors:['Nursing'],minors:['Biology'],fields:['health'],class_year:'junior',grad_term:'Fall 2027',stages:['research'],terms:['Spring 2027'],paid_only:true,states:['RI','REMOTE'],work_auth:'visa'}}},location.origin));
  await page.waitForFunction(()=>IS.loadProfile()?.majors.includes('Nursing'));
  const before=await profile(page);await choose(page,'Psychology');
  const after=await profile(page);for(const k of Object.keys(before).filter(k=>!['majors','updated'].includes(k)))assert.deepEqual(after[k],before[k],k);
  await page.getByRole('combobox',{name:'Class year (optional)',exact:true}).selectOption('senior');
  assert.deepEqual((await profile(page)).stages,['research']);
 });
 await run('blocked storage keeps current-page ranking usable',{init:()=>{Storage.prototype.setItem=()=>{throw new Error('storage blocked fixture');};}},async page=>{
  await choose(page,'Statistics and Data Science');
  assert.match(await page.locator('.list .c-co').first().innerText(),/Mason/);
  assert.equal(await profile(page),null,'blocked storage cannot promise reload persistence');
 });
 await run('major failure has field fallback in full setup',{failMajors:true},async page=>{
  await page.getByText("The major list didn't load. Open profile setup to choose fields instead.",{exact:true}).waitFor();
  assert.equal(await page.getByRole('combobox',{name:'I study',exact:true}).count(),0);
  await page.getByRole('button',{name:'Open profile setup',exact:true}).click();
  assert.match(await page.locator('.setup').innerText(),/field/i);
 });
 await run('skipping quick setup preserves the full editor and landing prefill',{query:'?field=nursing'},async page=>{
  await page.getByRole('button',{name:'Not now',exact:true}).click();
  await page.waitForFunction(()=>document.activeElement.id==='q');
  assert.equal(await profile(page),null);
  await page.reload({waitUntil:'networkidle'});
  assert.equal(await page.locator('.quick-profile').count(),0);
  await page.getByRole('button',{name:'Set up profile',exact:true}).click();
  assert.match(await page.locator('.setup').innerText(),/Nursing/);
  assert.equal(await profile(page),null,'full editor prefill is not an automatic save');
 });
}
