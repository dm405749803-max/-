import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../server/database.mjs';
import { createV2Api } from '../../server/api.mjs';
import { buildContext } from '../../server/context.mjs';
import { runSalesAssist } from '../../ai/sales-assist.mjs';
import { createConversationOrchestrator } from '../../server/conversation-orchestrator.mjs';
import { acquisitionChannel, isReturnGuaranteeRequest } from '../../ai/customer-signals.mjs';

function fixture(t, orchestrated = false) {
  const store = openDatabase(':memory:'); t.after(() => store.close());
  store.createCustomer('test', { customer_id: 'customer', name: '测试客户' });
  store.addOpportunity('test', 'customer', { opportunity_id: 'need', environment: 'simulation' });
  const route = createV2Api({ store, salesAssist: runSalesAssist,
    conversationOrchestrator: orchestrated ? createConversationOrchestrator({ runSalesAssist }) : null,
    readJson: async req => req.body, sendJson: (res, status, payload) => Object.assign(res, { status, payload }) });
  const message = (text, key = 'message') => store.addMessage('test', 'need', {
    idempotency_key: key, role: 'customer', text, status: 'received', source: 'simulation'
  });
  const request = async (path, method, body) => {
    const res = {};
    await route({ method, body, headers: { 'x-workspace-id': 'test' } }, res, new URL(path, 'http://localhost'));
    return res;
  };
  const generate = async () => {
    const c = buildContext(store, 'test', 'need');
    return request('/api/v2/opportunities/need/drafts', 'POST', {
      latest_message_id: c.latest_message_id, expected_revision: c.context_versions.opportunity_revision
    });
  };
  return { store, message, generate, request };
}

test('customer-stated acquisition sources persist with evidence, without duplicates or inferred product need', async t => {
  const f = fixture(t);
  const text = '我是刷到你的视频后加过来的';
  const saved = f.message(text); f.message(text);
  const response = await f.request('/api/v2/customers/customer', 'GET');
  assert.equal(response.status, 200);
  const customer = response.payload.data;
  assert.equal(customer.business_events.length, 1);
  assert.equal(customer.business_events[0].event_type, 'acquisition_source');
  assert.equal(customer.business_events[0].payload.channel, 'video');
  assert.deepEqual(customer.business_events[0].evidence_message_ids, [saved.message.message_id]);
  assert.equal(customer.opportunities[0].purpose, null);
  assert.equal(acquisitionChannel('我是通过直播找到你的'), 'livestream');
  assert.equal(acquisitionChannel('同事介绍我来咨询'), 'referral');
  assert.equal(acquisitionChannel('我不是从视频来的'), null);
  assert.equal(acquisitionChannel('你们的视频讲了什么？'), null);
});

test('complaints atomically persist an event linked to its task and evidence', async t => {
  const f = fixture(t);
  const saved = f.message('我要投诉之前的服务'); f.message('我要投诉之前的服务');
  const customer = f.store.getCustomer('test', 'customer');
  const events = customer.business_events.filter(x => x.event_type === 'complaint');
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.owner, 'unassigned');
  assert.ok(events[0].payload.due_at);
  assert.deepEqual(events[0].evidence_message_ids, [saved.message.message_id]);
  assert.ok(f.store.listTasks('test').some(x => x.task_id === events[0].payload.task_id));
  assert.equal(customer.human_handoff, true);
  assert.equal((await f.generate()).payload.data.draft, '');
  assert.throws(() => f.store.getCustomer('other-workspace', 'customer'));
});

test('return guarantee requests take priority over product questions and create a real handoff', async t => {
  for (const text of ['你只要保证收益，我就买', '先承诺一定回本，再告诉我有哪些产品', '这笔收益你能打包保证吗？', '麻烦安排人工保证我稳赚']) {
    const f = fixture(t, true);
    f.message(text);
    const result = await f.generate();
    assert.equal(result.status, 201, JSON.stringify(result.payload));
    assert.equal(result.payload.data.status, 'human_required', text);
    assert.equal(result.payload.data.draft, '', text);
    assert.equal(f.store.getCustomer('test', 'customer').opportunities[0].human_handoff, true);
    const tasks = f.store.listTasks('test').filter(x => x.title === '核对收益保证依据');
    assert.equal(tasks.length, 1);
    await f.generate();
    assert.equal(f.store.listTasks('test').filter(x => x.title === '核对收益保证依据').length, 1);
  }
  for (const text of ['我不需要你保证收益', '不能保证收益我理解', '合同里保证领取的金额是多少？', '收益率是多少']) {
    assert.equal(isReturnGuaranteeRequest(text), false, text);
  }
});

test('missing formal plan replies create a sales verification task instead of an empty promise', async t => {
  const f = fixture(t);
  f.message('这款产品收益率多少？我还没有正式计划书。');
  const result = await f.generate();
  assert.equal(result.status, 201, JSON.stringify(result.payload));
  assert.match(result.payload.data.draft, /不能直接给出收益率/);
  const tasks = f.store.listTasks('test').filter(x => x.title === '核对正式计划书与金额依据');
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].owner, 'sales');
  await f.generate();
  assert.equal(f.store.listTasks('test').filter(x => x.title === '核对正式计划书与金额依据').length, 1);
});

test('opt-out is immediate, silent, customer-wide and assigned to internal human handling', async t => {
  for (const wording of ['别再联系我', '不要再给我发了', '停止营销，你们有什么产品也别推荐了']) {
    const f = fixture(t, true);
    f.store.addOpportunity('test', 'customer', { opportunity_id: 'other-need', environment: 'simulation' });
    f.store.createTask('test', { customer_id: 'customer', opportunity_id: 'other-need', idempotency_key: 'marketing', owner: 'sales', title: '按约定时间回访', reason: 'future_follow_up_timing', status: 'open' });
    f.store.createTask('test', { customer_id: 'customer', opportunity_id: 'other-need', idempotency_key: 'service', owner: 'service', title: '处理保全申请', reason: '客户主动申请保全', status: 'open' });
    f.message(wording); f.message(wording);
    const customer = f.store.getCustomer('test', 'customer');
    assert.equal(customer.marketing_opt_out, true);
    assert.equal(customer.human_handoff, true);
    assert.equal(customer.handoff_owner, 'unassigned');
    const stopEvent = customer.business_events.find(x => x.event_type === 'marketing_opt_out');
    assert.equal(stopEvent.payload.cancellation_executed, true);
    assert.equal(stopEvent.payload.cancelled_marketing_task_count, 1);
    assert.equal(stopEvent.payload.remaining_marketing_task_count, 0);
    const tasks = f.store.listTasks('test');
    assert.equal(tasks.find(x => x.idempotency_key === 'marketing').status, 'cancelled');
    assert.deepEqual(stopEvent.payload.cancelled_marketing_task_ids, [tasks.find(x => x.idempotency_key === 'marketing').task_id]);
    assert.equal(tasks.find(x => x.idempotency_key === 'service').status, 'open');
    assert.equal(tasks.filter(x => x.title === '拒绝营销人工处理').length, 1);
    assert.match(tasks.find(x => x.title === '拒绝营销人工处理').reason, /不得主动营销/);
    const result = await f.generate();
    assert.equal(result.status, 201, JSON.stringify(result.payload));
    assert.equal(result.payload.data.status, 'stop_marketing');
    assert.equal(result.payload.data.draft, '');
    f.message('我主动咨询保全手续，请让人工处理', 'service-request');
    const service = await f.generate();
    assert.equal(service.status, 201, JSON.stringify(service.payload));
    assert.equal(service.payload.data.status, 'human_required');
    assert.equal(service.payload.data.draft, '');
    f.message('过几个月再考虑', 'later-message');
    assert.equal(f.store.listTasks('test').filter(x => x.status === 'open' && /回访|行动信号/.test(x.title)).length, 0);
  }
});
