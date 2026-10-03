import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../server/database.mjs';
import { createKnowledgeSafetyService } from '../../server/knowledge-safety.mjs';
import { retrieveKnowledge } from '../../knowledge/retrieve.mjs';
import { runSalesAssist } from '../../ai/sales-assist.mjs';

const now = () => new Date('2026-09-30T04:00:00.000Z');

function document(id, {
  knowledgeType = 'product', productId = 'product-current', productVersion = 'v2',
  lifecycleStatus = 'active', text = '当前版本支持3年交。', claimKey = 'payment-term'
} = {}) {
  return {
    document_id: id, version: 'doc-v1', title: `${id}测试资料`, knowledge_type: knowledgeType,
    product_id: productId, product_version: productVersion, policy_contract_versions: [],
    scopes: ['new_consultation'], lifecycle_status: lifecycleStatus, index_status: 'ready',
    verification_status: 'business_verified', customer_use: 'approved', valid_from: '2026-01-01', valid_to: null,
    source: { publisher: '业务审核', label: `${id}来源`, url: `https://example.invalid/${id}`, retrieved_at: '2026-09-30' },
    topics: ['payment_term'],
    chunks: [{ location: 'FAQ-交费期', claim_key: claimKey, keywords: ['交费'], text }]
  };
}

function request(overrides = {}) {
  return {
    query: '这款可以选几年交费？', environment: 'real', interaction_type: 'new_consultation',
    knowledge_scope: 'product', product_scope: { product_id: 'product-current', product_version: 'v2' },
    as_of: '2026-09-30', ...overrides
  };
}

function salesContext() {
  return {
    schema_version: 'sales-assist.v1', workspace_id: 'fixture', customer_id: 'customer', opportunity_id: 'opportunity',
    environment: 'real', latest_message_id: 'message', latest_message: '这款可以选几年交费？',
    contact_state: { marketing_opt_out: false, human_handoff: false, purchased_for_opportunity: false },
    persons: [], confirmed_facts: [], recent_messages: [], long_term_summary: { text: '', evidence_message_ids: [] },
    open_objections: [], promises: [], product_scope: { product_id: 'product-current', product_version: 'v2', policy_contract_version: null, as_of: '2026-09-30' },
    verified_plan: null,
    context_versions: { customer_revision: 1, opportunity_revision: 1, profile_version: 1, latest_message_id: 'message', latest_conversation_message_id: 'message' }
  };
}

test('[E08] a new RAG version with an old rules/catalog version locks every affected AI answer', t => {
  const store = openDatabase(':memory:', { now }); t.after(() => store.close());
  const safety = createKnowledgeSafetyService({ store, now });
  safety.upsertRelease('fixture', {
    product_id: 'product-current', version_id: 'v2', environment: 'real',
    rules_status: 'pending', rag_status: 'ready', review_status: 'approved'
  });
  const blocked = safety.status('fixture');
  assert.equal(blocked.locked, true);
  assert.equal(blocked.reason, 'knowledge_version_not_atomic');
  assert.throws(() => safety.assertAiAllowed('fixture'), error => error.code === 'AI_KNOWLEDGE_SAFETY_LOCKED');
});

test('[E11] product and public FAQ scopes never merge, while a same-scope conflict blocks drafting', async () => {
  const publicDoc = document('public-faq', { knowledgeType: 'global', productId: null, productVersion: null, text: '通用流程资料表述。' });
  const productDoc = document('product-faq', { text: '产品当前版本表述。' });
  const productResult = await retrieveKnowledge(request(), { documents: [publicDoc, productDoc], now });
  assert.deepEqual(productResult.documents.map(item => item.document_id), ['product-faq']);
  assert.ok(productResult.rejected.some(item => item.document_id === 'public-faq' && item.reason === 'shadowed_by_specific_scope'));

  const publicResult = await retrieveKnowledge(request({ knowledge_scope: 'global' }), {
    documents: [publicDoc, productDoc], now
  });
  assert.deepEqual(publicResult.documents.map(item => item.document_id), ['public-faq']);

  const conflicting = await retrieveKnowledge(request(), { documents: [productDoc, document('product-faq-conflict', { text: '产品同一版本的另一种相反表述。' })], now });
  assert.equal(conflicting.evidence_status, 'conflict');
  assert.deepEqual(conflicting.documents, []);
  assert.equal(conflicting.conflicts[0].claim_key, 'payment-term');

  const draft = await runSalesAssist(salesContext(), {
    now,
    retrieveKnowledge: async () => conflicting,
    runDify: async () => { throw new Error('证据冲突时不应调用模型'); }
  });
  assert.equal(draft.status, 'needs_source');
  assert.equal(draft.next_action, 'resolve_knowledge_conflict');
  assert.ok(draft.risk_flags.includes('knowledge_evidence_conflict'));
  assert.ok(draft.missing_evidence.includes('conflicting_approved_sources'));
});

test('[E12] a delisted product document cannot re-enter new-sales answers just because it is indexed', async () => {
  const result = await retrieveKnowledge(request(), { documents: [document('delisted', { lifecycleStatus: 'inactive' })], now });
  assert.equal(result.evidence_status, 'not_found');
  assert.deepEqual(result.documents, []);
  assert.ok(result.rejected.some(item => item.document_id === 'delisted' && item.reason === 'not_active'));
});

test('[E14] a low-relevance retrieval result is treated as no evidence', async () => {
  const unrelated = document('unrelated', { claimKey: null });
  unrelated.topics = ['complaint'];
  unrelated.chunks = [{ location: '联系方式', keywords: ['投诉电话'], text: '这里只有一段投诉联系方式。' }];
  const result = await retrieveKnowledge(request({ query: '这款的领取金额是多少？' }), { documents: [unrelated], now });
  assert.equal(result.evidence_status, 'not_found');
  assert.deepEqual(result.documents, []);
  assert.ok(result.rejected.some(item => item.reason === 'low_relevance'));
});
