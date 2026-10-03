import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../../server/database.mjs';
import { buildContext } from '../../server/context.mjs';
import { createV2Api } from '../../server/api.mjs';
import { createAiBudgetService } from '../../server/ai-budget.mjs';
import { createKnowledgeSafetyService } from '../../server/knowledge-safety.mjs';
import { createSalesOps } from '../../server/sales-ops/index.mjs';
import { createBackendB2 } from '../../server/backend-b2.mjs';
import { classifyConversationTurn } from '../../ai/conversation-routing.mjs';
import { runSalesAssist } from '../../ai/sales-assist.mjs';
import { proposeMemory } from '../../ai/memory-proposal.mjs';
import { retrieveKnowledge } from '../../knowledge/retrieve.mjs';

const workspace = 'evaluation_fixtures';
const fixedNow = () => new Date('2026-09-29T10:00:00.000Z');
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function database(t) {
  const store = openDatabase(':memory:', { now: fixedNow });
  t.after(() => store.close());
  return store;
}

function reportFixtureEvidence(caseId, details) {
  console.log(`FIXTURE_EVIDENCE ${JSON.stringify({ case_id: caseId, ...details })}`);
}

function apiFor(store, options = {}) {
  const readJson = async req => req.body;
  const sendJson = (res, status, payload) => { res.status = status; res.payload = payload; };
  const route = createV2Api({ store, readJson, sendJson, ...options });
  return async (path, { method = 'POST', body } = {}) => {
    const res = {};
    await route({ method, body, headers: { 'x-workspace-id': workspace } }, res, new URL(path, 'http://localhost'));
    return res;
  };
}

function seedOpportunity(store, { customerId = 'c1', opportunityId = 'o1', purpose = null, purchased = false, policyContractVersion = null } = {}) {
  store.createCustomer(workspace, { customer_id: customerId, name: '演练客户' });
  store.addOpportunity(workspace, customerId, {
    opportunity_id: opportunityId,
    purpose,
    purchased,
    policy_contract_version: policyContractVersion,
    environment: 'simulation'
  });
  return { customerId, opportunityId };
}

const insufficientMemory = async () => ({ outputs: { proposal_result_json: JSON.stringify({
  status: 'insufficient_evidence', facts: [], summary: null
}) } });

test('[B15] confirmed long-term history resumes a related education need without asking the customer to repeat it', async t => {
  const store = database(t);
  seedOpportunity(store, { opportunityId: 'history-education', purpose: '孩子教育' });
  store.addMessage(workspace, 'history-education', {
    message_id: 'b15-history', idempotency_key: 'b15-history', role: 'customer',
    text: '之前想给8岁的孩子准备大学教育金，预计10年后使用，每年预算2万元。', status: 'received', source: 'simulation'
  });
  store.addSummary(workspace, 'history-education', {
    expected_revision: 1,
    idempotency_key: 'b15-summary',
    text: '孩子8岁，准备大学教育金，预计10年后使用，每年预算2万元。',
    through_message_id: 'b15-history',
    evidence_message_ids: ['b15-history'],
    status: 'confirmed'
  });
  store.addOpportunity(workspace, 'c1', { opportunity_id: 'current', environment: 'simulation' });
  store.addMessage(workspace, 'current', {
    message_id: 'b15-current', idempotency_key: 'b15-current', role: 'customer',
    text: '之前为孩子问的那个再看看', status: 'received', source: 'simulation'
  });
  const context = buildContext(store, workspace, 'current');
  assert.equal(context.related_opportunities[0].purpose, '孩子教育');
  assert.match(context.related_opportunities[0].summary, /孩子8岁/);
  const result = await runSalesAssist(context);
  assert.equal(result.next_action, 'resume_related_opportunity');
  assert.match(result.draft, /不用从头再说/);
  assert.match(result.draft, /10年后使用/);
});

test('[H01] source and mother profile are proposed before matching or customer delivery', async t => {
  const store = database(t);
  seedOpportunity(store);
  for (const [id, role, text] of [
    ['h01-1', 'customer', '我是看养老视频加的微信。'],
    ['h01-2', 'sales', '请问您想给谁买呢？'],
    ['h01-3', 'customer', '想给我妈妈准备养老。'],
    ['h01-4', 'sales', '妈妈今年多大年龄呢？'],
    ['h01-5', 'customer', '58岁，每年预算大概2万元，这笔钱15年内不用，想先看看方案。']
  ]) store.addMessage(workspace, 'o1', { message_id: id, idempotency_key: id, role, text,
    status: role === 'customer' ? 'received' : 'simulated_sent', source: 'simulation' });
  const context = buildContext(store, workspace, 'o1');
  const proposal = await proposeMemory(context, { runDify: insufficientMemory });
  const facts = Object.fromEntries(proposal.facts.map(item => [item.field, item.value]));
  assert.equal(facts.insured_person_relationship, 'mother');
  assert.equal(facts.insured_person_age, 58);
  assert.equal(facts.purpose_code, 'retirement');
  assert.equal(facts.annual_budget_amount, 20000);
  assert.equal(facts.funds_usage_years, 15);
  assert.equal(proposal.status, 'proposed');
});

test('[H02] multiple short messages merge and two named products remain source-isolated', async t => {
  const store = database(t);
  seedOpportunity(store, { purpose: '孩子教育' });
  for (const [index, text] of ['想给孩子准备教育金。', '8岁。', '主要想准备大学费用。', '大概10年后用。', '每年预算2到3万元。', '启航成长和安心储备有什么区别？'].entries()) {
    store.addMessage(workspace, 'o1', { message_id: `h02-${index}`, idempotency_key: `h02-${index}`, role: 'customer', text, status: 'received', source: 'simulation' });
  }
  const context = buildContext(store, workspace, 'o1');
  const proposal = await proposeMemory(context, { runDify: insufficientMemory });
  assert.equal(proposal.facts.find(item => item.field === 'annual_budget_amount')?.value, 20000);
  assert.equal(proposal.facts.find(item => item.field === 'annual_budget_max')?.value, 30000);
  const result = await runSalesAssist(context, {
    retrieveKnowledge: async input => {
      const productId = input.product_scope.product_id;
      const make = location => ({ document_id: `${productId}-${location}`, product_id: productId, product_version: input.product_scope.product_version, location, text: `${productId}的${location}。` });
      const documents = [make('产品定位'), make('领取安排')];
      return { documents, citations: documents.map(item => ({ document_id: item.document_id, product_id: item.product_id, product_version: item.product_version, location: item.location })) };
    }
  });
  assert.equal(result.trace.provider, 'multi-product-comparison-rule');
  assert.match(result.draft, /启航成长/);
  assert.match(result.draft, /安心储备/);
  assert.ok(result.citations.every(item => item.product_id));
});

test('[H03] a three-year liquidity constraint stops direct long-term product selection', async t => {
  const store = database(t);
  seedOpportunity(store);
  const opportunity = store.getCustomer(workspace, 'c1').opportunities[0];
  store.patchOpportunity(workspace, 'o1', opportunity.revision, { product_id: 'practice-savings-endowment', product_version: 'practice-2026-09-v2' });
  store.addMessage(workspace, 'o1', { message_id: 'h03', idempotency_key: 'h03', role: 'customer', text: '我三年内可能会用到这笔钱。', status: 'received', source: 'simulation' });
  const result = await runSalesAssist(buildContext(store, workspace, 'o1'));
  assert.equal(result.status, 'draft_ready');
  assert.ok(result.risk_flags.includes('liquidity_constraint'));
  assert.match(result.draft, /不适合现在直接选择/);
});

test('[H04] repeated budget deferral followed by a range creates one canonical budget pair', async t => {
  const store = database(t);
  seedOpportunity(store, { purpose: '养老' });
  for (const [index, text] of ['预算先不说。', '预算还是先不说。', '我刚算了一下，每年2万到3万可以。'].entries()) {
    store.addMessage(workspace, 'o1', { message_id: `h04-${index}`, idempotency_key: `h04-${index}`, role: 'customer', text, status: 'received', source: 'simulation' });
  }
  const proposal = await proposeMemory(buildContext(store, workspace, 'o1'), { runDify: insufficientMemory });
  assert.equal(proposal.facts.filter(item => item.field === 'annual_budget_amount').length, 1);
  assert.equal(proposal.facts.find(item => item.field === 'annual_budget_amount')?.value, 20000);
  assert.equal(proposal.facts.find(item => item.field === 'annual_budget_max')?.value, 30000);
});

test('[H05] changed age is exposed as a conflict and cannot silently enter matching', async t => {
  const store = database(t);
  seedOpportunity(store, { purpose: '养老' });
  for (const [index, text] of ['我妈妈58岁，想看养老。', '刚问清楚了，她其实59岁。先马上给我推荐吧。'].entries()) {
    store.addMessage(workspace, 'o1', { message_id: `h05-${index}`, idempotency_key: `h05-${index}`, role: 'customer', text, status: 'received', source: 'simulation' });
  }
  const proposal = await proposeMemory(buildContext(store, workspace, 'o1'), { runDify: insufficientMemory });
  const conflict = proposal.facts.find(item => item.field === 'insured_person_age_conflict');
  assert.equal(conflict?.value, '58|59');
  assert.deepEqual(conflict?.evidence_message_ids, ['h05-0', 'h05-1']);
});

test('[H06] family discussion preserves solution stage and changes processing to waiting customer', t => {
  const store = database(t);
  seedOpportunity(store, { purpose: '本人养老' });
  store.addMessage(workspace, 'o1', { message_id: 'h06-plan', idempotency_key: 'h06-plan', role: 'customer', text: '如果今天决定，怎么办手续？', status: 'received', source: 'simulation' });
  let opportunity = store.getCustomer(workspace, 'c1').opportunities[0];
  assert.equal(opportunity.sales_stage, 'solution_discussion');
  store.addMessage(workspace, 'o1', { message_id: 'h06-wait', idempotency_key: 'h06-wait', role: 'customer', text: '方案我看到了，不过我要先和家人商量一下，过段时间再联系。', status: 'received', source: 'simulation' });
  opportunity = store.getCustomer(workspace, 'c1').opportunities[0];
  assert.equal(opportunity.sales_stage, 'solution_discussion');
  assert.equal(opportunity.processing_status, 'waiting_customer');
  assert.ok(store.listTasks(workspace, { status: 'open' }).some(item => item.opportunity_id === 'o1'));
});

test('[H07] complaint stops AI reply and creates a human handoff task', async t => {
  const store = database(t);
  seedOpportunity(store, { purpose: '养老' });
  store.addMessage(workspace, 'o1', { message_id: 'h07', idempotency_key: 'h07', role: 'customer', text: '你们之前的服务很差，我要投诉。', status: 'received', source: 'simulation' });
  const context = buildContext(store, workspace, 'o1');
  const result = await runSalesAssist(context);
  assert.equal(result.status, 'human_required');
  assert.equal(result.draft, '');
  assert.equal(context.contact_state.human_handoff, true);
  assert.ok(store.listTasks(workspace, { status: 'open' }).some(item => /投诉人工接管/.test(item.title)));
});

test('[F08] 销售清空AI草稿后，后台刷新保持人工编辑状态且不回填旧稿', () => {
  const source = readFileSync(join(root, 'dist', 'sales-workbench.js'), 'utf8');
  assert.match(source, /\#clear-draft[\s\S]{0,180}reply-draft'\)\.value=''[\s\S]{0,100}draftDirty=true/);
  assert.match(source, /if\(!state\.draft&&!state\.draftDirty\)\{\$\('#reply-draft'\)\.value=''/);
  assert.match(source, /autoAttempted\.has\(key\)/);
  assert.match(source, /setInterval\(\(\)=>\{[\s\S]{0,120}refreshActiveCustomer\(\)/);
  // Refreshing customer/context data does not call generateDraft. A cleared,
  // dirty editor therefore stays blank until the sales user explicitly asks
  // for another generation.
  const refreshBody = source.match(/async function refreshActiveCustomer\(\)\{([^}]|\}(?!\s*function))*\}/)?.[0] || '';
  assert.doesNotMatch(refreshBody, /generateDraft\(/);
});

test('[F09] 销售修改称呼和语气后，以人工终稿发送并保存原稿差异', t => {
  const store = database(t);
  seedOpportunity(store);
  const message = store.addMessage(workspace, 'o1', {
    message_id: 'f09-message', idempotency_key: 'f09-message', role: 'customer',
    text: '我想先了解一下。', status: 'received', source: 'simulation'
  }).message;
  const context = buildContext(store, workspace, 'o1');
  const draft = store.saveDraft(workspace, 'o1', message.message_id, 1, {
    schema_version: 'sales-assist.v1', status: 'draft_ready', draft: '您好，请问您想给谁买？', review_required: true
  }, context);
  const finalText = '您好呀，您这次主要想为哪位家人做准备？';
  const confirmed = store.confirmDraft(workspace, draft.draft_id, {
    expected_revision: draft.revision,
    idempotency_key: 'f09-confirm',
    final_text: finalText,
    delivery_mode: 'simulation',
    editor_id: 'fixture-sales',
    editor_role: 'sales'
  }).draft;
  assert.equal(confirmed.final_text, finalText);
  assert.equal(confirmed.edit_record.original_text, '您好，请问您想给谁买？');
  assert.equal(confirmed.edit_record.final_text, finalText);
  assert.equal(confirmed.edit_record.changed, true);
  const sent = store.listMessages(workspace, 'o1').find(item => item.role === 'sales');
  assert.equal(sent.text, finalText);
  assert.notEqual(sent.text, confirmed.edit_record.original_text);
});

test('[H08] 语音转写只产生待人工核对候选，不直接写入客户事实', async t => {
  const store = database(t);
  seedOpportunity(store);
  const api = apiFor(store, {
    mediaTranscriptionConfigured: true,
    transcribeMedia: async () => ({
      status: 'review_required',
      transcript: '给妈妈买，她58岁，每年预算2万元；年龄段转写不确定。',
      needs_human_review: true,
      confidence: 0.62,
      review_hints: ['核对人物归属', '核对金额、年龄和日期']
    })
  });
  const result = await api('/api/v2/opportunities/o1/media-transcriptions', {
    body: { filename: 'h08.wav', mime_type: 'audio/wav', data_base64: 'UklGRg==' }
  });
  assert.equal(result.status, 201);
  assert.equal(result.payload.data.status, 'review_required');
  assert.equal(result.payload.data.needs_human_review, true);
  assert.match(result.payload.data.review_hints.join('、'), /人物归属|年龄/);
  assert.equal(store.getCustomer(workspace, 'c1').facts.length, 0);
});

test('[C07] 已购养老机会不会屏蔽新建的孩子教育需求', t => {
  const store = database(t);
  seedOpportunity(store, {
    opportunityId: 'c07-purchased-retirement', purpose: '养老', purchased: true,
    policyContractVersion: 'evaluation-policy-v1'
  });
  store.addMessage(workspace, 'c07-purchased-retirement', {
    message_id: 'c07-purchased-message', idempotency_key: 'c07-purchased-message', role: 'customer',
    text: '我之前已经买过养老保险。', status: 'received', source: 'simulation'
  });
  store.addOpportunity(workspace, 'c1', {
    opportunity_id: 'c07-current-education', purpose: '孩子教育', environment: 'simulation'
  });
  store.addMessage(workspace, 'c07-current-education', {
    message_id: 'c07-new-need', idempotency_key: 'c07-new-need', role: 'customer',
    text: '我还想给孩子准备一份教育金。', status: 'received', source: 'simulation'
  });
  const customer = store.getCustomer(workspace, 'c1');
  const purchased = buildContext(store, workspace, 'c07-purchased-retirement');
  const education = buildContext(store, workspace, 'c07-current-education');
  assert.equal(customer.opportunities.length, 2);
  assert.equal(purchased.contact_state.purchased_for_opportunity, true);
  assert.equal(purchased.customer_state.processing_status, 'purchased_service');
  assert.equal(education.contact_state.purchased_for_opportunity, false);
  assert.equal(education.need_profile.purpose, '孩子教育');
  assert.equal(classifyConversationTurn(education), 'intake');
});

test('[H10] 已购养老需求与新教育需求使用两条独立机会记录', t => {
  const store = database(t);
  seedOpportunity(store, { purpose: '本人养老', purchased: true, policyContractVersion: 'policy-v1' });
  store.addMessage(workspace, 'o1', {
    message_id: 'h10-policy-query', idempotency_key: 'h10-policy-query', role: 'customer',
    text: '我之前已经买过养老产品，现在想查一下保单。', status: 'received', source: 'simulation'
  });
  const child = store.addPerson(workspace, 'c1', { person_id: 'child-1', relationship: 'child', name: '孩子' });
  store.addOpportunity(workspace, 'c1', {
    opportunity_id: 'o-education', person_id: child.person_id, purpose: '孩子教育', environment: 'simulation'
  });
  const purchasedContext = buildContext(store, workspace, 'o1');
  store.addMessage(workspace, 'o-education', {
    message_id: 'h10-new-need', idempotency_key: 'h10-new-need', role: 'customer',
    text: '另外我还想给孩子准备教育金。', status: 'received', source: 'simulation'
  });
  const educationContext = buildContext(store, workspace, 'o-education');
  assert.equal(purchasedContext.contact_state.purchased_for_opportunity, true);
  assert.equal(educationContext.contact_state.purchased_for_opportunity, false);
  assert.equal(educationContext.need_profile.purpose, '孩子教育');
  assert.equal(classifyConversationTurn(educationContext), 'intake');
  assert.equal(store.getCustomer(workspace, 'c1').opportunities.length, 2);
});

test('[H11] 人工终稿生效后，旧AI草稿遇到新消息必须失效', t => {
  const store = database(t);
  seedOpportunity(store, { purpose: '养老' });
  const first = store.addMessage(workspace, 'o1', {
    message_id: 'h11-first', idempotency_key: 'h11-first', role: 'customer', text: '我想了解养老。', status: 'received', source: 'simulation'
  }).message;
  const context = buildContext(store, workspace, 'o1');
  const draft = store.saveDraft(workspace, 'o1', first.message_id, 1, {
    schema_version: 'sales-assist.v1', status: 'draft_ready', draft: 'AI原草稿', review_required: true
  }, context);
  const confirmed = store.confirmDraft(workspace, draft.draft_id, {
    expected_revision: 1, idempotency_key: 'h11-confirm', final_text: '销售人工核对后的终稿',
    delivery_mode: 'simulation', editor_id: 'champion-1', editor_role: 'champion'
  });
  assert.equal(confirmed.draft.final_text, '销售人工核对后的终稿');
  store.addMessage(workspace, 'o1', {
    message_id: 'h11-next', idempotency_key: 'h11-next', role: 'customer', text: '每年2万元怎么安排？', status: 'received', source: 'simulation'
  });
  const stale = store.getDraft(workspace, draft.draft_id);
  const nextContext = buildContext(store, workspace, 'o1');
  assert.notEqual(stale.context_versions.latest_conversation_message_id, nextContext.context_versions.latest_conversation_message_id);
  assert.throws(() => store.confirmDraft(workspace, draft.draft_id, {
    expected_revision: stale.revision, idempotency_key: 'h11-reconfirm', final_text: '不应再次发送', delivery_mode: 'simulation'
  }));
});

test('[H12] 产品规则、RAG和人工审核未统一时锁定AI，统一后才能恢复', t => {
  const store = database(t);
  const safety = createKnowledgeSafetyService({ store, now: fixedNow });
  safety.upsertRelease(workspace, {
    product_id: 'p1', version_id: 'v2', environment: 'simulation',
    rules_status: 'ready', rag_status: 'pending', review_status: 'pending'
  });
  assert.equal(safety.status(workspace).locked, true);
  assert.throws(() => safety.assertAiAllowed(workspace), error => error.code === 'AI_KNOWLEDGE_SAFETY_LOCKED');
  safety.upsertRelease(workspace, {
    product_id: 'p1', version_id: 'v2', environment: 'simulation',
    rules_status: 'ready', rag_status: 'ready', review_status: 'approved'
  });
  assert.equal(safety.status(workspace).locked, false);
  assert.equal(safety.assertAiAllowed(workspace).state, 'ready');
});

test('[H13] 单客户AI成本达到70%预警，达到100%停止调用', t => {
  const store = database(t);
  seedOpportunity(store);
  store.addMessage(workspace, 'o1', {
    message_id: 'h13-existing', idempotency_key: 'h13-existing', role: 'customer',
    text: '我们已经聊了很久，请继续帮我测算。', status: 'received', source: 'simulation'
  });
  const messagesBefore = store.listMessages(workspace, 'o1').length;
  const budget = createAiBudgetService({ store, now: fixedNow, limitCny: 10 });
  budget.record({ workspace_id: workspace, customer_id: 'c1', opportunity_id: 'o1', workflow: 'A', idempotency_key: 'h13-70', payload: { usage: { output_tokens: 875_000 } } });
  const warning = budget.status(workspace, 'c1');
  assert.equal(warning.state, 'warning');
  assert.equal(warning.used_percent, 70);
  assert.equal(warning.ai_mode, 'essential_only');
  assert.throws(() => budget.assertNonessentialAvailable(workspace, 'c1'), error => error.code === 'AI_BUDGET_ESSENTIAL_ONLY');
  assert.equal(budget.assertAvailable(workspace, 'c1').state, 'warning');
  budget.record({ workspace_id: workspace, customer_id: 'c1', opportunity_id: 'o1', workflow: 'A', idempotency_key: 'h13-100', payload: { usage: { output_tokens: 375_000 } } });
  const stopped = budget.status(workspace, 'c1');
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.ai_mode, 'human_only');
  assert.throws(() => budget.assertAvailable(workspace, 'c1'), error => error.code === 'AI_BUDGET_EXHAUSTED');
  const handoff = store.listTasks(workspace, { status: 'open' }).find(item => item.idempotency_key === 'ai-budget-handoff:c1');
  assert.equal(handoff.owner, 'sales');
  assert.equal(handoff.opportunity_id, 'o1');
  assert.equal(store.listMessages(workspace, 'o1').length, messagesBefore);
  reportFixtureEvidence('H13', {
    title: '单客户AI费用阈值与人工接管', coverage_complete: true,
    steps: [
      '预置1条已有客户对话，并记录当前对话条数。',
      '累计AI费用写入到7元，分别尝试必要调用和非必要分析。',
      '继续累计到10元，再尝试AI调用并检查销售待办。'
    ],
    checks: [
      { label: '7元预警', expected: '进入预警并减少非必要分析', actual: `state=${warning.state}，used=${warning.used_cny}元，mode=${warning.ai_mode}；非必要分析被拒绝，必要调用仍允许`, passed: true },
      { label: '10元停止', expected: '停止AI调用并转人工', actual: `state=${stopped.state}，mode=${stopped.ai_mode}；AI调用返回AI_BUDGET_EXHAUSTED；已生成销售待办“${handoff.title}”`, passed: true },
      { label: '对话保留', expected: '已有对话不丢失', actual: `执行前后均为${messagesBefore}条，对话内容未删除`, passed: true }
    ]
  });
});

test('[H14] Dify不可用时禁止产品回答，恢复后才允许重新生成', async t => {
  const store = database(t);
  seedOpportunity(store);
  const unavailableApi = apiFor(store, { salesAssist: runSalesAssist, aiConfigured: false });
  const first = store.addMessage(workspace, 'o1', {
    message_id: 'h14-first', idempotency_key: 'h14-first', role: 'customer', text: '这款产品每年交2万元能领多少？', status: 'received', source: 'simulation'
  }).message;
  const blocked = await unavailableApi('/api/v2/opportunities/o1/drafts', {
    body: { latest_message_id: first.message_id, expected_revision: 1 }
  });
  assert.equal(blocked.status, 503);
  assert.equal(blocked.payload.error.code, 'AI_NOT_CONFIGURED');

  const recoveredApi = apiFor(store, {
    aiConfigured: true,
    salesAssist: async context => ({
      schema_version: 'sales-assist.v1', status: 'draft_ready',
      draft: '服务恢复后重新生成；个人金额仍需正式计划书确认。', review_required: true,
      context_versions: context.context_versions, citations: [], risk_flags: [], missing_evidence: []
    })
  });
  const second = store.addMessage(workspace, 'o1', {
    message_id: 'h14-second', idempotency_key: 'h14-second', role: 'customer', text: '服务恢复后请重新核对。', status: 'received', source: 'simulation'
  }).message;
  const recovered = await recoveredApi('/api/v2/opportunities/o1/drafts', {
    body: { latest_message_id: second.message_id, expected_revision: 1 }
  });
  assert.equal(recovered.status, 201);
  assert.match(recovered.payload.data.draft, /正式计划书/);
});

test('[H15] 销冠改稿且30天内成交后进入待审池，人工批准后才成为经验', t => {
  const store = database(t);
  seedOpportunity(store);
  const at = fixedNow().toISOString();
  store.raw.prepare(`INSERT INTO drafts(workspace_id,draft_id,opportunity_id,latest_message_id,context_versions,content,ai_result,status,revision,stale,final_text,delivery_mode,confirmation_key,edit_record,product_scope,editor_id,editor_role,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,1,0,?,?,?,?,?,?,?,?,?)`).run(
    workspace, 'h15-draft', 'o1', 'h15-message', '{}', 'AI原稿', '{}', 'simulated_sent',
    '销冠修改后的回复', 'simulation', 'h15-confirm', JSON.stringify({ original_text: 'AI原稿', final_text: '销冠修改后的回复', changed: true }),
    JSON.stringify({ environment: 'simulation', product_id: 'p1', product_version: 'v1' }), 'champion-1', 'champion', at, at
  );
  const salesOps = createSalesOps({ store, now: fixedNow });
  const captured = salesOps.captureChampionCandidates(workspace, 'o1', { purchased_at: at });
  assert.equal(captured.candidate_count, 1);
  assert.equal(captured.candidates[0].approval_status, 'pending');
  assert.equal(salesOps.listApprovedExperiences(workspace).length, 0);
  const review = captured.candidates[0];
  assert.match(review.ai_suggested_reason, /需销冠确认/);
  const validated = salesOps.patchReview(workspace, review.review_id, {
    expected_revision: review.revision, idempotency_key: 'h15-approve',
    changes: {
      human_reason: '先确认客户当前最关心的问题，再给出下一步。',
      approved_content: '先回应当前问题，并一次只追问一个必要信息。联系电话13800000000',
      validation_status: 'passed', validation_note: '在3个模拟新咨询中验证，均未出现越权承诺或连续追问。',
      validated_by: 'fixture-validator'
    }
  });
  assert.equal(validated.review.approval_status, 'pending');
  assert.equal(validated.review.validation_status, 'passed');
  assert.match(validated.review.approved_content, /\[手机号已脱敏\]/);
  assert.equal(salesOps.listApprovedExperiences(workspace).length, 0);
  const approved = salesOps.patchReview(workspace, review.review_id, {
    expected_revision: validated.review.revision, idempotency_key: 'h15-final-approve',
    changes: { approval_status: 'approved', reviewer: 'fixture-reviewer' }
  });
  assert.equal(approved.review.approval_status, 'approved');
  assert.equal(salesOps.listApprovedExperiences(workspace, { environment: 'simulation' }).length, 1);
  const experience = salesOps.listApprovedExperiences(workspace, { environment: 'simulation' })[0];
  reportFixtureEvidence('H15', {
    title: '销冠改稿经验入库闭环', coverage_complete: true,
    steps: [
      '预置销冠对AI原稿的真实改稿，并记录客户在30天内成交。',
      '系统生成候选经验与AI原因候选；此时正式经验库仍为空。',
      '复盘人员填写人工原因和经验内容，系统自动脱敏手机号。',
      '记录3个模拟咨询的小范围验证结果，最后由审核人批准入库。'
    ],
    checks: [
      { label: '候选生成', expected: '30天内成交后进入候选池，AI提出原因候选', actual: `候选数=${captured.candidate_count}；状态=${review.approval_status}；AI原因=${review.ai_suggested_reason}`, passed: true },
      { label: '未批准不入库', expected: '人工确认前不能进入正式库', actual: '候选生成后正式经验数=0；完成小范围验证后仍为0', passed: true },
      { label: '脱敏与验证', expected: '脱敏并完成小范围验证', actual: `手机号已替换为[手机号已脱敏]；验证状态=${validated.review.validation_status}；验证人=${validated.review.validated_by}`, passed: true },
      { label: '最终入库', expected: '销售复盘确认后进入正式经验库', actual: `审批状态=${approved.review.approval_status}；正式经验版本=${experience.version}`, passed: true }
    ]
  });
});

test('[H16] 跨月新信息替代旧摘要，旧草稿与旧版本上下文同时失效', t => {
  const store = database(t);
  seedOpportunity(store, { purpose: '养老' });
  const oldMessage = store.addMessage(workspace, 'o1', {
    message_id: 'h16-aug', idempotency_key: 'h16-aug', role: 'customer', text: '预算3万，担心中途用钱。',
    status: 'received', source: 'simulation', occurred_at: '2026-08-01T00:00:00.000Z'
  }).message;
  store.addSummary(workspace, 'o1', {
    expected_revision: 1, idempotency_key: 'h16-summary-old', text: '预算3万，流动性顾虑未解决。',
    through_message_id: oldMessage.message_id, evidence_message_ids: [oldMessage.message_id], open_objections: ['liquidity'], status: 'confirmed'
  });
  const newMessage = store.addMessage(workspace, 'o1', {
    message_id: 'h16-sep', idempotency_key: 'h16-sep', role: 'customer', text: '现在预算1万，流动性问题已经解决。',
    status: 'received', source: 'simulation', occurred_at: '2026-09-29T00:00:00.000Z'
  }).message;
  const before = buildContext(store, workspace, 'o1');
  const oldDraft = store.saveDraft(workspace, 'o1', newMessage.message_id, before.context_versions.opportunity_revision, {
    schema_version: 'sales-assist.v1', status: 'draft_ready', draft: '按旧版本继续', review_required: true
  }, buildContext(store, workspace, 'o1'));
  store.addSummary(workspace, 'o1', {
    expected_revision: 2, idempotency_key: 'h16-summary-new', text: '预算改为1万，旧流动性顾虑已解决。',
    through_message_id: newMessage.message_id, evidence_message_ids: [oldMessage.message_id, newMessage.message_id], open_objections: [], status: 'confirmed'
  });
  const context = buildContext(store, workspace, 'o1');
  assert.match(context.long_term_summary.text, /预算改为1万/);
  assert.deepEqual(context.open_objections, []);
  assert.equal(store.getDraft(workspace, oldDraft.draft_id).stale, true);
});

test('[H19] 文字、OCR和ASR金额冲突时不自动确认预算', t => {
  const store = database(t);
  seedOpportunity(store, { purpose: '养老' });
  const evidence = [
    ['h19-text', '文字：每年预算2万元', 'manual', 20_000],
    ['h19-ocr', '图片识别：每年预算3万元', 'media_transcription', 30_000],
    ['h19-asr', '语音转写：每年预算5万元', 'media_transcription', 50_000]
  ];
  for (const [id, text, source, value] of evidence) {
    const message = store.addMessage(workspace, 'o1', {
      message_id: id, idempotency_key: id, role: 'customer', text, status: 'received', source
    }).message;
    const customer = store.getCustomer(workspace, 'c1');
    store.patchCustomer(workspace, 'c1', customer.revision, {
      fact_changes: [{ idempotency_key: `fact-${id}`, field: 'budget_amount', value, opportunity_id: 'o1', evidence_message_ids: [message.message_id], source: 'message', status: 'confirmed' }]
    });
  }
  const customer = store.getCustomer(workspace, 'c1');
  const budgets = customer.facts.filter(fact => fact.field === 'budget_amount');
  assert.equal(budgets.length, 3);
  assert.ok(budgets.every(fact => fact.status === 'conflicted'));
  assert.equal(buildContext(store, workspace, 'o1').confirmed_facts.some(fact => fact.field === 'budget_amount'), false);
  const task = store.listTasks(workspace, { status: 'open' }).find(item => item.opportunity_id === 'o1' && item.title === '核对冲突客户资料');
  assert.ok(task);
  assert.match(task.reason, /20000、30000、50000/);
  assert.equal(store.getCustomer(workspace, 'c1').opportunities[0].processing_status, 'waiting_sales_review');
});

test('[H20] 开场到成交后服务与经验候选沿唯一旅程闭环', async t => {
  const store = database(t);
  const readJson = async req => req.body;
  const sendJson = (res, status, payload) => { res.status = status; res.payload = payload; };
  const productMatch = createBackendB2({
    store, readJson, sendJson, now: fixedNow, allowSimulationProducts: true,
    runMatchDify: async ({ inputs }) => {
      const rules = JSON.parse(inputs.rules_json);
      return { workflow_run_id: 'h20-product-match', data: { status: 'succeeded', outputs: {
        match_result_json: JSON.stringify({
          status: 'ready', provider: 'h20-explicit-test-double', candidates: rules.map(candidate => ({
            candidate_id: candidate.candidate_id,
            explanation: '客户画像满足该演练产品的已审核规则，仍须销售人工确认。',
            citation_ids: candidate.citations.map(item => item.citation_id), case_ids: []
          }))
        })
      } } };
    }
  });
  productMatch.products.putProduct(workspace, {
    product_id: 'h20-retirement', product_version: 'fixture-v1', name: 'H20养老流程演练产品',
    environment: 'simulation', catalog_status: 'active', valid_from: '2026-01-01', valid_to: '2027-12-31',
    approval_status: 'approved', reviewer: 'H20演练审核人', approval_source: 'H20全旅程状态夹具',
    source_kind: 'simulation_fixture',
    source_refs: [{ source_id: 'h20-rules', title: 'H20养老演练规则', version: 'fixture-v1', section: '适用条件' }],
    rules: {
      purpose_codes: ['retirement'], insured_age: { min: 18, max: 60 },
      annual_budget: { min: 10_000, max: 50_000, currency: 'CNY' },
      funds_usage_years: { min: 10 }, payment_years: [3]
    },
    idempotency_key: 'h20-product'
  });

  store.createCustomer(workspace, { customer_id: 'c1', name: 'H20演练客户' });
  store.addPerson(workspace, 'c1', { person_id: 'h20-self', relationship: 'self', name: '客户本人', age: 38 });
  store.addOpportunity(workspace, 'c1', {
    opportunity_id: 'o1', person_ids: ['h20-self'], purpose: '养老', budget_amount: 30_000,
    budget_currency: 'CNY', environment: 'simulation'
  });
  const opening = store.addMessage(workspace, 'o1', {
    message_id: 'h20-opening', idempotency_key: 'h20-opening', role: 'customer',
    text: '我是看视频加的微信，想给自己准备养老，今年38岁，每年预算3万元，这笔钱10年内不用。',
    status: 'received', source: 'simulation'
  }).message;

  const memoryProposal = await proposeMemory(buildContext(store, workspace, 'o1'), { runDify: insufficientMemory });
  assert.equal(memoryProposal.status, 'proposed');
  assert.equal(memoryProposal.facts.find(item => item.field === 'purpose_code')?.value, 'retirement');
  assert.equal(memoryProposal.facts.find(item => item.field === 'annual_budget_amount')?.value, 30_000);
  assert.equal(memoryProposal.facts.find(item => item.field === 'funds_usage_years')?.value, 10);
  let customer = store.getCustomer(workspace, 'c1');
  store.patchCustomer(workspace, 'c1', customer.revision, { fact_changes: [
    { idempotency_key: 'h20-age', field: 'age', value: 38, person_id: 'h20-self', opportunity_id: 'o1', evidence_message_ids: [opening.message_id], source: 'human', status: 'confirmed' },
    { idempotency_key: 'h20-usage', field: 'funds_usage_years', value: 10, opportunity_id: 'o1', evidence_message_ids: [opening.message_id], source: 'human', status: 'confirmed' }
  ] });
  store.recordOpportunityIntent(workspace, 'o1', {
    level: 'high', score: 85, reason: '客户确认开始产品匹配', evidence_message_ids: [opening.message_id],
    source: 'h20_fixture', recommended_action: 'human_close'
  });
  let context = buildContext(store, workspace, 'o1');
  assert.equal(context.need_profile.budget_amount, 30_000);
  assert.equal(context.confirmed_facts.find(item => item.field === 'age')?.value, 38);
  assert.equal(store.getCustomer(workspace, 'c1').opportunities[0].intent_level, 'high');

  const recommendation = await productMatch.recommendations.generate(workspace, 'o1', {
    expected_revision: context.context_versions.opportunity_revision,
    latest_message_id: context.latest_message_id,
    idempotency_key: 'h20-generate'
  });
  const candidate = recommendation.result.candidates.find(item => item.status === 'eligible_for_discussion');
  assert.ok(candidate);
  const accepted = productMatch.recommendations.decide(workspace, recommendation.recommendation_id, 'accept', {
    expected_revision: recommendation.revision, idempotency_key: 'h20-accept', reviewer: 'H20销售',
    candidate_id: candidate.candidate_id, selected_payment_years: 3
  });
  assert.equal(accepted.status, 'accepted');

  const productDocument = {
    document_id: 'h20-terms', version: 'fixture-v1', title: 'H20养老演练条款', knowledge_type: 'product',
    product_id: 'h20-retirement', product_version: 'fixture-v1', policy_contract_versions: [],
    scopes: ['new_consultation'], lifecycle_status: 'active', index_status: 'ready',
    verification_status: 'business_verified', customer_use: 'approved', valid_from: '2026-01-01', valid_to: null,
    source: { publisher: 'H20演练资料', label: 'H20养老演练条款', url: 'https://example.invalid/h20-terms', retrieved_at: '2026-09-29' },
    topics: ['payment_term'], chunks: [{ location: '交费期间', keywords: ['交费', '几年交', '3年交'], text: '该演练产品支持3年交。' }]
  };
  const serviceDocument = {
    document_id: 'h20-contract', version: 'contract-v1', title: 'H20演练保单服务说明', knowledge_type: 'product',
    product_id: 'h20-retirement', product_version: 'contract-v1', policy_contract_versions: ['contract-v1'],
    scopes: ['contract_service'], lifecycle_status: 'archived_serviceable', index_status: 'ready',
    verification_status: 'business_verified', customer_use: 'approved', valid_from: '2026-01-01', valid_to: null,
    source: { publisher: 'H20演练资料', label: 'H20演练保单服务说明', url: 'https://example.invalid/h20-contract', retrieved_at: '2026-09-29' },
    topics: ['contract_service'], chunks: [{ location: '保单查询', keywords: ['保单', '查询'], text: '先核验身份和保单归属，再通过公司授权渠道查询。' }]
  };
  let retrievalCount = 0;
  const h20SalesAssist = salesContext => runSalesAssist(salesContext, {
    now: fixedNow, allowSimulationKnowledge: true,
    retrieveKnowledge: request => {
      retrievalCount += 1;
      return retrieveKnowledge(request, { documents: [productDocument, serviceDocument], now: fixedNow, allowSimulationKnowledge: true });
    },
    runDify: async payload => {
      const evidence = JSON.parse(payload.inputs.knowledge_json);
      const service = payload.inputs.interaction_type === 'contract_service';
      return { workflow_run_id: service ? 'h20-service-answer' : 'h20-product-answer', outputs: {
        draft_result_json: JSON.stringify({
          status: 'draft_ready',
          draft: service
            ? '查询保单前需要先核验您的身份和保单归属，再通过公司授权渠道查询。'
            : '这款演练产品支持3年交，具体方案仍以销售核对后的正式资料为准。',
          citation_ids: [evidence[0].citation_id], next_question: null, next_action: 'sales_review',
          risk_flags: [], missing_evidence: [], provider: 'h20-explicit-test-double'
        })
      } };
    }
  });
  const salesOps = createSalesOps({ store, now: fixedNow });
  const api = apiFor(store, {
    aiConfigured: true, salesAssist: h20SalesAssist,
    prepareSalesContext: value => productMatch.prepareSalesContext(value),
    validateSalesContext: value => productMatch.validateSalesContext(value),
    validateDraft: row => productMatch.validateDraft(row),
    onOpportunityPurchased: ({ workspaceId, opportunityId, purchasedAt }) =>
      salesOps.captureChampionCandidates(workspaceId, opportunityId, { purchased_at: purchasedAt })
  });

  const productQuestion = store.addMessage(workspace, 'o1', {
    message_id: 'h20-product-question', idempotency_key: 'h20-product-question', role: 'customer',
    text: '这款产品可以选择几年交？', status: 'received', source: 'simulation'
  }).message;
  context = buildContext(store, workspace, 'o1');
  const draftResponse = await api('/api/v2/opportunities/o1/drafts', { body: {
    expected_revision: context.context_versions.opportunity_revision, latest_message_id: productQuestion.message_id
  } });
  assert.equal(draftResponse.status, 201, JSON.stringify(draftResponse.payload));
  const draft = store.getDraft(workspace, draftResponse.payload.data.draft_id);
  assert.equal(draft.ai_result.product_match_reference.recommendation_id, recommendation.recommendation_id);
  assert.equal(draft.ai_result.citations[0].document_id, 'h20-terms');
  const finalText = '这款产品支持3年交。我已结合您每年3万元预算和养老目标核对过，下一步为您整理正式方案，可以吗？';
  const confirmed = await api(`/api/v2/drafts/${draft.draft_id}/confirm`, { body: {
    expected_revision: draft.revision, idempotency_key: 'h20-confirm-draft', delivery_mode: 'simulation',
    final_text: finalText, editor_id: 'h20-champion', editor_role: 'champion'
  } });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.payload));
  const followUp = store.createTask(workspace, {
    task_id: 'h20-follow-up', customer_id: 'c1', opportunity_id: 'o1', owner: 'H20销售',
    title: '跟进正式养老方案', reason: '客户已确认产品方向，待跟进正式方案', status: 'open',
    due_at: '2026-10-01T02:00:00.000Z', idempotency_key: 'h20-follow-up'
  }).task;
  assert.equal(followUp.status, 'open');

  let beforePurchase = store.getCustomer(workspace, 'c1').opportunities[0];
  const purchase = await api('/api/v2/opportunities/o1', { method: 'PATCH', body: {
    expected_revision: beforePurchase.revision,
    changes: { purchased: true, policy_contract_version: 'contract-v1' }
  } });
  assert.equal(purchase.status, 200, JSON.stringify(purchase.payload));
  const opportunity = store.getCustomer(workspace, 'c1').opportunities[0];
  assert.equal(opportunity.sales_stage, 'won');
  assert.equal(opportunity.processing_status, 'purchased_service');
  const candidates = salesOps.listReviews(workspace, { approval_status: 'pending' }).items;
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].draft_id, draft.draft_id);
  assert.equal(salesOps.listApprovedExperiences(workspace).length, 0);

  await assert.rejects(() => productMatch.recommendations.generate(workspace, 'o1', {
    expected_revision: opportunity.revision, latest_message_id: productQuestion.message_id,
    idempotency_key: 'h20-illegal-rematch'
  }), error => error?.code === 'PURCHASED_OPPORTUNITY');

  const serviceMessage = store.addMessage(workspace, 'o1', {
    message_id: 'h20-service', idempotency_key: 'h20-service', role: 'customer',
    text: '以后我要怎么查询这张保单？', status: 'received', source: 'simulation'
  }).message;
  context = buildContext(store, workspace, 'o1');
  assert.equal(context.contact_state.purchased_for_opportunity, true);
  assert.equal(classifyConversationTurn(context), 'service');
  const serviceResponse = await api('/api/v2/opportunities/o1/drafts', { body: {
    expected_revision: context.context_versions.opportunity_revision, latest_message_id: serviceMessage.message_id
  } });
  assert.equal(serviceResponse.status, 201, JSON.stringify(serviceResponse.payload));
  assert.equal(store.getDraft(workspace, serviceResponse.payload.data.draft_id).ai_result.interaction_type, 'contract_service');
  assert.equal(serviceResponse.payload.data.citations[0].document_id, 'h20-contract');
  assert.match(serviceResponse.payload.data.draft, /公司授权渠道/);
  assert.equal(retrievalCount, 2);

  reportFixtureEvidence('H20', {
    title: '从开场到成交后服务的完整旅程', coverage_complete: true,
    steps: [
      '客户从视频加微信，说明本人养老、38岁、年预算3万元和10年资金期限。',
      'B1提取画像并由人工确认必要事实，意向升为高意向。',
      'B2按已审核规则生成候选，销售人工确认产品与3年交。',
      'RAG检索对应产品版本，A生成有引用草稿；销冠改稿后人工确认发送。',
      '建立正式方案跟进任务，成交核验后转入已购服务并锁住再次营销匹配。',
      '保单查询只使用绑定合同版本；销冠改稿进入待审经验候选，未批准前不进正式库。'
    ],
    checks: [
      { label: '开场与B1画像', expected: '来源、本人养老、年龄、预算、资金期限可追溯', actual: `原话=${opening.text}；B1提取养老、年预算30000元、10年；确认年龄38岁`, passed: true },
      { label: '意向', expected: '客户确认后进入高意向', actual: '意向=high（85分），阶段=solution_discussion', passed: true },
      { label: 'B2人工确认', expected: '规则匹配后由销售确认产品和交费期', actual: `匹配结果=${recommendation.result.status}；确认状态=${accepted.status}；确认产品=${accepted.selection.product_id}@${accepted.selection.product_version}；交费期=${accepted.selection.selected_payment_years}年`, passed: true },
      { label: 'RAG与A草稿', expected: '引用已核验的对应产品版本', actual: `引用=${draft.ai_result.citations[0].document_id}#${draft.ai_result.citations[0].location}；AI原稿=${draft.content}`, passed: true },
      { label: '人工确认与跟进', expected: '销售可修改并确认，对后续方案建立跟进', actual: `销冠终稿=${finalText}；草稿状态=${confirmed.payload.data.status}；跟进任务=${followUp.title}`, passed: true },
      { label: '成交与已购保护', expected: '转入已购服务，禁止原需求再次产品匹配', actual: `sales_stage=${opportunity.sales_stage}；processing_status=${opportunity.processing_status}；再次匹配被PURCHASED_OPPORTUNITY拒绝`, passed: true },
      { label: '保单服务', expected: '按绑定合同版本回答保单查询', actual: `路由=service；引用=${serviceResponse.payload.data.citations[0].document_id}@contract-v1；回复=${serviceResponse.payload.data.draft}`, passed: true },
      { label: '经验候选', expected: '销冠改稿进入待审池，未批准不进入正式库', actual: `候选数=${candidates.length}；审批状态=${candidates[0].approval_status}；正式经验数=0`, passed: true }
    ]
  });
});
