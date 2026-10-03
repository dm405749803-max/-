'use strict';

const salesUI={session:null,detail:null,messages:[],tasks:[],draft:null,busy:false,lastCustomerMessage:null,activeDraftId:null,draftDirty:false,budget:null,knowledgeSafety:null,alertKeys:new Set()};
const $=selector=>document.querySelector(selector);
const timeLabel=value=>{const date=new Date(value);return Number.isFinite(date.getTime())?date.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false}):'';};
function setStatus(message,type=''){$('#sales-status').textContent=message;$('#sales-status').className=`inline-status ${type}`.trim();}
function showSafetyAlert(key,title,message){if(salesUI.alertKeys.has(key))return;salesUI.alertKeys.add(key);$('#safety-modal-title').textContent=title;$('#safety-modal-message').textContent=message;$('#safety-modal').hidden=false;}
function aiBlocked(){return salesUI.budget?.state==='stopped'||salesUI.knowledgeSafety?.locked;}
function renderSafety(){
 const budget=salesUI.budget,bc=$('#budget-chip'),kc=$('#knowledge-chip');bc.textContent=budget?`AI成本 ${budget.used_percent}%`:'AI成本待读取';bc.className=`safety-chip ${budget?.state==='stopped'?'stop':budget?.state==='warning'?'warn':'ok'}`;
 kc.textContent=salesUI.knowledgeSafety?.locked?'知识版本异常':'知识版本正常';kc.className=`safety-chip ${salesUI.knowledgeSafety?.locked?'stop':'ok'}`;
 if(budget?.state==='warning')showSafetyAlert(`budget-warning:${salesUI.session?.customer_id}`,'AI成本已达70%',budget.alert||'请留意该客户后续AI用量。');
 if(budget?.state==='stopped')showSafetyAlert(`budget-stop:${salesUI.session?.customer_id}`,'AI调用已停止',budget.alert||'该客户AI成本已达到10元上限，请人工接管。');
 if(salesUI.knowledgeSafety?.locked)showSafetyAlert('knowledge-lock','知识版本不一致，AI已停止','产品结构化规则与RAG文档没有同时通过审核。为避免引用旧资料，所有AI对客草稿已停止，请人工接管。');
 if(aiBlocked()){$('#generate-draft').disabled=true;$('#confirm-draft').disabled=true;}
}
function renderProfile(){
 const el=$('#sales-profile'),detail=salesUI.detail;if(!detail){el.innerHTML='<div><dt>状态</dt><dd>请先在客户模拟端创建会话</dd></div>';$('#lead-state').textContent='等待会话';return;}
 const {customer,opportunity}=detail,stageLabels={new_contact:'新客户',discovery:'需求了解',solution_discussion:'方案沟通',closing:'促成确认',won:'已成交',paused:'暂停'},intentLabels={unknown:'待识别',low:'低',medium:'中',high:'高'},processingLabels={normal:'正常沟通',waiting_customer:'等待客户',waiting_sales_review:'等待销售确认',human_handoff:'人工接手',marketing_opt_out:'拒收营销',purchased_service:'已购服务'};$('#lead-state').textContent=opportunity.purpose?'需求已识别':'新线索';
 el.innerHTML=[['客户',customer.name],['加入日期',customer.wechat_joined_label||'待记录'],['购买需求',opportunity.purpose||'待识别'],['预算',opportunity.budget_amount==null?'待确认':`${Number(opportunity.budget_amount).toLocaleString('zh-CN')} 元`],['产品',opportunity.product_id||'尚未匹配'],['销售阶段',stageLabels[opportunity.sales_stage]||opportunity.sales_stage],['意向等级',`${intentLabels[opportunity.intent_level]||opportunity.intent_level}（${opportunity.intent_score||0}分）`],['处理状态',processingLabels[opportunity.processing_status]||opportunity.processing_status]].map(([label,value])=>`<div><dt>${DualTest.escapeHTML(label)}</dt><dd>${DualTest.escapeHTML(value)}</dd></div>`).join('');
}
function renderMessages(){
 const el=$('#sales-chat');el.innerHTML=salesUI.messages.length?salesUI.messages.map(message=>`<div class="chat-line ${message.role==='sales'?'sales':'customer'}"><div class="chat-bubble">${DualTest.escapeHTML(message.text)}<small>${message.role==='sales'?'销售已发送':'客户'} · ${timeLabel(message.occurred_at)}</small></div></div>`).join(''):'<div class="chat-empty">客户消息会自动同步到这里。请先打开客户模拟端并发送第一句话。</div>';el.scrollTop=el.scrollHeight;
}
function renderTasks(){
 const el=$('#sales-tasks'),tasks=salesUI.tasks||[];
 el.innerHTML=tasks.length?tasks.map(task=>`<article><b>${DualTest.escapeHTML(task.title)}</b><p>${DualTest.escapeHTML(task.reason)}</p></article>`).join(''):'<p>当前没有待处理事项。</p>';
 const conflict=tasks.find(task=>task.title==='核对冲突客户资料');
 if(conflict)showSafetyAlert(`fact-conflict:${conflict.task_id}`,'客户资料存在冲突',conflict.reason);
}
function renderDraft(){
 const draft=salesUI.draft,valid=draft&&draft.status==='draft_ready'&&String(draft.draft||'').trim();$('#draft-empty').hidden=Boolean(valid);$('#draft-editor').hidden=!valid;$('#confirm-draft').disabled=!valid;
 if(!valid){salesUI.activeDraftId=null;salesUI.draftDirty=false;$('#draft-state').textContent=draft?.status||'未生成';$('#draft-state').className='pill neutral';if(draft)$('#draft-empty').textContent=draft.next_action==='run_product_match'?'基础信息已收集，下一步进入产品匹配和销售确认。':draft.next_question||draft.missing_evidence?.join('；')||'当前没有可确认草稿。';return;}
 $('#draft-state').textContent=salesUI.draftDirty?'已手动修改':'等待销售确认';$('#draft-state').className='pill';
 if(salesUI.activeDraftId!==draft.draft_id){salesUI.activeDraftId=draft.draft_id;salesUI.draftDirty=false;$('#sales-draft').value=draft.draft;}
 $('#confirm-draft').disabled=!String($('#sales-draft').value||'').trim();
 const citations=(draft.citations||[]).map(item=>`<li>${DualTest.escapeHTML(item.title||item.document_id||item.citation_id||'已核验依据')}</li>`).join('');$('#draft-evidence').innerHTML=`<strong>回复依据</strong>${citations?`<ul>${citations}</ul>`:'<p>首轮接待，不涉及产品事实。</p>'}<details><summary>技术追溯</summary><p>provider：${DualTest.escapeHTML(draft.trace?.provider||'-')}<br>workflow：${DualTest.escapeHTML(draft.trace?.workflow_run_id||'-')}</p></details>`;
 }
function render(){renderProfile();renderMessages();renderTasks();renderDraft();renderSafety();}
async function sync({quiet=true}={}){
 const session=DualTest.getSession();salesUI.session=session;
 if(!session){salesUI.detail=null;salesUI.messages=[];salesUI.tasks=[];salesUI.draft=null;render();if(!quiet)setStatus('请先在客户模拟端点击“新会话”。');return;}
 try{
  salesUI.detail=await DualTest.detail(session);salesUI.messages=await DualTest.messages(session);salesUI.lastCustomerMessage=[...salesUI.messages].reverse().find(item=>item.role==='customer')||null;
  const draftPath=salesUI.lastCustomerMessage?`/api/v2/opportunities/${encodeURIComponent(session.opportunity_id)}/drafts/latest?latest_message_id=${encodeURIComponent(salesUI.lastCustomerMessage.message_id)}`:null;
  const [budget,safety,draftPayload,tasksPayload]=await Promise.all([DualTest.api(`/api/v2/customers/${encodeURIComponent(session.customer_id)}/ai-budget`).catch(()=>null),DualTest.api('/api/v2/knowledge-safety/status').catch(()=>null),draftPath?DualTest.api(draftPath).catch(()=>null):null,DualTest.api('/api/v2/tasks?status=open').catch(()=>null)]);salesUI.budget=budget?.data||null;salesUI.knowledgeSafety=safety?.data||null;salesUI.draft=draftPayload?.data||null;salesUI.tasks=(tasksPayload?.data||[]).filter(task=>task.opportunity_id===session.opportunity_id);
  render();if(!quiet)setStatus(salesUI.lastCustomerMessage&&!salesUI.draft?'后台正在分析客户消息…':'双端会话已同步。',salesUI.draft?'success':'');
 }catch(error){setStatus(error.message,'error');}
}
async function generateDraft(){
 if(salesUI.busy)return;const session=DualTest.getSession();if(!session)return setStatus('请先在客户模拟端创建会话。','error');
 if(aiBlocked())return setStatus('AI已被成本或知识版本门禁停止，请人工接管。','error');
 salesUI.busy=true;$('#generate-draft').disabled=true;setStatus('中控正在分析客户消息…');
 try{
  const context=await DualTest.api(`/api/v2/opportunities/${encodeURIComponent(session.opportunity_id)}/context`);
  const response=await DualTest.api(`/api/v2/opportunities/${encodeURIComponent(session.opportunity_id)}/drafts`,{method:'POST',body:{latest_message_id:context.data.latest_message_id,expected_revision:context.data.context_versions.opportunity_revision}});
  salesUI.draft=response.data;salesUI.activeDraftId=null;salesUI.draftDirty=false;renderDraft();
  if(salesUI.draft.status==='draft_ready'&&salesUI.draft.review_required===false&&salesUI.draft.next_action==='auto_send_safe_intake'){
   setStatus('正在自动发送基础信息问句…');await confirmDraft({automatic:true});return;
  }
  setStatus(salesUI.draft.status==='draft_ready'?'草稿已生成；客户尚不可见，请销售核对。':'中控未生成可发送草稿，请查看提示。',salesUI.draft.status==='draft_ready'?'success':'error');
 }catch(error){setStatus(error.message,'error');}
 finally{salesUI.busy=false;$('#generate-draft').disabled=false;}
}
async function confirmDraft({automatic=false}={}){
 const session=DualTest.getSession(),draft=salesUI.draft,finalText=$('#sales-draft').value.trim();if(!session||!draft||!finalText)return;
 if(aiBlocked())return setStatus('AI已停止，现有AI草稿不能继续对客发送，请人工接管。','error');
 $('#confirm-draft').disabled=true;setStatus('正在记录销售确认…');
 try{
  await DualTest.api(`/api/v2/drafts/${encodeURIComponent(draft.draft_id)}/confirm`,{method:'POST',body:{expected_revision:draft.revision,final_text:finalText,delivery_mode:'simulation',editor_id:'demo-champion',editor_role:'champion',idempotency_key:DualTest.id('sales-confirm')}});
  salesUI.draft=null;salesUI.activeDraftId=null;salesUI.draftDirty=false;await sync();setStatus(automatic?'已自动回复一个安全的基础信息问句。':'已模拟发送；客户模拟端现在可以看到最终文本。','success');
 }catch(error){setStatus(error.message,'error');renderDraft();}
}

$('#sales-draft').addEventListener('input',()=>{salesUI.draftDirty=true;$('#draft-state').textContent='已手动修改';$('#confirm-draft').disabled=!$('#sales-draft').value.trim();});
$('#close-safety-modal').addEventListener('click',()=>{$('#safety-modal').hidden=true;});
$('#refresh-sales').addEventListener('click',()=>sync({quiet:false}));$('#generate-draft').addEventListener('click',generateDraft);$('#confirm-draft').addEventListener('click',()=>confirmDraft());window.addEventListener('storage',()=>sync());sync({quiet:false});setInterval(()=>sync(),1500);
