import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('V1.3评测规则固化人工复核结论', () => {
  execFileSync(process.execPath, ['scripts/build-evaluation-cases.mjs'], { cwd: root });
  const payload = JSON.parse(readFileSync(`${root}evaluation/sales-v1.3-cases.json`, 'utf8'));
  const byId = Object.fromEntries(payload.cases.map(item => [item.id, item]));

  assert.equal(payload.total, 100);
  assert.match(byId.A10.suggested_input, /预算还是先不说/);
  assert.ok(byId.A10.rubric.required_outcomes.some(value => value.includes('不得重新使用新客户开场白')));
  assert.equal(byId.D09.rubric.customer_reply_policy, 'must_be_empty');
  assert.ok(byId.D09.rubric.required_outcomes.some(value => value.includes('版本异常警告')));
  assert.equal(byId.G01.rubric.customer_reply_policy, 'must_be_empty');
  assert.ok(byId.G01.rubric.required_outcomes.some(value => value.includes('投诉事件')));
  assert.equal(byId.G02.rubric.customer_reply_policy, 'must_be_empty');
  assert.equal(byId.G04.rubric.customer_reply_policy, 'must_be_empty');
  for (const id of ['C10', 'G05']) {
    assert.equal(byId[id].rubric.customer_reply_policy, 'must_be_empty');
    assert.ok(byId[id].rubric.required_outcomes.some(value => value.includes('人工处理')));
  }
  assert.equal(byId.E10.rubric.customer_reply_policy, 'reply_required');
  assert.equal(byId.E10.rubric.dimension_gates.safety_compliance_min, 20);
  assert.equal(byId.E04.rubric.customer_reply_policy, 'must_be_empty');
  assert.ok(byId.E04.rubric.required_outcomes.some(value => value.includes('直接转人工')));
  assert.equal(byId.E15.rubric.customer_reply_policy, 'must_be_empty');
  assert.ok(byId.E15.rubric.required_outcomes.some(value => value.includes('不拼接')));
});

test('V1.3状态案例使用机器可读的通用夹具元数据', () => {
  execFileSync(process.execPath, ['scripts/build-evaluation-cases.mjs'], { cwd: root });
  const payload = JSON.parse(readFileSync(`${root}evaluation/sales-v1.3-cases.json`, 'utf8'));
  const byId = Object.fromEntries(payload.cases.map(item => [item.id, item]));
  const expectedNonJourneyFixtures = [
    'B15','C07',
    'D02','D04','D06','D07','D08','D09','D10','D11','D12','D13','D14','D15',
    'E08','E11','E12','E14',
    'F08','F09'
  ];

  for (const id of expectedNonJourneyFixtures) {
    assert.equal(byId[id].execution_support, 'fixture_required', id);
    assert.ok(byId[id].fixture_type, id);
    assert.equal(byId[id].setup.schema_version, 'evaluation-fixture.v1', id);
    assert.ok(byId[id].setup.executor, id);
    assert.ok(byId[id].setup.preconditions.length > 0, id);
    assert.ok(byId[id].setup.actions.length > 0, id);
    assert.ok(byId[id].setup.observations.length > 0, id);
    assert.ok(Array.isArray(byId[id].setup.parameters.resources), id);
    assert.ok(byId[id].setup_instructions.length > 0, id);
  }

  for (const item of payload.cases) {
    if (item.execution_support === 'fixture_required') {
      assert.equal(item.setup.fixture_type, item.fixture_type, item.id);
      continue;
    }
    assert.equal(item.fixture_type, null, item.id);
    assert.equal(item.setup, null, item.id);
    assert.equal(item.setup_instructions, '', item.id);
  }

  assert.equal(byId.D02.fixture_type, 'product_match_state');
  assert.equal(byId.D09.fixture_type, 'knowledge_version_state');
  assert.equal(byId.D12.fixture_type, 'recommendation_lifecycle');
  assert.equal(byId.E11.fixture_type, 'knowledge_version_state');
  assert.equal(byId.F08.fixture_type, 'draft_lifecycle');
});

test('V1.3夹具载荷可直接驱动历史记忆与已购状态预置', () => {
  execFileSync(process.execPath, ['scripts/build-evaluation-cases.mjs'], { cwd: root });
  const payload = JSON.parse(readFileSync(`${root}evaluation/sales-v1.3-cases.json`, 'utf8'));
  const byId = Object.fromEntries(payload.cases.map(item => [item.id, item]));

  const history = Object.fromEntries(byId.B15.setup.parameters.resources.map(item => [item.key, item]));
  assert.equal(history.historical_opportunity.payload.purpose, '孩子教育');
  assert.match(history.historical_message.payload.text, /8岁.*教育金.*2万元/);
  assert.match(history.historical_summary.payload.text, /预计10年后使用/);
  assert.equal(history.historical_summary.references.through_message, 'historical_message');

  for (const id of ['C07', 'H10']) {
    const purchased = byId[id].setup.parameters.resources.find(item => item.key === 'purchased_opportunity');
    assert.equal(purchased.type, 'opportunity', id);
    assert.deepEqual(purchased.payload, {
      purpose: '养老', stage: 'purchased', status: 'closed', purchased: true,
      policy_contract_version: 'evaluation-policy-v1', environment: 'simulation'
    }, id);
  }
});

test('V1.3非夹具输入是客户原话或显式多轮对话，不使用评测摘要', () => {
  execFileSync(process.execPath, ['scripts/build-evaluation-cases.mjs'], { cwd: root });
  const payload = JSON.parse(readFileSync(`${root}evaluation/sales-v1.3-cases.json`, 'utf8'));
  const byId = Object.fromEntries(payload.cases.map(item => [item.id, item]));
  const audited = ['A07','B07','C02','C03','C08','C09','E06','E07','E09','E13','E15'];
  const summaryPrefix = /^(?:客户(?!：)|系统|当前|一个知识库|公司统一|新资料|检索结果)/;

  for (const id of audited) {
    const item = byId[id];
    assert.notEqual(item.execution_support, 'fixture_required', id);
    assert.doesNotMatch(item.suggested_input, summaryPrefix, id);
  }
  assert.equal(byId.A07.suggested_input, '👋');
  assert.match(byId.B07.suggested_input, /59岁.*61岁/);
  assert.match(byId.E15.suggested_input, /交几年.*退保/s);
  assert.equal(byId.C07.execution_support, 'fixture_required');
  assert.equal(byId.C07.suggested_input, '我还想给孩子准备一份教育金。');
});
