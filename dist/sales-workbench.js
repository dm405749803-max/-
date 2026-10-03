'use strict';

(function(){
 const client=new SalesWorkbenchV2Client();
 const state={health:null,customers:[],details:new Map(),tasks:[],activeCustomerId:null,activeOpportunityId:null,messages:[],context:null,draft:null,draftDirty:false,memory:[],recommendations:[],budget:null,safety:null,filter:'all',query:'',busy:new Set(),autoAttempted:new Set(),poll:null};
 const $=selector=>document.querySelector(selector);
 const $$=selector=>[...document.querySelectorAll(selector)];
 const escapeHTML=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
 const id=prefix=>`${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
 const unwrap=payload=>Array.isArray(payload)?payload:payload?.customers||payload?.messages||payload?.tasks||payload?.proposals||payload?.recommendations||[];
 const activeDetail=()=>state.details.get(state.activeCustomerId)||null;
 const activeOpportunity=()=>activeDetail()?.opportunities?.find(item=>item.opportunity_id===state.activeOpportunityId)||null;
 const activePerson=()=>{const detail=activeDetail(),opportunity=activeOpportunity();return detail?.persons?.find(item=>item.person_id===(opportunity?.person_id||opportunity?.person_ids?.[0]))||null;};
 const formatDate=value=>{if(!value)return '未记录';const date=new Date(value);return Number.isNaN(date.getTime())?String(value):date.toLocaleDateString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit'}).replaceAll('/','/');};
 const formatTime=value=>{const date=new Date(value);return Number.isNaN(date.getTime())?'':date.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false});};
 const labelMap={
  intent:{unknown:'待识别',low:'低意向',medium:'中意向',high:'高意向'},
  stage:{new_contact:'新接触',discovery:'需求了解',solution_discussion:'方案沟通',closing:'促成确认',won:'已成交',paused:'暂停'},
  processing:{normal:'正常沟通',waiting_customer:'等待客户',waiting_sales_review:'等待销售确认',human_handoff:'人工接管',marketing_opt_out:'拒收营销',purchased_service:'已购服务'},
  relationship:{self:'本人',spouse:'配偶',son:'儿子',daughter:'女儿',father:'父亲',mother:'母亲',family:'家人'},
  fact:{age:'年龄',gender:'性别',annual_budget:'年度预算',budget:'预算',funds_usage_years:'资金使用时间',payment_years:'交费年限',purpose:'需求方向',relationship:'关系',risk_preference:'风险偏好',health_note:'健康信息'}
 };

 async function api(path,options={}){
  const response=await fetch(path,{method:options.method||'GET',headers:{accept:'application/json','content-type':'application/json','x-workspace-id':'demo'},...(options.body===undefined?{}:{body:JSON.stringify(options.body)})});
  let payload={};try{payload=await response.json();}catch{}
  if(!response.ok)throw new V2ApiError(payload?.error?.message||`请求失败（${response.status}）`,{status:response.status,code:payload?.error?.code||'HTTP_ERROR',details:payload?.error?.details,traceId:payload?.trace_id});
  return payload;
 }
 function toast(message){const el=$('#toast');el.textContent=message;el.classList.add('visible');clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.classList.remove('visible'),2600);}
 function showAlert(message){const el=$('#global-alert');el.textContent=message;el.hidden=!message;}
 function setBusy(key,value){value?state.busy.add(key):state.busy.delete(key);renderActionStates();}
 function renderActionStates(){const has=Boolean(activeOpportunity());$('#generate-draft').disabled=!has||state.busy.has('draft')||aiBlocked();$('#confirm-draft').disabled=!has||state.busy.has('confirm')||!$('#reply-draft').value.trim()||aiBlocked();$('#generate-match').disabled=!has||state.busy.has('match')||aiBlocked();}
 function aiBlocked(){return state.safety?.locked||state.budget?.state==='stopped';}

 async function loadHealth(){
  try{const response=await fetch('/api/health',{headers:{accept:'application/json'}});state.health=response.ok?await response.json():null;}
  catch{state.health=null;}
  const chip=$('#backend-status');
  if(state.health?.v2_database==='ready'){chip.className='status-chip ok';chip.innerHTML='<i></i>后端可用';}
  else{chip.className='status-chip stop';chip.innerHTML='<i></i>后端不可用';}
 }
 async function loadSafety(){
  const customerId=state.activeCustomerId;
  const [safety,budget]=await Promise.all([
   api('/api/v2/knowledge-safety/status').then(item=>item.data).catch(()=>null),
   customerId?api(`/api/v2/customers/${encodeURIComponent(customerId)}/ai-budget`).then(item=>item.data).catch(()=>null):null
  ]);
  state.safety=safety;state.budget=budget;renderSafety();
 }
 function renderSafety(){
  const kc=$('#knowledge-status'),bc=$('#budget-status');
  kc.className=`status-chip ${state.safety?.locked?'stop':state.safety?'ok':''}`;kc.innerHTML=`<i></i>${state.safety?.locked?'知识异常·AI停止':state.safety?'知识版本正常':'知识状态待读取'}`;
  bc.className=`status-chip ${state.budget?.state==='stopped'?'stop':state.budget?.state==='warning'?'warn':state.budget?'ok':''}`;bc.innerHTML=`<i></i>${state.budget?`AI 成本 ${state.budget.used_percent||0}%`:'AI 成本待读取'}`;
  const alert=state.safety?.locked?'产品规则与 RAG 版本不一致，所有 AI 对客能力已停止，请人工处理。':state.budget?.state==='stopped'?(state.budget.alert||'该客户已达到 AI 成本上限，请人工处理。'):state.budget?.state==='warning'?(state.budget.alert||'该客户 AI 成本已达到提醒线。'):'';
  showAlert(alert);renderActionStates();
 }

 async function loadCustomers({preserve=true}={}){
  setBusy('customers',true);
  try{
   const response=await client.listCustomers();state.customers=unwrap(response.data);
   const detailPairs=await Promise.all(state.customers.map(async customer=>{try{return [customer.customer_id,(await client.getCustomer(customer.customer_id)).data];}catch{return [customer.customer_id,{...customer,persons:[],opportunities:[],facts:[]}];}}));
   state.details=new Map(detailPairs);
   if(!preserve||!state.details.has(state.activeCustomerId))state.activeCustomerId=state.customers[0]?.customer_id||null;
   const detail=activeDetail();if(!detail?.opportunities?.some(item=>item.opportunity_id===state.activeOpportunityId))state.activeOpportunityId=detail?.opportunities?.[0]?.opportunity_id||null;
   renderCustomers();
  }catch(error){showAlert(`客户数据加载失败：${error.message}`);state.customers=[];renderCustomers();}
  finally{setBusy('customers',false);}
 }
 function customerViewModel(customer){
  const detail=state.details.get(customer.customer_id)||customer,opportunities=detail.opportunities||[];
  const current=opportunities.find(item=>item.processing_status==='waiting_sales_review')||opportunities.find(item=>item.intent_level==='high')||opportunities[0]||{};
  return {customer,detail,current,intent:current.intent_level||'unknown',purpose:current.purpose||'需求待了解',processing:current.processing_status||'normal',purchased:opportunities.some(item=>item.purchased),review:opportunities.some(item=>['waiting_sales_review','human_handoff'].includes(item.processing_status))};
 }
 function filteredCustomers(){
  const query=state.query.trim().toLowerCase();return state.customers.map(customerViewModel).filter(item=>{
   if(state.filter==='high'&&item.intent!=='high')return false;if(state.filter==='review'&&!item.review)return false;if(state.filter==='purchased'&&!item.purchased)return false;
   if(!query)return true;const haystack=[item.customer.name,item.purpose,item.current.product_id,item.customer.wechat_joined_label].join(' ').toLowerCase();return haystack.includes(query);
  });
 }
 function renderCustomers(){
  const items=filteredCustomers();$('#customer-count').textContent=`${items.length} 人`;
  $('#customer-list').innerHTML=items.length?items.map(({customer,current,intent,purpose,processing})=>`<button class="customer-row ${customer.customer_id===state.activeCustomerId?'active':''}" type="button" data-customer-id="${escapeHTML(customer.customer_id)}"><div class="customer-row-top"><div class="customer-row-name"><span class="mini-avatar">${escapeHTML((customer.name||'客').slice(0,1))}</span><strong>${escapeHTML(customer.name||'未命名客户')}</strong></div><span class="mini-intent ${escapeHTML(intent)}">${escapeHTML(labelMap.intent[intent]||intent)}</span></div><p>${escapeHTML(purpose)}</p><div class="customer-row-bottom"><span>${escapeHTML(customer.wechat_joined_label||formatDate(customer.wechat_joined_on))} 加入</span><span>${escapeHTML(labelMap.processing[processing]||processing)}</span></div></button>`).join(''):'<div class="list-empty">暂时没有符合条件的客户。<br>可以从客户模拟端创建演练客户。</div>';
  $$('.customer-row').forEach(button=>button.addEventListener('click',()=>selectCustomer(button.dataset.customerId)));
 }

 async function selectCustomer(customerId){state.activeCustomerId=customerId;const detail=activeDetail();state.activeOpportunityId=detail?.opportunities?.[0]?.opportunity_id||null;state.draft=null;state.draftDirty=false;renderCustomers();await loadActiveWorkspace();}
 async function selectOpportunity(opportunityId){state.activeOpportunityId=opportunityId;state.draft=null;state.draftDirty=false;renderConversationShell();await loadActiveWorkspace({keepShell:true});}
 async function loadActiveWorkspace({keepShell=false}={}){
  const opportunity=activeOpportunity();
  if(!opportunity){state.messages=[];state.context=null;state.memory=[];state.recommendations=[];renderAll();return;}
  if(!keepShell)renderConversationShell();
  setBusy('workspace',true);
  const oid=encodeURIComponent(opportunity.opportunity_id);
  const [messages,context,memory,recommendations,tasks]=await Promise.all([
   client.listMessages(opportunity.opportunity_id).then(item=>unwrap(item.data)).catch(error=>{toast(error.message);return [];}),
   client.getContext(opportunity.opportunity_id).then(item=>item.data).catch(()=>null),
   state.health?.backend_b1_enabled?client.listMemoryProposals({opportunity_id:opportunity.opportunity_id}).then(item=>unwrap(item.data)).catch(()=>[]):[],
   state.health?.backend_b2_enabled?client.listRecommendations(opportunity.opportunity_id).then(item=>unwrap(item.data)).catch(()=>[]):[],
   client.listTasks().then(item=>unwrap(item.data)).catch(()=>state.tasks)
  ]);
  state.messages=messages;state.context=context;state.memory=memory;state.recommendations=recommendations;state.tasks=tasks;await loadSafety();renderAll();setBusy('workspace',false);maybeAutoGenerate();
 }

 function maybeAutoGenerate(){
  const opportunity=activeOpportunity(),latest=state.messages.at(-1);if(!opportunity||latest?.role!=='customer'||aiBlocked())return;
  const key=`${opportunity.opportunity_id}:${latest.message_id}`;if(state.autoAttempted.has(key))return;
  state.autoAttempted.add(key);queueMicrotask(generateDraft);
 }

 function renderAll(){renderCustomers();renderConversationShell();renderMessages();renderAssistant();renderTasks();renderActionStates();}
 function renderConversationShell(){
  const detail=activeDetail(),opportunity=activeOpportunity(),person=activePerson();const has=Boolean(detail&&opportunity);
  $('#conversation-empty').hidden=has;$('#conversation-content').hidden=!has;$('#assistant-empty').style.display=has?'none':'block';if(!has)return;
  $('#active-customer-name').textContent=detail.name||'未命名客户';$('#customer-avatar').textContent=(detail.name||'客').slice(0,1);
  $('#active-customer-meta').textContent=`${detail.wechat_joined_label||formatDate(detail.wechat_joined_on)} 加入微信 · ${person?.relationship?labelMap.relationship[person.relationship]||person.relationship:'购买对象待了解'}`;
  const intent=opportunity.intent_level||'unknown';$('#active-intent').textContent=`${labelMap.intent[intent]||intent} · ${opportunity.intent_score||0}分`;$('#active-intent').className=`intent-badge ${intent}`;
  $('#opportunity-tabs').innerHTML=(detail.opportunities||[]).map(item=>`<button class="opportunity-tab ${item.opportunity_id===opportunity.opportunity_id?'active':''}" type="button" data-opportunity-id="${escapeHTML(item.opportunity_id)}">${escapeHTML(item.purpose||'待识别需求')}${item.purchased?' · 已购':''}</button>`).join('');
  $$('.opportunity-tab').forEach(button=>button.addEventListener('click',()=>selectOpportunity(button.dataset.opportunityId)));
  $('#sales-stage').value=opportunity.sales_stage||'new_contact';$('#summary-person').textContent=person?.name||labelMap.relationship[person?.relationship]||'待了解';$('#summary-purpose').textContent=opportunity.purpose||'待了解';$('#summary-budget').textContent=opportunity.budget_amount==null?'待了解':`${Number(opportunity.budget_amount).toLocaleString('zh-CN')} 元/年`;$('#summary-processing').textContent=labelMap.processing[opportunity.processing_status]||opportunity.processing_status;
  $('#handoff-button').textContent=opportunity.contact_state?.human_handoff?'已人工接管':'转人工接管';$('#handoff-button').disabled=Boolean(opportunity.contact_state?.human_handoff);$('#purchased-button').textContent=opportunity.purchased?'已标记购买':'标记已购';$('#purchased-button').disabled=Boolean(opportunity.purchased);
  if(!state.draft&&!state.draftDirty){$('#reply-draft').value='';$('#draft-state').textContent='未生成';$('#draft-state').className='draft-state';}
 }
 function renderMessages(){
  const el=$('#message-list');if(!activeOpportunity())return;
  el.innerHTML=state.messages.length?state.messages.map(message=>`<div class="message-line ${message.role==='sales'?'sales':'customer'}"><div class="message-bubble">${escapeHTML(message.text)}<small>${message.role==='sales'?'销售':'客户'} · ${escapeHTML(formatTime(message.occurred_at))}${message.status==='simulated_sent'?' · 演练发送':''}</small></div></div>`).join(''):'<div class="message-empty">这项购买需求还没有会话。客户发来消息后会显示在这里。</div>';el.scrollTop=el.scrollHeight;
 }
 function renderAssistant(){
  const opportunity=activeOpportunity();if(!opportunity)return;
  const lastCustomer=[...state.messages].reverse().find(item=>item.role==='customer');const processing=opportunity.processing_status;
  const route=processing==='human_handoff'?['人工接管','AI停止销售对话',['由人工继续处理客户问题','处理完成后再恢复普通流程']]:processing==='marketing_opt_out'?['停止营销','客户已拒收营销',['停止产品触达','只处理客户主动提出的合同服务']]:opportunity.purchased?['已购服务','当前购买需求已经成交',['停止重复推荐','进入保单服务与续期维护']]:lastCustomer?['分析最新消息','先回应，再推进',['回答客户当前问题','仅在必要时追问一个基础信息','产品内容由销售确认后发送']]:['等待客户','尚无客户消息',['等待客户表达问题或需求']];
  $('#route-label').textContent=route[0];$('#route-explanation').textContent=route[1];$('#route-steps').innerHTML=route[2].map((item,index)=>`<li data-index="${index+1}">${escapeHTML(item)}</li>`).join('');
  $('#intent-score').textContent=`${opportunity.intent_score||0} 分`;$('#intent-score-bar').style.width=`${Math.max(0,Math.min(100,opportunity.intent_score||0))}%`;$('#intent-reason').textContent=opportunity.intent_reason||'当前没有足够信号判断客户意向。';
  renderCitations();renderFacts();renderMemory();renderRecommendations();
 }
 function renderCitations(){const citations=state.draft?.citations||[];$('#citation-count').textContent=`${citations.length} 条`;$('#citation-list').innerHTML=citations.length?citations.map(item=>`<div class="citation-item"><strong>${escapeHTML(item.title||item.document_id||'核验资料')}</strong><p>${escapeHTML(item.excerpt||item.quote||item.location||'已由工作流引用')}</p></div>`).join(''):'<p class="muted-copy">生成草稿后显示引用依据。基础接待通常不需要产品引用。</p>';}
 function renderFacts(){const facts=activeDetail()?.facts||[];$('#fact-count').textContent=`${facts.length} 项`;$('#confirmed-facts').innerHTML=facts.length?facts.map(fact=>`<div class="fact-item"><strong>${escapeHTML(labelMap.fact[fact.field]||fact.field)}</strong><p>${escapeHTML(typeof fact.value==='object'?JSON.stringify(fact.value):fact.value)}</p></div>`).join(''):'<p class="muted-copy">还没有经确认的长期客户信息。</p>';}
 function renderMemory(){const pending=state.memory.filter(item=>item.status==='pending');$('#memory-count').textContent=pending.length;$('#memory-proposals').innerHTML=pending.length?pending.map(item=>`<div class="proposal-card" data-proposal-id="${escapeHTML(item.proposal_id)}"><strong>${item.review_mode==='conflict_review'?'发现信息冲突':'本轮画像更新'}</strong><p>${escapeHTML(item.summary?.text||item.summary?.summary||'AI从客户原话中发现了可沉淀的信息。')}</p>${(item.facts||[]).map(fact=>`<span class="proposal-tag">${escapeHTML(labelMap.fact[fact.field]||fact.field)}：${escapeHTML(fact.value)}</span>`).join('')}<div class="proposal-actions"><button class="accept-button" data-memory-action="approve">确认写入</button><button class="reject-button" data-memory-action="reject">不采用</button></div></div>`).join(''):'<p class="muted-copy">目前没有需要你处理的画像变化。</p>';$$('[data-memory-action]').forEach(button=>button.addEventListener('click',()=>decideMemory(button.closest('[data-proposal-id]').dataset.proposalId,button.dataset.memoryAction)));}
 function renderRecommendations(){const items=state.recommendations;$('#product-recommendations').innerHTML=items.length?items.map(item=>`<div class="recommendation-card" data-recommendation-id="${escapeHTML(item.recommendation_id)}"><strong>${item.decision==='accepted'?'已采纳的产品建议':'最新匹配结果'}</strong><p>${escapeHTML(item.result?.reason||item.reason||`状态：${item.status||item.result?.status||'待判断'}`)}</p>${(item.result?.candidates||[]).map(candidate=>`<div class="candidate ${candidate.status==='eligible_for_discussion'?'eligible':''}"><h4>${escapeHTML(candidate.product_name||candidate.product_id||'候选产品')} · ${escapeHTML(candidate.status||'')}</h4><ul>${(candidate.reasons||candidate.match_reasons||[]).map(reason=>`<li>${escapeHTML(reason)}</li>`).join('')}${(candidate.missing_fields||[]).map(field=>`<li>还需确认：${escapeHTML(labelMap.fact[field]||field)}</li>`).join('')}</ul></div>`).join('')}<div class="recommendation-actions">${item.decision==='pending'||!item.decision?'<button class="accept-button" data-match-action="accept">采纳建议</button><button class="reject-button" data-match-action="reject">驳回</button>':''}</div></div>`).join(''):'<p class="muted-copy">尚未生成产品建议。先完成必要画像，再让 B2 进行匹配。</p>';$$('[data-match-action]').forEach(button=>button.addEventListener('click',()=>decideRecommendation(button.closest('[data-recommendation-id]').dataset.recommendationId,button.dataset.matchAction)));}
 function renderTasks(){const tasks=state.tasks.filter(item=>!state.activeCustomerId||item.customer_id===state.activeCustomerId);const open=tasks.filter(item=>item.status==='open');$('#task-count').textContent=open.length;$('#nav-task-count').textContent=state.tasks.filter(item=>item.status==='open').length;$('#open-task-count').textContent=`${open.length} 项`;$('#task-list').innerHTML=open.length?open.map(task=>`<div class="task-card" data-task-id="${escapeHTML(task.task_id)}"><strong>${escapeHTML(task.title||task.reason||'跟进待办')}</strong><p>${escapeHTML(task.reason||'')}</p><span class="task-tag">${task.overdue?'已逾期':task.due_at?`${formatDate(task.due_at)} 到期`:'未设置日期'}</span><div class="task-actions"><button class="accept-button" data-task-action="done">完成待办</button></div></div>`).join(''):'<p class="muted-copy">当前客户没有未完成待办。</p>';$$('[data-task-action]').forEach(button=>button.addEventListener('click',()=>completeTask(button.closest('[data-task-id]').dataset.taskId)));}

 async function generateDraft(){
  const opportunity=activeOpportunity(),lastCustomer=[...state.messages].reverse().find(item=>item.role==='customer');if(!opportunity||!lastCustomer)return toast('当前没有可回复的客户消息。');if(aiBlocked())return toast('AI 已被安全门禁停止，请人工处理。');
  setBusy('draft',true);$('#draft-state').textContent='生成中';
  try{const context=(await client.getContext(opportunity.opportunity_id)).data;const response=await client.createDraft(opportunity.opportunity_id,{latest_message_id:context.latest_message_id,expected_revision:context.context_versions.opportunity_revision});state.draft=response.data;state.draftDirty=false;
   if(state.draft.status==='draft_ready'&&String(state.draft.draft||'').trim()){$('#reply-draft').value=state.draft.draft;$('#draft-state').textContent=state.draft.review_required===false?'安全问询·可自动':'等待你确认';$('#draft-state').className='draft-state ready';$('#draft-subtitle').textContent=state.draft.review_required===false?'基础信息问句已通过安全规则':'AI 已生成建议，客户现在看不到';renderCitations();if(state.draft.review_required===false&&state.draft.next_action==='auto_send_safe_intake')await confirmDraft({automatic:true});else toast('AI 草稿已生成，请核对后发送。');}
   else{$('#draft-state').textContent='需要补充信息';$('#draft-state').className='draft-state';$('#draft-guidance').textContent=state.draft.next_question||state.draft.reason||state.draft.missing_evidence?.join('；')||'当前没有可发送草稿。';toast('中控暂未生成可发送草稿，请查看提示。');}
  }catch(error){toast(`生成失败：${error.message}`);$('#draft-state').textContent='生成失败';}
  finally{setBusy('draft',false);renderActionStates();}
 }
 async function confirmDraft({automatic=false}={}){const text=$('#reply-draft').value.trim();if(!text)return toast('回复内容不能为空。');if(!state.draft)return toast('当前回复不是可确认的 AI 草稿，请先生成草稿。');setBusy('confirm',true);try{await client.confirmDraft(state.draft.draft_id,{expected_revision:state.draft.revision,final_text:text,delivery_mode:'simulation',idempotency_key:id('sales-send')});state.draft=null;state.draftDirty=false;$('#reply-draft').value='';$('#draft-state').textContent='已模拟发送';$('#draft-state').className='draft-state ready';await refreshActiveCustomer();toast(automatic?'已自动回复安全的基础问句。':'已确认并记录为演练发送。');}catch(error){toast(`发送失败：${error.message}`);}finally{setBusy('confirm',false);}}
 async function patchOpportunity(changes,success){const opportunity=activeOpportunity();if(!opportunity)return;try{const response=await client.patchOpportunity(opportunity.opportunity_id,{expected_revision:opportunity.revision,changes});const detail=activeDetail(),index=detail.opportunities.findIndex(item=>item.opportunity_id===opportunity.opportunity_id);detail.opportunities[index]=response.data;renderAll();toast(success);}catch(error){toast(`保存失败：${error.message}`);}}
 async function decideMemory(proposalId,action){const item=state.memory.find(entry=>entry.proposal_id===proposalId);if(!item)return;try{if(action==='approve')await client.approveMemoryProposal(proposalId,{expected_revision:item.revision,idempotency_key:id('memory-approve'),reviewer:'演练销售',reason:'销售已核对本轮画像卡'});else await client.rejectMemoryProposal(proposalId,{expected_revision:item.revision,idempotency_key:id('memory-reject'),reviewer:'演练销售',reason:'销售确认该信息不应写入长期记忆'});await refreshActiveCustomer();toast(action==='approve'?'客户信息已确认写入。':'该项信息已忽略。');}catch(error){toast(`记忆处理失败：${error.message}`);}}
 async function generateMatch(){const opportunity=activeOpportunity(),context=state.context;if(!opportunity||!context)return toast('客户上下文尚未加载。');setBusy('match',true);try{await client.generateRecommendation(opportunity.opportunity_id,{idempotency_key:id('product-match'),latest_message_id:context.latest_message_id,expected_revision:context.context_versions.opportunity_revision,expected_context_versions:context.context_versions});state.recommendations=unwrap((await client.listRecommendations(opportunity.opportunity_id)).data);renderRecommendations();toast('产品匹配已完成，请查看理由和信息缺口。');}catch(error){toast(`产品匹配失败：${error.message}`);}finally{setBusy('match',false);}}
 async function decideRecommendation(recommendationId,action){const item=state.recommendations.find(entry=>entry.recommendation_id===recommendationId);if(!item)return;try{const body={expected_revision:item.revision,idempotency_key:id(`match-${action}`),reviewer:'演练销售',reason:action==='accept'?'销售已核对候选产品、信息缺口和适用边界':'销售判断该建议暂不适用'};if(action==='accept')await client.acceptRecommendation(recommendationId,body);else await client.rejectRecommendation(recommendationId,body);state.recommendations=unwrap((await client.listRecommendations(activeOpportunity().opportunity_id)).data);renderRecommendations();toast(action==='accept'?'产品建议已采纳，可用于下一次回复草稿。':'产品建议已驳回。');}catch(error){toast(`产品建议处理失败：${error.message}`);}}
 async function completeTask(taskId){const task=state.tasks.find(item=>item.task_id===taskId);if(!task)return;try{await client.patchTask(taskId,{expected_revision:task.revision,changes:{status:'done',result:'销售已在工作台完成'}});state.tasks=unwrap((await client.listTasks()).data);renderTasks();toast('待办已完成。');}catch(error){toast(`待办更新失败：${error.message}`);}}
 async function refreshActiveCustomer(){if(!state.activeCustomerId)return;try{state.details.set(state.activeCustomerId,(await client.getCustomer(state.activeCustomerId)).data);}catch{}await loadActiveWorkspace({keepShell:true});}

 function bind(){
  $('#customer-search').addEventListener('input',event=>{state.query=event.target.value;renderCustomers();});$$('.filter-tabs button').forEach(button=>button.addEventListener('click',()=>{$$('.filter-tabs button').forEach(item=>item.classList.remove('active'));button.classList.add('active');state.filter=button.dataset.filter;renderCustomers();}));
  $$('.assistant-tabs button').forEach(button=>button.addEventListener('click',()=>openPanel(button.dataset.panel)));$$('[data-panel-target]').forEach(button=>button.addEventListener('click',()=>{openPanel(button.dataset.panelTarget);document.querySelector('.assistant-pane')?.classList.add('open');}));
  $('#refresh-all').addEventListener('click',init);$('#refresh-customer').addEventListener('click',refreshActiveCustomer);$('#generate-draft').addEventListener('click',generateDraft);$('#confirm-draft').addEventListener('click',()=>confirmDraft());$('#clear-draft').addEventListener('click',()=>{$('#reply-draft').value='';state.draftDirty=true;$('#draft-state').textContent='已清空·可手写';$('#draft-state').className='draft-state dirty';renderActionStates();});
  $('#reply-draft').addEventListener('input',()=>{if(state.draft){state.draftDirty=true;$('#draft-state').textContent='已人工修改';$('#draft-state').className='draft-state dirty';}renderActionStates();});
  $('#sales-stage').addEventListener('change',event=>patchOpportunity({sales_stage:event.target.value},'销售阶段已更新。'));$('#handoff-button').addEventListener('click',()=>askConfirm('转为人工接管','转人工后，AI将停止为当前购买需求生成销售话术。',()=>patchOpportunity({human_handoff:true,handoff_owner:'演练销售',processing_status:'human_handoff'},'已转人工接管。')));$('#purchased-button').addEventListener('click',()=>askConfirm('标记客户已购买','标记后将停止对当前购买需求进行重复营销触达。',()=>patchOpportunity({purchased:true},'已标记为已购买。')));
  $('#reload-memory').addEventListener('click',refreshActiveCustomer);$('#generate-match').addEventListener('click',generateMatch);
 }
 function openPanel(name){$$('.assistant-tabs button').forEach(item=>item.classList.toggle('active',item.dataset.panel===name));$$('.assistant-panel').forEach(item=>item.classList.toggle('active',item.dataset.panelView===name));}
 function askConfirm(title,message,onConfirm){const dialog=$('#confirm-dialog');$('#dialog-title').textContent=title;$('#dialog-message').textContent=message;dialog.returnValue='';dialog.showModal();dialog.addEventListener('close',()=>{if(dialog.returnValue==='confirm')onConfirm();},{once:true});}
 async function init(){showAlert('');await loadHealth();await loadCustomers();state.tasks=unwrap((await client.listTasks().catch(()=>({data:[]}))).data);if(state.activeOpportunityId)await loadActiveWorkspace();else renderAll();}
 bind();init();state.poll=setInterval(()=>{if(document.visibilityState==='visible'&&state.activeCustomerId)refreshActiveCustomer();},12000);
})();
