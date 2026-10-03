import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../server/database.mjs';
import { buildContext } from '../../server/context.mjs';
import { createBackendB2 } from '../../server/backend-b2.mjs';
import { createV2Api } from '../../server/api.mjs';

const product = (key = 'product-1') => ({
  product_id: 'fixture-product', product_version: 'fixture-v1', name: '匹配规则演练样本', environment: 'simulation',
  catalog_status: 'active', valid_from: '2026-01-01', valid_to: '2027-12-31', approval_status: 'approved',
  reviewer: '演练审核人', approval_source: '明确的合成用例，仅作接口验收', source_kind: 'simulation_fixture',
  source_refs: [{source_id:'b2-rules-fixture',title:'单产品匹配规则演练数据',version:'fixture-v1',section:'条件'}],
  rules: { purpose_codes:['education'], insured_age:{min:0,max:70}, annual_budget:{min:1000,max:100000,currency:'CNY'},
    funds_usage_years:{min:5}, payment_years:[3] },
  idempotency_key: key
});
const mockMatch = async ({inputs}) => {
  const rules=JSON.parse(inputs.rules_json);
  return {workflow_run_id:'explicit-mock-product-match',data:{status:'succeeded',outputs:{match_result_json:JSON.stringify({
    status:'ready',provider:'explicit-test-double',candidates:rules.map(candidate=>({
      candidate_id:candidate.candidate_id,explanation:'符合该演练规则的已知条件，仍需销售核对。',
      citation_ids:candidate.citations.map(item=>item.citation_id),case_ids:[]
    }))
  })}}};
};

function fixture(t, {runMatchDify=mockMatch}={}) {
  const store=openDatabase(':memory:');t.after(()=>store.close());
  const now=()=>new Date('2026-09-23T12:00:00.000Z');
  const sendJson=(res,status,payload)=>{res.status=status;res.payload=payload;};
  const readJson=async req=>req.body;
  const runtime=createBackendB2({store,sendJson,readJson,now,runMatchDify,allowSimulationProducts:true});
  let salesContext=null;
  const v2=createV2Api({store,sendJson,readJson,
    prepareSalesContext:context=>runtime.prepareSalesContext(context),
    validateSalesContext:context=>runtime.validateSalesContext(context), validateDraft:row=>runtime.validateDraft(row),
    salesAssist:async context=>{salesContext=context;return {schema_version:'sales-assist.v1',status:'draft_ready',
      draft:'我们先核对已确认方案中的交费安排。',citations:[],review_required:true,context_versions:context.context_versions,
      trace:{provider:'explicit-test-double',workflow_run_id:'mock-sales'}};}
  });
  const request=async(path,method='GET',body,ws='b2-tests')=>{
    const req={url:path,method,headers:{'x-workspace-id':ws},body};const res={};const url=new URL(path,'http://localhost');
    const handled=await runtime.route(req,res,url)||await v2(req,res,url);assert.equal(handled,true);return res;
  };
  const seed=async(suffix='1',date='2026/9/23')=>{
    assert.equal((await request('/api/v2/customers','POST',{customer_id:`customer-${suffix}`,name:'演练客户',wechat_joined_on:date,wechat_joined_source:date ? 'manual' : 'unknown'})).status,201);
    assert.equal((await request(`/api/v2/customers/customer-${suffix}/persons`,'POST',{person_id:`child-${suffix}`,name:'演练孩子',relationship:'daughter',age:8})).status,201);
    assert.equal((await request(`/api/v2/customers/customer-${suffix}/opportunities`,'POST',{opportunity_id:`need-${suffix}`,person_ids:[`child-${suffix}`],purpose:'教育',budget_amount:30000,budget_currency:'CNY',environment:'simulation'})).status,201);
    assert.equal((await request(`/api/v2/opportunities/need-${suffix}/messages`,'POST',{message_id:`message-${suffix}`,idempotency_key:`message-${suffix}`,role:'customer',status:'received',source:'simulation',text:'孩子8岁，教育安排至少10年后用，想先看3年交费。'})).status,201);
    const customer=(await request(`/api/v2/customers/customer-${suffix}`)).payload.data;
    const facts=[['age',8,`child-${suffix}`],['funds_usage_years',10,null],['payment_years',3,null]].map(([field,value,person_id])=>({field,value,person_id,opportunity_id:`need-${suffix}`,status:'confirmed',source:'human',evidence_message_ids:[],idempotency_key:`fact-${suffix}-${field}`}));
    const updated=await request(`/api/v2/customers/customer-${suffix}`,'PATCH',{expected_revision:customer.revision,changes:{fact_changes:facts}});
    assert.equal(updated.status,200,JSON.stringify(updated.payload));return `need-${suffix}`;
  };
  const generate=async oid=>{
    const context=buildContext(store,'b2-tests',oid,{asOf:now().toISOString()});
    return request(`/api/v2/product-match/opportunities/${oid}/recommendations`,'POST',{
      expected_revision:context.context_versions.opportunity_revision,latest_message_id:context.latest_message_id,idempotency_key:`gen-${oid}`
    });
  };
  return {store,runtime,request,seed,generate,salesContext:()=>salesContext};
}

test('join date API displays YYYY/M/D, filters calendar ranges and preserves manual correction audit', async t=>{
  const f=fixture(t);await f.seed();await f.seed('2','2026/9/3');await f.seed('3',null);
  const all=await f.request('/api/v2/customers');assert.equal(all.payload.data.length,3);
  assert.equal(all.payload.data.find(item=>item.customer_id==='customer-1').wechat_joined_label,'2026/9/23');
  const exact=await f.request('/api/v2/customers?joined_on=2026%2F9%2F23');assert.deepEqual(exact.payload.data.map(c=>c.customer_id),['customer-1']);
  const range=await f.request('/api/v2/customers?joined_from=2026-09-10&joined_to=2026-09-30');assert.equal(range.payload.data.length,1);
  assert.equal((await f.request('/api/v2/customers?joined_on=2026-02-30')).status,400);
  const customer=(await f.request('/api/v2/customers/customer-1')).payload.data;
  const changed=await f.request('/api/v2/customers/customer-1','PATCH',{expected_revision:customer.revision,changes:{wechat_joined_on:'2026/9/22',wechat_joined_actor:'销售'}});
  assert.equal(changed.payload.data.wechat_joined_label,'2026/9/22');
  const audit=await f.request('/api/v2/customers/customer-1/join-date-audit');assert.equal(audit.status,200);assert.ok(audit.payload.data.length>=2);
  assert.equal((await f.request('/api/v2/customers/customer-1/join-date-audit','GET',undefined,'other-team')).status,404);
});

test('product recommendation requires human selection then connects to the existing sales draft endpoint',async t=>{
  const f=fixture(t);const oid=await f.seed();
  const saved=await f.request('/api/v2/product-match/products','POST',product());assert.equal(saved.status,201,JSON.stringify(saved.payload));
  const generation=await f.generate(oid);assert.equal(generation.status,201,JSON.stringify(generation.payload));
  const rec=generation.payload.data;
  assert.equal(rec.result.status,'ready',JSON.stringify(rec.result));
  assert.equal(buildContext(f.store,'b2-tests',oid).product_scope.product_id,'');
  const candidate=rec.result.candidates.find(item=>item.status==='eligible_for_discussion');assert.ok(candidate);
  const accepted=await f.request(`/api/v2/product-match/recommendations/${rec.recommendation_id}/accept`,'POST',{
    expected_revision:rec.revision,idempotency_key:'accept',reviewer:'演练销售',candidate_id:candidate.candidate_id,selected_payment_years:3
  });assert.equal(accepted.status,200,JSON.stringify(accepted.payload));
  const context=buildContext(f.store,'b2-tests',oid);
  const draft=await f.request(`/api/v2/opportunities/${oid}/drafts`,'POST',{expected_revision:context.context_versions.opportunity_revision,latest_message_id:context.latest_message_id});
  assert.equal(draft.status,201,JSON.stringify(draft.payload));
  assert.equal(f.salesContext().confirmed_product_match.recommendation_id,rec.recommendation_id);
  const row=f.store.getDraft('b2-tests',draft.payload.data.draft_id);assert.equal(row.ai_result.product_match_reference.recommendation_id,rec.recommendation_id);
  // Updating the catalog must prevent confirmation of the draft that used its old match.
  const entries=f.runtime.products.listProducts('b2-tests',{environment:'simulation',as_of:'2026-09-23'});
  const updated=await f.request('/api/v2/product-match/products','POST',{
    ...product('product-2'),expected_revision:entries.items[0].revision,rules:{...product().rules,payment_years:[5]}
  });assert.equal(updated.status,201,JSON.stringify(updated.payload));
  const confirmation=await f.request(`/api/v2/drafts/${row.draft_id}/confirm`,'POST',{expected_revision:row.revision,idempotency_key:'confirm',delivery_mode:'simulation',final_text:row.content});
  assert.equal(confirmation.status,409);assert.equal(confirmation.payload.error.code,'PRODUCT_MATCH_STALE');
});

test('no catalog and no model are truthful, not simulated successful AI recommendations',async t=>{
  const f=fixture(t,{runMatchDify:null});const oid=await f.seed();
  const noCatalog=await f.generate(oid);assert.equal(noCatalog.status,201,JSON.stringify(noCatalog.payload));assert.equal(noCatalog.payload.data.result.status,'needs_source');
  await f.request('/api/v2/product-match/products','POST',product());
  const context=buildContext(f.store,'b2-tests',oid);
  const noModel=await f.request(`/api/v2/product-match/opportunities/${oid}/recommendations`,'POST',{
    expected_revision:context.context_versions.opportunity_revision,latest_message_id:context.latest_message_id,idempotency_key:'without-model'
  });assert.equal(noModel.status,201,JSON.stringify(noModel.payload));assert.equal(noModel.payload.data.result.status,'unavailable');
  assert.equal((await f.request('/api/v2/product-match/cases','POST',{})).status,404);
});
