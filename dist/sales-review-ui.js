'use strict';

const salesReviewRuntime={joinFrom:'',joinTo:'',dateAllowedIds:null,memory:[],recommendations:[],recommendationsByOpportunity:{},products:{},busy:'',loaded:false};
const memoryFieldLabels={age:'年龄',budget_amount:'年度预算',funds_usage_years:'预计用钱年限',payment_years:'倾向交费期',purpose:'用途',gender:'性别',relationship:'关系',concern:'主要顾虑'};
const candidateStatusLabels={eligible_for_discussion:'可讨论',needs_information:'待补信息',not_matched:'暂不匹配'};
const asRows=value=>Array.isArray(value)?value:Array.isArray(value?.items)?value.items:[];
function salesReviewPendingCount(){return state.tasks.filter(t=>!t.done&&t.status!=='completed').length+salesReviewRuntime.memory.length+salesReviewRuntime.recommendations.length;}
function normalizedJoinDate(value){const match=String(value||'').match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);return match?`${match[1]}-${String(match[2]).padStart(2,'0')}-${String(match[3]).padStart(2,'0')}`:'';}
function customerMatchesJoinDate(customer){
 if(!salesReviewRuntime.joinFrom&&!salesReviewRuntime.joinTo)return true;
 if(salesReviewRuntime.dateAllowedIds instanceof Set)return salesReviewRuntime.dateAllowedIds.has(customer.customer_id||customer.id);
 const value=normalizedJoinDate(customer.wechat_joined_on||customer.wechat_joined_label);
 return Boolean(value&&(!salesReviewRuntime.joinFrom||value>=salesReviewRuntime.joinFrom)&&(!salesReviewRuntime.joinTo||value<=salesReviewRuntime.joinTo));
}
function currentMemoryProposal(opportunity){return salesReviewRuntime.memory.find(item=>item.opportunity_id===opportunity?.opportunity_id)||null;}
function currentRecommendation(opportunity){return (salesReviewRuntime.recommendationsByOpportunity[opportunity?.opportunity_id]||[])[0]||salesReviewRuntime.recommendations.find(item=>item.opportunity_id===opportunity?.opportunity_id)||null;}
function productName(id){return salesReviewRuntime.products[id]?.name||id||'未命名产品';}
function candidateReasons(candidate){return (candidate.reasons||[]).map(item=>item.message).filter(Boolean).slice(0,3);}
function memoryValue(value){return typeof value==='object'?JSON.stringify(value):String(value??'');}

function joinDateFilterHTML(){return `<section class="join-date-filter" aria-label="按加入微信日期筛选客户"><div><strong>加入微信日期</strong><span>按客户第一次进入微信的日期查找</span></div><label>从<input id="join-date-from" type="date" value="${escapeHTML(salesReviewRuntime.joinFrom)}"></label><label>到<input id="join-date-to" type="date" value="${escapeHTML(salesReviewRuntime.joinTo)}"></label>${button('查询','apply-join-date-filter','small')}${button('清除','clear-join-date-filter','small')}${salesReviewRuntime.joinFrom||salesReviewRuntime.joinTo?tag('筛选中','blue'):''}</section>`;}

function memoryReviewHTML(c,opportunity){
 const proposal=currentMemoryProposal(opportunity);
 if(!proposal)return `<section class="panel review-decision"><div class="panel-head"><div><h2>本轮信息整理</h2><small>只在信息新增、变化或冲突时确认</small></div>${tag('无需每日审核','green')}</div><div class="panel-body"><p class="page-note">一轮沟通结束、准备方案或客户重新回来时，点一次整理即可。没有可确认的新信息就不进入待办。</p>${button(salesReviewRuntime.busy==='memory'?'正在整理…':'整理本轮信息','organize-memory','small block',salesReviewRuntime.busy?'disabled':'')}</div></section>`;
 const facts=proposal.facts||[],conflict=proposal.review_mode==='conflict_review';
 return `<section class="panel review-decision attention"><div class="panel-head"><div><h2>${conflict?'发现客户信息冲突':`本次方案画像有 ${facts.length} 项待确认`}</h2><small>${conflict?'新旧说法不一致，必须由销售判断':'影响产品匹配的信息集中确认一次'}</small></div>${tag(conflict?'冲突必须处理':'方案前确认',conflict?'red':'orange')}</div><div class="panel-body"><div class="review-fact-list">${facts.map(fact=>{const person=(c.persons||[]).find(item=>item.person_id===fact.person_id);return `<div><span>${escapeHTML(memoryFieldLabels[fact.field]||fact.field)}</span><strong>${escapeHTML(memoryValue(fact.value))}</strong><small>${person?`属于：${escapeHTML(person.name)} · `:''}来源：${escapeHTML((fact.evidence_message_ids||[]).join('、'))}</small></div>`;}).join('')||'<div class="muted-box">本次只有摘要变化，没有新增结构化字段。</div>'}</div><details class="section-gap"><summary>查看AI整理的本轮摘要</summary><p class="page-note">${escapeHTML(proposal.summary?.text||'')}</p></details><div class="decision-actions">${button('确认本次更新','approve-memory','primary small',salesReviewRuntime.busy?'disabled':'')}${button('暂不采用','reject-memory','small',salesReviewRuntime.busy?'disabled':'')}</div></div></section>`;
}

function recommendationHTML(opportunity){
 const recommendation=currentRecommendation(opportunity);
 if(!recommendation)return `<section class="panel review-decision"><div class="panel-head"><div><h2>产品建议</h2><small>根据已确认画像和产品规则生成</small></div>${tag('销售确认后使用','blue')}</div><div class="panel-body"><p class="page-note">先完成必要客户信息，再生成候选产品。系统给理由和限制，不自动替客户作决定。</p>${button(salesReviewRuntime.busy==='recommendation'?'正在匹配…':'生成产品建议','generate-recommendation','small block',salesReviewRuntime.busy?'disabled':'')}</div></section>`;
 if(recommendation.status==='accepted'){const selected=recommendation.selection||{};return `<section class="panel review-decision accepted"><div class="panel-head"><div><h2>已确认产品建议</h2><small>后续草稿使用这次人工选择</small></div>${tag('已采纳','green')}</div><div class="panel-body"><h3>${escapeHTML(productName(selected.product_id))}</h3><p class="page-note">${selected.selected_payment_years?`${selected.selected_payment_years}年交 · `:''}${escapeHTML((selected.explanation||'已由销售确认，仍需结合正式方案核对。'))}</p></div></section>`;}
 const result=recommendation.result||{},eligible=(result.candidates||[]).filter(item=>item.status==='eligible_for_discussion'),others=(result.candidates||[]).filter(item=>item.status!=='eligible_for_discussion');
 return `<section class="panel review-decision attention"><div class="panel-head"><div><h2>产品建议待确认</h2><small>${eligible.length} 款可讨论 · 由销售选择</small></div>${tag(recommendation.stale?'已过期':'待确认',recommendation.stale?'red':'orange')}</div><div class="panel-body">${eligible.map(candidate=>`<div class="candidate-card"><div class="space-between"><h3>${escapeHTML(productName(candidate.product_id))}</h3>${tag(candidateStatusLabels[candidate.status],'green')}</div><p>${escapeHTML(candidate.explanation||candidateReasons(candidate).join('；')||'符合当前已确认的基础条件。')}</p><ul>${candidateReasons(candidate).map(reason=>`<li>${escapeHTML(reason)}</li>`).join('')}</ul><label class="term-select">交费期<select data-payment-candidate="${escapeHTML(candidate.candidate_id)}">${(candidate.allowed_payment_years||[]).map(year=>`<option value="${year}">${year}年交</option>`).join('')}</select></label>${button('采用这款','accept-recommendation','primary small',`data-id="${escapeHTML(candidate.candidate_id)}" ${recommendation.stale||salesReviewRuntime.busy?'disabled':''}`)}</div>`).join('')}${!eligible.length?`<div class="notice warning">${escapeHTML((result.questions||[]).join('；')||'当前资料不足或没有匹配产品，请先补充客户信息。')}</div>`:''}${others.length?`<details class="section-gap"><summary>查看其他 ${others.length} 款及原因</summary>${others.map(item=>`<p class="page-note"><strong>${escapeHTML(productName(item.product_id))}</strong> · ${escapeHTML(candidateStatusLabels[item.status]||item.status)}：${escapeHTML((item.missing_fields||[]).join('、')||candidateReasons(item).join('；'))}</p>`).join('')}</details>`:''}<div class="decision-actions">${button('本次不采用','reject-recommendation','small',salesReviewRuntime.busy?'disabled':'')}${recommendation.stale?button('重新生成','generate-recommendation','small',''):''}</div></div></section>`;
}

function reviewQueueHTML(){
 const tasks=state.tasks.filter(item=>!item.done&&item.status!=='completed'),memory=salesReviewRuntime.memory,recommendations=salesReviewRuntime.recommendations;
 const row=(title,detail,customerId,opportunityId,type)=>{const c=state.customers.find(item=>(item.customer_id||item.id)===customerId);return `<div class="list-row"><span class="queue-icon">${type==='memory'?'记':'荐'}</span><div class="grow"><h3>${escapeHTML(title)}</h3><p>${escapeHTML(detail)}</p><small>${escapeHTML(c?.name||customerId)} · 购买需求 ${escapeHTML(opportunityId||'待确认')}</small></div>${c?button('去处理','open-review-customer','small',`data-customer="${escapeHTML(c.id)}" data-opportunity="${escapeHTML(opportunityId||'')}"`):''}</div>`;};
 return `<div class="metric-row review-metrics"><section class="panel metric"><span>客户信息待确认</span><strong>${memory.length}</strong><small>按本轮变化集中处理</small></section><section class="panel metric"><span>产品建议待确认</span><strong>${recommendations.length}</strong><small>销售决定是否采用</small></section><section class="panel metric"><span>普通跟进任务</span><strong>${tasks.length}</strong><small>电话、接手与复盘</small></section></div><section class="panel review-queue"><div class="panel-head"><div><h2>需要你判断</h2><small>只列必须由人确认的变化</small></div>${tag(`${memory.length+recommendations.length} 项`,'orange')}</div>${memory.map(item=>row('确认本轮客户信息',`${(item.facts||[]).length}项信息等待确认后进入长期资料`,item.customer_id,item.opportunity_id,'memory')).join('')}${recommendations.map(item=>row('确认产品建议',`${(item.result?.candidates||[]).filter(c=>c.status==='eligible_for_discussion').length}款产品可讨论`,item.customer_id,item.opportunity_id,'recommendation')).join('')||(!memory.length?'<div class="empty">当前没有需要人工确认的信息或产品建议</div>':'')}</section>`;
}

async function loadSalesReviewQueues(opportunityId){
 if(v2Runtime.status!=='connected')return;
 const calls=[v2Runtime.client.listMemoryProposals({status:'pending'}),v2Runtime.client.listAllRecommendations({status:'pending'}),v2Runtime.client.listProducts({environment:'simulation'})];
 if(opportunityId)calls.push(v2Runtime.client.listRecommendations(opportunityId));
 const [memory,recommendations,products,currentList]=await Promise.allSettled(calls);
 if(memory.status==='fulfilled')salesReviewRuntime.memory=asRows(memory.value.data);
 if(recommendations.status==='fulfilled')salesReviewRuntime.recommendations=asRows(recommendations.value.data);
 if(products.status==='fulfilled')salesReviewRuntime.products=Object.fromEntries(asRows(products.value.data).map(item=>[item.product_id,item]));
 if(opportunityId&&currentList?.status==='fulfilled')salesReviewRuntime.recommendationsByOpportunity[opportunityId]=asRows(currentList.value.data);
 salesReviewRuntime.loaded=true;
}

async function refreshJoinDateFilter(){
 if(salesReviewRuntime.joinFrom&&salesReviewRuntime.joinTo&&salesReviewRuntime.joinFrom>salesReviewRuntime.joinTo){toast('开始日期不能晚于结束日期。');return;}
 if(v2Runtime.status==='connected'){
  try{const response=await v2Runtime.client.listCustomers({joined_from:salesReviewRuntime.joinFrom,joined_to:salesReviewRuntime.joinTo});salesReviewRuntime.dateAllowedIds=new Set(asRows(response.data).map(item=>item.customer_id));}
  catch(error){toast(`日期查询失败：${error.message}`);return;}
 }else salesReviewRuntime.dateAllowedIds=null;
 render();
}

const baseReviewRenderCustomers=renderCustomers;
renderCustomers=function(){
 const c=current(),opportunity=activeOpportunity(c);let html=baseReviewRenderCustomers();
 html=html.replace('<div class="tabs" aria-label="客户阶段">',`${joinDateFilterHTML()}<div class="tabs" aria-label="客户阶段">`);
 const marker='<section class="panel"><div class="panel-head"><h2>下一步</h2>';
 return html.replace(marker,`${memoryReviewHTML(c,opportunity)}${recommendationHTML(opportunity)}${marker}`);
};
const baseReviewRenderTasks=renderTasks;
renderTasks=function(){const html=baseReviewRenderTasks();return html.replace('<section class="panel task-board">',`${reviewQueueHTML()}<section class="panel task-board">`);};

const baseReviewLoadV2Customer=loadV2Customer;
loadV2Customer=async function(customerId,options={}){await baseReviewLoadV2Customer(customerId,options);const opportunityId=options.opportunityId||activeOpportunity(current())?.opportunity_id;await loadSalesReviewQueues(opportunityId);render();};

document.addEventListener('change',event=>{const select=event.target.closest?.('[data-payment-candidate]');if(select)salesReviewRuntime.selectedTerms={...(salesReviewRuntime.selectedTerms||{}),[select.dataset.paymentCandidate]:Number(select.value)};});
document.addEventListener('click',async event=>{
 const el=event.target.closest?.('[data-action]');if(!el)return;const action=el.dataset.action,c=current(),opportunity=activeOpportunity(c);
 if(action==='apply-join-date-filter'){salesReviewRuntime.joinFrom=$('#join-date-from').value;salesReviewRuntime.joinTo=$('#join-date-to').value;await refreshJoinDateFilter();}
 else if(action==='clear-join-date-filter'){salesReviewRuntime.joinFrom='';salesReviewRuntime.joinTo='';salesReviewRuntime.dateAllowedIds=null;render();}
 else if(action==='organize-memory'){
  if(v2Runtime.status!=='connected')return toast('请在本机一体化工作台中整理本轮信息。');salesReviewRuntime.busy='memory';render();
  try{await v2Runtime.client.createMemoryProposal(opportunity.opportunity_id,{idempotency_key:uiId('memory')});await loadSalesReviewQueues(opportunity.opportunity_id);toast('只发现有证据的新信息，已放入本次确认卡片。');}
  catch(error){toast(error.code==='MEMORY_PROPOSAL_INSUFFICIENT_EVIDENCE'?'本轮没有足够明确的新信息，不需要审核。':error.message);}
  finally{salesReviewRuntime.busy='';render();}
 }
 else if(action==='approve-memory'||action==='reject-memory'){
  const proposal=currentMemoryProposal(opportunity);if(!proposal)return;salesReviewRuntime.busy='memory';render();
  try{const input={expected_revision:proposal.revision,idempotency_key:uiId(action),reviewer:'演练销售',reason:action==='approve-memory'?'已在本轮信息卡核对':'本轮暂不写入长期资料'};if(action==='approve-memory')await v2Runtime.client.approveMemoryProposal(proposal.proposal_id,input);else await v2Runtime.client.rejectMemoryProposal(proposal.proposal_id,input);await baseReviewLoadV2Customer(c.customer_id,{opportunityId:opportunity.opportunity_id});await loadSalesReviewQueues(opportunity.opportunity_id);toast(action==='approve-memory'?'本轮信息已确认并写入客户资料。':'本轮建议已忽略，原聊天记录仍保留。');}
  catch(error){toast(error.message);}finally{salesReviewRuntime.busy='';render();}
 }
 else if(action==='generate-recommendation'){
  if(v2Runtime.status!=='connected')return toast('请在本机一体化工作台中生成产品建议。');const context=v2Runtime.contextByOpportunity[opportunity.opportunity_id];if(!context)return toast('请先刷新当前客户资料。');salesReviewRuntime.busy='recommendation';render();
  try{await v2Runtime.client.generateRecommendation(opportunity.opportunity_id,{expected_revision:context.context_versions.opportunity_revision,latest_message_id:context.latest_message_id,idempotency_key:uiId('match')});await loadSalesReviewQueues(opportunity.opportunity_id);toast('产品建议已生成，请由销售选择是否采用。');}
  catch(error){toast(error.message);}finally{salesReviewRuntime.busy='';render();}
 }
 else if(action==='accept-recommendation'||action==='reject-recommendation'){
  const recommendation=currentRecommendation(opportunity);if(!recommendation)return;salesReviewRuntime.busy='recommendation';render();
  try{if(action==='accept-recommendation'){const candidate=(recommendation.result?.candidates||[]).find(item=>item.candidate_id===el.dataset.id),term=(salesReviewRuntime.selectedTerms||{})[candidate.candidate_id]??candidate.allowed_payment_years?.[0]??null;await v2Runtime.client.acceptRecommendation(recommendation.recommendation_id,{expected_revision:recommendation.revision,idempotency_key:uiId('accept'),reviewer:'演练销售',candidate_id:candidate.candidate_id,selected_payment_years:term});toast('产品建议已确认，后续回复草稿会引用这次选择。');}else{await v2Runtime.client.rejectRecommendation(recommendation.recommendation_id,{expected_revision:recommendation.revision,idempotency_key:uiId('reject'),reviewer:'演练销售',reason:'销售暂不采用本次建议'});toast('本次产品建议已驳回，不会进入回复草稿。');}await baseReviewLoadV2Customer(c.customer_id,{opportunityId:opportunity.opportunity_id});await loadSalesReviewQueues(opportunity.opportunity_id);}
  catch(error){toast(error.message);}finally{salesReviewRuntime.busy='';render();}
 }
 else if(action==='open-review-customer'){
  const target=state.customers.find(item=>item.id===el.dataset.customer);if(!target)return;selected=target.id;view='customers';await selectWorkbenchOpportunity(target,el.dataset.opportunity||activeOpportunity(target)?.opportunity_id);}
});

state.customers.forEach((customer,index)=>{if(!customer.wechat_joined_label){const day=[23,18,11,3,1][index]||1;customer.wechat_joined_on=`2026-09-${String(day).padStart(2,'0')}`;customer.wechat_joined_label=`2026/9/${day}`;}});
setTimeout(async()=>{if(v2Runtime.status==='connected'){await loadSalesReviewQueues(activeOpportunity(current())?.opportunity_id);render();}},300);
