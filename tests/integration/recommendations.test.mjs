import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../server/database.mjs';
import { buildContext } from '../../server/context.mjs';
import { createRecommendationService } from '../../server/recommendations.mjs';

function fixture(t, options = {}) {
  const store = openDatabase(':memory:');
  t.after(() => store.close());
  const ws = 'recommendation-tests';
  store.createCustomer(ws, { customer_id: 'customer', name: '演练客户' });
  store.addOpportunity(ws, 'customer', { opportunity_id: 'need', environment: 'simulation' });
  store.addMessage(ws, 'need', { message_id: 'm1', idempotency_key: 'm1', role: 'customer', status: 'received', source: 'simulation', text: '请核对产品交费安排。' });
  let catalogVersion = 'catalog-1'; let candidateStatus = 'eligible_for_discussion'; let calls = 0;
  let capturedCase = null;
  const candidate = () => ({ candidate_id: 'candidate-1', product_id: 'fixture-product', product_version: 'fixture-v1',
    status: candidateStatus, reasons: [{ code: 'fixture', message: '演练匹配依据', citation_ids: ['fixture-source'] }],
    missing_fields: [], questions: [], citations: [{ source_id: 'fixture-source', title: '演练来源', version: 'fixture-v1', section: '条件' }], allowed_payment_years: [3, 5] });
  const evaluate = context => ({ schema_version: 'product-match-rules.v1', status: 'evaluated', catalog_fingerprint: catalogVersion,
    profile_snapshot: { frozen: 'generation-time', context_versions: context.context_versions }, candidates: [candidate()], missing_fields: [], risk_flags: [] });
  const generate = async (context, rules) => {
    calls++;
    if (options.onGenerate) await options.onGenerate({store, ws});
    const result = { schema_version: 'product-match.v1', status: options.resultStatus || 'ready', candidates: rules.candidates.map(item => ({ ...item, explanation: '仅供人工核对的演练建议。', case_references: [] })),
      context_versions: context.context_versions, catalog_fingerprint: rules.catalog_fingerprint, profile_snapshot: rules.profile_snapshot,
      review_required: true, trace: { provider: 'explicit-test-double', workflow_run_id: 'mock' } };
    return options.changeResult ? options.changeResult(result) : result;
  };
  const service = createRecommendationService({ store, evaluate, generate, putCase: (_ws, input) => { capturedCase = input; return {case_id:'case-1'}; } });
  const context = () => buildContext(store, ws, 'need');
  const input = () => ({ idempotency_key: 'generate-1', latest_message_id: context().latest_message_id, expected_revision: context().context_versions.opportunity_revision });
  const approve = (row, extras = {}) => service.decide(ws, row.recommendation_id, 'accept', {
    idempotency_key: 'accept-1', expected_revision: row.revision, reviewer: '演练销售', candidate_id: 'candidate-1', selected_payment_years: 3, ...extras
  });
  return {store, ws, context, input, service, approve, calls:()=>calls,
    changeCatalog:()=>{catalogVersion='catalog-2';}, setCandidateStatus:value=>{candidateStatus=value;}, capturedCase:()=>capturedCase};
}

test('generation freezes evidence, human acceptance alone binds a product and repeated confirmation is idempotent', async t => {
  const f = fixture(t);
  const input = f.input();
  const rec = await f.service.generate(f.ws, 'need', input);
  assert.equal(rec.status, 'pending');
  assert.equal(f.context().product_scope.product_id, '');
  assert.equal(f.service.getConfirmed(f.context()), null);
  assert.equal((await f.service.generate(f.ws, 'need', input)).idempotent_replay, true);
  assert.equal((await f.service.generate(f.ws, 'need', { ...input,
    trace_id: 'new-trace', session_id: 'new-session', case_id: 'H02', eval_run_id: 'retry-run'
  })).idempotent_replay, true);
  assert.equal(f.calls(), 1);
  const accepted = f.approve(rec);
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.stale, false);
  assert.equal(f.context().product_scope.product_id, 'fixture-product');
  const confirmed = f.service.getConfirmed(f.context());
  assert.equal(confirmed.schema_version, 'confirmed-product-match.v1');
  assert.equal(confirmed.status, 'human_confirmed');
  assert.equal(confirmed.selected_payment_years, 3);
  const revision = f.context().context_versions.opportunity_revision;
  assert.equal(f.approve(rec).idempotent_replay, true);
  assert.equal(f.context().context_versions.opportunity_revision, revision);
  assert.throws(()=>f.approve(rec, {reviewer:'不同销售'}), {code:'IDEMPOTENCY_KEY_REUSE'});
  await assert.rejects(f.service.generate(f.ws, 'need', {...input,expected_revision:999}), {code:'IDEMPOTENCY_KEY_REUSE'});
});

test('unsupported term or noneligible candidate cannot be accepted', async t => {
  const f = fixture(t); const rec = await f.service.generate(f.ws, 'need', f.input());
  assert.throws(()=>f.approve(rec,{selected_payment_years:20}), {code:'UNSUPPORTED_PAYMENT_TERM'});
  assert.equal(f.context().product_scope.product_id, '');
  assert.throws(()=>f.approve(rec,{candidate_id:'invented'}), {code:'CANDIDATE_NOT_ELIGIBLE'});
  assert.equal(f.service.get(f.ws,rec.recommendation_id).status,'pending');
});

for (const status of ['needs_information', 'not_matched', 'needs_source', 'unavailable', 'invalid_output']) {
  test(`${status} results are preserved truthfully and not eligible for acceptance`, async t => {
    const f = fixture(t,{resultStatus:status}); const rec = await f.service.generate(f.ws,'need',f.input());
    assert.equal(rec.result.status,status);
    assert.throws(()=>f.approve(rec),{code:'RECOMMENDATION_NOT_READY'});
    assert.equal(f.context().product_scope.product_id,'');
  });
}

test('new customer message expires pending recommendations and never binds a product', async t => {
  const f = fixture(t); const rec = await f.service.generate(f.ws, 'need', f.input());
  f.store.addMessage(f.ws, 'need', { idempotency_key:'new', role:'customer',text:'预算有变化。',status:'received',source:'simulation' });
  assert.equal(f.service.get(f.ws,rec.recommendation_id).stale,true);
  assert.throws(()=>f.approve(rec),{code:'RECOMMENDATION_STALE'});
  assert.equal(f.context().product_scope.product_id,'');
});

test('ordinary conversation keeps an accepted product available to the sales workflow', async t => {
  const f=fixture(t); const rec=await f.service.generate(f.ws,'need',f.input());
  f.approve(rec); assert.ok(f.service.getConfirmed(f.context()));
  f.store.addMessage(f.ws,'need',{idempotency_key:'follow-up',role:'customer',text:'中途需要用钱怎么办？',status:'received',source:'simulation'});
  assert.equal(f.service.get(f.ws,rec.recommendation_id).stale,false);
  assert.equal(f.service.getConfirmed(f.context()).product_id,'fixture-product');
});

test('catalog update expires pending recommendations and removes accepted recommendations from sales context', async t => {
  const f=fixture(t); const rec=await f.service.generate(f.ws,'need',f.input());
  f.approve(rec); assert.ok(f.service.getConfirmed(f.context()));
  f.changeCatalog();
  assert.equal(f.service.get(f.ws,rec.recommendation_id).stale,true);
  assert.equal(f.service.getConfirmed(f.context()),null);
});

test('same generation request regenerates against a newly released catalog', async t => {
  const f=fixture(t);const first=await f.service.generate(f.ws,'need',f.input());
  f.changeCatalog();
  const second=await f.service.generate(f.ws,'need',{...f.input(),trace_id:'retry-trace'});
  assert.notEqual(second.recommendation_id,first.recommendation_id);
  assert.equal(second.stale,false);
  assert.equal(second.idempotent_replay,false);
  assert.equal(f.calls(),2);
});

test('accepting a recommendation atomically invalidates an earlier draft and audit failure rolls back the product binding', async t => {
  const f=fixture(t); const context=f.context();
  const draft=f.store.saveDraft(f.ws,'need',context.latest_message_id,context.context_versions.opportunity_revision,{
    schema_version:'sales-assist.v1',status:'draft_ready',draft:'选择前的旧草稿',context_versions:context.context_versions
  },context);
  const rec=await f.service.generate(f.ws,'need',f.input());
  f.store.raw.exec("CREATE TRIGGER fail_recommendation_audit BEFORE INSERT ON recommendation_decisions BEGIN SELECT RAISE(ABORT,'audit unavailable'); END;");
  assert.throws(()=>f.approve(rec),/audit unavailable/);
  assert.equal(f.context().product_scope.product_id,'');
  assert.equal(f.service.get(f.ws,rec.recommendation_id).status,'pending');
  assert.equal(f.store.getDraft(f.ws,draft.draft_id).stale,false);
  f.store.raw.exec('DROP TRIGGER fail_recommendation_audit');
  f.approve(rec);
  assert.equal(f.store.getDraft(f.ws,draft.draft_id).stale,true);
});

test('catalog edits before human acceptance require regeneration even without a new message', async t=>{
  const f=fixture(t);const rec=await f.service.generate(f.ws,'need',f.input());
  f.changeCatalog();assert.throws(()=>f.approve(rec),{code:'RECOMMENDATION_STALE'});
  assert.equal(f.context().product_scope.product_id,'');
});

test('changes during asynchronous generation do not save a stale recommendation', async t => {
  const f=fixture(t,{onGenerate:({store,ws})=>store.patchCustomer(ws,'customer',1,{name:'更新后的演练客户'})});
  await assert.rejects(f.service.generate(f.ws,'need',f.input()),{code:'STALE_CONTEXT'});
  assert.equal(f.service.list(f.ws,'need').length,0);
});

test('workspace isolation and manually rejected recommendation never change product scope', async t => {
  const f=fixture(t);const rec=await f.service.generate(f.ws,'need',f.input());
  assert.throws(()=>f.service.get('another-team',rec.recommendation_id),{code:'RECOMMENDATION_NOT_FOUND'});
  assert.throws(()=>f.service.decide(f.ws,rec.recommendation_id,'reject',{expected_revision:1,idempotency_key:'reject',reviewer:'销售'}),{code:'REASON_REQUIRED'});
  const denied=f.service.decide(f.ws,rec.recommendation_id,'reject',{expected_revision:1,idempotency_key:'reject',reviewer:'销售',reason:'需先核对资金使用安排。'});
  assert.equal(denied.status,'rejected');assert.equal(f.context().product_scope.product_id,'');
});

test('marketing opt-out, human handoff and purchased needs prevent generation', async t => {
  const f=fixture(t);
  f.store.patchOpportunity(f.ws,'need',1,{purchased:true});
  await assert.rejects(f.service.generate(f.ws,'need',f.input()),{code:'PURCHASED_OPPORTUNITY'});
  assert.equal(f.calls(),0);
});

test('model cannot replace a product version or change suitability gates', async t => {
  const f=fixture(t,{changeResult:result=>({...result,candidates:result.candidates.map(item=>({...item,product_version:'made-up'}))})});
  await assert.rejects(f.service.generate(f.ws,'need',f.input()),{code:'MATCH_RULES_CHANGED_BY_MODEL'});
  assert.equal(f.service.list(f.ws,'need').length,0);
});

test('confirmed recommendation freezes outcome source at generation time, not the later closing profile', async t => {
  const f=fixture(t);const rec=await f.service.generate(f.ws,'need',f.input());
  assert.throws(()=>f.service.recordOutcome(f.ws,rec.recommendation_id,{idempotency_key:'outcome'}),{code:'RECOMMENDATION_NOT_ACCEPTED'});
  f.approve(rec);
  f.store.patchOpportunity(f.ws,'need',f.context().context_versions.opportunity_revision,{budget_amount:99999});
  f.service.recordOutcome(f.ws,rec.recommendation_id,{idempotency_key:'outcome',outcome:'failure',reviewer:'演练销售',approval_source:'人工复盘',sharing_approved:true,snapshot_at:new Date().toISOString()});
  assert.equal(f.capturedCase().source_snapshot.profile_snapshot.frozen,'generation-time');
  assert.equal(f.capturedCase().source_snapshot.decision,'accepted');
  assert.equal(f.capturedCase().product_version,'fixture-v1');
  assert.throws(()=>f.service.recordOutcome(f.ws,rec.recommendation_id,{idempotency_key:'fake',source_opportunity_id:'someone-else'}),{code:'UNSUPPORTED_CHANGE'});
});
