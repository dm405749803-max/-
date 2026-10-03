const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const elements=new Map();
const get=key=>{if(!elements.has(key))elements.set(key,{innerHTML:'',textContent:'',value:'',open:false,style:{},addEventListener(){},classList:{add(){},remove(){}},showModal(){this.open=true;},close(){this.open=false;},getBoundingClientRect(){return {left:0,right:10,top:0,bottom:10};}});return elements.get(key);};
const fetchStub=async url=>url==='/api/health'?{ok:true,status:200,json:async()=>({mode:'static',dify_configured:false,asr_configured:false})}:{ok:false,status:404,json:async()=>({error:{code:'NOT_FOUND',message:'未接通'},trace_id:'ui-fixture'})};
const document={querySelector:get,addEventListener(){},createElement(){return {click(){}}}};
const windowObject={addEventListener(){},scrollTo(){}};
const context=vm.createContext({console,Intl,Date,Set,JSON,Object,Array,String,Number,RegExp,Promise,AbortController,Math,URLSearchParams,URL,Blob,fetch:fetchStub,document,window:windowObject,location:{origin:'http://127.0.0.1:8821'},navigator:{clipboard:{writeText:async()=>{}}},localStorage:{getItem(){return null;},setItem(){}},setInterval(){},setTimeout(fn){fn();return 1;},clearTimeout(){},globalThis:null});
context.globalThis=context;context.window.globalThis=context;
for(const name of ['v2-api.js','app.js','modules.js','workbench-v2.js','sales-review-ui.js','media-transcription-ui.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../../dist',name),'utf8'),context,{filename:name});
const evaluate=code=>vm.runInContext(code,context);

setImmediate(()=>{
 const html=get('#main').innerHTML;
 assert.match(html,/购买需求/);assert.match(html,/记忆摘要与证据/);assert.match(html,/合同演练 · 待联调/);assert.match(html,/复制只更新剪贴板，不算发送/);
 assert.match(html,/加入微信日期/);assert.match(html,/本轮信息整理/);assert.match(html,/产品建议/);
 assert.match(html,/语音与短视频/);assert.match(html,/原文件只在本页试听/);
 const mediaSource=fs.readFileSync(path.join(__dirname,'../../dist/media-transcription-ui.js'),'utf8');
 assert.match(mediaSource,/确认可用，进入分析/);assert.match(mediaSource,/识别有误，不采用/);assert.doesNotMatch(mediaSource,/确认文字并写入会话/);
 evaluate("state.drafts.c1={text:'旧草稿',context_versions:contextStamp(state.customers[0])}");
 assert.equal(evaluate('draftIsCurrent(state.customers[0],state.drafts.c1)'),true);
 evaluate("state.customers[0].messages.push({role:'customer',text:'预算改了',message_id:'m-new',status:'received'});markContextChanged(state.customers[0],{opportunity:true})");
 assert.equal(evaluate('draftIsCurrent(state.customers[0],state.drafts.c1)'),false);
 evaluate("const testCustomer=state.customers[0];activeOpportunity(testCustomer).contact_state.purchased_for_opportunity=true;testCustomer.opportunities.push({opportunity_id:'new-need',person_id:testCustomer.persons[0].person_id,purpose:'新需求',revision:1,profile_version:1,contact_state:{marketing_opt_out:false,human_handoff:false,purchased_for_opportunity:false}});testCustomer.selectedOpportunityId='new-need'");
 assert.equal(evaluate('contactProtection(state.customers[0]).purchased_for_opportunity'),false);
 assert.match(evaluate('renderTasks()'),/负责人/);
 assert.match(evaluate('renderTasks()'),/需要你判断/);
 console.log('PASS — need-first workspace, date filter, low-burden memory review, product confirmation, stale drafts, and task surface.');
});
