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
async function context(browser,width,colorScheme,{seed=true,blocked=false,delayFar=false,failFar=false}={}){
 const ctx=await browser.newContext({viewport:{width,height:1000},colorScheme,locale:'en-US',timezoneId:'America/New_York'}),requests=[];
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
  const body=phase==='before'&&['app.js','index.html'].includes(path.basename(file))?execFileSync('git',['show','9c5d14c1:docs/'+path.relative(path.join(root,'docs'),file).replaceAll('\\','/')],{cwd:root}):fs.readFileSync(file);
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
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 try{for(const width of (process.argv.includes('--extra-only')?[]:[1280,375]))for(const colorScheme of ['light','dark']){
  const {ctx,page,errors,requests}=await context(browser,width,colorScheme);await page.goto('http://127.0.0.1:8765/?state=all',{waitUntil:'networkidle'});await stable(page);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  if(phase==='after'){
   await page.evaluate(()=>{window.fixtureCounts=[];IS.count=name=>window.fixtureCounts.push(name);});
   assert.equal(await page.locator('.list select.mine').count(),0);
   assert.match(await page.locator('#listing-p13-pay').innerText(),/New since your last visit/);
   await save(page,'p13-pay').focus();await page.keyboard.press('Space');assert.equal(await save(page,'p13-pay').getAttribute('aria-pressed'),'true');
   assert.equal(await save(page,'p13-pay').evaluate(el=>el===document.activeElement),true);
   await page.screenshot({path:path.join(__dirname,`after-${width}-${colorScheme}.png`),fullPage:true});
   const beforeRequests=requests.filter(p=>/^\/data\/listings\/[^/]+\.json$/.test(p)).length;
   await view(page).click();await settled(page);assert.equal(await page.locator('.list select.mine').count(),6);
   assert.match(await page.locator('#listing-p14-closed').innerText(),/Closed/);
   assert.match(await page.locator('#listing-p14-missing').innerText(),/Current posting status unknown/);
   assert.doesNotMatch(await page.locator('#listing-p14-missing').innerText(),/Closed|Auto-Apply|Pay not listed/);
   assert.equal(requests.filter(p=>/^\/data\/listings\/[^/]+\.json$/.test(p)).length,beforeRequests,'already loaded shards cause no additional requests');
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   await page.screenshot({path:path.join(__dirname,`after-mylist-${width}-${colorScheme}.png`),fullPage:true});
   await page.locator('#listing-p13-stipend select.mine').selectOption('interviewing');
   await save(page,'p13-canada').focus();await page.keyboard.press('Space');await page.waitForFunction(()=>document.activeElement?.id==='listings');
   assert.equal(await page.locator('#listing-p13-canada').count(),0);
   let kept=await store(page);assert.equal(JSON.parse(kept['internscout.appstate.v1'])['p13-canada'],'applied');assert.equal(JSON.parse(kept['internscout.mylist.v1']).roles['p13-canada'].saved,false);
   assert.deepEqual(JSON.parse(kept['internscout.saved.v1']),searches);
   // Status changes and Mark applied can remove the focused row from a progress-filtered view.
   await page.locator('#listing-p13-stipend select.mine').selectOption('interested');await page.getByRole('combobox',{name:'My list progress',exact:true}).selectOption('interested');
   const filteredPosting=page.locator('#listing-p13-stipend .open-link');await filteredPosting.evaluate(el=>el.addEventListener('click',e=>e.preventDefault(),{once:true}));await filteredPosting.click();
   await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'));Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});document.dispatchEvent(new Event('visibilitychange'));});
   await page.locator('#ask-p13-stipend').getByRole('button',{name:'Mark applied',exact:true}).click();await page.waitForFunction(()=>document.activeElement?.id==='listings');assert.equal(await page.locator('#listing-p13-stipend').count(),0);
   await page.getByRole('combobox',{name:'My list progress',exact:true}).selectOption('applied');await page.locator('#listing-p13-stipend select.mine').selectOption('rejected');await page.waitForFunction(()=>document.activeElement?.id==='listings');
   await page.getByRole('combobox',{name:'My list progress',exact:true}).selectOption('');
   await browse(page).click();await page.locator('#q').fill('research');await page.waitForTimeout(500);const filteredUrl=page.url();
   await view(page).click();await settled(page);await browse(page).click();assert.equal(await page.locator('#q').inputValue(),'research');assert.equal(page.url(),filteredUrl);
   await page.locator('#q').fill('');await page.waitForTimeout(500);await page.reload({waitUntil:'networkidle'});await stable(page);
   assert.equal(await page.locator('.list .new').count(),0,'the next visit has no newly first-seen fixture roles');
   await view(page).click();await settled(page);assert.equal(await page.locator('#listing-p13-canada').count(),0,'reload does not remigrate explicit unsave');
   await browse(page).click();await save(page,'p13-canada').click();kept=await store(page);assert.equal(JSON.parse(kept['internscout.appstate.v1'])['p13-canada'],'applied');
   // Preserve the return prompt while keeping an explicitly unsaved role out of My list.
   await save(page,'p13-pay').click();const posting=page.locator('#listing-p13-pay .open-link');await posting.evaluate(el=>el.addEventListener('click',e=>e.preventDefault(),{once:true}));await posting.click();
   await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'));Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});document.dispatchEvent(new Event('visibilitychange'));});
   await page.locator('#ask-p13-pay').getByRole('button',{name:'Mark applied',exact:true}).click();await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='Save Software Engineering Intern at Fixture Robotics');
   kept=await store(page);assert.equal(JSON.parse(kept['internscout.appstate.v1'])['p13-pay'],'applied');assert.equal(JSON.parse(kept['internscout.mylist.v1']).roles['p13-pay'].saved,false);
   if(width===375&&colorScheme==='dark'){
    // Cancel preserves all tracker stores; accepting the second confirm clears them.
    await page.evaluate(()=>IS.saveProfile(IS.emptyProfile()));await page.reload({waitUntil:'networkidle'});await stable(page);
    let confirms=0;const cancelTracker=async dialog=>{assert.equal(dialog.type(),'confirm');confirms++;confirms===1?await dialog.accept():await dialog.dismiss();};page.on('dialog',cancelTracker);
    await page.getByRole('button',{name:'My profile',exact:true}).click();await page.getByRole('button',{name:'Delete my data',exact:true}).click();await page.waitForFunction(()=>!!document.querySelector('.quick-profile'));
    page.off('dialog',cancelTracker);assert.equal(confirms,2);kept=await store(page);assert.ok(kept['internscout.mylist.v1']);assert.ok(kept['internscout.visit.v1']);assert.ok(kept['internscout.saved.v1']);
    await view(page).click();await settled(page);const dismiss=dialog=>dialog.dismiss();page.on('dialog',dismiss);await page.getByRole('button',{name:'Delete browser tracker',exact:true}).click();page.off('dialog',dismiss);assert.ok((await store(page))['internscout.mylist.v1']);
    page.on('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Delete browser tracker',exact:true}).click();await page.waitForTimeout(100);
    kept=await store(page);for(const key of ['internscout.mylist.v1','internscout.visit.v1','internscout.appstate.v1','internscout.saved.v1'])assert.equal(kept[key],undefined,key);
   }
  }else await page.screenshot({path:path.join(__dirname,`before-${width}-${colorScheme}.png`),fullPage:true});
  assert.deepEqual(errors,[]);console.log(JSON.stringify({phase,width,colorScheme,behavior:'passed'}));await ctx.close();
 }
 if(phase==='after'){
  const {ctx,page,errors,requests}=await context(browser,375,'light',{seed:false});await page.goto('http://127.0.0.1:8765/?state=RI',{waitUntil:'networkidle'});await stable(page);
  assert.equal(await page.locator('.list .new').count(),0,'first visit has no badge');await save(page,'p13-pay').click();const before=requests.length;await view(page).click();await settled(page);assert.equal(requests.length,before,'one cached save does not fetch extra data');await ctx.close();assert.deepEqual(errors,[]);
  const blocked=await context(browser,375,'dark',{seed:false,blocked:true});await blocked.page.goto('http://127.0.0.1:8765/?state=RI',{waitUntil:'networkidle'});await stable(blocked.page);await save(blocked.page,'p13-pay').click();await view(blocked.page).click();await settled(blocked.page);assert.match(await blocked.page.locator('main').innerText(),/last only in this tab/);assert.equal(await blocked.page.locator('#listing-p13-pay').count(),1);assert.deepEqual(blocked.errors,[]);await blocked.ctx.close();
  const hinted=await context(browser,375,'light',{seed:false,delayFar:true});
  await hinted.ctx.addInitScript(()=>localStorage.setItem('internscout.mylist.v1',JSON.stringify({version:1,roles:{'p14-far':{saved:true,company:'Fixture saved identity',title:'Saved research role',shards:['CA']}}})));
  await hinted.page.goto('http://127.0.0.1:8765/?state=RI',{waitUntil:'networkidle'});await stable(hinted.page);assert.equal(hinted.requests.includes('/data/listings/CA.json'),false);
  await view(hinted.page).click();assert.match(await hinted.page.locator('#listing-p14-far').innerText(),/Checking current listing data/);await settled(hinted.page);assert.match(await hinted.page.locator('#listing-p14-far').innerText(),/Fixture Western Research/);
  await browse(hinted.page).click();assert.equal(await hinted.page.locator('#listing-p14-far').count(),0,'My list loading does not broaden Browse scope');assert.deepEqual(hinted.errors,[]);await hinted.ctx.close();
  const failed=await context(browser,375,'dark',{seed:false,failFar:true});
  await failed.ctx.addInitScript(()=>localStorage.setItem('internscout.mylist.v1',JSON.stringify({version:1,roles:{'p14-far':{saved:true,company:'Fixture saved identity',title:'Saved research role',shards:['CA']}}})));
  await failed.page.goto('http://127.0.0.1:8765/?state=RI',{waitUntil:'networkidle'});await stable(failed.page);await view(failed.page).click();await settled(failed.page);
  assert.match(await failed.page.locator('#listing-p14-far').innerText(),/Couldn't check current listing data/);assert.doesNotMatch(await failed.page.locator('#listing-p14-far').innerText(),/Closed/);
  await failed.page.screenshot({path:path.join(__dirname,'after-unavailable-375-dark.png'),fullPage:true});failed.setFarFailure(false);await failed.page.getByRole('button',{name:'Retry saved role details',exact:true}).click();await failed.page.waitForFunction(()=>document.querySelector('#listing-p14-far .co')?.textContent==='Fixture Western Research');await settled(failed.page);assert.match(await failed.page.locator('#listing-p14-far').innerText(),/Fixture Western Research/);assert.deepEqual(failed.errors,[]);await failed.ctx.close();
  const selected=await context(browser,1280,'light',{seed:false});
  await selected.ctx.addInitScript(()=>{
   window.fixtureQueue={order:[],jobs:{}};window.fixtureEnqueues=[];
   window.addEventListener('message',e=>{const d=e.data;if(e.source!==window||d?.__internscout!=='req')return;let result={};
    if(d.msg.type==='ping')result={ok:true,onboarded:true};
    if(d.msg.type==='get_queue')result={queue:window.fixtureQueue};
    if(d.msg.type==='enqueue'){window.fixtureEnqueues.push(d.msg.jobs.map(j=>j.id));const added=[];for(const job of d.msg.jobs){const id='fixture-'+job.id;added.push(id);window.fixtureQueue.order.push(id);window.fixtureQueue.jobs[id]={...job,id,listingId:job.id,status:'queued',updated:1};}result={added,skipped:[]};window.postMessage({__internscout:'push',queue:window.fixtureQueue},location.origin);}
    window.postMessage({__internscout:'res',id:d.id,result},location.origin);
   });
  });
  await selected.page.goto('http://127.0.0.1:8765/?state=all',{waitUntil:'networkidle'});await stable(selected.page);await selected.page.waitForSelector('#listing-p13-pay .c-chk input');
  await save(selected.page,'p13-stipend').click();await selected.page.locator('#listing-p13-pay .c-chk input').check();await view(selected.page).click();await settled(selected.page);
  assert.equal(await selected.page.getByRole('button',{name:'Auto-Apply',exact:true}).isDisabled(),true,'Browse selection is not queued in My list');
  await selected.page.locator('#listing-p13-stipend .c-chk input').check();await browse(selected.page).click();assert.equal(await selected.page.locator('#listing-p13-pay .c-chk input').isChecked(),true);assert.equal(await selected.page.locator('#listing-p13-stipend .c-chk input').isChecked(),false,'My list selection is separate');
  await selected.page.locator('#listing-p13-stipend .c-chk input').check();await view(selected.page).click();await settled(selected.page);await selected.page.getByRole('button',{name:'Auto-Apply 1 selected',exact:true}).click();
  await selected.page.waitForFunction(()=>window.fixtureEnqueues.length===1);assert.deepEqual(await selected.page.evaluate(()=>window.fixtureEnqueues),[['p13-stipend']]);await browse(selected.page).click();assert.equal(await selected.page.locator('#listing-p13-pay .c-chk input').isChecked(),true);assert.equal(await selected.page.locator('#listing-p13-stipend .c-chk input').isChecked(),false,'queued IDs clear in both views without losing other picks');assert.deepEqual(selected.errors,[]);await selected.ctx.close();
  rows[0].first_seen='2026-11-10T16:00:00';rows[1].first_seen='2026-11-10T10:00:00';
  const utc=await context(browser,375,'light');await utc.ctx.addInitScript(()=>localStorage.setItem('internscout.visit.v1',JSON.stringify(Date.parse('2026-11-10T12:00:00Z'))));await utc.page.goto('http://127.0.0.1:8765/?state=all',{waitUntil:'networkidle'});await stable(utc.page);assert.equal(await utc.page.locator('#listing-p13-pay .new').count(),1);assert.equal(await utc.page.locator('#listing-p13-stipend .new').count(),0);assert.deepEqual(utc.errors,[]);await utc.ctx.close();
  for(let i=0;i<151;i++){const id='p14-bulk-'+i;rows.push({...rows[0],id,company_name:'Fixture bulk '+i,regions:[{kind:'us',state:'RI',loc:'Providence, RI'}],apply_url:'https://jobs.example.com/'+id});states[id]='interested';}
  const many=await context(browser,375,'light');await many.page.goto('http://127.0.0.1:8765/?state=all',{waitUntil:'networkidle'});await stable(many.page);await view(many.page).click();await settled(many.page);
  assert.equal(await many.page.locator('.list select.mine').count(),150);assert.match(await many.page.locator('.filterbar-foot').innerText(),/150 of 156 saved roles shown/);await many.page.waitForTimeout(1000);assert.match(await many.page.locator('[aria-live=polite][aria-atomic=true]').innerText(),/150 of 156 saved roles shown/);
  await many.page.getByRole('button',{name:'Show 6 more',exact:true}).click();assert.equal(await many.page.locator('.list select.mine').count(),156);assert.match(await many.page.locator('.filterbar-foot').innerText(),/156 of 156 saved roles shown/);assert.deepEqual(many.errors,[]);await many.ctx.close();
  console.log(JSON.stringify({extraCases:'first visit, cached save, blocked storage, hinted/delayed/failing/retried shards, view selections and mocked queue, naive UTC timestamps in New York, 156-role pagination passed'}));
 }
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
