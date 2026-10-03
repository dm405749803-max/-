const $=selector=>document.querySelector(selector);
const safe=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const api=async path=>{const response=await fetch(path,{headers:{'x-workspace-id':'eval_any_agent'}});const payload=await response.json();if(!response.ok)throw new Error(payload?.error?.message||`HTTP ${response.status}`);return payload.data};
const toast=message=>{const el=$('#toast');el.textContent=message;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),1800)};
const labels={ready:['允许发布','所有可判定的门槛均已达标。'],blocked:['暂停发布','存在未达标的上线门槛。'],data_pending:['评测已闭环，线上数据待采样','已有评测结论，仍有指标缺少真实使用数据。']};
const gateCopy={overall_core_pass_rate:'按最终通过案例÷本批全部案例。',naturalness_average:'只统计实际有客户可见回复的人工评分。',p0_unresolved:'P0待修复或待人工复核必须清零。',high_risk_miss_rate:'需要 evaluation_judged 的高风险正负样本标注。'};
function value(item){return item.actual==null?'—':`${item.actual}${item.unit||''}`}
function render(data){
 const [title,copy]=labels[data.release_status]||labels.data_pending;$('#release-title').textContent=title;$('#release-copy').textContent=copy;
 const badge=$('#release-badge');badge.textContent={ready:'已达标',blocked:'有阻塞',data_pending:'待补数据'}[data.release_status];badge.className=`badge ${data.release_status==='data_pending'?'pending':data.release_status}`;
 $('#closed-count').textContent=`${data.cases.closed}/${data.cases.total}`;$('#closed-note').textContent=`批次 ${data.eval_run_id||'暂无'}`;$('#unresolved-count').textContent=data.cases.unresolved;
 $('#naturalness').textContent=data.naturalness.average==null?'不适用':`${data.naturalness.average}/5`;$('#naturalness-note').textContent=`${data.naturalness.count}条有效人工评分`;
 $('#trace-count').textContent=data.traces.total;$('#trace-note').textContent=`平均耗时 ${data.traces.average_duration_ms??'—'}ms`;
 $('#gate-rows').innerHTML=data.gates.map(item=>`<tr><td><b>${safe(item.name)}</b></td><td>${safe(item.target)}</td><td>${safe(value(item))}</td><td><span class="status ${safe(item.status)}">${item.status==='passed'?'通过':item.status==='failed'?'未通过':'待补数据'}</span></td><td>${safe(gateCopy[item.key]||'')}</td></tr>`).join('');
 const f=data.funnel;const cells=[['客户消息',f.customer_messages],['客户UV',f.customer_uv],['AI草稿生成',f.drafts_generated],['确认发送',f.drafts_sent],['草稿采纳率',f.draft_adoption_rate==null?'待采样':`${f.draft_adoption_rate}%`],['工作流成功率',f.workflow_success_rate==null?'待采样':`${f.workflow_success_rate}%`],['人工接管',f.human_handoffs],['成交确认',f.purchases]];
 $('#funnel').innerHTML=cells.map(([name,val])=>`<div><b>${safe(val)}</b><span>${safe(name)}</span></div>`).join('');
 $('#events').innerHTML=data.event_summary.length?data.event_summary.map(item=>`<div class="event"><b>${safe(item.event_name)}</b><span>${item.count}次</span><span>${item.customer_uv}客户UV</span></div>`).join(''):'<div class="empty">暂无埋点数据，新的销售操作会自动进入。</div>';
}
async function loadRuns(){const items=await api('/api/v2/observability/badcases');const runs=[...new Set(items.map(item=>item.eval_run_id))];$('#run-filter').innerHTML='<option value="">自动选择最新批次</option>'+runs.map(run=>`<option value="${safe(run)}">${safe(run)}</option>`).join('')}
async function load(){const run=$('#run-filter').value;render(await api(`/api/v2/observability/metrics${run?`?eval_run_id=${encodeURIComponent(run)}`:''}`))}
$('#run-filter').onchange=()=>load().catch(error=>toast(error.message));$('#refresh').onclick=()=>load().then(()=>toast('已刷新')).catch(error=>toast(error.message));
loadRuns().then(load).catch(error=>{toast(error.message);$('#release-title').textContent='看板暂时无法读取'});
