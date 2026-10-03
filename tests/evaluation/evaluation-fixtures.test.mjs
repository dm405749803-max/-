import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createEvaluationFixtureOrchestrator, resolveEvaluationFixturePlan } from '../../server/evaluation-fixtures.mjs';

test('fixture plan is derived from execution support and setup meaning, not case id', () => {
  const first = resolveEvaluationFixturePlan({
    case_id: 'arbitrary-case', execution_support: 'fixture_required',
    setup_instructions: '需要预置同一客户此前的孩子教育购买需求和已确认长期摘要。'
  });
  assert.deepEqual(first.setup_types, ['historical_memory']);
  assert.deepEqual(first.unsupported_setup_types, ['historical_memory']);

  const second = resolveEvaluationFixturePlan({
    case_id: 'another-case', execution_support: 'fixture_required',
    setup_instructions: '需要媒体转写候选、置信度和销售已检查操作夹具。'
  });
  assert.deepEqual(second.setup_types, ['media_review']);
  assert.deepEqual(second.unsupported_setup_types, ['media_review']);
});

test('explicit fixture contract is primary and preserves executor lifecycle fields', () => {
  const plan = resolveEvaluationFixturePlan({
    case_id: 'Z96', execution_support: 'fixture_required', fixture_type: 'draft_lifecycle',
    setup: {
      schema_version: 'evaluation-fixture.v1', fixture_type: 'draft_lifecycle', executor: 'state_fixture',
      preconditions: ['persisted_ai_draft'], actions: ['apply_sales_editor_action'], observations: ['visible_draft']
    },
    setup_instructions: '需要预置AI草稿。'
  });
  assert.equal(plan.fixture_type, 'draft_lifecycle');
  assert.equal(plan.setup.executor, 'state_fixture');
  assert.deepEqual(plan.setup.actions, ['apply_sales_editor_action']);
  assert.equal(plan.setup_types[0], 'draft_lifecycle');
});

test('explicit fixture setup type overrides the need for case-number routing', () => {
  const plan = resolveEvaluationFixturePlan({
    case_id: 'Z99', execution_support: 'fixture_required', fixture_setup: ['purchased_state']
  });
  assert.deepEqual(plan.setup_types, ['purchased_state']);
});

test('every fixture-required dataset row resolves to at least one semantic setup type', async () => {
  const dataset = JSON.parse(await readFile(new URL('../../evaluation/sales-v1.3-cases.json', import.meta.url), 'utf8'));
  const unresolved = dataset.cases.filter(item => item.execution_support === 'fixture_required').filter(item => {
    const plan = resolveEvaluationFixturePlan({
      execution_support: item.execution_support,
      fixture_type: item.fixture_type,
      setup: item.setup,
      setup_instructions: item.setup_instructions,
      customer_input: item.suggested_input
    });
    return plan.setup_types.length === 0;
  });
  assert.deepEqual(unresolved.map(item => item.id), []);
});

test('all fixture-required rows expose the versioned setup contract', async () => {
  const dataset = JSON.parse(await readFile(new URL('../../evaluation/sales-v1.3-cases.json', import.meta.url), 'utf8'));
  const invalid = dataset.cases.filter(item => item.execution_support === 'fixture_required').filter(item =>
    !item.fixture_type || item.setup?.schema_version !== 'evaluation-fixture.v1'
      || item.setup.fixture_type !== item.fixture_type || !item.setup.executor
      || !Array.isArray(item.setup.preconditions) || !Array.isArray(item.setup.actions)
      || !Array.isArray(item.setup.observations));
  assert.deepEqual(invalid.map(item => item.id), []);
});

test('customer correction requests a generic profile-change approval action', () => {
  const plan = resolveEvaluationFixturePlan({
    case_id: 'Z98', execution_support: 'conversation_executable',
    customer_input: '刚才说错了，其实这次是给妈妈买。'
  });
  assert.equal(plan.needs_profile_change_approval, true);
});

test('orchestrator interprets a declarative resource graph without case-specific routing', async () => {
  const calls = [];
  const request = async (path, options = {}) => {
    calls.push({ path, options });
    if (path.endsWith('/messages')) return { data: { message_id: 'history-message' } };
    return { data: {} };
  };
  const createRun = createEvaluationFixtureOrchestrator({ request });
  const run = createRun({
    execution_support: 'fixture_required',
    fixture_type: 'memory_history',
    setup: {
      schema_version: 'evaluation-fixture.v1', fixture_type: 'memory_history', executor: 'state_fixture',
      preconditions: ['persisted_customer_history'], actions: ['resume_customer_conversation'], observations: ['memory_recall'],
      parameters: { resources: [
        { key: 'history', type: 'opportunity', payload: { purpose: '孩子教育', environment: 'simulation' } },
        { key: 'message', type: 'message', parent_ref: 'history', payload: { role: 'customer', text: '历史消息', status: 'received', source: 'simulation', environment: 'simulation' } },
        { key: 'summary', type: 'summary', parent_ref: 'history', payload: { text: '历史摘要', status: 'confirmed' }, references: { through_message: 'message', evidence_messages: ['message'] } },
        { key: 'purchased', type: 'opportunity', payload: { purpose: '养老', purchased: true, environment: 'simulation' } }
      ] }
    }
  }, { headers: {}, opportunityId: 'current-opportunity' });
  await run.afterCustomerCreated({
    customerId: 'customer-1', opportunityId: 'current-opportunity', runId: 'run-1', suffix: 'suffix-1'
  });
  assert.ok(calls.some(call => call.options.body?.opportunity_id === 'current-opportunity-fixture-history'));
  assert.ok(calls.some(call => call.options.body?.opportunity_id === 'current-opportunity-fixture-purchased'));
  assert.deepEqual(run.report().events.map(event => event.type), [
    'resource:opportunity', 'resource:message', 'resource:summary', 'resource:opportunity'
  ]);
  assert.equal(run.report().status, 'prepared');
});

test('orchestrator approves a pending profile change without checking case id', async () => {
  const calls = [];
  const request = async (path, options = {}) => {
    calls.push({ path, options });
    if (path.endsWith('/approve')) return { data: { status: 'approved' } };
    return { data: [] };
  };
  const createRun = createEvaluationFixtureOrchestrator({ request });
  const run = createRun({
    case_id: 'Z97', customer_input: '改一下，其实这次给妈妈买。'
  }, { headers: {}, opportunityId: 'opportunity-1' });
  await run.afterMemory({
    runId: 'run-1', suffix: 'suffix-1',
    memoryPayload: { data: [{
      proposal_id: 'proposal-1', revision: 3, status: 'pending', review_mode: 'solution_profile_card',
      facts: [{ field: 'insured_person_relationship', value: 'mother' }]
    }] }
  });
  assert.ok(calls.some(call => call.path.endsWith('/proposals/proposal-1/approve')));
  assert.equal(run.report().events[0].type, 'profile_change_approval');
});
