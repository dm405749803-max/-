import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../server/database.mjs';
import { createAiBudgetService } from '../../server/ai-budget.mjs';
import { createKnowledgeSafetyService } from '../../server/knowledge-safety.mjs';
import { createSalesOps } from '../../server/sales-ops/index.mjs';

async function fixture(t, now = () => new Date('2026-09-24T12:00:00.000Z')) {
  const directory = await mkdtemp(join(tmpdir(), 'tongpin-accepted-'));
  const store = openDatabase(join(directory, 'data.sqlite'), { now });
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  return { store, now };
}

test('single-customer AI budget warns at 70 percent and stops at 100 percent', async t => {
  const { store, now } = await fixture(t);
  const budget = createAiBudgetService({ store, now, limitCny: 10 });
  budget.record({ workspace_id: 'demo', customer_id: 'c1', workflow: 'A', idempotency_key: 'u1', payload: { usage: { output_tokens: 875_000 } } });
  assert.equal(budget.status('demo', 'c1').state, 'warning');
  assert.equal(budget.status('demo', 'c1').used_percent, 70);
  budget.record({ workspace_id: 'demo', customer_id: 'c1', workflow: 'B1', idempotency_key: 'u2', payload: { usage: { output_tokens: 375_000 } } });
  assert.equal(budget.status('demo', 'c1').state, 'stopped');
  assert.throws(() => budget.assertAvailable('demo', 'c1'), error => error.code === 'AI_BUDGET_EXHAUSTED');
});

test('knowledge version safety lock requires rules, RAG and review to become ready together', async t => {
  const { store, now } = await fixture(t);
  const safety = createKnowledgeSafetyService({ store, now });
  assert.equal(safety.status('demo').locked, false);
  safety.upsertRelease('demo', { product_id: 'p1', version_id: 'v2', environment: 'simulation', rules_status: 'ready', rag_status: 'pending', review_status: 'pending' });
  assert.equal(safety.status('demo').locked, true);
  assert.throws(() => safety.assertAiAllowed('demo'), error => error.code === 'AI_KNOWLEDGE_SAFETY_LOCKED');
  safety.upsertRelease('demo', { product_id: 'p1', version_id: 'v2', environment: 'simulation', rules_status: 'ready', rag_status: 'ready', review_status: 'approved' });
  assert.equal(safety.status('demo').locked, false);
});

test('high intent advances the sales stage while processing state remains independently controlled', async t => {
  const { store } = await fixture(t);
  store.createCustomer('demo', { customer_id: 'c1', name: '演练客户' });
  store.addOpportunity('demo', 'c1', { opportunity_id: 'o1', environment: 'simulation' });
  store.addMessage('demo', 'o1', { idempotency_key: 'm1', role: 'customer', text: '我想给妈妈看看养老，预算每年两万。', status: 'received', source: 'simulation', environment: 'simulation' });
  store.recordOpportunityIntent('demo', 'o1', { level: 'high', score: 82, reason: '主动给出预算并要求方案', evidence_message_ids: ['m1'] });
  const opportunity = store.getCustomer('demo', 'c1').opportunities[0];
  assert.equal(opportunity.sales_stage, 'solution_discussion');
  assert.equal(opportunity.intent_level, 'high');
  assert.equal(opportunity.processing_status, 'normal');
  assert.equal(store.listOpportunityIntentEvents('demo', 'o1').length, 1);
});

test('only a changed champion draft followed by purchase enters the candidate experience pool', async t => {
  const { store, now } = await fixture(t);
  store.createCustomer('demo', { customer_id: 'c1', name: '演练客户' });
  store.addOpportunity('demo', 'c1', { opportunity_id: 'o1', environment: 'simulation' });
  const at = now().toISOString();
  store.raw.prepare(`INSERT INTO drafts(workspace_id,draft_id,opportunity_id,latest_message_id,context_versions,content,ai_result,status,revision,stale,final_text,delivery_mode,confirmation_key,edit_record,product_scope,editor_id,editor_role,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,1,0,?,?,?,?,?,?,?,?,?)`).run('demo','d1','o1','m1','{}','AI原稿','{}','simulated_sent','销冠修改后的回复','simulation','confirm-1',JSON.stringify({ original_text:'AI原稿', final_text:'销冠修改后的回复', changed:true }),JSON.stringify({ environment:'simulation', product_id:'p1', product_version:'v1' }),'champion-1','champion',at,at);
  const salesOps = createSalesOps({ store, now });
  const captured = salesOps.captureChampionCandidates('demo', 'o1', { purchased_at: at });
  assert.equal(captured.candidate_count, 1);
  assert.equal(captured.candidates[0].approval_status, 'pending');
  assert.equal(captured.candidates[0].outcome, 'success');
  assert.match(captured.candidates[0].ai_suggested_reason, /需销冠确认/);
  assert.equal(salesOps.listApprovedExperiences('demo').length, 0);
});
