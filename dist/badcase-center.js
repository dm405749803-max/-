'use strict';
const workspace='eval_any_agent';
const state={items:[],run:'',layer:'',severity:'',status:'',query:''};
const labels={model_provider_balance:'模型服务余额',b1_memory_contract:'B1记忆结构',b1_memory:'B1记忆',rag_or_fixture:'RAG与前置条件',evaluation_dataset:'评测集可执行性',evaluation_fixture:'评测状态夹具',evaluation_fixture_ready:'夹具已就绪待重跑',human_judgment_pending:'P0待人工复核',human_judgment:'人工复核未通过',ai_judgment:'AI语义评分',passed:'已通过',backend_runtime:'后端运行',workflow_gate:'中控门禁',unclassified:'待归因'};
const $=selector=>document.querySelector(selector);
const safe=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
async function api(path,options={}){const r=await fetch(path,{...options,headers:{accept:'application/json','content-type':'application/json','x-workspace-id':workspace,...(options.headers||{})}});const j=await r.json().catch(()=>null);if(!r.ok)throw new Error(j?.error?.message||j?.message||`HTTP ${r.status}`);return j.data;}
function toast(message){const el=$('#toast');el.textContent=message;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),2200)}
function filtered(){return state.items.filter(x=>(!state.run||x.eval_run_id===state.run)&&(!state.layer||x.root_cause_layer===state.layer)&&(!state.severity||x.severity===state.severity)&&(!state.status||x.status===state.status)&&(!state.query||`${x.case_id} ${x.root_cause_layer} ${x.root_cause_note}`.toLowerCase().includes(state.query.toLowerCase())))}
function render(){
 const runItems=state.items.filter(x=>!state.run||x.eval_run_id===state.run),items=filtered();
 const objectiveFailures=runItems.filter(x=>['failed_objective_checks','failed_ai_judgment'].includes(x.regression_status));
 const pendingJudgment=runItems.filter(x=>x.status==='needs_review'||['objective_checks_passed_human_pending','ai_passed_p0_human_pending'].includes(x.regression_status));
 const p0Review=runItems.filter(x=>x.severity==='P0'&&x.regression_status!=='passed');
 const passed=runItems.filter(x=>x.regression_status==='passed'||x.status==='closed');
 $('#metric-total').textContent=objectiveFailures.length;$('#metric-p0').textContent=p0Review.length;$('#metric-regression').textContent=pendingJudgment.length;$('#metric-passed').textContent=passed.length;
 const groups=Object.entries(runItems.reduce((acc,x)=>{acc[x.root_cause_layer]=(acc[x.root_cause_layer]||0)+1;return acc},{})).sort((a,b)=>b[1]-a[1]);
 $('#clusters').innerHTML=`<button class="cluster ${!state.layer?'active':''}" data-layer=""><span><b>全部案例</b><small>失败、复核与通过</small></span><em>${runItems.length}</em></button>`+groups.map(([key,count])=>`<button class="cluster ${state.layer===key?'active':''}" data-layer="${safe(key)}"><span><b>${safe(labels[key]||key)}</b><small>${safe(key)}</small></span><em>${count}</em></button>`).join('');
 document.querySelectorAll('[data-layer]').forEach(btn=>btn.onclick=()=>{state.layer=btn.dataset.layer;render()});
 $('#case-count').textContent=`${items.length}条`;
 const regressionLabel=value=>({passed:'已通过',failed:'回归失败',failed_objective_checks:'客观检查失败',failed_ai_judgment:'AI评分未通过',failed_human_judgment:'人工复核未通过',objective_checks_passed_human_pending:'客观已过，待评分',ai_passed_p0_human_pending:'AI已过，P0待复核',fixture_passed_p0_human_pending:'夹具已过，P0待复核',ai_passed_human_pending:'AI已过，待人工复核',fixture_passed_human_pending:'夹具已过，待人工复核',blocked_external:'外部阻塞',not_run:'未运行'}[value]||'未运行');
 $('#case-rows').innerHTML=items.length?items.map(x=>`<tr data-case="${safe(x.case_id)}" data-run="${safe(x.eval_run_id)}"><td><span class="severity ${safe(x.severity)}">${safe(x.severity)}</span></td><td><span class="case-id">${safe(x.case_id)}</span><br><small>${safe(x.eval_run_id)}</small></td><td><span class="root-pill">${safe(labels[x.root_cause_layer]||x.root_cause_layer)}</span></td><td class="note">${safe(x.root_cause_note||'等待补充')}</td><td>${safe(regressionLabel(x.regression_status))}</td><td><button class="trace-button" type="button">查看</button></td></tr>`).join(''):'<tr><td colspan="6" class="empty">没有符合条件的案例。</td></tr>';
 document.querySelectorAll('[data-case]').forEach(row=>row.onclick=()=>openDetail(state.items.find(x=>x.case_id===row.dataset.case&&x.eval_run_id===row.dataset.run)));
}
async function openDetail(item){
 if(!item)return;$('#detail-severity').textContent=item.severity;$('#detail-severity').className=`severity ${item.severity}`;$('#detail-title').textContent=`${item.case_id} · ${labels[item.root_cause_layer]||item.root_cause_layer}`;
 let trace=null;if(item.trace_id)trace=await api(`/api/v2/observability/traces/${item.trace_id}`).catch(()=>null);
 const langfuseUrl=item.trace_id?`http://127.0.0.1:3001/project/insurance-sales/traces/${encodeURIComponent(item.trace_id)}`:null;
 const timeline=(trace?.observations||[]).map(o=>`<div class="timeline-item ${o.status==='error'?'error':''}"><i></i><b>${safe(o.name)}</b><span>${safe(o.status)}</span><span>${safe(o.error_code||`${o.duration_ms??0}ms`)}</span></div>`).join('')||'<p>没有可读取的步骤。</p>';
 const fixture=item.actual?.fixture_execution?.details||item.actual?.evaluation_fixture?.evidence?.details||null;
 const isFixtureOnly=item.actual?.evidence_kind==='fixture_only';
 const fixtureChecks=Array.isArray(fixture?.checks)?fixture.checks:[];
 const fixtureEvidenceReady=Boolean(fixture?.coverage_complete&&fixtureChecks.length&&fixtureChecks.every(check=>check.passed===true));
 const customerMessage=trace?.input?.text||trace?.input?.latest_message||item.actual?.latest_customer_message||item.actual?.input||'当前记录未带回客户原话';
 const response=item.actual?.response||'没有生成客户可见回复';
 const hasCustomerReply=Boolean(String(item.actual?.response||'').trim());
 const expected=item.expected?.behavior||'当前案例未配置文字标准';
 const hardFailure=item.expected?.hard_failure||'无额外一票否决项';
 const ai=item.actual?.ai_evaluation||{};
 const aiSummary=ai.score==null?'尚未进行AI评分':`${ai.score}/100｜${ai.passed?'AI判定通过':'AI判定未通过'}\n${ai.reason||''}`;
 const reviewDone=item.human_review_status&&item.human_review_status!=='pending';
 const canReview=!isFixtureOnly||fixtureEvidenceReady;
 const reviewPanel=reviewDone
  ?`<div class="review-result ${item.human_review_status==='approved'?'approved':'rejected'}"><b>${item.human_review_status==='approved'?'人工复核：通过':'人工复核：不通过'}</b>${item.naturalness_score?`<span>自然度：${safe(item.naturalness_score)} / 5</span>`:''}<span>${safe(item.human_review_note||'未填写备注')}</span><small>${safe(item.reviewed_by||'人工复核员')} · ${safe(item.reviewed_at||'')}</small></div>`
  :item.status==='needs_review'&&!canReview?`<section class="review-panel evidence-blocked"><div><b>当前不能人工判断</b><p>这是一条系统状态测试，但报告没有带回可核对的执行步骤和实际结果。请先重跑对应夹具，补齐证据后再复核。</p></div></section>`
  :item.status==='needs_review'?`<section class="review-panel"><div><b>请做最终人工判断</b><p>逐项核对实际结果与正确标准。全部符合才点“人工通过”；有一项不符就填写原因并点“人工不通过”。</p></div>${hasCustomerReply?'<label class="naturalness-label" for="review-naturalness">回复自然度（必填）<select id="review-naturalness"><option value="">请选择1–5分</option><option value="1">1分 · 很生硬</option><option value="2">2分</option><option value="3">3分 · 基本自然</option><option value="4">4分</option><option value="5">5分 · 很自然</option></select></label>':'<div class="naturalness-na">这是系统状态测试，没有客户回复需要评价，自然度不适用。</div>'}<textarea id="review-note" placeholder="通过时备注可选；不通过时请说明具体问题"></textarea><div class="review-actions"><button id="review-reject" class="review-button reject" type="button">人工不通过</button><button id="review-approve" class="review-button approve" type="button">人工通过</button></div></section>`:'';
 const fixtureFlow=`<div class="human-flow fixture-flow"><article><label>① 测试类型</label><p>${safe(fixture?.title||'系统状态测试（不产生客户回复）')}</p></article><article><label>② 实际执行动作</label><p>${safe(Array.isArray(fixture?.steps)&&fixture.steps.length?fixture.steps.map((step,index)=>`${index+1}. ${step}`).join('\n'):'本次报告没有带回执行步骤。')}</p></article><article><label>③ 实际检查结果</label><div class="fixture-checks">${fixtureChecks.length?fixtureChecks.map(check=>`<div class="fixture-check ${check.passed?'passed':'failed'}"><b>${check.passed?'✓':'×'} ${safe(check.label)}</b><span>期望：${safe(check.expected)}</span><span>实际：${safe(check.actual)}</span></div>`).join(''):'<p>本次报告没有带回可核对结果。</p>'}</div></article><article><label>④ 正确标准</label><p>${safe(expected)}</p></article><article><label>⑤ 一票否决项</label><p>${safe(hardFailure)}</p></article></div>`;
 const conversationFlow=`<div class="human-flow"><article><label>① 客户原话</label><p>${safe(customerMessage)}</p></article><article><label>② 系统实际回复</label><p>${safe(response)}</p></article><article><label>③ 正确标准</label><p>${safe(expected)}</p></article><article><label>④ 一票否决项</label><p>${safe(hardFailure)}</p></article><article class="ai-card"><label>⑤ AI评分与理由</label><p>${safe(aiSummary)}</p></article></div>`;
 $('#detail-body').innerHTML=`${isFixtureOnly?fixtureFlow:conversationFlow}${reviewPanel}<details class="tech-details"><summary>查看技术运行信息（一般复核不用看）</summary><div class="detail-grid"><div class="detail-card"><label>进入处理池的原因</label><pre>${safe(item.root_cause_note||'')}</pre></div><div class="detail-card"><label>未通过维度</label><pre>${safe((item.failed_dimensions||[]).join('、')||'无')}</pre></div><div class="detail-card"><label>完整实际结果</label><pre>${safe(JSON.stringify(item.actual,null,2))}</pre></div><div class="detail-card"><label>完整正确标准</label><pre>${safe(JSON.stringify(item.expected,null,2))}</pre></div><div class="detail-card full"><label>Trace ${safe(item.trace_id||'—')}</label>${langfuseUrl?`<a class="langfuse-trace-link" href="${langfuseUrl}" target="_blank" rel="noreferrer">在 Langfuse 打开这条链路</a>`:'<span class="trace-missing">本案例没有 Trace</span>'}<div class="timeline">${timeline}</div></div></div></details>`;
 $('#detail-dialog').showModal();
 if($('#review-approve'))$('#review-approve').onclick=()=>submitReview(item,'approved');
 if($('#review-reject'))$('#review-reject').onclick=()=>submitReview(item,'rejected');
}
async function submitReview(item,decision){
 const note=$('#review-note')?.value.trim()||'';
 const hasCustomerReply=Boolean(String(item.actual?.response||'').trim()),naturalness=$('#review-naturalness')?.value||'';
 if(hasCustomerReply&&!naturalness){toast('请先给回复自然度打1–5分');$('#review-naturalness')?.focus();return;}
 if(decision==='rejected'&&!note){toast('请先填写不通过原因');$('#review-note')?.focus();return;}
 const buttons=[...document.querySelectorAll('.review-button')];buttons.forEach(button=>button.disabled=true);
 try{await api(`/api/v2/observability/badcases/${encodeURIComponent(item.badcase_id)}/review`,{method:'POST',body:JSON.stringify({decision,note,naturalness_score:naturalness||null,reviewer:'产品负责人'})});$('#detail-dialog').close();await load(false);toast(decision==='approved'?'已记录：人工通过':'已记录：人工不通过');}
 catch(error){buttons.forEach(button=>button.disabled=false);toast(error.message);}
}
async function load(resetRun=true){state.items=await api('/api/v2/observability/badcases');const runs=[...new Set(state.items.map(x=>x.eval_run_id))],params=new URLSearchParams(location.search),requestedRun=params.get('run'),requestedCase=params.get('case');$('#run-filter').innerHTML='<option value="">全部批次</option>'+runs.map(x=>`<option value="${safe(x)}">${safe(x)}</option>`).join('');if(resetRun){const requestedItem=state.items.find(x=>x.case_id===requestedCase&&(requestedRun?x.eval_run_id===requestedRun:true));state.run=runs.includes(requestedRun)?requestedRun:requestedItem?.eval_run_id||runs[0]||'';}else if(!runs.includes(state.run))state.run=runs[0]||'';$('#run-filter').value=state.run;render();if(resetRun&&requestedCase)openDetail(state.items.find(x=>x.case_id===requestedCase&&x.eval_run_id===state.run))}
$('#run-filter').onchange=e=>{state.run=e.target.value;state.layer='';render()};$('#severity-filter').onchange=e=>{state.severity=e.target.value;render()};$('#status-filter').onchange=e=>{state.status=e.target.value;render()};$('#search').oninput=e=>{state.query=e.target.value;render()};$('#refresh').onclick=()=>load().then(()=>toast('已刷新'));$('#close-dialog').onclick=()=>$('#detail-dialog').close();
load().catch(error=>{toast(error.message);$('#case-rows').innerHTML=`<tr><td colspan="6" class="empty">${safe(error.message)}</td></tr>`});
