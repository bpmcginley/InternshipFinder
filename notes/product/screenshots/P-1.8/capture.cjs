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
async function context(browser,width,colorScheme,{seed=true,blocked=false,delayFar=false,failFar=false,fallback=false,signedIn=true,failMe=false,failInvite=false,failConfig=false,paused=false,limit=27,bonus=0,used=27,capped=false,blockedReturn=false,disabledBase=false,plan='free',tier='edu',canUpgrade=true,holdConfig=false,stallBilling=false}={}){
 let configFails=failConfig,meFails=failMe,inviteFails=failInvite,holdOld=false,billingStall=stallBilling;const releases=[],configReleases=[],billingReleases=[];const calls=[];const cfg={providers:[{id:'google',client_id:'fixture',authorize_url:'https://signin.fixture.test/authorize'}],payments:{enabled:true,plans:[{plan:'supporter',label:'Supporter',multiplier:2,price:'$8/month (fixture)'},{plan:'pro',label:'Pro',multiplier:4,price:'$16/month (fixture)'}]},allowance:{edu:{autofill:20},general:{autofill:10},supporter:{autofill:40},pro:{autofill:80}},invite:{bonus:{autofill:3},max:2}};if(disabledBase)cfg.allowance.edu.autofill=0;
 const ctx=await browser.newContext({viewport:{width,height:1000},javaScriptEnabled:!fallback,hasTouch:width===375,colorScheme,locale:'en-US',timezoneId:'America/New_York'}),requests=[];
 await ctx.addInitScript(({states,searches,seed,blocked,signedIn,blockedReturn})=>{
  if(!sessionStorage.getItem('fixture-seeded')){localStorage.setItem('internscout.setup.skipped.v1','true');localStorage.setItem('internscout.landing.seen.v1','true');
   if(signedIn)localStorage.setItem('internscout.session',JSON.stringify({token:'iss_fixture_a',account:'fixture-a',email:'student@example.edu',expires:'2027-11-10T18:00:00Z'}));history.replaceState({fixture:'keep'},'',location.href);
   if(seed){localStorage.setItem('internscout.appstate.v1',JSON.stringify(states));localStorage.setItem('internscout.saved.v1',JSON.stringify(searches));localStorage.setItem('internscout.visit.v1',JSON.stringify(Date.parse('2026-11-09T18:00:00Z')));}sessionStorage.setItem('fixture-seeded','1');}
  if(blockedReturn)Object.defineProperty(window,'sessionStorage',{get(){throw new Error('fixture blocked session storage');}});
  if(blocked)Storage.prototype.setItem=function(){throw new Error('fixture storage blocked');};
 },{states,searches,seed,blocked,signedIn,blockedReturn});
 await ctx.route('**/*',async route=>{
  const u=new URL(route.request().url());requests.push(u.pathname);let file;
  if(u.hostname==='cdn.jsdelivr.net')file=path.join(tools,'node_modules',u.pathname.includes('react-dom@')?'react-dom/umd/react-dom.production.min.js':'react/umd/react.production.min.js');
  else if(u.hostname==='signin.fixture.test')return route.fulfill({contentType:'text/html',body:'<p>Local sign-in fixture</p>'});
  else if(u.hostname!=='127.0.0.1'){
   calls.push({path:u.pathname,method:route.request().method()});const accountB=(route.request().headers().authorization||'').endsWith('iss_fixture_b');if(holdOld&&!accountB&&['/me','/invite'].includes(u.pathname))await new Promise(resolve=>releases.push(resolve));
   if(u.pathname==='/config'&&holdConfig)await new Promise(resolve=>configReleases.push(resolve));
   if(u.pathname==='/config')return route.fulfill(configFails?{status:503,body:''}:{json:cfg});
   if(u.pathname==='/me')return route.fulfill(meFails?{status:503,body:''}:{json:{month:'2026-11',plan,tier,can_upgrade:canUpgrade,paused,allowance:{autofill:accountB?{used:2,limit:10,bonus:0}:{used,limit,bonus}}}});
   if(u.pathname==='/invite')return route.fulfill(inviteFails?{status:503,body:''}:{json:{link:'https://internscout.org/?ref='+(accountB?'bcdefghj':'abcdefgh'),max:2,rewarded:capped?2:1,bonus:{autofill:3}}});
   if(u.pathname==='/session')return route.fulfill({json:{session:'iss_fixture_return',account:'fixture-return',email:'return@example.edu',expires:'2027-11-10T18:00:00Z'}});
   if(u.pathname.startsWith('/billing/')){if(billingStall){billingStall=false;await new Promise(resolve=>billingReleases.push(resolve));return route.fulfill({json:{url:'https://late-checkout.fixture.test/'}});}return route.fulfill({json:{message:'Fixture checkout stopped before redirect'}});}
   return route.fulfill({json:{}});
  }
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
  let body=phase==='before'&&['app.js','index.html'].includes(path.basename(file))?execFileSync('git',['show','bb315b21:docs/'+path.relative(path.join(root,'docs'),file).replaceAll('\\','/')],{cwd:root}):fs.readFileSync(file);
  if(phase==='after'&&path.basename(file)==='app.js')body=Buffer.from('window.fixtureEvents=[];window.IS.count=event=>window.fixtureEvents.push(event);\n'+body.toString());
  return route.fulfill({body,contentType:type,headers:{'access-control-allow-origin':'*'}});
 });
 const page=await ctx.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.clock.install({time:new Date(date)});
 return {ctx,page,errors,requests,calls,releaseConfig:()=>{holdConfig=false;configReleases.splice(0).forEach(r=>r());},releaseBilling:()=>billingReleases.splice(0).forEach(r=>r()),holdAccountA:()=>{holdOld=true;},releaseOld:()=>releases.splice(0).forEach(r=>r()),pendingOld:()=>releases.length,setFailures:()=>{configFails=false;meFails=false;inviteFails=false;}};
}
const store=async page=>page.evaluate(()=>Object.fromEntries(Object.keys(localStorage).map(k=>[k,localStorage.getItem(k)])));
const stable=async page=>{await page.waitForSelector('.list .c-co');await page.evaluate(()=>document.fonts.ready);};
const view=page=>page.getByRole('button',{name:/^My list \(/});
const browse=page=>page.getByRole('button',{name:'Browse roles',exact:true});
const save=(page,id)=>page.locator('#listing-'+id+' .save-role');
const settled=async page=>page.waitForFunction(()=>!document.querySelector('.filterbar-foot')?.textContent.includes('Checking current listing data'));


const target='http://127.0.0.1:8765/?upgrade=pro&out_of_runs=1&state=all&campaign=fixture#listings';
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 try{
  for(const width of [1280,375])for(const colorScheme of ['light','dark']){
   const {ctx,page,errors,calls}=await context(browser,width,colorScheme);
   await page.goto(target,{waitUntil:'networkidle'});await stable(page);await page.waitForTimeout(1800);
   if(phase==='after'){
    const panel=page.locator('#allowance-panel');await panel.waitFor();assert.match(await panel.innerText(),/No Auto-Apply runs left.*27 Auto-Apply runs used this month; 0 runs left/s);
    assert.equal(new URL(page.url()).searchParams.has('upgrade'),false);assert.equal(new URL(page.url()).searchParams.get('campaign'),'fixture');assert.equal(new URL(page.url()).hash,'#listings');assert.equal(await page.evaluate(()=>history.state.fixture),'keep');
    assert.equal(calls.some(c=>c.path.startsWith('/billing/')),false);
    await panel.getByRole('button',{name:'Get my invite link',exact:true}).click();await panel.getByRole('button',{name:'Copy link',exact:true}).waitFor();
    await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw Error('fixture clipboard denied');}}}));
    await panel.getByRole('button',{name:'Copy link',exact:true}).click();assert.equal(await page.locator('#invite-link').evaluate(el=>el===document.activeElement&&el.selectionEnd===el.value.length),true);
    assert.match(await panel.innerText(),/Clipboard access is unavailable/);assert.deepEqual(await page.evaluate(()=>fixtureEvents.filter(x=>x.startsWith('out_of_runs_'))),['out_of_runs_view','out_of_runs_invite']);
   }
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   await page.screenshot({path:path.join(__dirname,`${phase}-${width}-${colorScheme}.png`),fullPage:true});assert.deepEqual(errors,[]);
   if(phase==='after'&&width===1280&&colorScheme==='light'){await page.locator('#allowance-panel').getByRole('button',{name:'Pro · $16/month (fixture)',exact:true}).click();await page.waitForTimeout(100);assert.equal(calls.filter(c=>c.path==='/billing/checkout').length,1);assert.deepEqual(await page.evaluate(()=>fixtureEvents.filter(x=>x.startsWith('out_of_runs_'))),['out_of_runs_view','out_of_runs_invite','out_of_runs_plan']);}
   console.log(JSON.stringify({phase,width,colorScheme,behavior:'passed',checkoutCalls:calls.filter(c=>c.path.startsWith('/billing/')).length}));await ctx.close();
  }
  if(phase==='after'){
   for(const scenario of [{name:'bonus',limit:30,bonus:3},{name:'unlimited',limit:null},{name:'paused',paused:true},{name:'disabled',limit:0,used:0},{name:'capped',capped:true},{name:'disabled-prior-bonus',disabledBase:true,used:5,limit:8,bonus:3},{name:'top-plan',plan:'pro',canUpgrade:false}]){
    const {ctx,page,errors}=await context(browser,375,'light',scenario);await page.goto(target,{waitUntil:'networkidle'});await stable(page);const panel=page.locator('#allowance-panel');await panel.waitFor();
    if(scenario.name==='bonus')assert.match(await panel.innerText(),/3 runs left in your allowance.*Includes 3 extra runs/s);
    if(scenario.name==='unlimited'){assert.match(await panel.innerText(),/no monthly run limit/);assert.doesNotMatch(await panel.innerText(),/No Auto-Apply runs left/);}
    if(scenario.name==='paused'||scenario.name.startsWith('disabled'))assert.equal(await panel.getByRole('button',{name:'Get my invite link',exact:true}).count(),0);
    if(scenario.name==='top-plan'){assert.match(await panel.innerText(),/No plan upgrade is available/);assert.equal(await panel.locator('.allowance-plans button').count(),0);}
    if(scenario.name==='disabled-prior-bonus')assert.match(await panel.innerText(),/3 runs left.*currently unavailable/s);
    if(scenario.name==='capped'){await panel.getByRole('button',{name:'Get my invite link',exact:true}).click();await panel.getByRole('button',{name:'Copy link',exact:true}).waitFor();assert.match(await panel.innerText(),/will not receive more invite rewards/);}
    await page.screenshot({path:path.join(__dirname,`after-${scenario.name}-375-light.png`),fullPage:true});assert.deepEqual(errors,[]);console.log(scenario.name+' passed');await ctx.close();
   }
   const failed=await context(browser,375,'dark',{failMe:true,failInvite:true});await failed.page.goto(target,{waitUntil:'networkidle'});await stable(failed.page);await failed.page.getByRole('button',{name:'Retry allowance',exact:true}).waitFor();const liveStatus=await failed.page.locator('#allowance-status').elementHandle();failed.setFailures();await failed.page.getByRole('button',{name:'Retry allowance',exact:true}).click();await failed.page.getByRole('button',{name:'Get my invite link',exact:true}).waitFor();assert.equal(await liveStatus.evaluate(el=>el.isConnected&&el.getAttribute('aria-live')==='polite'&&el.getAttribute('aria-atomic')==='true'),true);assert.match(await liveStatus.innerText(),/runs used this month/);assert.deepEqual(failed.errors,[]);await failed.ctx.close();console.log('allowance retry passed');
   const badInvite=await context(browser,375,'light',{failInvite:true});await badInvite.page.goto(target,{waitUntil:'networkidle'});await stable(badInvite.page);await badInvite.page.getByRole('button',{name:'Get my invite link',exact:true}).click();await badInvite.page.getByRole('button',{name:'Retry invite link',exact:true}).waitFor();badInvite.setFailures();await badInvite.page.getByRole('button',{name:'Retry invite link',exact:true}).click();await badInvite.page.getByRole('button',{name:'Copy link',exact:true}).waitFor();assert.deepEqual(badInvite.errors,[]);await badInvite.ctx.close();console.log('invite retry passed');
   const badConfig=await context(browser,375,'dark',{failConfig:true,limit:30});await badConfig.page.goto(target,{waitUntil:'networkidle'});await stable(badConfig.page);await badConfig.page.getByRole('button',{name:'Retry account options',exact:true}).waitFor();assert.equal(new URL(badConfig.page.url()).searchParams.get('upgrade'),'pro');badConfig.setFailures();await badConfig.page.getByRole('button',{name:'Retry account options',exact:true}).click();await badConfig.page.waitForFunction(()=>!new URL(location.href).searchParams.has('upgrade'));assert.deepEqual(badConfig.errors,[]);await badConfig.ctx.close();console.log('config retry passed');
   const invalid=await context(browser,375,'light',{limit:30});await invalid.page.goto('http://127.0.0.1:8765/?upgrade=unknown&out_of_runs=true&campaign=fixture#listings',{waitUntil:'networkidle'});await stable(invalid.page);assert.equal(await invalid.page.locator('#allowance-panel').count(),0);assert.equal(new URL(invalid.page.url()).searchParams.get('upgrade'),'unknown');await invalid.ctx.close();console.log('invalid arrival ignored');
   const switched=await context(browser,375,'dark');await switched.page.goto(target,{waitUntil:'networkidle'});await stable(switched.page);await switched.page.getByRole('button',{name:'Get my invite link',exact:true}).waitFor();switched.holdAccountA();await switched.page.getByRole('button',{name:'Get my invite link',exact:true}).click();await switched.page.clock.fastForward(61001);await switched.page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await switched.page.waitForTimeout(100);assert.ok(switched.pendingOld()>=2);
   await switched.page.getByRole('button',{name:'Account',exact:true}).click();await switched.page.getByRole('button',{name:'Sign out',exact:false}).click();
   await switched.page.evaluate(()=>{addEventListener('message',event=>{const d=event.data;if(d?.__internscout!=='req')return;let result={};if(d.msg.type==='ping')result={ok:true,onboarded:false};if(d.msg.type==='auth:token')result={token:'iss_fixture_b',account:'fixture-b',email:'second@example.edu',expires:'2027-11-10T18:00:00Z'};if(d.msg.type==='get_queue')result={queue:{order:[],jobs:{}}};postMessage({__internscout:'res',id:d.id,result},location.origin);});postMessage({__internscout:'hello'},location.origin);});
   await switched.page.waitForFunction(()=>document.querySelector('#allowance-panel')?.textContent.includes('2 Auto-Apply runs used'));
   await switched.page.getByRole('button',{name:'Get my invite link',exact:true}).click();await switched.page.getByRole('button',{name:'Copy link',exact:true}).waitFor();switched.releaseOld();await switched.page.waitForTimeout(100);assert.match(await switched.page.locator('#allowance-panel').innerText(),/2 Auto-Apply runs used this month; 8 runs left/);assert.match(await switched.page.locator('#invite-link').inputValue(),/bcdefghj$/);assert.deepEqual(switched.errors,[]);await switched.page.screenshot({path:path.join(__dirname,'after-account-switch-375-dark.png'),fullPage:true});await switched.ctx.close();console.log('late account and invite responses ignored');
   const delayed=await context(browser,375,'light',{holdConfig:true,limit:30});await delayed.page.goto('http://127.0.0.1:8765/?upgrade=pro&state=all',{waitUntil:'domcontentloaded'});await stable(delayed.page);await delayed.page.locator('#q').fill('Engineer');const beforeQ=await delayed.page.locator('#q').boundingBox();delayed.releaseConfig();await delayed.page.locator('#allowance-panel').waitFor();await delayed.page.waitForTimeout(100);assert.equal(await delayed.page.locator('#q').evaluate(el=>el===document.activeElement),true);assert.equal(await delayed.page.locator('#q').inputValue(),'Engineer');const afterQ=await delayed.page.locator('#q').boundingBox();assert.ok(Math.abs(afterQ.y-beforeQ.y)<1,'typing control keeps its exact viewport position');assert.match(await delayed.page.locator('#allowance-announcement').innerText(),/allowance options are open/);assert.deepEqual(delayed.errors,[]);await delayed.page.screenshot({path:path.join(__dirname,'after-delayed-config-375-light.png'),fullPage:true});console.log(JSON.stringify({case:'delayed config preserves typing',beforeQ:beforeQ.y,afterQ:afterQ.y}));await delayed.ctx.close();
   const stalled=await context(browser,375,'dark',{stallBilling:true});await stalled.page.goto(target,{waitUntil:'networkidle'});await stable(stalled.page);const choice=stalled.page.locator('#allowance-panel').getByRole('button',{name:'Pro · $16/month (fixture)',exact:true});await choice.click();await stalled.page.waitForTimeout(100);assert.equal(await choice.isDisabled(),true);await stalled.page.clock.fastForward(8001);await stalled.page.getByText("Couldn't open billing. Try again.",{exact:true}).waitFor();assert.equal(await choice.isEnabled(),true);const unchangedUrl=stalled.page.url();await choice.click();await stalled.page.waitForTimeout(100);assert.equal(stalled.calls.filter(c=>c.path==='/billing/checkout').length,2);stalled.releaseBilling();await stalled.page.waitForTimeout(100);assert.equal(stalled.page.url(),unchangedUrl,'late timed-out checkout cannot redirect');assert.deepEqual(stalled.errors,[]);await stalled.ctx.close();console.log('stalled checkout explicit retry passed');
   for(const blockedReturn of [false,true]){
    const {ctx,page,errors}=await context(browser,375,'light',{signedIn:false,blockedReturn,limit:30,bonus:3});await page.goto(target,{waitUntil:'networkidle'});await stable(page);
    await page.locator('#allowance-panel').getByRole('button',{name:'Sign in with Google',exact:true}).click();await page.waitForURL('https://signin.fixture.test/**');
    const authUrl=new URL(page.url());const state=authUrl.searchParams.get('state'),nonce=authUrl.searchParams.get('nonce');
    const claims={sub:'fixture',email:'return@example.edu',exp:Date.parse('2026-11-11T18:00:00Z')/1000,nonce};const jwt=['fixture',Buffer.from(JSON.stringify(claims)).toString('base64url'),'fixture'].join('.');
    await page.goto('http://127.0.0.1:8765/#id_token='+encodeURIComponent(jwt)+'&state='+encodeURIComponent(state),{waitUntil:'networkidle'});await stable(page);
    assert.equal(new URL(page.url()).hash,'');
    if(!blockedReturn){await page.locator('#allowance-panel').waitFor();assert.equal(await page.evaluate(()=>sessionStorage.getItem('internscout.allowance.return.v1')),null);assert.match(await page.locator('#allowance-panel').innerText(),/Auto-Apply allowance|No Auto-Apply runs left/);}
    else assert.match(await page.locator('main').innerText(),/Sign-in didn't work/);
    assert.deepEqual(errors,[]);console.log('redirect return blocked='+blockedReturn+' passed');await ctx.close();
   }
  }
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
