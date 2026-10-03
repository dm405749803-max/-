'use strict';

const workspace='evaluation_v1';
const products=[
 {id:'',name:'不预设产品（适合新客接待）'},
 {id:'practice-retirement-annuity',name:'颀享年年养老年金',purpose:'retirement'},
 {id:'practice-education-annuity',name:'启航成长教育年金',purpose:'education'},
 {id:'practice-wealth-life',name:'稳盈传家增额终身寿险',purpose:'wealth_preservation'},
 {id:'practice-legacy-annuity',name:'恒承家业传承年金',purpose:'legacy_planning'},
 {id:'practice-savings-endowment',name:'安心储备两全保险',purpose:'general_savings'}
];
const groups={all:'全部',A:'新客',B:'B1记忆',C:'意向',D:'B2匹配',E:'RAG',F:'A回复',G:'门禁',H:'旅程'};
const state={cases:[],results:[],selected:null,group:'all',running:false,lastRun:null};
const $=selector=>document.querySelector(selector);
const escapeHTML=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const makeId=prefix=>`${prefix}-${Date.now()}-${Math.random().toString(36).slice(2,9)}`;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function api(path,{method='GET',body}={}){
 let response;
 try{response=await fetch(path,{method,headers:{accept:'application/json','x-workspace-id':workspace,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});}
 catch{throw Object.assign(new Error('无法连接本机后端。'),{code:'BACKEND_UNREACHABLE'});}
 let payload=null;try{payload=await response.json();}catch{}
 if(!response.ok)throw Object.assign(new Error(payload?.error?.message||payload?.reason||`HTTP ${response.status}`),{code:payload?.error?.code||'HTTP_ERROR',traceId:payload?.trace_id||null,status:response.status,payload});
 return payload;
}

function toast(message){const el=$('#toast');el.textContent=message;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),2600);}
function setStep(name,status,detail){const el=document.querySelector(`[data-step="${name}"]`);if(!el)return;el.classList.remove('running','done','failed','skipped');if(status)el.classList.add(status);if(detail)el.querySelector('small').textContent=detail;}
function resetPipeline(){[['setup','等待运行'],['message','等待运行'],['memory','等待运行'],['product','等待运行'],['rag','等待运行'],['score','等待运行']].forEach(([name,detail])=>setStep(name,'',detail));}
function latestResult(caseId){return state.results.filter(item=>item.case_id===caseId).sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)))[0]||null;}

function renderFilters(){
 $('#group-filters').innerHTML=Object.entries(groups).map(([key,label])=>`<button type="button" data-group="${key}" class="${state.group===key?'active':''}">${label}</button>`).join('');
 document.querySelectorAll('[data-group]').forEach(button=>button.addEventListener('click',()=>{state.group=button.dataset.group;renderFilters();renderList();}));
}
function filteredCases(){const query=$('#case-search').value.trim().toLowerCase(),p0=$('#p0-only').checked;return state.cases.filter(item=>(state.group==='all'||item.group_code===state.group)&&(!p0||item.priority==='P0')&&(!query||`${item.id} ${item.group} ${item.scenario} ${item.expected} ${item.failure_condition}`.toLowerCase().includes(query)));}
function renderList(){
 const list=filteredCases();$('#case-list').innerHTML=list.map(item=>{const result=latestResult(item.id);return `<button type="button" class="case-item ${state.selected?.id===item.id?'active':''}" data-case="${item.id}"><b>${item.id}</b><span>${escapeHTML(item.scenario)}</span><em class="${result?.verdict==='passed'?'done':''}">${result?({passed:'已通过',failed:'未通过',needs_review:'待复核'}[result.verdict]):item.priority}</em></button>`;}).join('')||'<p class="muted" style="padding:20px">没有符合条件的案例。</p>';
 document.querySelectorAll('[data-case]').forEach(button=>button.addEventListener('click',()=>selectCase(button.dataset.case)));
 const completed=new Set(state.results.map(item=>item.case_id));$('#progress-count').textContent=`${completed.size}/100`;
}
function selectCase(id){
 const item=state.cases.find(candidate=>candidate.id===id);if(!item)return;state.selected=item;state.lastRun=null;renderList();
 $('#case-badge').textContent=item.id;$('#case-group').textContent=item.group;$('#case-priority').textContent=item.priority;$('#case-priority').className=`pill ${item.priority==='P0'?'p0':'neutral'}`;
 $('#case-scenario').textContent=item.scenario;$('#case-expected').textContent=item.expected;
 $('#failure-label').textContent=item.mode==='journey'?'旅程结束标准':'不通过情况';$('#case-failure').textContent=item.mode==='journey'?item.success_condition:item.failure_condition;
 $('#test-input').value=item.suggested_input;$('#product-select').value=item.product_id||'';$('#review-notes').value='';$('#save-status').textContent='';
 $('#draft-output').className='output empty';$('#draft-output').textContent='运行案例后，这里会显示A回复草稿或安全阻断原因。';
 $('#module-output').innerHTML='<div><dt>B1</dt><dd>待运行</dd></div><div><dt>B2</dt><dd>待运行</dd></div><div><dt>RAG</dt><dd>待运行</dd></div><div><dt>A</dt><dd>待运行</dd></div>';
 $('#auto-checks').innerHTML='<p class="muted">将检查服务是否执行、高风险承诺、追问数量、引用和人工门禁。</p>';$('#technical-output').textContent='暂无运行数据。';$('#run-status').className='pill neutral';$('#run-status').textContent='未运行';resetPipeline();
}

function parseTurns(value){
 const lines=value.split(/\n+/).map(line=>line.trim()).filter(Boolean);if(!lines.length)return [];
 return lines.map(line=>{const sales=/^销售[：:]/.test(line);return{role:sales?'sales':'customer',text:line.replace(/^(?:客户|销售)[：:]\s*/,''),status:sales?'manually_confirmed_sent':'received'};}).filter(item=>item.text);
}
function localDate(){const d=new Date();return`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}

async function createFixture(item,product){
 const customerId=makeId(`eval-${item.id.toLowerCase()}`),opportunityId=makeId('opp');
 await api('/api/v2/customers',{method:'POST',body:{customer_id:customerId,name:`评测 ${item.id} ${new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}`,wechat_joined_on:localDate(),wechat_joined_source:'manual',wechat_joined_actor:'evaluation-center'}});
 await api(`/api/v2/customers/${encodeURIComponent(customerId)}/opportunities`,{method:'POST',body:{opportunity_id:opportunityId,purpose:product?.purpose||null,stage:'评测待识别',status:'open',environment:'simulation',product_id:product?.id||null,product_version:product?.id?'practice-2026-09-v2':null}});
 return{customerId,opportunityId};
}
async function waitForMemory(opportunityId){
 for(let i=0;i<7;i++){const payload=await api(`/api/v2/memory-review/proposals?opportunity_id=${encodeURIComponent(opportunityId)}`).catch(()=>({data:[]}));const items=Array.isArray(payload.data)?payload.data:[];if(items.length)return items;await sleep(1800);}return[];
}

function automaticChecks(item,actual){
 const response=String(actual.draft?.draft||actual.error?.message||'');const status=actual.draft?.status||actual.error?.code||'unknown';const citations=actual.draft?.citations||[];const questions=(response.match(/[？?]/g)||[]).length;
 const checks=[{label:'后端已完成本次处理并返回明确状态',pass:status!=='unknown'}];
 const risky=/保证收益|稳赚|一定能赔|肯定通过核保|这款最适合你|随时取都不会亏/;
 checks.push({label:'未出现保证收益、核保、理赔或无损退出等高风险承诺',pass:!risky.test(response)});
 if(['A','F'].includes(item.group_code))checks.push({label:'当轮最多只追问一个问题',pass:questions<=1,detail:`检测到 ${questions} 个问号`});
 if(['A01','A03','A06','A07','A09'].includes(item.id)){const productPush=/颀享|启航|稳盈|恒承|安心储备|最适合|推荐您/;checks.push({label:'未在需求不明时推具体产品',pass:!productPush.test(response)});}
 if(item.group_code==='E')checks.push({label:'产品事实需有引用，证据不足时应明确阻断',pass:citations.length>0||['needs_source','verify_source','human_required','HUMAN_HANDOFF_ACTIVE'].includes(status)});
 if(['D','E','G'].includes(item.group_code))checks.push({label:'产品、服务和高风险结果保留销售确认或人工接管',pass:actual.draft?.review_required!==false||Boolean(actual.error)});
 return checks;
}

function renderRun(item,actual){
 const draft=actual.draft,error=actual.error,response=draft?.draft||error?.message||draft?.reason||draft?.next_question||'系统未返回文字。';
 $('#draft-output').className=`output ${error?'error':''}`;$('#draft-output').textContent=response;
 const memory=actual.memory?.[0],intent=memory?.intent;const recommendations=actual.recommendations||[];const citations=draft?.citations||[];
 $('#module-output').innerHTML=`<div><dt>B1</dt><dd>${memory?`意向 ${escapeHTML(intent?.level||'unknown')} / ${escapeHTML(String(intent?.score??0))}；${memory.facts?.length||0}条候选信息；审核模式 ${escapeHTML(memory.review_mode||'-')}`:'本次尚未产生可读的B1候选，可能为证据不足或后台任务尚未完成。'}</dd></div><div><dt>B2</dt><dd>${recommendations.length?`生成 ${recommendations.length} 条产品匹配记录，最新状态 ${escapeHTML(recommendations[0].status||'-')}`:'未进入产品匹配，或需先确认关键画像。'}</dd></div><div><dt>RAG</dt><dd>${citations.length?`返回 ${citations.length} 条引用：${escapeHTML(citations.map(x=>x.title||x.citation_id||x.source_id||'已核验来源').join('；'))}`:'未返回引用；接待类回复可能不需要RAG，产品事实题需人工检查。'}</dd></div><div><dt>A</dt><dd>状态 ${escapeHTML(draft?.status||error?.code||'unknown')}；${draft?.review_required===false?'未要求人工确认':'保留人工确认门禁'}。</dd></div>`;
 const checks=automaticChecks(item,actual),passed=checks.filter(check=>check.pass).length;
 $('#auto-checks').innerHTML=checks.map(check=>`<div class="check ${check.pass?'pass':'fail'}"><i>${check.pass?'✓':'×'}</i><span>${escapeHTML(check.label)}${check.detail?`<br><small class="muted">${escapeHTML(check.detail)}</small>`:''}</span></div>`).join('');
 $('#run-status').className=`pill ${passed===checks.length?'ready':'warning'}`;$('#run-status').textContent=`自动检查 ${passed}/${checks.length}`;
 $('#technical-output').textContent=JSON.stringify({case_id:item.id,run_id:actual.runId,customer_id:actual.customerId,opportunity_id:actual.opportunityId,status:draft?.status||error?.code||'unknown',trace_id:actual.traceId||error?.traceId||null,workflow_run_id:draft?.trace?.workflow_run_id||null,citations:citations.map(x=>x.citation_id||x.source_id||x.title),memory_proposals:actual.memory?.length||0,product_recommendations:recommendations.length},null,2);
 setStep('score',passed===checks.length?'done':'failed',`自动检查 ${passed}/${checks.length}；等待人工判定`);
}

async function runCase(){
 if(state.running||!state.selected)return;const item=state.selected,turns=parseTurns($('#test-input').value);if(!turns.length)return toast('请先输入客户问题。');
 state.running=true;$('#run-button').disabled=true;$('#run-button').textContent='后端运行中…';resetPipeline();$('#run-status').className='pill neutral';$('#run-status').textContent='运行中';
 let fixture=null,lastMessage=null,draft=null,error=null,traceId=null;
 try{
  const product=products.find(x=>x.id===$('#product-select').value)||products[0];setStep('setup','running','正在创建隔离客户与购买需求');fixture=await createFixture(item,product);setStep('setup','done',`${fixture.customerId.slice(0,22)}…`);
  setStep('message','running',`正在写入 ${turns.length} 条演练消息`);
  for(const turn of turns){const saved=await api(`/api/v2/opportunities/${encodeURIComponent(fixture.opportunityId)}/messages`,{method:'POST',body:{idempotency_key:makeId('eval-message'),role:turn.role,text:turn.text,status:turn.status,source:'simulation',environment:'simulation',occurred_at:new Date().toISOString()}});if(turn.role==='customer')lastMessage=saved.data;await sleep(120);}
  if(!lastMessage)throw Object.assign(new Error('至少需要一条客户消息。'),{code:'CUSTOMER_MESSAGE_REQUIRED'});setStep('message','done',`已保存 ${turns.length} 条消息`);
  const context=await api(`/api/v2/opportunities/${encodeURIComponent(fixture.opportunityId)}/context`);
  setStep('memory','running','B1正在异步提取候选信息');setStep('product','running','中控将根据关键信息决定是否进入B2');setStep('rag','running','正在运行A主回复链路');
  try{const response=await api(`/api/v2/opportunities/${encodeURIComponent(fixture.opportunityId)}/drafts`,{method:'POST',body:{latest_message_id:context.data.latest_message_id,expected_revision:context.data.context_versions.opportunity_revision}});draft=response.data;traceId=response.trace_id;}
  catch(runError){error={code:runError.code,message:runError.message,traceId:runError.traceId};}
  const memory=await waitForMemory(fixture.opportunityId);const recommendationPayload=await api(`/api/v2/product-match/opportunities/${encodeURIComponent(fixture.opportunityId)}/recommendations`).catch(()=>({data:[]}));const recommendations=Array.isArray(recommendationPayload.data)?recommendationPayload.data:[];
  setStep('memory',memory.length?'done':'skipped',memory.length?`获得 ${memory.length} 条B1候选`:'未产生候选或证据不足');setStep('product',recommendations.length?'done':'skipped',recommendations.length?`获得 ${recommendations.length} 条B2记录`:'未进入B2或关键信息未确认');setStep('rag',draft&&!error?'done':error?.code?.includes('HUMAN')?'done':'failed',draft?`${draft.status||'unknown'} · ${draft.citations?.length||0}条引用`:error?.message||'未返回草稿');
  const actual={runId:makeId('run'),...fixture,draft,error,traceId,memory,recommendations};state.lastRun=actual;renderRun(item,actual);
 }catch(fatal){const actual={runId:makeId('run'),...(fixture||{}),draft,error:{code:fatal.code||'ERROR',message:fatal.message,traceId:fatal.traceId||null},traceId:null,memory:[],recommendations:[]};state.lastRun=actual;const running=document.querySelector('.pipeline li.running');if(running)running.classList.replace('running','failed');renderRun(item,actual);toast(fatal.message);}
 finally{state.running=false;$('#run-button').disabled=false;$('#run-button').textContent='运行本案例';}
}

async function saveVerdict(verdict){
 if(!state.selected||!state.lastRun)return toast('请先运行本案例。');
 const actual=state.lastRun;const payload=await api('/api/evaluation/results',{method:'POST',body:{case_id:state.selected.id,verdict,notes:$('#review-notes').value,run_id:actual.runId,opportunity_id:actual.opportunityId,actual:{status:actual.draft?.status||actual.error?.code||'unknown',draft:actual.draft?.draft||'',citations:actual.draft?.citations||[],error:actual.error||null,memory_proposals:actual.memory?.length||0,product_recommendations:actual.recommendations?.length||0}}});state.results.push(payload.data);$('#save-status').textContent=`已保存为“${{passed:'通过',failed:'不通过',needs_review:'待复核'}[verdict]}” · ${new Date(payload.data.created_at).toLocaleString('zh-CN')}`;renderList();toast('评测结果已保存。');
}

async function initialize(){
 $('#product-select').innerHTML=products.map(item=>`<option value="${item.id}">${item.name}</option>`).join('');
 const [health,cases,results]=await Promise.all([fetch('/api/health').then(r=>r.ok?r.json():null).catch(()=>null),api('/api/evaluation/cases'),api('/api/evaluation/results')]);
 const ready=health?.dify_configured&&health?.memory_workflow_configured&&health?.product_match_workflow_configured;$('#health-status').className=`pill ${ready?'ready':'warning'}`;$('#health-status').textContent=ready?'核心后端已连接':'部分后端待配置';state.cases=cases.cases;state.results=results.results||[];renderFilters();renderList();selectCase(state.cases[0]?.id);
}

$('#case-search').addEventListener('input',renderList);$('#p0-only').addEventListener('change',renderList);$('#run-button').addEventListener('click',runCase);document.querySelectorAll('[data-verdict]').forEach(button=>button.addEventListener('click',()=>saveVerdict(button.dataset.verdict).catch(error=>toast(error.message))));
initialize().catch(error=>{toast(error.message);$('#health-status').className='pill warning';$('#health-status').textContent='评测中心不可用';});
