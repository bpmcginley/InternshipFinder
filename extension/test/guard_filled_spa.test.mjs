import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import test from 'node:test';
const source = new URL('../agent/',import.meta.url);
let fields=[],buttons=[],options=[],sent=0,selectedAfterHalt=false,ctx;
class El {
 constructor(tag,text,attrs={}) {Object.assign(this,{tagName:tag,nodeType:1,innerText:text,textContent:text,attrs,disabled:false,isConnected:true,required:false,id:'',name:'',className:'',type:attrs.type||'',parentElement:null,form:null,value:'',isContentEditable:false});}
 getAttribute(n){return this.attrs[n]??null;} setAttribute(n,v){this.attrs[n]=String(v);} hasAttribute(n){return n in this.attrs;}
 closest(sel){if(sel==='button, input[type="submit"], input[type="button"], a, [role="button"]')return this.tagName==='BUTTON'?this:null;return null;}
 matches(){return false;} querySelectorAll(){return [];} querySelector(){return null;} getRootNode(){return doc;}
 getBoundingClientRect(){return {width:200,height:30,left:10,right:210,top:10,bottom:40};} getClientRects(){return [this.getBoundingClientRect()];}
 scrollIntoView(){} focus(){} contains(n){return this===n;}
 dispatchEvent(){return true;}
 click(){if(this.attrs['aria-haspopup']==='listbox')return; if(this.attrs.role==='option'){selectedAfterHalt=ctx.__isHaltGen===2;fields[0].innerText=fields[0].textContent=this.textContent;options=[];}else sent++;}
}
const doc={body:null,title:'Synthetic application',visibilityState:'visible',__isRunFilled:true,
 addEventListener(type,handler){if(type==='click')this.clickHandler=handler;},removeEventListener(type,handler){if(this.clickHandler===handler)delete this.clickHandler;},querySelector(){return null;},getElementById(){return null;},
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

// 2026-10-23: the audit's actual snapshot/act path must refuse custom final actions without headings.
test('filled SPAs refuse unfamiliar and consent actions in snapshot and execution', async()=>{
 for(const runFilled of [true,false])for(const text of ['I agree','Accept','Let’s make it official','Go','OK','Accept and continue']){
  fields=runFilled?[]:[new El('INPUT','',{'type':'text'})];
  if(fields.length)fields[0].value='Fictional answer';
  buttons=[new El('BUTTON',text,{type:'button'})];
  const snap=ctx.ISDom.snapshot({runFilled});const b=snap.buttons[0];
  assert.ok(b?.blocked,text);const before=sent;
  const result=await ctx.ISDom.act(b.ref,'click',{gen:1,runFilled});
  assert.equal(result.ok,false,text);assert.equal(sent,before,'sending handler never ran');
 }
});

test('known Next and Back work after filling; initial unknown action stays usable', async()=>{
 fields=[];
 for(const text of ['Next','Back','Continue','Edit application','Create account']){
  buttons=[new El('BUTTON',text,{type:'button'})];
  const b=ctx.ISDom.snapshot({runFilled:true}).buttons[0];
  assert.equal(!!b.blocked,false,text);
  assert.equal((await ctx.ISDom.act(b.ref,'click',{gen:1,runFilled:true})).ok,true,text);
 }
 doc.__isRunFilled=false;
 buttons=[new El('BUTTON','Let’s make it official',{type:'button'})];
 assert.equal(!!ctx.ISDom.snapshot({runFilled:false}).buttons[0].blocked,false);
});

test('click interception blocks synthetic custom final action and permits explicit human action',()=>{
 fields=[];doc.__isRunFilled=true;
 const target=new El('BUTTON','Let’s make it official',{type:'button'});
 // Simulate reinjection over an old version: the previous handler must be removed.
 const old=()=>{};doc.__isClickBlock=old;doc.clickHandler=old;
 ctx.ISGuard.installClickBlock(doc);assert.notEqual(doc.clickHandler,old);
 let prevented=0,stopped=0;
 const event=(isTrusted)=>({target,isTrusted,preventDefault(){prevented++;},stopImmediatePropagation(){stopped++;}});
 doc.clickHandler(event(false));assert.equal(prevented,1);assert.equal(stopped,1);
 doc.clickHandler(event(true));assert.equal(prevented,1);assert.equal(stopped,1);
});
