const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const tools=process.env.CAPTURE_TOOLS,{chromium}=require(path.join(tools,'node_modules/playwright-core'));
const root=path.resolve(__dirname,'../../../..'),phase=process.argv[2]||'before';
const rows=JSON.parse(fs.readFileSync(path.join(__dirname,'listings-fixture.json'))),date='2026-11-10T18:00:00Z';
const inKey=(r,k)=>k==='remote'?r.is_remote||(r.regions||[]).some(g=>g.kind==='remote'):(r.regions||[]).some(g=>g.state===k);
const files=Object.fromEntries(['RI','MA','QC','NY','TX','remote'].map(k=>[k,{file:`listings/${k}.json`,open:rows.filter(r=>inKey(r,k)).length}]));
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 try {for(const width of [1280,375])for(const colorScheme of ['light','dark']){
  const ctx=await browser.newContext({viewport:{width,height:1000},colorScheme,locale:'en-US',timezoneId:'America/New_York'});
  await ctx.addInitScript(()=>{localStorage.setItem('internscout.setup.skipped.v1','true');localStorage.setItem('internscout.landing.seen.v1','true');});
  await ctx.route('**/*',async route=>{
   const u=new URL(route.request().url());let file;
   if(u.hostname==='cdn.jsdelivr.net')file=path.join(tools,'node_modules',u.pathname.includes('react-dom@')?'react-dom/umd/react-dom.production.min.js':'react/umd/react.production.min.js');
   else if(u.hostname!=='127.0.0.1')return route.fulfill({json:{}});
   else{
    const p=decodeURIComponent(u.pathname);
    if(p==='/data/listings/index.json')return route.fulfill({json:{generated_at:date,files,first:{file:'first.json',rows:rows.length,keys:Object.keys(files),sort:'new'}}});
    if(p==='/data/first.json')return route.fulfill({json:rows});
    if(/^\/data\/listings\/[^/]+\.json$/.test(p))return route.fulfill({json:rows.filter(r=>inKey(r,path.basename(p,'.json')))});
    if(p==='/data/stats.json')return route.fulfill({json:{generated_at:date,open:rows.length,new:0}});
    if(p==='/data/placements.json')return route.fulfill({json:[]});
    file=path.join(root,'docs',p==='/'?'index.html':p);
   }
   if(!fs.existsSync(file))return route.fulfill({status:404,body:''});
   const type={'.html':'text/html','.js':'text/javascript','.json':'application/json','.woff2':'font/woff2','.svg':'image/svg+xml','.png':'image/png'}[path.extname(file)]||'application/octet-stream';
   const body=phase==='before'&&['app.js','index.html'].includes(path.basename(file))?execFileSync('git',['show','98f22627:docs/'+path.relative(path.join(root,'docs'),file).replaceAll('\\','/')],{cwd:root}):fs.readFileSync(file);
   return route.fulfill({body,contentType:type,headers:{'access-control-allow-origin':'*'}});
  });
  const page=await ctx.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.clock.install({time:new Date(date)});
  await page.goto('http://127.0.0.1:8765/?state=all',{waitUntil:'networkidle'});
  await page.waitForSelector('.list .c-co');await page.waitForSelector('.rowbtn.try');await page.evaluate(()=>document.fonts.ready);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:path.join(__dirname,`${phase}-${width}-${colorScheme}.png`),fullPage:true});
  if(phase==='after'){
   const paid=page.locator('#listing-p13-pay');
   assert.match(await paid.innerText(),/North Kingstown, RI \+1 more/);
   assert.equal(await paid.locator('.facts span[title]').getAttribute('title'),rows[0].regions.map(g=>g.loc).join('; '));
   assert.equal(await paid.locator('time>[aria-hidden=true]').innerText(),'Posted 2 days ago');
   assert.equal(await paid.locator('time .sr').innerText(),'Posted '+await paid.locator('time').getAttribute('title'));
   assert.equal(await page.locator('#listing-p13-stipend time>[aria-hidden=true]').innerText(),'Posted yesterday');
   assert.match(await page.locator('#listing-p13-canada .facts').innerText(),/Montréal, QC, Canada/);
   assert.match(await page.locator('#listing-p13-remote .facts').innerText(),/Remote, TX/);
   const future=page.locator('#listing-p13-future time');
   assert.equal(await future.locator('[aria-hidden=true]').innerText(),'Posted '+await future.getAttribute('title'));
   assert.equal(await page.locator('.list .pay-badge').count(),3);
   assert.equal(await page.locator('.list .company-tile[aria-hidden=true]').count(),rows.length);
   const minContrast=await page.evaluate(()=>{
    const probe=document.createElement('span');probe.className='company-tile';probe.style.position='fixed';probe.style.left='-100px';document.body.append(probe);
    const lum=s=>s.match(/[\d.]+/g).slice(0,3).map(Number).map(x=>{x/=255;return x<=0.04045?x/12.92:((x+0.055)/1.055)**2.4;}).reduce((sum,x,i)=>sum+x*[0.2126,0.7152,0.0722][i],0);
    let min=Infinity;for(let hue=0;hue<360;hue++){probe.style.setProperty('--company-hue',hue);const css=getComputedStyle(probe),a=lum(css.color),b=lum(css.backgroundColor);min=Math.min(min,(Math.max(a,b)+.05)/(Math.min(a,b)+.05));}probe.remove();return min;
   });
   assert.ok(minContrast>=4.5,`all 360 tile hues meet text contrast: ${minContrast}`);
   const details=page.getByRole('button',{name:'Details: Fixture Robotics, Software Engineering Intern',exact:true});
   await details.click();const why=page.getByRole('region',{name:'Why: Fixture Robotics, Software Engineering Intern',exact:true});
   await why.waitFor();assert.match(await why.innerText(),/Job board: Ashby/);
   assert.doesNotMatch(await paid.innerText(),/Ashby/);
   if(width===375)await page.screenshot({path:path.join(__dirname,`after-details-${width}-${colorScheme}.png`),fullPage:true});
   await why.press('Escape');await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='Details: Fixture Robotics, Software Engineering Intern');
   const auto=paid.locator('.rowbtn.try');assert.equal(await auto.getAttribute('title'),'Fills from your resume. You review and submit.');
   await auto.click();assert.equal(await auto.getAttribute('aria-expanded'),'true');assert.match(await page.locator('.aa-info').innerText(),/You review it and press Submit yourself/);
   await auto.click();assert.equal(await auto.getAttribute('aria-expanded'),'false');
   await page.getByRole('button',{name:'Details: Fixture Arts, Creative Intern',exact:true}).click();
   const other=page.getByRole('region',{name:'Why: Fixture Arts, Creative Intern',exact:true});assert.doesNotMatch(await other.innerText(),/Job board:/);await other.press('Escape');
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   if(width===375&&colorScheme==='dark'){
    await page.evaluate(()=>{
     window.__requests=[];window.addEventListener('message',e=>{const d=e.data;if(e.source!==window||d?.__internscout!=='req')return;window.__requests.push(d.msg.type);const result=d.msg.type==='ping'?{ok:true,onboarded:false}:d.msg.type==='get_queue'?{queue:{order:[],jobs:{}}}:{};window.postMessage({__internscout:'res',id:d.id,result},location.origin);});
     document.documentElement.dataset.internscout='fixture';window.postMessage({__internscout:'hello'},location.origin);
    });
    await page.waitForSelector('#listing-p13-pay .rowbtn:not(.try)');
    assert.match(await page.locator('#listing-p13-unknown .aa-note').innerText(),/asks for site access/);
    const selected=page.getByRole('checkbox',{name:'Select Fixture Robotics, Software Engineering Intern',exact:true});await selected.check();assert.equal(await selected.isChecked(),true);
    assert.equal(await paid.locator('.rowbtn').isEnabled(),true);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.screenshot({path:path.join(__dirname,'after-installed-375-dark.png'),fullPage:true});
    assert.equal((await page.evaluate(()=>window.__requests)).some(type=>/queue:add|run|submit/.test(type)),false);
   }
   console.log(JSON.stringify({width,colorScheme,minContrast,behavior:'passed'}));
  }
  assert.deepEqual(errors,[]);console.log(JSON.stringify({phase,width,colorScheme,errors}));await ctx.close();
 }}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
