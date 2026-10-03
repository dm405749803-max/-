import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../server/database.mjs';
import { buildContext } from '../../server/context.mjs';
import { createSalesOps, createSalesOpsApi } from '../../server/sales-ops/index.mjs';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'sales-ops-'));
  let clock = new Date('2026-09-23T10:00:00.000Z');
  const now = () => new Date(clock);
  const store = openDatabase(join(directory, 'test.sqlite'), { now });
  const draftColumns = store.raw.prepare('PRAGMA table_info(drafts)').all();
  if (!draftColumns.some(column => column.name === 'product_scope')) store.raw.exec('ALTER TABLE drafts ADD COLUMN product_scope TEXT');
  const workspace = 'sales_ops_test';
  store.createCustomer(workspace, { customer_id: 'customer-1', name: '演练客户' });
  store.addPerson(workspace, 'customer-1', { person_id: 'person-1', name: '演练家人', relationship: '家人' });
  const opportunity = store.addOpportunity(workspace, 'customer-1', {
    opportunity_id: 'opportunity-1', person_id: 'person-1', purpose: '演练需求', environment: 'simulation',
    product_id: 'product-1', product_version: 'v1'
  });
  let sequence = 0;
  const confirmDraft = (original, finalText) => {
    sequence += 1;
    clock = new Date(clock.getTime() + 60_000);
    const added = store.addMessage(workspace, opportunity.opportunity_id, {
      idempotency_key: `customer-message-${sequence}`, message_id: `message-${sequence}`, role: 'customer',
      text: `演练问题 ${sequence}`, status: 'received', source: 'manual', environment: 'simulation',
      occurred_at: clock.toISOString()
    }).message;
    const context = buildContext(store, workspace, opportunity.opportunity_id);
    const currentOpportunity = store.raw.prepare('SELECT * FROM opportunities WHERE workspace_id=? AND opportunity_id=?').get(workspace, opportunity.opportunity_id);
    const draft = store.saveDraft(workspace, opportunity.opportunity_id, added.message_id, currentOpportunity.revision, {
      schema_version: 'sales-assist.v1', status: 'draft_ready', draft: original,
      citations: [], proposed_fact_changes: [], next_question: null, next_action: 'sales_review',
      risk_flags: [], missing_evidence: [], review_required: true,
      context_versions: context.context_versions, trace: { provider: 'test', workflow_run_id: null }
    }, context);
    store.raw.prepare('UPDATE drafts SET product_scope=? WHERE workspace_id=? AND draft_id=?')
      .run(JSON.stringify({ ...context.product_scope, environment: currentOpportunity.environment }), workspace, draft.draft_id);
    return store.confirmDraft(workspace, draft.draft_id, {
      expected_revision: draft.revision, final_text: finalText, delivery_mode: 'simulation',
      editor_id: 'champion-test', editor_role: 'champion',
      idempotency_key: `confirm-${sequence}`
    }).draft;
  };
  const close = () => { store.close(); rmSync(directory, { recursive: true, force: true }); };
  return { store, workspace, opportunity, now, setClock: value => { clock = new Date(value); }, confirmDraft, close };
}

test('review queue separates outcomes, never invents edit counts, and only exports approved scoped experience', () => {
  const f = fixture();
  try {
    const service = createSalesOps({ store: f.store, now: f.now });
    const successDraft = f.confirmDraft('您好，请尽快购买。', '您好，我们先核对您最关心的问题。');
    const failureDraft = f.confirmDraft('这款肯定适合您。', '我先记录您的顾虑，具体是否合适需要再核对。');
    f.store.patchOpportunity(f.workspace, f.opportunity.opportunity_id, 1, { product_version: 'v2' });

    const createdSuccess = service.createReview(f.workspace, {
      draft_id: successDraft.draft_id, outcome: 'success', outcome_note: '客户愿意继续沟通',
      ai_suggested_reason: 'AI 推测：语气改善', idempotency_key: 'review-success'
    });
    assert.equal(createdSuccess.idempotent_replay, false);
    assert.equal(service.createReview(f.workspace, {
      draft_id: successDraft.draft_id, outcome: 'success', outcome_note: '客户愿意继续沟通',
      ai_suggested_reason: 'AI 推测：语气改善', idempotency_key: 'review-success'
    }).idempotent_replay, true);
    assert.throws(() => service.createReview(f.workspace, {
      draft_id: successDraft.draft_id, outcome: 'failure', idempotency_key: 'review-success'
    }), error => error.code === 'IDEMPOTENCY_KEY_REUSE');

    service.createReview(f.workspace, {
      draft_id: failureDraft.draft_id, outcome: 'failure', outcome_note: '客户结束本次沟通',
      ai_suggested_reason: 'AI 推测：解释太长', idempotency_key: 'review-failure'
    });
    const successQueue = service.listReviews(f.workspace, { outcome: 'success' });
    const failureQueue = service.listReviews(f.workspace, { outcome: 'failure' });
    assert.equal(successQueue.items.length, 1);
    assert.equal(failureQueue.items.length, 1);
    assert.equal(successQueue.metrics.changed_draft_count, 1);
    assert.equal(successQueue.metrics.edit_count, null);
    assert.match(successQueue.metrics.edit_count_basis, /不推测|只统计/);
    assert.equal(successQueue.items[0].edit_count, null);
    assert.equal(successQueue.items[0].change_metrics.changed, true);
    assert.ok(successQueue.items[0].change_metrics.change_ratio >= 0 && successQueue.items[0].change_metrics.change_ratio <= 1);
    assert.match(successQueue.items[0].change_metrics.change_ratio_basis, /0\.\.1/);
    assert.equal(successQueue.items[0].product_version, 'v1');
    assert.equal(successQueue.items[0].source_scope_status, 'verified');
    assert.ok(successQueue.items[0].ranking_reasons.length >= 2);

    const reviewId = createdSuccess.review.review_id;
    assert.throws(() => service.patchReview(f.workspace, reviewId, {
      expected_revision: 1, idempotency_key: 'approve-sensitive',
      changes: { approval_status: 'approved', human_reason: '人工判断', approved_content: '客户病史显示需调整表达' }
    }), error => error.code === 'REVIEWER_REQUIRED');
    assert.throws(() => service.patchReview(f.workspace, reviewId, {
      expected_revision: 1, idempotency_key: 'approve-sensitive-reason',
      changes: { approval_status: 'approved', reviewer: '复核员', human_reason: '根据客户病史调整', approved_content: '先澄清当前问题' }
    }), error => error.code === 'SENSITIVE_EXPERIENCE_CONTENT');
    assert.throws(() => service.patchReview(f.workspace, reviewId, {
      expected_revision: 1, idempotency_key: 'approve-with-person-name',
      changes: { approval_status: 'approved', reviewer: '复核员', human_reason: '人工判断', approved_content: '先询问演练家人的情况' }
    }), error => error.code === 'EXPERIENCE_NOT_DEIDENTIFIED');
    assert.throws(() => service.patchReview(f.workspace, reviewId, {
      expected_revision: 1, idempotency_key: 'approve-raw-draft',
      changes: { approval_status: 'approved', reviewer: '复核员', human_reason: '人工判断', approved_content: '您好，我们先核对您最关心的问题。' }
    }), error => error.code === 'RAW_CHAT_NOT_ALLOWED');

    const approved = service.patchReview(f.workspace, reviewId, {
      expected_revision: 1, idempotency_key: 'approve-success',
      changes: {
        approval_status: 'approved', reviewer: '复核员', human_reason: '先澄清问题比催促成交更有效',
        approved_content: '先回答客户当前问题，再确认下一步。联系号码13800000000不应进入通用经验。',
        validation_status: 'passed', validation_note: '已在3个模拟咨询中验证通过。', validated_by: '验证员'
      }
    });
    assert.equal(approved.review.approval_status, 'approved');
    assert.equal(approved.review.approved_at, '2026-09-23T10:02:00.000Z');
    assert.match(approved.review.approved_content, /\[手机号已脱敏\]/);
    assert.doesNotMatch(approved.review.approved_content, /13800000000/);
    assert.equal(approved.review.ai_suggested_reason, 'AI 推测：语气改善');
    assert.notEqual(approved.review.human_reason, approved.review.ai_suggested_reason);
    assert.equal(service.patchReview(f.workspace, reviewId, {
      expected_revision: 1, idempotency_key: 'approve-success',
      changes: {
        approval_status: 'approved', reviewer: '复核员', human_reason: '先澄清问题比催促成交更有效',
        approved_content: '先回答客户当前问题，再确认下一步。联系号码13800000000不应进入通用经验。',
        validation_status: 'passed', validation_note: '已在3个模拟咨询中验证通过。', validated_by: '验证员'
      }
    }).idempotent_replay, true);
    assert.throws(() => service.patchReview(f.workspace, reviewId, {
      expected_revision: 1, idempotency_key: 'stale-review-version', changes: { outcome_note: '新说明' }
    }), error => error.code === 'REVISION_CONFLICT');

    const matching = service.listApprovedExperiences(f.workspace, { environment: 'simulation', product_id: 'product-1', product_version: 'v1' });
    assert.equal(matching.length, 1);
    assert.equal(matching[0].source_review_id, reviewId);
    assert.equal(matching[0].approval_status, 'approved');
    assert.equal(matching[0].reviewer, '复核员');
    assert.match(matching[0].content, /\[手机号已脱敏\]/);
    assert.equal(Object.hasOwn(matching[0], 'original_text'), false);
    assert.equal(Object.hasOwn(matching[0], 'final_text'), false);
    assert.deepEqual(service.listApprovedExperiences(f.workspace, { environment: 'real', product_id: 'product-1', product_version: 'v1' }), []);
    assert.deepEqual(service.listApprovedExperiences(f.workspace, { environment: 'simulation', product_id: 'product-1', product_version: 'v2' }), []);
    assert.deepEqual(service.listApprovedExperiences('another_workspace', { environment: 'simulation' }), []);

    const reopened = service.patchReview(f.workspace, reviewId, {
      expected_revision: 2, idempotency_key: 'edit-approved-reopens',
      changes: { human_reason: '改为先确认客户当前的唯一问题' }
    });
    assert.equal(reopened.review.approval_status, 'pending');
    assert.equal(reopened.review.reviewer, null);
    assert.deepEqual(service.listApprovedExperiences(f.workspace, { environment: 'simulation', product_id: 'product-1', product_version: 'v1' }), []);
    const reapproved = service.patchReview(f.workspace, reviewId, {
      expected_revision: 3, idempotency_key: 'reapprove-after-edit',
      changes: {
        approval_status: 'approved', reviewer: '二次复核员', validation_status: 'passed',
        validation_note: '修改后重新完成3个模拟咨询验证。', validated_by: '二次验证员'
      }
    });
    assert.equal(reapproved.review.approval_status, 'approved');
    assert.equal(reapproved.review.experience_version, 2);
  } finally { f.close(); }
});

test('pending and unknown outcomes remain distinct and cannot be approved as final experience', () => {
  const f = fixture();
  try {
    const service = createSalesOps({ store: f.store, now: f.now });
    const draft = f.confirmDraft('待跟进草稿', '待跟进终稿');
    const created = service.createReview(f.workspace, {
      draft_id: draft.draft_id, outcome: 'pending', idempotency_key: 'pending-review'
    });
    assert.equal(service.listReviews(f.workspace, { outcome: 'pending' }).items.length, 1);
    assert.equal(service.listReviews(f.workspace, { outcome: 'unknown' }).items.length, 0);
    assert.throws(() => service.patchReview(f.workspace, created.review.review_id, {
      expected_revision: 1, idempotency_key: 'pending-approve',
      changes: { approval_status: 'approved', reviewer: '复核员', human_reason: '人工判断', approved_content: '尚未得到最终结果' }
    }), error => error.code === 'OUTCOME_NOT_FINAL');
    const unknown = service.patchReview(f.workspace, created.review.review_id, {
      expected_revision: 1, idempotency_key: 'pending-to-unknown', changes: { outcome: 'unknown' }
    });
    assert.equal(unknown.review.outcome, 'unknown');
    assert.equal(service.listReviews(f.workspace, { outcome: 'unknown' }).items.length, 1);
  } finally { f.close(); }
});

test('legacy drafts without a frozen source scope stay reviewable but cannot become approved experience', () => {
  const f = fixture();
  try {
    const draft = f.confirmDraft('原始建议文本', '人工确认后的文本');
    f.store.raw.prepare('UPDATE drafts SET product_scope=NULL WHERE workspace_id=? AND draft_id=?').run(f.workspace, draft.draft_id);
    f.store.patchOpportunity(f.workspace, f.opportunity.opportunity_id, 1, { product_version: 'v9' });
    const service = createSalesOps({ store: f.store, now: f.now });
    const created = service.createReview(f.workspace, {
      draft_id: draft.draft_id, outcome: 'success', idempotency_key: 'legacy-review'
    });
    assert.equal(created.review.source_scope_status, 'unverified');
    assert.equal(created.review.environment, null);
    assert.equal(created.review.product_version, null);
    assert.throws(() => service.patchReview(f.workspace, created.review.review_id, {
      expected_revision: 1, idempotency_key: 'legacy-approve',
      changes: { approval_status: 'approved', reviewer: '复核员', human_reason: '人工理由', approved_content: '通用经验内容' }
    }), error => error.code === 'SOURCE_SCOPE_UNVERIFIED');
    assert.deepEqual(service.listApprovedExperiences(f.workspace), []);
  } finally { f.close(); }
});

test('due task scans create persistent in-app notifications exactly once and stop after completion', () => {
  const f = fixture();
  try {
    const service = createSalesOps({ store: f.store, now: f.now });
    f.store.createTask(f.workspace, {
      task_id: 'due-task', customer_id: 'customer-1', opportunity_id: f.opportunity.opportunity_id,
      owner: '我', title: '回访演练客户', reason: '人工确认跟进', due_at: '2026-09-23T09:00:00.000Z', idempotency_key: 'task-due'
    });
    f.store.createTask(f.workspace, {
      task_id: 'future-task', customer_id: 'customer-1', opportunity_id: f.opportunity.opportunity_id,
      owner: '我', title: '未来任务', reason: '还未到期', due_at: '2026-09-24T09:00:00.000Z', idempotency_key: 'task-future'
    });
    f.store.createTask(f.workspace, {
      task_id: 'offset-task', customer_id: 'customer-1', opportunity_id: f.opportunity.opportunity_id,
      owner: '我', title: '时区任务', reason: '按真实时间已到期', due_at: '2026-09-23T17:30:00+08:00', idempotency_key: 'task-offset'
    });
    f.store.createTask(f.workspace, {
      task_id: 'completed-before-scan', customer_id: 'customer-1', opportunity_id: f.opportunity.opportunity_id,
      owner: '我', title: '已完成任务', reason: '不应提醒', status: 'completed', due_at: '2026-09-23T08:00:00Z', idempotency_key: 'task-completed'
    });
    f.store.createTask(f.workspace, {
      task_id: 'invalid-date-task', customer_id: 'customer-1', opportunity_id: f.opportunity.opportunity_id,
      owner: '我', title: '无效日期任务', reason: '不应提醒', due_at: '2026-09-23T08:00:00Z', idempotency_key: 'task-invalid-date'
    });
    f.store.patchTask(f.workspace, 'invalid-date-task', 1, { due_at: '2026-02-30T08:00:00Z' });
    const first = service.scanDueTasks(f.workspace, { idempotency_key: 'scan-1' });
    assert.equal(first.created_notification_count, 2);
    assert.equal(service.scanDueTasks(f.workspace, { idempotency_key: 'scan-1' }).idempotent_replay, true);
    f.store.patchTask(f.workspace, 'offset-task', 1, { due_at: '2026-09-23T09:30:00.000Z' });
    assert.equal(service.scanDueTasks(f.workspace, { idempotency_key: 'scan-2' }).created_notification_count, 0);
    let notifications = service.listNotifications(f.workspace, { unread: true });
    assert.equal(notifications.length, 2);
    assert.equal(notifications.filter(item => item.task_id === 'offset-task').length, 1);
    assert.equal(notifications.filter(item => item.task_id === 'completed-before-scan').length, 0);
    assert.equal(notifications.filter(item => item.task_id === 'invalid-date-task').length, 0);
    const dueNotification = notifications.find(item => item.task_id === 'due-task');

    const read = service.markNotificationRead(f.workspace, dueNotification.notification_id, {
      expected_revision: 1, idempotency_key: 'read-1', changes: { read: true }
    });
    assert.equal(read.notification.read, true);
    assert.equal(service.markNotificationRead(f.workspace, dueNotification.notification_id, {
      expected_revision: 1, idempotency_key: 'read-1', changes: { read: true }
    }).idempotent_replay, true);
    assert.throws(() => service.markNotificationRead(f.workspace, dueNotification.notification_id, {
      expected_revision: 1, idempotency_key: 'read-2', changes: { read: false }
    }), error => error.code === 'REVISION_CONFLICT');
    assert.equal(service.listNotifications(f.workspace, { unread: true }).length, 1);

    f.store.patchTask(f.workspace, 'due-task', 1, { status: 'completed', result: '人工完成' });
    f.setClock('2026-09-25T10:00:00.000Z');
    const afterCompletion = service.scanDueTasks(f.workspace, { idempotency_key: 'scan-3' });
    assert.equal(afterCompletion.created_notification_count, 1);
    notifications = service.listNotifications(f.workspace);
    assert.equal(notifications.filter(item => item.task_id === 'due-task').length, 1);
    assert.equal(notifications.filter(item => item.task_id === 'future-task').length, 1);
    assert.equal(notifications.filter(item => item.task_id === 'offset-task').length, 1);
  } finally { f.close(); }
});

test('sales-ops HTTP router stays in its namespace and returns v2 envelopes', async () => {
  const f = fixture();
  try {
    const service = createSalesOps({ store: f.store, now: f.now });
    const sent = [];
    const route = createSalesOpsApi({
      store: f.store, salesOps: service, now: f.now,
      readJson: async req => req.body,
      sendJson: (res, status, payload) => { res.status = status; res.payload = payload; sent.push({ status, payload }); }
    });
    assert.equal(await route({ method: 'GET', url: '/api/v2/customers', headers: {} }, {}, new URL('http://localhost/api/v2/customers')), false);
    const res = {};
    assert.equal(await route({ method: 'GET', url: '/api/v2/sales-ops/reviews?outcome=unknown', headers: { 'x-workspace-id': f.workspace } }, res, new URL('http://localhost/api/v2/sales-ops/reviews?outcome=unknown')), true);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.payload.data.items));
    assert.match(res.payload.trace_id, /^trace_/);

    const bad = {};
    await route({ method: 'GET', url: '/api/v2/sales-ops/reviews', headers: { 'x-workspace-id': '../bad' } }, bad, new URL('http://localhost/api/v2/sales-ops/reviews'));
    assert.equal(bad.status, 400);
    assert.equal(bad.payload.error.code, 'INVALID_WORKSPACE_ID');
    assert.ok(sent.length >= 2);
  } finally { f.close(); }
});
