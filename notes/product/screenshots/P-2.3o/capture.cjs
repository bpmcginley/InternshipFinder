// Existing real counter, synthetic local HTML and wholly intercepted page requests only.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const { chromium } = require(path.join(process.env.TEMP, 'internscout-product-capture-tools/node_modules/playwright-core'));
const site = path.resolve(process.argv[2], 'after');
const repo = path.resolve(__dirname, '../../../..');
const beforeCode = cp.execFileSync('git', ['show', 'aea5f010:docs/js/count.js'], {cwd:repo});
const afterCode = fs.readFileSync(path.join(repo, 'docs/js/count.js'));
const origin = 'https://internscout.org';
let browser;
(async () => {
  browser = await chromium.launch({ executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless:true });
  const report=[], prior=new Map();
  async function open({phase='after', width=375, theme='light', flag=true, bot=false, pathname='/internships/mechanical-engineering/', search='', frame=false}={}) {
    const context = await browser.newContext({viewport:{width,height:1000},colorScheme:theme,reducedMotion:'reduce'});
    // Positive fixture simulates an eligible ordinary browser; production code is unchanged.
    if (!bot) await context.addInitScript(() => Object.defineProperty(navigator,'webdriver',{get:()=>false}));
    const sent=[], errors=[];
    await context.route('**/*', async route => {
      const request=route.request(), url=new URL(request.url());
      if (url.origin === 'https://internscout-api.bpmcginley.workers.dev' && url.pathname === '/hit') {
        sent.push(JSON.parse(request.postData() || '{}'));
        return route.fulfill({status:204,body:''});
      }
      if (url.origin !== origin) return route.abort();
      if (url.pathname === '/frame') return route.fulfill({contentType:'text/html',body:'<iframe src="/internships/mechanical-engineering/"></iframe>'});
      if (url.pathname === '/js/count.js') return route.fulfill({contentType:'text/javascript',body:phase==='before'?beforeCode:afterCode});
      let name=url.pathname.replace(/^\//,'');
      if (name.startsWith('widget/')) name='internships/mechanical-engineering/';
      if (name.endsWith('/')) name+='index.html';
      const file=path.resolve(site,name); assert(file.startsWith(site+path.sep));
      if (!fs.existsSync(file)) return route.fulfill({status:404,body:'Not found'});
      let body=fs.readFileSync(file);
      if (name.endsWith('.html') && flag) body=Buffer.from(body.toString().replace('<script defer src="/js/count.js"','<script defer data-employer-posting-counts="1" src="/js/count.js"'));
      return route.fulfill({body,contentType:({'.html':'text/html','.js':'text/javascript','.woff2':'font/woff2'})[path.extname(file)]||'application/octet-stream'});
    });
    const page=await context.newPage(); page.on('pageerror',e=>errors.push(e.message));
    await page.goto(origin+(frame?'/frame':pathname)+search);
    const target=frame?page.frames().find(f=>f!==page.mainFrame()):page;
    await target.locator('a.go').first().waitFor();
    await target.evaluate(()=>document.fonts.ready);
    await page.waitForTimeout(150);
    return {context,page,target,sent,errors, employer:()=>sent.filter(x=>x.e==='employer_posting_open')};
  }
  for (const phase of ['before','after']) for (const width of [1280,375]) for (const theme of ['light','dark']) for (const [name,slug] of [['field','mechanical-engineering'],['pay','highest-paying']]) {
    const r=await open({phase,width,theme,pathname:'/internships/'+slug+'/'});
    assert.equal(r.employer().length,0);
    const link=r.page.locator('a.go').first(); await link.scrollIntoViewIfNeeded();
    const proof=await r.page.evaluate(()=>({text:document.querySelector('main').innerText,width:document.documentElement.scrollWidth,links:[...document.querySelectorAll('main a')].map(a=>[a.getAttribute('href'),a.textContent,a.target,a.rel,a.getBoundingClientRect().x,a.getBoundingClientRect().y,a.getBoundingClientRect().width,a.getBoundingClientRect().height])}));
    assert(proof.width<=width+1); const key=`${name}-${width}-${theme}`;
    if (phase==='before') prior.set(key,proof); else assert.deepEqual(proof,prior.get(key));
    await r.page.screenshot({path:path.join(__dirname,`${phase}-${key}.png`)});
    await link.focus(); await r.page.keyboard.press('Enter'); await r.page.waitForTimeout(150);
    assert.equal(r.employer().length,phase==='after'?1:0);
    if (phase==='after') assert.deepEqual(Object.keys(r.employer()[0]).sort(),['c','e']);
    assert.deepEqual(r.errors,[]);
    report.push({phase,name,width,theme,noEmployerOnLoad:true,employerAfterKeyboard:r.employer().length,externalPageRequestsAllowed:0});
    await r.context.close();
  }
  for (const [name,opts] of [['missing flag',{flag:false}],['webdriver',{bot:true}],['nocount',{search:'?nocount=1'}],['widget',{pathname:'/widget/test/'}],['iframe',{frame:true}]]) {
    const r=await open(opts); await r.target.locator('a.go').first().click(); await r.page.waitForTimeout(150);
    assert.equal(r.employer().length,0,name); report.push({exclusion:name,employerEvents:0}); await r.context.close();
  }
  const r=await open();
  await r.page.evaluate(()=>{
    const cases=[['same1','one','go',''],['same2','one','go',''],['different','two','open-link',''],['paid','excluded','go','paid'],['placement','excluded','go','placement'],['sponsored','excluded','go','sponsored'],['auto','excluded','aa',''],['saved',null,'open-link',''],['explicit','excluded','open-link','exclude'],['script','script','go',''],['middle','middle','go',''],['invalid',' x','go','']];
    const box=document.createElement('section'); box.id='synthetic-checks';
    for (const [id,key,cls,kind] of cases) { const wrap=document.createElement('div'),a=document.createElement('a'); a.id=id; a.className=cls;a.href='https://jobs.example.test/'+id; a.target='_blank';a.textContent=id; if(id==='same1'){const span=document.createElement('span');span.textContent=id;a.textContent='';a.append(span);}
      if(key!==null)a.setAttribute('data-employer-key',key); if(kind==='paid')wrap.className='paid'; if(kind==='placement')wrap.setAttribute('data-placement','synthetic');if(kind==='exclude')wrap.setAttribute('data-employer-posting-exclude','');if(kind==='sponsored')a.rel='sponsored';wrap.append(a);box.append(wrap); }
    document.body.append(box);
  });
  await r.page.locator('#script').evaluate(a=>a.click());
  for (const id of ['paid','placement','sponsored','auto','saved','explicit','invalid']) await r.page.locator('#'+id).click();
  await r.page.waitForTimeout(150); assert.deepEqual(r.employer(),[]);
  await r.page.locator('#same1 span').click(); await r.page.locator('#same2').click(); await r.page.locator('#different').click({modifiers:['Control']}); await r.page.locator('#middle').click({button:'middle'}); await r.page.locator('a.go[data-employer-key="example & research"]').first().click(); await r.page.waitForTimeout(150);
  assert.deepEqual(r.employer().map(x=>x.c),['one','two','middle','example & research']);
  for(const body of r.employer())assert.deepEqual(Object.keys(body).sort(),['c','e']);
  report.push({delegatedDynamicLinks:true,nestedTarget:true,htmlEntityDecodedKey:true,excludedPaidPlacementSponsoredAutoApplySavedOnlyExplicitSyntheticInvalid:true,perEmployerDeduplication:true,middleAndModifiedClicks:true,payloadFields:['e','c']});
  assert.deepEqual(r.errors,[]);await r.context.close();
  await browser.close(); fs.writeFileSync(path.join(__dirname,'report.json'),JSON.stringify(report,null,2)+'\n');
})().catch(async e=>{console.error(e);if(browser)await browser.close();process.exitCode=1;});
