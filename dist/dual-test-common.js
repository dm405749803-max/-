'use strict';

const DualTest=(()=>{
 const workspace='demo';
 const sessionKey='tongpin-dual-test-session-v1';
 const id=prefix=>`${prefix}-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
 const escapeHTML=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
 async function api(path,{method='GET',body}={}){
  let response;
  try{response=await fetch(path,{method,headers:{accept:'application/json','x-workspace-id':workspace,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});}
  catch{throw Object.assign(new Error('无法连接本机后端，请刷新页面后重试。'),{code:'BACKEND_UNREACHABLE'});}
  let payload=null;try{payload=await response.json();}catch{}
  if(!response.ok)throw Object.assign(new Error(payload?.error?.message||`请求失败（HTTP ${response.status}）`),{code:payload?.error?.code||'HTTP_ERROR',traceId:payload?.trace_id||null});
  return payload;
 }
 function getSession(){try{return JSON.parse(localStorage.getItem(sessionKey)||'null');}catch{return null;}}
 function setSession(value){localStorage.setItem(sessionKey,JSON.stringify(value));window.dispatchEvent(new StorageEvent('storage',{key:sessionKey,newValue:JSON.stringify(value)}));return value;}
 function clearSession(){localStorage.removeItem(sessionKey);window.dispatchEvent(new StorageEvent('storage',{key:sessionKey,newValue:null}));}
 function localDate(){const value=new Date();return `${value.getFullYear()}-${String(value.getMonth()+1).padStart(2,'0')}-${String(value.getDate()).padStart(2,'0')}`;}
 async function createSession({welcome=true,caseId=null}={}){
  const now=new Date(),customerId=id('dual-customer'),opportunityId=id('dual-session');
  const customerName=`测试客户 ${String(now.getMonth()+1).padStart(2,'0')}/${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  await api('/api/v2/customers',{method:'POST',body:{customer_id:customerId,name:customerName,wechat_joined_on:localDate(),wechat_joined_source:'manual',wechat_joined_actor:'dual-test'}});
  await api(`/api/v2/customers/${encodeURIComponent(customerId)}/opportunities`,{method:'POST',body:{opportunity_id:opportunityId,purpose:null,stage:'待识别',status:'open',environment:'simulation'}});
  if(welcome)await api(`/api/v2/opportunities/${encodeURIComponent(opportunityId)}/messages`,{method:'POST',body:{idempotency_key:`welcome-${opportunityId}`,role:'sales',text:'你好，我是太保的销售经理，请问您想给谁买呢？',status:'simulated_sent',source:'simulation',environment:'simulation',occurred_at:new Date().toISOString()}});
  return setSession({customer_id:customerId,opportunity_id:opportunityId,customer_name:customerName,case_id:caseId,created_at:new Date().toISOString()});
 }
 async function detail(session=getSession()){
  if(!session)return null;
  const payload=await api(`/api/v2/customers/${encodeURIComponent(session.customer_id)}`);
  const opportunity=payload.data.opportunities.find(item=>item.opportunity_id===session.opportunity_id);
  if(!opportunity)throw new Error('共享测试会话不存在，请重新开始。');
  return {customer:payload.data,opportunity};
 }
 async function messages(session=getSession()){
  if(!session)return [];
  const payload=await api(`/api/v2/opportunities/${encodeURIComponent(session.opportunity_id)}/messages`);
  return Array.isArray(payload.data)?payload.data:[];
 }
 return {api,id,escapeHTML,getSession,setSession,clearSession,createSession,detail,messages,sessionKey};
})();
