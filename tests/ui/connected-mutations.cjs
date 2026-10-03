const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const elements=new Map();
const get=key=>{if(!elements.has(key))elements.set(key,{innerHTML:'',textContent:'',value:'',open:false,style:{},addEventListener(){},classList:{add(){},remove(){}},showModal(){this.open=true;},close(){this.open=false;},getBoundingClientRect(){return {left:0,right:10,top:0,bottom:10};}});return elements.get(key);};
const fetchStub=async url=>url==='/api/health'?{ok:true,status:200,json:async()=>({mode:'static',dify_configured:false})}:{ok:false,status:404,json:async()=>({error:{code:'NOT_FOUND',message:'未接通'},trace_id:'fixture'})};
const context=vm.createContext({console,Intl,Date,Set,JSON,Object,Array,String,Number,RegExp,Promise,AbortController,Math,URLSearchParams,URL,Blob,fetch:fetchStub,document:{querySelector:get,addEventListener(){},createElement(){return {click(){}}}},window:{addEventListener(){},scrollTo(){}},location:{origin:'http://127.0.0.1:8821'},navigator:{clipboard:{writeText:async()=>{}}},localStorage:{getItem(){return null;},setItem(){}},setInterval(){},setTimeout(fn){fn();return 1;},clearTimeout(){},globalThis:null});
context.globalThis=context;context.window.globalThis=context;
for(const name of ['v2-api.js','app.js','modules.js','workbench-v2.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../../dist',name),'utf8'),context,{filename:name});
const evaluate=code=>vm.runInContext(code,context);

(async()=>{
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(evaluate("parseBudgetAmount('')"),null);
 assert.equal(evaluate("parseBudgetAmount('0')"),0);
 assert.equal(evaluate("parseBudgetAmount('30000')"),30000);
 assert.throws(()=>evaluate("parseBudgetAmount('3万')"),/只接受人民币元数字/);

 evaluate("ensureWorkbenchModel();v2Runtime.status='connected';globalThis.contractCustomer=state.customers[0];globalThis.contractOpportunity=activeOpportunity(contractCustomer);contractCustomer.human=false;contractCustomer.human_handoff=false;contractOpportunity.revision=7;contractOpportunity.contact_state={marketing_opt_out:false,human_handoff:false,purchased_for_opportunity:false};globalThis.apiCalls=[];v2Runtime.client.patchOpportunity=async(id,input)=>{apiCalls.push({kind:'patch',id,input});return {data:{...contractOpportunity,revision:8,handoff_owner:'我',contact_state:{marketing_opt_out:false,human_handoff:true,purchased_for_opportunity:false}}}};v2Runtime.client.createTask=async input=>{apiCalls.push({kind:'task',input});return {data:{task_id:'task-handoff',customer_id:contractCustomer.customer_id,opportunity_id:contractOpportunity.opportunity_id,title:'人工接手',reason:'人工接手',owner:'我',status:'open',revision:1}}}");
 assert.equal(await evaluate('persistOpportunityHandoff(contractCustomer,contractOpportunity)'),true);
 const handoffCalls=JSON.parse(evaluate('JSON.stringify(apiCalls)'));
 assert.deepEqual(handoffCalls[0],{kind:'patch',id:'c1-o1',input:{expected_revision:7,changes:{human_handoff:true,handoff_owner:'我'}}});
 assert.equal(handoffCalls[1].kind,'task');
 assert.match(handoffCalls[1].input.idempotency_key,/^handoff:c1-o1:8$/);
 assert.equal(evaluate('contractOpportunity.revision'),8);
 assert.equal(evaluate('contractOpportunity.contact_state.human_handoff'),true);

 evaluate("contractOpportunity.revision=9;contractOpportunity.contact_state.human_handoff=false;globalThis.beforeTaskCount=state.tasks.length;v2Runtime.client.patchOpportunity=async()=>{throw new V2ApiError('版本冲突',{status:409,code:'REVISION_CONFLICT',traceId:'trace-409'})}");
 assert.equal(await evaluate('persistOpportunityHandoff(contractCustomer,contractOpportunity)'),false);
 assert.equal(evaluate('contractOpportunity.revision'),9);
 assert.equal(evaluate('contractOpportunity.contact_state.human_handoff'),false);
 assert.equal(evaluate('state.tasks.length'),evaluate('beforeTaskCount'));
 assert.match(get('#toast').textContent,/人工接手保存失败：版本冲突/);

 evaluate("contractOpportunity.revision=10;contractOpportunity.contact_state.purchased_for_opportunity=false;globalThis.apiCalls=[];v2Runtime.client.patchOpportunity=async(id,input)=>{apiCalls.push({id,input});return {data:{...contractOpportunity,purchased:true,revision:11,contact_state:{marketing_opt_out:false,human_handoff:false,purchased_for_opportunity:true}}}}");
 assert.equal(await evaluate('persistOpportunityPurchased(contractCustomer,contractOpportunity)'),true);
 assert.deepEqual(JSON.parse(evaluate('JSON.stringify(apiCalls[0].input)')),{expected_revision:10,changes:{purchased:true}});
 assert.equal(evaluate('contractOpportunity.revision'),11);
 assert.equal(evaluate('contractOpportunity.contact_state.purchased_for_opportunity'),true);

 evaluate("contractOpportunity.revision=12;contractOpportunity.contact_state.purchased_for_opportunity=false;v2Runtime.client.patchOpportunity=async()=>{throw new V2ApiError('版本冲突',{status:409,code:'REVISION_CONFLICT'})}");
 assert.equal(await evaluate('persistOpportunityPurchased(contractCustomer,contractOpportunity)'),false);
 assert.equal(evaluate('contractOpportunity.revision'),12);
 assert.equal(evaluate('contractOpportunity.contact_state.purchased_for_opportunity'),false);
 assert.match(get('#toast').textContent,/已购状态保存失败：版本冲突/);

 get('#profile-purpose').value='本人养老';get('#profile-budget').value='0';
 evaluate("contractOpportunity.revision=20;contractOpportunity.budget_amount=null;globalThis.apiCalls=[];v2Runtime.client.patchOpportunity=async(id,input)=>{apiCalls.push({id,input});return {data:{...contractOpportunity,purpose:input.changes.purpose,budget_amount:input.changes.budget_amount,budget_currency:'CNY',revision:21}}}");
 assert.equal(await evaluate('saveWorkbenchProfile(contractCustomer)'),true);
 const budgetCall=JSON.parse(evaluate('JSON.stringify(apiCalls[0])'));
 assert.deepEqual(budgetCall.input,{expected_revision:20,changes:{purpose:'本人养老',budget_amount:0,budget_currency:'CNY'}});
 assert.equal(Object.hasOwn(budgetCall.input.changes,'budget'),false);
 assert.equal(evaluate('contractOpportunity.budget_amount'),0);

 get('#profile-budget').value='3万';
 evaluate('globalThis.patchCount=0;v2Runtime.client.patchOpportunity=async()=>{patchCount++;throw new Error("不应调用")};contractOpportunity.revision=22;contractOpportunity.budget_amount=0');
 assert.equal(await evaluate('saveWorkbenchProfile(contractCustomer)'),true);
 assert.equal(evaluate('patchCount'),0);
 assert.equal(evaluate('contractOpportunity.budget_amount'),0);
 assert.match(get('#toast').textContent,/预算金额只接受人民币元数字/);

 get('#profile-budget').value='40000';
 evaluate("v2Runtime.client.patchOpportunity=async()=>{throw new V2ApiError('版本冲突',{status:409,code:'REVISION_CONFLICT'})};contractOpportunity.revision=23;contractOpportunity.budget_amount=0");
 assert.equal(await evaluate('saveWorkbenchProfile(contractCustomer)'),true);
 assert.equal(evaluate('contractOpportunity.revision'),23);
 assert.equal(evaluate('contractOpportunity.budget_amount'),0);
 assert.match(get('#toast').textContent,/需求条件保存失败：版本冲突/);

 get('#profile-budget').value='';
 evaluate("globalThis.apiCalls=[];v2Runtime.client.patchOpportunity=async(id,input)=>{apiCalls.push({id,input});return {data:{...contractOpportunity,budget_amount:null,budget_currency:'CNY',revision:24}}}");
 assert.equal(await evaluate('saveWorkbenchProfile(contractCustomer)'),true);
 assert.equal(JSON.parse(evaluate('JSON.stringify(apiCalls[0].input.changes)')).budget_amount,null);
 assert.equal(evaluate('contractOpportunity.budget_amount'),null);

 evaluate("contractCustomer.human_handoff=true;contractOpportunity.contact_state.human_handoff=false");
 assert.equal(evaluate('contactProtection(contractCustomer).human_handoff'),true);

 evaluate("contractCustomer.human_handoff=false;state.tasks.unshift({id:'task-contract',task_id:'task-contract',status:'open',done:false,revision:1});v2Runtime.client.patchTask=async()=>{throw new V2ApiError('版本冲突',{status:409,code:'REVISION_CONFLICT'})}");
 assert.equal(await evaluate("completeWorkbenchTask('task-contract')"),true);
 assert.equal(evaluate("state.tasks.find(item=>item.task_id==='task-contract').done"),false);
 assert.equal(evaluate("state.tasks.find(item=>item.task_id==='task-contract').status"),'open');

 evaluate(`
  contractCustomer.human_handoff=false;
  contractCustomer.contact_preferences={marketing_opt_out:false};
  contractOpportunity.contact_state={marketing_opt_out:false,human_handoff:false,purchased_for_opportunity:false};
  contractCustomer.messages=[
   {role:'customer',status:'received',message_id:'m-customer',text:'我的预算是多少合适？'},
   {role:'sales',status:'manually_confirmed_sent',message_id:'m-sales',text:'我帮您核对。'}
  ];
  v2Runtime.contextByOpportunity[contractOpportunity.opportunity_id]={
   latest_message_id:'m-customer',
   context_window:{included_message_count:2,omitted_message_count:5,complete:false},
   context_versions:{customer_revision:31,opportunity_revision:30,profile_version:4,latest_message_id:'m-customer',latest_conversation_message_id:'m-sales'}
  };
  globalThis.draftCalls=[];
  v2Runtime.client.createDraft=async(id,input)=>{
   draftCalls.push({id,input});
   return {data:{draft_id:'draft-contract',revision:2,draft:'这是一份待人工确认的草稿。',status:'draft_ready',context_versions:{customer_revision:31,opportunity_revision:30,profile_version:4,latest_message_id:'m-customer',latest_conversation_message_id:'m-sales'}}};
  };
  v2Runtime.client.getContext=async()=>({data:v2Runtime.contextByOpportunity[contractOpportunity.opportunity_id]});
 `);
 await evaluate('generateReply(contractCustomer)');
 assert.deepEqual(JSON.parse(evaluate('JSON.stringify(draftCalls[0])')),{id:'c1-o1',input:{latest_message_id:'m-customer',expected_revision:30}});
 assert.equal(evaluate("getOpportunityDraft(contractCustomer).context_versions.latest_conversation_message_id"),'m-sales');
 assert.equal(evaluate("draftIsCurrent(contractCustomer,getOpportunityDraft(contractCustomer))"),true);
 assert.match(evaluate('renderCustomersV2()'),/近期纳入 2 条；历史省略 5 条/);

 evaluate("globalThis.oldDraft={...getOpportunityDraft(contractCustomer),context_versions:{...getOpportunityDraft(contractCustomer).context_versions}};delete oldDraft.context_versions.latest_conversation_message_id");
 assert.equal(evaluate('draftIsCurrent(contractCustomer,oldDraft)'),false);
 evaluate("v2Runtime.contextByOpportunity[contractOpportunity.opportunity_id].context_versions.latest_conversation_message_id='m-new-sales'");
 assert.equal(evaluate("draftIsCurrent(contractCustomer,getOpportunityDraft(contractCustomer))"),false);

 evaluate(`
  v2Runtime.contextByOpportunity[contractOpportunity.opportunity_id].context_versions.latest_conversation_message_id='m-sales';
  globalThis.acceptedDraftId=getOpportunityDraft(contractCustomer).draft_id;
  globalThis.refreshedContext={...v2Runtime.contextByOpportunity[contractOpportunity.opportunity_id],context_versions:{...v2Runtime.contextByOpportunity[contractOpportunity.opportunity_id].context_versions,latest_conversation_message_id:'m-concurrent-sales'}};
  v2Runtime.client.createDraft=async()=>({data:{draft_id:'draft-raced',revision:1,draft:'不应保存',status:'draft_ready',context_versions:{customer_revision:31,opportunity_revision:30,profile_version:4,latest_message_id:'m-customer',latest_conversation_message_id:'m-sales'}}});
  v2Runtime.client.getContext=async()=>({data:refreshedContext});
 `);
 await evaluate('generateReply(contractCustomer)');
 assert.equal(evaluate('getOpportunityDraft(contractCustomer).draft_id'),evaluate('acceptedDraftId'));
 assert.match(get('#toast').textContent,/生成期间双向会话或条件已变化/);

 evaluate("v2Runtime.contextByOpportunity[contractOpportunity.opportunity_id].context_versions.latest_conversation_message_id='m-sales';v2Runtime.client.createDraft=async()=>{throw new V2ApiError('单条消息超过上限',{status:422,code:'CONTEXT_MESSAGE_TOO_LARGE',traceId:'trace-large'})}");
 await evaluate('generateReply(contractCustomer)');
 assert.match(get('#toast').textContent,/消息过长，无法生成草稿：单条消息超过上限/);

 evaluate("state.insights[contractCustomer.id]={profile_suggestions:[{field:'age',label:'年龄',value:'42'}]};globalThis.ageBefore=contractCustomer.age");
 assert.equal(await evaluate('applyWorkbenchProfileSuggestion(contractCustomer,0)'),true);
 assert.equal(evaluate('contractCustomer.age'),evaluate('ageBefore'));
 assert.match(get('#toast').textContent,/v2 合同不支持写入/);

 evaluate(`
  contractCustomer.messages=[{role:'customer',status:'received',message_id:'stale-local',text:'不应保留'}];
  v2Runtime.client.getCustomer=async()=>({data:{customer_id:contractCustomer.customer_id,revision:40,profile_version:4,human_handoff:false,contact_preferences:{marketing_opt_out:false},persons:contractCustomer.persons,opportunities:contractCustomer.opportunities}});
  v2Runtime.client.listMessages=async()=>({data:{messages:[]}});
  v2Runtime.client.getContext=async()=>({data:{context_versions:{customer_revision:40,opportunity_revision:30,profile_version:4,latest_message_id:null,latest_conversation_message_id:null}}});
 `);
 await evaluate('loadV2Customer(contractCustomer.customer_id)');
 assert.equal(evaluate('contractCustomer.messages.length'),0);
 assert.equal(evaluate('contractCustomer.last'),'暂无消息');

 console.log('PASS — connected writes are API-first, budgets are canonical, failures preserve local state, and drafts use server conversation versions.');
})().catch(error=>{console.error(error);process.exitCode=1;});
