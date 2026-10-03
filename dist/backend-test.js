'use strict';

const workspace='demo';
const state={customers:[],customer:null,opportunity:null,messages:[],busy:false,health:null};
const $=selector=>document.querySelector(selector);
const escapeHTML=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const id=prefix=>`${prefix}-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;

async function api(path,{method='GET',body}={}){
 let response;
 try{response=await fetch(path,{method,headers:{accept:'application/json','x-workspace-id':workspace,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});}
 catch{throw Object.assign(new Error('无法连接本机后端，请刷新页面后重试。'),{code:'BACKEND_UNREACHABLE',traceId:null});}
 let payload=null;try{payload=await response.json();}catch{}
 if(!response.ok)throw Object.assign(new Error(payload?.error?.message||`请求失败（HTTP ${response.status}）`),{code:payload?.error?.code||'HTTP_ERROR',traceId:payload?.trace_id||null,status:response.status});
 return payload;
}

function toast(message){const el=$('#toast');el.textContent=message;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),2600);}
function setStep(name,status,detail){const el=document.querySelector(`[data-step="${name}"]`);if(!el)return;el.classList.remove('running','done','failed');if(status)el.classList.add(status);if(detail)el.querySelector('small').textContent=detail;}
function resetSteps(){setStep('message','', '等待测试');setStep('context','', '短期记忆＋长期资料');setStep('knowledge','', '版本与适用范围校验');setStep('draft','', '按消息类型调用接待规则或 Dify');setStep('review','', '本页不执行发送');$('#technical-result').textContent='本次调用的 trace_id 和回复流程状态会显示在这里。';}

function renderHealth(){
 const h=state.health,el=$('#backend-status');
 if(!h){el.className='status error';el.textContent='后端不可用';return;}
 const complete=h.dify_configured&&h.memory_workflow_configured&&h.product_match_workflow_configured;
 el.className=`status ${complete?'ready':'warning'}`;el.textContent=complete?'核心后端已连接':'部分能力待配置';
}

function renderCustomerOptions(){
 const select=$('#customer-select');select.innerHTML='<option value="">新客户（刚加入微信，需求待识别）</option>'+state.customers.map(item=>`<option value="${escapeHTML(item.customer_id)}">${escapeHTML(item.name)}</option>`).join('');
 select.value=state.customer?.customer_id||'';
}

function renderOpportunityOptions(){
 const select=$('#opportunity-select'),items=state.customer?.opportunities||[];
 if(!state.customer){select.innerHTML='<option value="">待识别（将随首轮对话创建）</option>';select.disabled=true;$('#opportunity-profile').innerHTML=[['加入日期','发送首条消息时自动记录'],['购买需求','待识别'],['预算','待确认'],['产品','尚未匹配'],['状态','新线索']].map(([label,value])=>`<div><dt>${label}</dt><dd>${value}</dd></div>`).join('');return;}
 select.disabled=false;select.innerHTML=items.map(item=>`<option value="${escapeHTML(item.opportunity_id)}">${escapeHTML(item.purpose||'待识别需求')}${item.contact_state?.purchased_for_opportunity?' · 已购':''}${item.contact_state?.human_handoff?' · 人工接手':''}</option>`).join('');
 if(state.opportunity)select.value=state.opportunity.opportunity_id;
 const o=state.opportunity;
 $('#opportunity-profile').innerHTML=o?[['加入日期',state.customer?.wechat_joined_label||'待记录'],['购买需求',o.purpose||'待识别'],['预算',o.budget_amount==null?'待确认':`${Number(o.budget_amount).toLocaleString('zh-CN')} 元`],['产品',o.product_id||'尚未匹配'],['状态',o.contact_state?.human_handoff?'人工接手':o.contact_state?.purchased_for_opportunity?'已购保护':o.purpose?'已识别':'新线索']].map(([label,value])=>`<div><dt>${escapeHTML(label)}</dt><dd>${escapeHTML(value)}</dd></div>`).join(''):'';
}

function renderMessages(){
 const el=$('#conversation');
 if(!state.messages.length){el.innerHTML=`<div class="empty">${state.customer?'这条线索还没有对话，可以继续输入客户第一句话。':'客户刚加入微信，系统还不知道购买需求。请从“你好”或“看视频来的”开始测试。'}</div>`;return;}
 el.innerHTML=state.messages.slice(-10).map(message=>`<div class="message ${message.role==='sales'?'sales':''}"><div class="bubble">${escapeHTML(message.text)}<small>${message.role==='sales'?'销售记录':'客户消息'} · ${escapeHTML(message.source||'manual')}</small></div></div>`).join('');el.scrollTop=el.scrollHeight;
}

async function loadMessages(){
 if(!state.opportunity)return;const payload=await api(`/api/v2/opportunities/${encodeURIComponent(state.opportunity.opportunity_id)}/messages`);state.messages=Array.isArray(payload.data)?payload.data:payload.data?.messages||[];renderMessages();
}

async function selectOpportunity(opportunityId){
 state.opportunity=state.customer?.opportunities?.find(item=>item.opportunity_id===opportunityId)||state.customer?.opportunities?.[0]||null;renderOpportunityOptions();resetSteps();$('#reply-result').hidden=true;await loadMessages();
}

async function loadCustomer(customerId){
 const payload=await api(`/api/v2/customers/${encodeURIComponent(customerId)}`);state.customer=payload.data;renderCustomerOptions();await selectOpportunity(state.customer.opportunities?.[0]?.opportunity_id);
}

function enterFreshLead(){
 state.customer=null;state.opportunity=null;state.messages=[];renderCustomerOptions();renderOpportunityOptions();renderMessages();resetSteps();$('#reply-result').hidden=true;$('#customer-message').focus();
}

function localDate(){const value=new Date();return `${value.getFullYear()}-${String(value.getMonth()+1).padStart(2,'0')}-${String(value.getDate()).padStart(2,'0')}`;}

async function createFreshLead(){
 const now=new Date(),customerId=id('new-lead'),opportunityId=id('lead-session');
 const name=`新客户 ${String(now.getMonth()+1).padStart(2,'0')}/${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
 await api('/api/v2/customers',{method:'POST',body:{customer_id:customerId,name,wechat_joined_on:localDate(),wechat_joined_source:'manual',wechat_joined_actor:'backend-test'}});
 await api(`/api/v2/customers/${encodeURIComponent(customerId)}/opportunities`,{method:'POST',body:{opportunity_id:opportunityId,purpose:null,stage:'待识别',status:'open',environment:'simulation'}});
 const list=await api('/api/v2/customers');state.customers=(list.data||[]).filter(item=>item.customer_id);await loadCustomer(customerId);
 return state.opportunity;
}

function showResult(draft,traceId){
 const el=$('#reply-result'),ready=draft.status==='draft_ready'&&String(draft.draft||'').trim();
 const citations=(draft.citations||[]).map(item=>`<li>${escapeHTML(item.title||item.citation_id||item.source||'已核验依据')} · ${escapeHTML(item.product_version||'')}</li>`).join('');
 el.hidden=false;el.innerHTML=`<h2>${ready?'中控台回复草稿':'中控台没有生成可用草稿'}</h2><p class="reply-text">${escapeHTML(ready?draft.draft:(draft.reason||draft.next_question||draft.missing_evidence?.join('；')||'当前条件不足，需要人工处理。'))}</p>${citations?`<ul class="citations">${citations}</ul>`:''}<p class="result-meta">状态：${escapeHTML(draft.status||'unknown')} · 只生成草稿，尚未发送</p>`;
 $('#technical-result').textContent=`trace_id: ${traceId||'-'}\nprovider: ${draft.trace?.provider||'-'}\nworkflow_run_id: ${draft.trace?.workflow_run_id||'-'}\ndraft_id: ${draft.draft_id||'-'}\nreview_required: ${draft.review_required!==false}`;
 el.scrollIntoView({behavior:'smooth',block:'nearest'});
}

async function submitMessage(message){
 resetSteps();let opportunity=state.opportunity;
 if(!opportunity){setStep('message','running','正在创建新客户与待识别会话');opportunity=await createFreshLead();}
 if(!opportunity)throw new Error('无法创建新客户会话。');
 if(opportunity.environment!=='simulation')throw new Error('联调台只允许使用演练需求。');
 if(opportunity.contact_state?.human_handoff)throw new Error('当前需求已转人工，AI草稿已暂停。');
 if(opportunity.contact_state?.purchased_for_opportunity)throw new Error('当前需求已购，不能生成新的营销草稿。');
 setStep('message','running','正在保存模拟客户消息');
 const saved=await api(`/api/v2/opportunities/${encodeURIComponent(opportunity.opportunity_id)}/messages`,{method:'POST',body:{idempotency_key:id('backend-test-message'),role:'customer',text:message,status:'received',source:'manual',environment:'simulation',occurred_at:new Date().toISOString()}});
 setStep('message','done',`已保存 ${saved.data.message_id}`);setStep('context','running','正在读取最新会话和确认资料');
 const context=await api(`/api/v2/opportunities/${encodeURIComponent(opportunity.opportunity_id)}/context`);
 setStep('context','done',`最近消息 ${context.data.recent_messages?.length||0} 条`);setStep('knowledge','running','正在校验产品版本与已确认建议');
 const refreshed=await api(`/api/v2/customers/${encodeURIComponent(state.customer.customer_id)}`);state.customer=refreshed.data;state.opportunity=state.customer.opportunities.find(item=>item.opportunity_id===opportunity.opportunity_id);renderOpportunityOptions();
 setStep('knowledge','done',state.opportunity.product_id?`${state.opportunity.product_id} · ${state.opportunity.product_version}`:'没有已确认产品');setStep('draft','running','正在调用中控回复流程');
 const draft=await api(`/api/v2/opportunities/${encodeURIComponent(opportunity.opportunity_id)}/drafts`,{method:'POST',body:{latest_message_id:context.data.latest_message_id,expected_revision:context.data.context_versions.opportunity_revision}});
 const ready=draft.data.status==='draft_ready'&&String(draft.data.draft||'').trim();setStep('draft',ready?'done':'failed',ready?'已返回可编辑草稿':draft.data.status||'未生成');setStep('review',ready?'running':'failed',ready?'等待销售核对，不会自动发送':'请查看阻断原因');showResult(draft.data,draft.trace_id);await loadMessages();
}

async function initialize(){
 resetSteps();
 try{const response=await fetch('/api/health',{headers:{accept:'application/json'}});state.health=response.ok?await response.json():null;}catch{state.health=null;}renderHealth();
 if(!state.health)throw new Error('无法连接本机后端，请确认服务已启动并刷新当前页面。');
 const payload=await api('/api/v2/customers');state.customers=(payload.data||[]).filter(item=>item.customer_id);enterFreshLead();
}

$('#new-lead-button').addEventListener('click',enterFreshLead);
$('#customer-select').addEventListener('change',event=>(event.target.value?loadCustomer(event.target.value):Promise.resolve(enterFreshLead())).catch(error=>toast(error.message)));
$('#opportunity-select').addEventListener('change',event=>selectOpportunity(event.target.value).catch(error=>toast(error.message)));
document.querySelectorAll('[data-example]').forEach(button=>button.addEventListener('click',()=>{$('#customer-message').value=button.dataset.example;$('#customer-message').focus();}));
$('#test-form').addEventListener('submit',async event=>{
 event.preventDefault();if(state.busy)return;const input=$('#customer-message'),message=input.value.trim();if(!message)return;
 state.busy=true;$('#send-button').disabled=true;$('#send-button').textContent='中控处理中…';$('#reply-result').hidden=true;
 try{await submitMessage(message);input.value='';toast('后端已返回结果；消息没有发送给真实客户。');}
 catch(error){const running=document.querySelector('.pipeline li.running');if(running)running.classList.replace('running','failed');$('#technical-result').textContent=`error: ${error.code||'ERROR'}\nmessage: ${error.message}\ntrace_id: ${error.traceId||'-'}`;toast(error.message);}
 finally{state.busy=false;$('#send-button').disabled=false;$('#send-button').textContent='发送给中控并生成回复';}
});

initialize().catch(error=>{toast(error.message);$('#technical-result').textContent=error.message;});
