'use strict';
(function(global){
 class V2ApiError extends Error{
  constructor(message,{status=0,code='NETWORK_ERROR',details=null,traceId=null}={}){super(message);this.name='V2ApiError';this.status=status;this.code=code;this.details=details;this.traceId=traceId;}
 }
 class SalesWorkbenchV2Client{
  constructor({baseUrl='',fetchImpl=global.fetch?.bind(global)}={}){if(typeof fetchImpl!=='function')throw new Error('SalesWorkbenchV2Client requires fetch');this.baseUrl=String(baseUrl).replace(/\/$/,'');this.fetchImpl=fetchImpl;}
  async request(path,{method='GET',body,signal,headers={}}={}){
   let response;
   try{response=await this.fetchImpl(this.baseUrl+path,{method,signal,headers:{accept:'application/json',...(body===undefined?{}:{'content-type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});}
   catch(error){throw new V2ApiError('无法连接 v2 工作台服务。',{details:{cause:error?.message||String(error)}});}
   let payload=null;try{payload=await response.json();}catch{if(response.ok&&response.status===204)return null;}
   if(!response.ok){const remote=payload?.error||{};throw new V2ApiError(remote.message||`v2 请求失败（HTTP ${response.status}）`,{status:response.status,code:remote.code||'HTTP_ERROR',details:remote.details??null,traceId:payload?.trace_id||null});}
   if(!payload||!Object.prototype.hasOwnProperty.call(payload,'data'))throw new V2ApiError('v2 响应缺少 data 字段。',{status:response.status,code:'INVALID_RESPONSE',traceId:payload?.trace_id||null});
   return {data:payload.data,trace_id:payload.trace_id||null};
  }
  listCustomers(query={},options={}){const params=new URLSearchParams(Object.entries(query||{}).filter(([,value])=>value!==undefined&&value!==null&&value!==''));return this.request(`/api/v2/customers${params.size?'?'+params:''}`,options);}
  getCustomer(customerId,options){return this.request(`/api/v2/customers/${encodeURIComponent(customerId)}`,options);}
  patchCustomer(customerId,{expected_revision,changes},options={}){return this.request(`/api/v2/customers/${encodeURIComponent(customerId)}`,{...options,method:'PATCH',body:{expected_revision,changes}});}
  createPerson(customerId,person,options={}){return this.request(`/api/v2/customers/${encodeURIComponent(customerId)}/persons`,{...options,method:'POST',body:person});}
  createOpportunity(customerId,opportunity,options={}){return this.request(`/api/v2/customers/${encodeURIComponent(customerId)}/opportunities`,{...options,method:'POST',body:opportunity});}
  patchOpportunity(opportunityId,{expected_revision,changes},options={}){return this.request(`/api/v2/opportunities/${encodeURIComponent(opportunityId)}`,{...options,method:'PATCH',body:{expected_revision,changes}});}
  listMessages(opportunityId,options){return this.request(`/api/v2/opportunities/${encodeURIComponent(opportunityId)}/messages`,options);}
  addMessage(opportunityId,message,options={}){return this.request(`/api/v2/opportunities/${encodeURIComponent(opportunityId)}/messages`,{...options,method:'POST',body:message});}
  transcribeMedia(opportunityId,media,options={}){return this.request(`/api/v2/opportunities/${encodeURIComponent(opportunityId)}/media-transcriptions`,{...options,method:'POST',body:media});}
  getContext(opportunityId,options){return this.request(`/api/v2/opportunities/${encodeURIComponent(opportunityId)}/context`,options);}
  createDraft(opportunityId,{latest_message_id,expected_revision},options={}){return this.request(`/api/v2/opportunities/${encodeURIComponent(opportunityId)}/drafts`,{...options,method:'POST',body:{latest_message_id,expected_revision}});}
  confirmDraft(draftId,{expected_revision,final_text,delivery_mode,idempotency_key},options={}){return this.request(`/api/v2/drafts/${encodeURIComponent(draftId)}/confirm`,{...options,method:'POST',body:{expected_revision,final_text,delivery_mode,idempotency_key}});}
  listPlans(opportunityId,options){return this.request(`/api/v2/opportunities/${encodeURIComponent(opportunityId)}/plans`,options);}
  createPlan(opportunityId,plan,options={}){return this.request(`/api/v2/opportunities/${encodeURIComponent(opportunityId)}/plans`,{...options,method:'POST',body:plan});}
  listTasks(query={},options={}){const params=new URLSearchParams(Object.entries(query).filter(([,value])=>value!==undefined&&value!==null&&value!==''));return this.request(`/api/v2/tasks${params.size?'?'+params:''}`,options);}
  createTask(task,options={}){return this.request('/api/v2/tasks',{...options,method:'POST',body:task});}
  patchTask(taskId,{expected_revision,changes},options={}){return this.request(`/api/v2/tasks/${encodeURIComponent(taskId)}`,{...options,method:'PATCH',body:{expected_revision,changes}});}
  listMemoryProposals(query={},options={}){const params=new URLSearchParams(Object.entries(query).filter(([,value])=>value!==undefined&&value!==null&&value!==''));return this.request(`/api/v2/memory-review/proposals${params.size?'?'+params:''}`,options);}
  createMemoryProposal(opportunityId,{idempotency_key},options={}){return this.request(`/api/v2/memory-review/opportunities/${encodeURIComponent(opportunityId)}/proposals`,{...options,method:'POST',body:{idempotency_key}});}
  approveMemoryProposal(proposalId,{expected_revision,idempotency_key,reviewer,reason},options={}){return this.request(`/api/v2/memory-review/proposals/${encodeURIComponent(proposalId)}/approve`,{...options,method:'POST',body:{expected_revision,idempotency_key,reviewer,reason}});}
  rejectMemoryProposal(proposalId,{expected_revision,idempotency_key,reviewer,reason},options={}){return this.request(`/api/v2/memory-review/proposals/${encodeURIComponent(proposalId)}/reject`,{...options,method:'POST',body:{expected_revision,idempotency_key,reviewer,reason}});}
  listProducts(query={},options={}){const params=new URLSearchParams(Object.entries(query).filter(([,value])=>value!==undefined&&value!==null&&value!==''));return this.request(`/api/v2/product-match/products${params.size?'?'+params:''}`,options);}
  listRecommendations(opportunityId,options){return this.request(`/api/v2/product-match/opportunities/${encodeURIComponent(opportunityId)}/recommendations`,options);}
  listAllRecommendations(query={},options={}){const params=new URLSearchParams(Object.entries(query).filter(([,value])=>value!==undefined&&value!==null&&value!==''));return this.request(`/api/v2/product-match/recommendations${params.size?'?'+params:''}`,options);}
  generateRecommendation(opportunityId,body,options={}){return this.request(`/api/v2/product-match/opportunities/${encodeURIComponent(opportunityId)}/recommendations`,{...options,method:'POST',body});}
  acceptRecommendation(recommendationId,body,options={}){return this.request(`/api/v2/product-match/recommendations/${encodeURIComponent(recommendationId)}/accept`,{...options,method:'POST',body});}
  rejectRecommendation(recommendationId,body,options={}){return this.request(`/api/v2/product-match/recommendations/${encodeURIComponent(recommendationId)}/reject`,{...options,method:'POST',body});}
 }
 global.V2ApiError=V2ApiError;
 global.SalesWorkbenchV2Client=SalesWorkbenchV2Client;
})(globalThis);
