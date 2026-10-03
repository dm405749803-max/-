import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../server/database.mjs';
import { createCopilotService, COPILOT_WORKSPACE as ws, draftDifference } from '../../server/copilot.mjs';

function fixture(t) {
  let clock = new Date('2026-10-02T02:00:00Z'); const now = () => clock;
  const store = openDatabase(':memory:', { now }); t.after(() => store.close());
  const events = []; const service = createCopilotService({ store, now, observability: { recordEvent: (_, e) => events.push(e) } });
  service.bootstrap(); const draft = store.getLatestDraft(ws, 'preview-lin-need');
  const input = { customer_id: 'preview-lin', opportunity_id: 'preview-lin-need', draft_id: draft.draft_id, expected_revision: draft.revision,
    final_text: draft.content, channel: 'simulation', attempt_id: 'attempt-test-001' };
  return { store, service, events, draft, input, advance: ms => clock = new Date(clock.getTime() + ms) };
}

test('preview delivery is atomic, idempotent and calculates adoption only on success', t => {
  const { service, input, store, events } = fixture(t);
  const result = service.send(input); assert.equal(result.state, 'success');
  assert.equal(service.send(input).idempotent_replay, true);
  assert.equal(store.listMessages(ws, input.opportunity_id).filter(m => m.role === 'sales').length, 1);
  assert.equal(events.filter(e => e.event_name === 'draft_action' && e.payload.outcome === 'direct_send').length, 1);
  assert.throws(() => service.send({ ...input, final_text: 'different' }), e => e.code === 'IDEMPOTENCY_CONFLICT');
});
test('failed and unknown delivery do not send, consume draft or count adoption; receipts cannot be overwritten', t => {
  const { service, input, store, events } = fixture(t);
  assert.equal(service.send({ ...input, simulation_result: 'failed' }).state, 'failed');
  assert.equal(store.getDraft(ws, input.draft_id).status, 'draft_ready');
  const pending = service.send({ ...input, attempt_id: 'attempt-test-002', simulation_result: 'unknown' });
  assert.equal(pending.state, 'unknown');
  assert.equal(events.filter(e => e.event_name === 'draft_action').length, 0);
  assert.throws(() => service.send({ ...input, attempt_id: 'attempt-test-003' }), e => e.code === 'DELIVERY_UNRESOLVED');
  assert.throws(() => service.discard(input), e => e.code === 'DELIVERY_UNRESOLVED');
  assert.equal(service.reconcile({ attempt_id: pending.attempt_id, result: 'success' }).state, 'success');
  assert.equal(store.listMessages(ws, input.opportunity_id).filter(m => m.role === 'sales').length, 1);
  service.reconcile({ attempt_id: pending.attempt_id, result: 'success' });
  assert.throws(() => service.reconcile({ attempt_id: pending.attempt_id, result: 'failed' }), e => e.code === 'RECEIPT_CONFLICT');
});
test('customer, revision, changed context, real channel and modified unsafe final text are blocked server-side', t => {
  const { service, input, store } = fixture(t);
  assert.throws(() => service.send({ ...input, customer_id: 'preview-zhou' }), e => e.code === 'CUSTOMER_MISMATCH');
  assert.throws(() => service.send({ ...input, opportunity_id: 'preview-zhou-need', customer_id: 'preview-zhou' }), e => e.code === 'DRAFT_CUSTOMER_MISMATCH');
  assert.throws(() => service.send({ ...input, channel: 'wecom' }), e => e.code === 'WECOM_NOT_CONNECTED');
  assert.throws(() => service.send({ ...input, expected_revision: 99 }), e => e.code === 'REVISION_CONFLICT');
  assert.throws(() => service.send({ ...input, final_text: '保证收益，肯定理赔' }), e => e.code === 'UNSAFE_FINAL_TEXT');
  store.addMessage(ws, input.opportunity_id, { role: 'customer', text: '妈妈55岁', status: 'received', source: 'manual', environment: 'simulation', idempotency_key: 'new-message' });
  assert.throws(() => service.send(input), e => ['STALE_DRAFT', 'STALE_CONTEXT'].includes(e.code));
});
test('editor saves empty deletions without discarding and rejects another tab overwriting a newer revision', t => {
  const { service, input, store, events } = fixture(t);
  const editor = service.saveEditor({ ...input, final_text: '', editor_revision: 0 });
  assert.equal(editor.revision, 1); assert.equal(service.editor(input.opportunity_id).final_text, '');
  assert.equal(store.getDraft(ws, input.draft_id).stale, false);
  assert.throws(() => service.saveEditor({ ...input, editor_revision: 0 }), e => e.code === 'EDITOR_CONFLICT');
  service.discard(input);
  assert.equal(store.getDraft(ws, input.draft_id).stale, true);
  assert.equal(events.filter(e => e.payload.outcome === 'discarded').length, 1);
});
test('risk clock is strictly over five minutes; response clears supervisor pending state but never unblocks marketing', t => {
  const { service, advance, store } = fixture(t);
  const first = service.snapshot().risks[0]; assert.equal(first.overdue, false);
  advance(300000); assert.equal(service.snapshot().risks[0].overdue, false);
  advance(1000); assert.equal(service.snapshot().risks[0].overdue, true);
  service.respond({ risk_id: first.risk_id });
  assert.equal(service.snapshot().risks.filter(r => r.overdue && !r.responded_at).length, 0);
  assert.equal(store._helpers.ensureOpportunity(ws, first.opportunity_id).human_handoff, 1);
});
test('edit outcomes distinguish direct, edited and rewrite with insertion counts not silently capped', () => {
  assert.equal(draftDifference('你好呀', '你好呀').outcome, 'direct_send');
  assert.equal(draftDifference('你好呀', '您好呀').outcome, 'edited_send');
  assert.equal(draftDifference('你好', '请问您想咨询什么').outcome, 'manual_rewrite');
  assert.ok(draftDifference('好', '非常非常好').edit_ratio > 1);
});
