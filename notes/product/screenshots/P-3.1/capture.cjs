// Local synthetic Edge preview. No extension installation, account, AI or external tab.
const fs=require("node:fs"),path=require("node:path"),assert=require("node:assert/strict");
const {execFileSync}=require("node:child_process");
const {chromium}=require(path.join(process.env.CAPTURE_TOOLS,"node_modules/playwright-core"));
const root=path.resolve(__dirname,"../../../.."),base="8c352e25",phase=process.argv[2]||"after";
(async()=>{const browser=await chromium.launch({headless:true,executablePath:"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"});
try{for(const width of [1280,375])for(const colorScheme of ["light","dark"]){
 const context=await browser.newContext({viewport:{width,height:1000},colorScheme});const remote=[],errors=[];
 await context.route("**/*",route=>{const url=new URL(route.request().url());if(url.hostname!=="127.0.0.1"){remote.push(url.href);return route.abort();}
 const relative=decodeURIComponent(url.pathname.slice(1)),file=path.join(root,relative);
 if(!relative.startsWith("extension/")||!fs.existsSync(file))return route.fulfill({status:404,body:""});
 const body=phase==="before"&&["extension/background/gemini.js","extension/sidepanel/card.js","extension/sidepanel/sidepanel.js"].includes(relative)?execFileSync("git",["show",`${base}:${relative}`],{cwd:root}):fs.readFileSync(file);
 return route.fulfill({body,contentType:file.endsWith(".js")?"text/javascript":file.endsWith(".css")?"text/css":file.endsWith(".html")?"text/html":"font/woff2"});});
 await context.addInitScript(()=>{const listeners=[],data={store:{version:3,settings:{onboarded:true,resume_details_ready:true},files:{resume:{name:"SYNTHETIC.txt",b64:"Zml4dHVyZQ=="}},profile:{facts:{}}},review_ask:{v:2,filled:0,ids:[],next:0,open:false,asks:0,done:null},queue:{order:[],jobs:{}}};
 const change=patch=>{const changes={};for(const [k,v]of Object.entries(patch)){changes[k]={oldValue:data[k],newValue:structuredClone(v)};data[k]=structuredClone(v);}listeners.forEach(fn=>fn(changes,"local"));};
 window.fixture={data,change,opened:[]};window.chrome={runtime:{sendMessage:async m=>{if(m.type==="get_queue")return{queue:structuredClone(data.queue)};throw Error("Unexpected message "+m.type);}},storage:{local:{get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,structuredClone(data[k])])),set:async patch=>change(patch),remove:async()=>{}},onChanged:{addListener:fn=>listeners.push(fn)}},tabs:{create:({url})=>fixture.opened.push(url)}};});
 const page=await context.newPage();page.on("pageerror",e=>errors.push(e.message));
 await page.goto("http://127.0.0.1:8765/extension/sidepanel/sidepanel.html");await page.waitForSelector("#addurl");
 const set=async scenario=>{await page.evaluate(async({scenario,phase})=>{const {workerError}=await import("/extension/background/gemini.js");
 const raw={error:"cap",task:"autofill",message:"Monthly autofill allowance is used up",resets:"2026-12-01",tier:"edu"};
 if(scenario==="offered"){raw.upgrade=true;raw.offer={plan:"supporter",label:"Supporter",allowance:{autofill:50}};}
 if(scenario==="per-run")raw.message="This run reached its call limit";
 const e=workerError(429,raw),j={id:"fixture",company:"Fixture Employer",title:"Synthetic Research Internship",status:"needs_you",reason:e.message,upgrade:e.offer||null,allowanceLimited:e.allowanceLimited===true,apply_url:"https://jobs.example.com/fixture"};
 fixture.change({queue:{order:[j.id],jobs:{[j.id]:j}}});},{scenario,phase});
 await page.waitForFunction(({scenario,phase})=>{const card=document.querySelector('[data-id="fixture"]');if(!card)return false;const offered=!!card.querySelector('[data-act="upgrade"]');const invite=!!card.querySelector('[data-act="invite"]');return offered===(scenario==="offered")&&invite===(phase==="after"&&scenario!=="per-run");},{scenario,phase});};
 for(const scenario of ["offered","top-plan","per-run"]){await set(scenario);await page.evaluate(()=>document.fonts.ready);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.screenshot({path:path.join(__dirname,`${phase}-${width}-${colorScheme}-${scenario}.png`),fullPage:true});
 if(scenario==="offered"){await page.locator('[data-act="upgrade"]').click();assert.equal(await page.evaluate(()=>fixture.opened.pop()),"https://internscout.org/?upgrade=supporter");}
 if(phase==="after"&&scenario!=="per-run"){
 const invite=page.locator('[data-act="invite"]');await invite.focus();await page.keyboard.press("Enter");assert.equal(await page.evaluate(()=>fixture.opened.pop()),"https://internscout.org/?out_of_runs=1");
 await page.evaluate(()=>{const q=structuredClone(fixture.data.queue);q.jobs.fixture.title="Synthetic updated internship";fixture.change({queue:q});});
 await page.waitForFunction(()=>document.querySelector('.title')?.textContent.includes("updated"));assert.equal(await invite.evaluate(el=>el===document.activeElement),true);
 await page.keyboard.press("Tab");assert.equal(await page.evaluate(()=>document.activeElement.dataset.act),"resume");
 }}
 assert.deepEqual(remote,[]);assert.deepEqual(errors,[]);console.log(JSON.stringify({phase,width,colorScheme,scenarios:3,remoteRequests:0,pageErrors:0}));await context.close();
}}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
