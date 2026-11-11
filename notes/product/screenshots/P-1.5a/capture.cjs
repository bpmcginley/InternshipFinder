const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const tools=process.env.CAPTURE_TOOLS,{chromium}=require(path.join(tools,'node_modules/playwright-core'));
const root=path.resolve(__dirname,'../../../..'),phase=process.argv[2]||'after',date='2026-11-10T18:00:00Z';
const rows=JSON.parse(fs.readFileSync(path.join(__dirname,'../P-1.3/listings-fixture.json')));
rows.push({...rows[1],id:'p14-closed',company_name:'Fixture Closed Research',title:'Closed Research Intern',status:'closed',apply_url:'https://jobs.example.com/p14-closed'});
rows.push({...rows[1],id:'p14-far',company_name:'Fixture Western Research',title:'Western Research Intern',regions:[{kind:'us',state:'CA',loc:'Irvine, CA'}],apply_url:'https://jobs.example.com/p14-far'});
const states={'p13-stipend':'interested','p13-canada':'applied','p14-closed':'interviewing','p13-unknown':'rejected','p14-missing':'offer'};
const searches=[{name:'Research in Boston',f:{q:'research',states:['MA']}}];
const inKey=(r,k)=>k==='remote'?r.is_remote||(r.regions||[]).some(g=>g.kind==='remote'):(r.regions||[]).some(g=>g.state===k);
const files=Object.fromEntries(['RI','MA','QC','NY','TX','CA','remote'].map(k=>[k,{file:`listings/${k}.json`,open:rows.filter(r=>inKey(r,k)&&r.status==='open').length}]));
async function context(browser,width,colorScheme,{seed=true,blocked=false,delayFar=false,failFar=false,fallback=false}={}){
 const ctx=await browser.newContext({viewport:{width,height:1000},javaScriptEnabled:!fallback,hasTouch:width===375,colorScheme,locale:'en-US',timezoneId:'America/New_York'}),requests=[];
 await ctx.addInitScript(({states,searches,seed,blocked})=>{
  if(!sessionStorage.getItem('fixture-seeded')){localStorage.setItem('internscout.setup.skipped.v1','true');localStorage.setItem('internscout.landing.seen.v1','true');
   if(seed){localStorage.setItem('internscout.appstate.v1',JSON.stringify(states));localStorage.setItem('internscout.saved.v1',JSON.stringify(searches));localStorage.setItem('internscout.visit.v1',JSON.stringify(Date.parse('2026-11-09T18:00:00Z')));}sessionStorage.setItem('fixture-seeded','1');}
  if(blocked)Storage.prototype.setItem=function(){throw new Error('fixture storage blocked');};
 },{states,searches,seed,blocked});
 await ctx.route('**/*',async route=>{
  const u=new URL(route.request().url());requests.push(u.pathname);let file;
  if(u.hostname==='cdn.jsdelivr.net')file=path.join(tools,'node_modules',u.pathname.includes('react-dom@')?'react-dom/umd/react-dom.production.min.js':'react/umd/react.production.min.js');
  else if(u.hostname!=='127.0.0.1')return route.fulfill({json:{}});
  else{const p=decodeURIComponent(u.pathname);
   if(p==='/data/listings/index.json')return route.fulfill({json:{generated_at:date,files,first:{file:'first.json',rows:rows.length,keys:Object.keys(files),sort:'new'}}});
   if(p==='/data/first.json')return route.fulfill({json:rows.filter(r=>['RI','MA','NY','remote'].some(k=>inKey(r,k)))});
   if(p==='/data/listings/CA.json'&&delayFar)await new Promise(r=>setTimeout(r,800));
   if(p==='/data/listings/CA.json'&&failFar)return route.fulfill({status:503,body:''});
   if(p.endsWith('.desc.json'))return route.fulfill({json:{}});
   if(/^\/data\/listings\/[^/]+\.json$/.test(p))return route.fulfill({json:rows.filter(r=>inKey(r,path.basename(p,'.json')))});
   if(p==='/data/stats.json')return route.fulfill({json:{generated_at:date,open:rows.filter(r=>r.status==='open').length,new:0}});
   if(p==='/data/placements.json')return route.fulfill({json:[]});
   file=path.join(root,'docs',p==='/'?'index.html':p);
  }
  if(!fs.existsSync(file))return route.fulfill({status:404,body:''});
  const type={'.html':'text/html','.js':'text/javascript','.json':'application/json','.woff2':'font/woff2','.svg':'image/svg+xml','.png':'image/png'}[path.extname(file)]||'application/octet-stream';
  const body=phase==='before'&&['app.js','index.html'].includes(path.basename(file))?execFileSync('git',['show','bd5d324a:docs/'+path.relative(path.join(root,'docs'),file).replaceAll('\\','/')],{cwd:root}):fs.readFileSync(file);
  return route.fulfill({body,contentType:type,headers:{'access-control-allow-origin':'*'}});
 });
 const page=await ctx.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.clock.install({time:new Date(date)});
 return {ctx,page,errors,requests,setFarFailure:value=>{failFar=value;}};
}
const store=async page=>page.evaluate(()=>Object.fromEntries(Object.keys(localStorage).map(k=>[k,localStorage.getItem(k)])));
const stable=async page=>{await page.waitForSelector('.list .c-co');await page.evaluate(()=>document.fonts.ready);};
const view=page=>page.getByRole('button',{name:/^My list \(/});
const browse=page=>page.getByRole('button',{name:'Browse roles',exact:true});
const save=(page,id)=>page.locator('#listing-'+id+' .save-role');
const settled=async page=>page.waitForFunction(()=>!document.querySelector('.filterbar-foot')?.textContent.includes('Checking current listing data'));

const expected=['internships/','digest/?from=dashboard-nav','install.html?from=dashboard-nav','pricing/','compare/','about/','employers/'];
const measurements=[];
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 try{for(const width of [1280,375])for(const colorScheme of ['light','dark'])for(const fallback of [false,true]){
  const {ctx,page,errors}=await context(browser,width,colorScheme,{fallback});
  await page.goto('http://127.0.0.1:8765/?state=all',{waitUntil:'networkidle'});
  if(!fallback)await stable(page);else await page.evaluate(()=>document.fonts.ready);
  const mode=fallback?'static':'live',name=`${phase}-${mode}-${width}-${colorScheme}`;
  assert.deepEqual(await page.locator('.sitenav a').evaluateAll(els=>els.map(el=>el.getAttribute('href'))),expected);
  assert.equal(await page.locator('.sitenav [data-digest-placement="nav"]').count(),1);
  assert.equal(await page.locator('.sitenav [data-employer-entry="nav"]').count(),1);
  const measure=await page.evaluate(()=>({header:document.querySelector('header.top').getBoundingClientRect().height,brand:document.querySelector('.brand').getBoundingClientRect().height,overflow:document.documentElement.scrollWidth>innerWidth,logo:document.querySelector('.mark').getBoundingClientRect().toJSON(),links:[...document.querySelectorAll('.sitenav a')].map(el=>({text:el.textContent,...el.getBoundingClientRect().toJSON()})),footer:[...document.querySelectorAll('footer .links a')].map(el=>({text:el.textContent,...el.getBoundingClientRect().toJSON()}))}));
  assert.equal(measure.overflow,false);measurements.push({phase,width,colorScheme,mode,...measure});
  await page.screenshot({path:path.join(__dirname,name+'.png'),fullPage:true});
  if(phase==='after'){
   assert.ok(measure.logo.height>=44&&measure.logo.width>=44);
   for(const a of measure.footer)assert.ok(a.height>=44&&a.width>=44,a.text);
   if(width===1280){assert.equal(await page.locator('summary').filter({hasText:'Menu'}).isVisible(),false);for(const a of measure.links)assert.ok(a.height>=44&&a.width>=44,a.text);}
   else{
    const summary=page.locator('.site-navigation summary'),details=page.locator('.site-navigation details'),links=page.locator('.sitenav a');
    assert.equal(await links.first().isVisible(),false);
    await summary.focus();await page.keyboard.press('Space');assert.equal(await details.getAttribute('open'),'');
    for(const a of await links.all()){const r=await a.boundingBox();assert.ok(r.height>=44&&r.width>=44);}
    await page.screenshot({path:path.join(__dirname,name+'-open.png'),fullPage:true});
    await page.keyboard.press('Enter');assert.equal(await links.first().isVisible(),false);
    await page.keyboard.press('Enter');await page.keyboard.press('Tab');assert.equal(await links.first().evaluate(el=>el===document.activeElement),true);
    if(!fallback){
     await page.keyboard.press('Control+Enter');await page.waitForTimeout(100);assert.equal(await details.getAttribute('open'),'');assert.equal(await links.first().evaluate(el=>el===document.activeElement),true,'new tab preserves original focus');for(const extra of ctx.pages().filter(p=>p!==page))await extra.close();await page.keyboard.press('Escape');assert.equal(await summary.evaluate(el=>el===document.activeElement),true);assert.equal(await links.first().isVisible(),false);
     await page.keyboard.press('Enter');await links.last().focus();await page.keyboard.press('Tab');assert.equal(await links.first().isVisible(),false);assert.equal(await summary.evaluate(el=>el===document.activeElement),false,'Tab does not steal destination focus');const outsideFocus=await page.evaluateHandle(()=>document.activeElement);await page.setViewportSize({width:1280,height:1000});await page.waitForTimeout(75);assert.equal(await outsideFocus.evaluate(el=>el===document.activeElement),true,'resize preserves genuine outside Tab focus');await page.setViewportSize({width:375,height:1000});await page.waitForTimeout(75);assert.equal(await outsideFocus.evaluate(el=>el===document.activeElement),true);
     await summary.focus();await page.keyboard.press('Enter');await links.first().focus();
     await page.mouse.click(17,25);assert.equal(await links.first().isVisible(),false,'outside pointer closes');
     await summary.focus();await page.setViewportSize({width:1280,height:1000});await page.waitForFunction(()=>document.activeElement===document.querySelector('.sitenav a'));
     await page.setViewportSize({width:375,height:1000});await page.waitForFunction(()=>document.activeElement===document.querySelector('.site-navigation summary'));
     await page.keyboard.press('Enter');await links.first().evaluate(el=>el.setAttribute('href',location.pathname+location.search+'#listings'));await links.first().click();assert.equal(await page.evaluate(()=>document.activeElement?.id),'listings');assert.equal(await links.first().isVisible(),false,'hash navigation closes without restoring Menu focus');await summary.click();await page.locator('#q').click();assert.equal(await links.first().isVisible(),false);await page.setViewportSize({width:1280,height:1000});await page.waitForTimeout(75);assert.equal(await page.locator('#q').evaluate(el=>el===document.activeElement),true,'resize preserves genuine outside pointer focus');
    }else{await summary.focus();await page.keyboard.press('Enter');assert.equal(await links.first().isVisible(),false);}
   }
  }
  assert.deepEqual(errors,[]);console.log(JSON.stringify({phase,width,colorScheme,mode,header:measure.header,brand:measure.brand,behavior:'passed'}));await ctx.close();
 }}finally{await browser.close();fs.writeFileSync(path.join(__dirname,phase+'-measurements.json'),JSON.stringify(measurements,null,2)+'\n');}
})().catch(error=>{console.error(error);process.exitCode=1;});
