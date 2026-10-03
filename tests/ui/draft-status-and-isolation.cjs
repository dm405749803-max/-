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

 evaluate("connection={checked:true,local:true,difyConfigured:true};updateConnectionNotice()");
 assert.match(get('#connection-notice').textContent,/Dify 调用已配置/);
 assert.doesNotMatch(get('#connection-notice').textContent,/已接通/);
 assert.equal(evaluate("relationshipLabel('daughter')"),'女儿');
 assert.equal(evaluate("stageLabel('new')"),'待了解');
 for(const [status,label] of Object.entries({needs_source:'缺少已核验资料',needs_information:'需要补充信息',human_required:'需要人工处理',stop_marketing:'已停止营销',stale_context:'会话已变化',error:'未能生成草稿'}))assert.equal(evaluate(`draftStatusPresentation({status:${JSON.stringify(status)},text:''}).label`),label);

 evaluate(`
  ensureWorkbenchModel();v2Runtime.status='connected';
  globalThis.c=state.customers[0];globalThis.a=activeOpportunity(c);
  c.human=false;c.human_handoff=false;c.contact_preferences={marketing_opt_out:false};
  a.contact_state={marketing_opt_out:false,human_handoff:false,purchased_for_opportunity:false};
  c.messages=[{role:'customer',status:'received',message_id:'message-a',text:'A需求客户消息'}];
  v2Runtime.messagesByOpportunity[a.opportunity_id]=[...c.messages];
  v2Runtime.contextByOpportunity[a.opportunity_id]={context_versions:{customer_revision:5,opportunity_revision:7,profile_version:3,latest_message_id:'message-a',latest_conversation_message_id:'message-a'}};
  setOpportunityDraft(c,{draft_id:'draft-a',revision:1,text:'A需求未发送人工编辑',original:'A需求原稿',provider:'dify',status:'draft_ready',source_status:'draft_ready',citations:[],context_versions:contextStamp(c)},a);
  globalThis.b=normalizeOpportunity({opportunity_id:'opportunity-b',person_id:a.person_id,purpose:'第二需求',budget_amount:0,budget_currency:'CNY',stage:'new',revision:1,profile_version:1,contact_state:{marketing_opt_out:false,human_handoff:false,purchased_for_opportunity:false}});
  c.opportunities.push(b);
  v2Runtime.client.getCustomer=async()=>({data:{customer_id:c.customer_id,revision:5,profile_version:3,human_handoff:false,contact_preferences:{marketing_opt_out:false},persons:c.persons,opportunities:c.opportunities}});
  v2Runtime.client.listMessages=async id=>({data:id===a.opportunity_id?[{role:'customer',status:'received',message_id:'message-a',text:'A需求客户消息'}]:[]});
  v2Runtime.client.getContext=async id=>{if(id===b.opportunity_id)throw new V2ApiError('该需求暂无客户消息',{status:409,code:'NO_CUSTOMER_MESSAGE'});return {data:v2Runtime.contextByOpportunity[a.opportunity_id]};};
 `);

 const selectingB=evaluate('selectWorkbenchOpportunity(c,b.opportunity_id)');
 assert.equal(evaluate('c.selectedOpportunityId'),'opportunity-b');
 assert.equal(evaluate('c.messages.length'),0);
 assert.equal(evaluate('getOpportunityDraft(c)'),null);
 assert.match(evaluate('renderCustomersV2()'),/正在加载当前需求的会话/);
 assert.doesNotMatch(evaluate('renderCustomersV2()'),/A需求客户消息|A需求未发送人工编辑/);
 await selectingB;
 assert.equal(evaluate('c.messages.length'),0);
 assert.equal(evaluate('v2Runtime.loadingOpportunityId'),null);
 assert.match(evaluate('renderCustomersV2()'),/这项需求还没有客户消息/);
 assert.doesNotMatch(get('#toast').textContent,/客户详情读取失败/);

 await evaluate('selectWorkbenchOpportunity(c,a.opportunity_id)');
 assert.equal(evaluate('c.messages[0].message_id'),'message-a');
 assert.equal(evaluate('getOpportunityDraft(c).text'),'A需求未发送人工编辑');
 await evaluate('selectWorkbenchOpportunity(c,b.opportunity_id)');
 assert.equal(evaluate('getOpportunityDraft(c)'),null);

 evaluate(`
  c.selectedOpportunityId=a.opportunity_id;c.messages=[...v2Runtime.messagesByOpportunity[a.opportunity_id]];
  globalThis.resolveSlowA=null;
  v2Runtime.client.listMessages=id=>id===a.opportunity_id?new Promise(resolve=>{resolveSlowA=resolve;}):Promise.resolve({data:[]});
  v2Runtime.client.getContext=async id=>id===a.opportunity_id?{data:v2Runtime.contextByOpportunity[a.opportunity_id]}:Promise.reject(new V2ApiError('该需求暂无客户消息',{status:409,code:'NO_CUSTOMER_MESSAGE'}));
 `);
 const slowA=evaluate('selectWorkbenchOpportunity(c,a.opportunity_id)');
 await new Promise(resolve=>setImmediate(resolve));
 await evaluate('selectWorkbenchOpportunity(c,b.opportunity_id)');
 evaluate("resolveSlowA({data:[{role:'customer',status:'received',message_id:'late-a',text:'A延迟响应'}]})");
 await slowA;
 assert.equal(evaluate('c.selectedOpportunityId'),'opportunity-b');
 assert.equal(evaluate('c.messages.length'),0);

 evaluate(`
  c.selectedOpportunityId=a.opportunity_id;c.messages=[...v2Runtime.messagesByOpportunity[a.opportunity_id]];
  v2Runtime.contextByOpportunity[a.opportunity_id]={context_versions:{customer_revision:5,opportunity_revision:7,profile_version:3,latest_message_id:'message-a',latest_conversation_message_id:'message-a'}};
  v2Runtime.client.getContext=async()=>({data:v2Runtime.contextByOpportunity[a.opportunity_id]});
  v2Runtime.client.createDraft=async()=>({data:{draft_id:'blocked',revision:1,draft:'',status:'needs_source',missing_evidence:['no_relevant_approved_source','candidate_source_not_business_approved'],next_action:'verify_product_source',risk_flags:['business_review_pending'],trace:{provider:'knowledge-adapter'},context_versions:{customer_revision:5,opportunity_revision:7,profile_version:3,latest_message_id:'message-a',latest_conversation_message_id:'message-a'}}});
 `);
 await evaluate('generateReply(c)');
 assert.equal(evaluate('getOpportunityDraft(c).status'),'needs_source');
 assert.equal(evaluate('getOpportunityDraft(c).text'),'');
 assert.equal(evaluate('draftCanConfirm(c,getOpportunityDraft(c))'),false);
 assert.equal(get('#toast').textContent,'当前没有可用的已核验资料，未生成草稿。');
 const blockedHtml=evaluate('renderCustomersV2()');
 assert.match(blockedHtml,/缺少已核验资料/);
 assert.match(blockedHtml,/没有找到与问题相关且已通过业务核验的资料/);
 assert.match(blockedHtml,/先完成相关产品资料的业务核验/);
 assert.match(blockedHtml,/资料核验/);
 assert.doesNotMatch(get('#toast').textContent,/可编辑草稿|已生成/);

 const citationHtml=evaluate(`citationsHTML([{document_id:'terms-v1',title:'测试条款',version:'v1',location:'交费期',excerpt:'仅支持3年交',source_url:'https://example.invalid/terms'},{document_id:'unsafe',location:'x',excerpt:'y',source_url:'javascript:alert(1)'}])`);
 assert.match(citationHtml,/测试条款/);assert.match(citationHtml,/v1 · 交费期/);assert.match(citationHtml,/仅支持3年交/);assert.match(citationHtml,/href="https:\/\/example\.invalid\/terms"/);assert.doesNotMatch(citationHtml,/href="javascript:/);

 console.log('PASS — configured is not connected, draft statuses and citations are truthful, and messages/drafts stay isolated by opportunity across empty and delayed loads.');
})().catch(error=>{console.error(error);process.exitCode=1;});
