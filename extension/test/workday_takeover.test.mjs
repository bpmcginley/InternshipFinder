import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source = new URL('../agent/', import.meta.url);
let fields=[],buttons=[],options=[],sent=0,selectedAfterHalt=false,ctx,onOpen=null,opened=0;
class El {
 constructor(tag,text,attrs={}) {Object.assign(this,{tagName:tag,nodeType:1,innerText:text,textContent:text,attrs,disabled:false,isConnected:true,required:false,id:'',name:'',className:'',type:attrs.type||'',parentElement:null,form:null,value:'',isContentEditable:false});}
 getAttribute(n){return this.attrs[n]??null;} setAttribute(n,v){this.attrs[n]=String(v);} hasAttribute(n){return n in this.attrs;}
 closest(sel){if(sel==='button, input[type="submit"], input[type="button"], a, [role="button"]')return this.tagName==='BUTTON'?this:null;return null;}
 matches(){return false;} querySelectorAll(){return [];} querySelector(){return null;} getRootNode(){return doc;}
 getBoundingClientRect(){return {width:200,height:30,left:10,right:210,top:10,bottom:40};} getClientRects(){return [this.getBoundingClientRect()];}
 scrollIntoView(){} focus(){} contains(n){return this===n;}
 dispatchEvent(){return true;}
 click(){if(this.attrs['aria-haspopup']==='listbox'){opened++;if(onOpen)onOpen();return;} if(this.attrs.role==='option'){selectedAfterHalt=ctx.__isHaltGen===2;fields[0].innerText=fields[0].textContent=this.textContent;options=[];}else sent++;}
}
const doc={body:null,title:'Synthetic application',visibilityState:'visible',__isRunFilled:true,
 addEventListener(){},removeEventListener(){},querySelector(){return null;},getElementById(){return null;},
 querySelectorAll(sel){
  if(sel==='*')return [];
  if(sel.startsWith('input, textarea, select, button[aria-haspopup'))return fields;
  if(sel.startsWith('button:not('))return buttons;
  if(sel.startsWith('input, textarea, select'))return fields.filter(e=>e.tagName==='INPUT');
  if(sel.startsWith('[data-automation-id="promptOption"]'))return options;
  return [];
 }};
ctx=vm.createContext({document:doc,location:new URL('https://fictional.myworkdayjobs.com/apply'),Event,MouseEvent:class extends Event{},KeyboardEvent:class extends Event{},FocusEvent:class extends Event{},
 CSS:{escape:String},requestAnimationFrame(){},getComputedStyle:()=>({visibility:'visible',display:'block',opacity:'1'}),setTimeout,clearTimeout,scrollX:0,scrollY:0});ctx.window=ctx;
for(const script of ['guard.js','actions.js','dom.js'])vm.runInContext(readFileSync(new URL(script,source),'utf8'),ctx);


// 2026-10-23: exercise real DOM routing and asynchronous Workday helpers, no employer traffic (EXT-4).
for (const automatic of [false, true]) test(`Take over cancels a late Workday option (${automatic ? "prefill" : "tool"})`, async () => {
  vm.runInContext("delete window.__isHaltGen", ctx); doc.__isRunFilled = false; selectedAfterHalt = false;
  const dropdown = new El("BUTTON", "Select One", {"aria-haspopup":"listbox", "aria-label":"Country"});
  fields = [dropdown]; buttons = []; options = [];
  const snap = ctx.ISDom.snapshot();
  opened = 0;
  onOpen = () => setTimeout(() => { ctx.ISDom.halt(2); options = [new El("DIV", "Canada", {role:"option"})]; }, 30);
  const run = automatic ? ctx.ISDom.fastFill({ country: "Canada" }, null, { gen: 1 })
    : ctx.ISDom.act(snap.elements[0].ref, "select", { gen: 1, option: "Canada" });
  const result = await run;
  assert.equal(opened, 1, JSON.stringify(snap));
  assert.equal(selectedAfterHalt, false);
  assert.equal(dropdown.textContent, "Select One");
  if (!automatic) { assert.equal(result.ok, false); assert.equal(result.cancelled, true); }
  else assert.deepEqual(Array.from(result), []);
});
test("a current Workday tool still selects a matching option", async () => {
  vm.runInContext("delete window.__isHaltGen", ctx); doc.__isRunFilled = false; selectedAfterHalt = false;
  const dropdown = new El("BUTTON", "Select One", {"aria-haspopup":"listbox", "aria-label":"Country"});
  fields = [dropdown]; buttons = []; options = [];
  const snap = ctx.ISDom.snapshot();
  onOpen = () => { options = [new El("DIV", "Canada", {role:"option"})]; };
  const run = ctx.ISDom.act(snap.elements[0].ref, "select", {gen: 3, option: "Canada"});
  assert.equal((await run).ok, true); assert.equal(dropdown.textContent, "Canada");
});
