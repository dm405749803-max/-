import { randomUUID } from 'node:crypto';
import { ApiError, assertApi } from '../errors.mjs';

const WORKSPACE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const OUTCOMES = new Set(['success', 'failure', 'pending', 'unknown']);
const APPROVALS = new Set(['pending', 'approved', 'rejected']);
const VALIDATIONS = new Set(['pending', 'passed', 'failed']);
const CONFIRMED_DRAFT_STATUSES = new Set(['simulated_sent', 'manually_confirmed_sent', 'provider_confirmed_sent']);
const SENSITIVE_EXPERIENCE = /(?:病史|疾病|诊断|用药|住院|体检|健康状况|遗传病)/i;

const nowIso = now => (now ? now() : new Date()).toISOString();
const makeId = prefix => `${prefix}_${randomUUID()}`;
const json = value => JSON.stringify(value ?? null);
const parse = (value, fallback = null) => {
  try { return value == null ? fallback : JSON.parse(value); } catch { return fallback; }
};
const normalizeText = (value, limit = 4000) => String(value ?? '').trim().slice(0, limit);
const normalizeNullable = (value, limit = 1000) => {
  const text = normalizeText(value, limit);
  return text || null;
};
const parseInstant = value => {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|([+-])(\d{2}):(\d{2}))$/);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone, , offsetHourText, offsetMinuteText] = match;
  const [year, month, day, hour, minute, second] = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  const maxDay = month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;
  if (day < 1 || day > maxDay || hour > 23 || minute > 59 || second > 59) return null;
  if (zone !== 'Z') {
    const offsetHour = Number(offsetHourText); const offsetMinute = Number(offsetMinuteText);
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) return null;
  }
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? instant : null;
};
const stableValue = value => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  return value;
};
const fingerprint = value => JSON.stringify(stableValue(value));

function transaction(db, work) {
  if (db.isTransaction) return work();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function changeMetrics(original, finalText) {
  const before = String(original ?? '');
  const after = String(finalText ?? '');
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix
    && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix += 1;
  const removed = before.length - prefix - suffix;
  const added = after.length - prefix - suffix;
  const denominator = Math.max(before.length + after.length, 1);
  return {
    changed: before !== after,
    original_length: before.length,
    final_length: after.length,
    common_prefix_length: prefix,
    common_suffix_length: suffix,
    removed_characters: Math.max(0, removed),
    added_characters: Math.max(0, added),
    change_ratio: Number(((Math.max(0, removed) + Math.max(0, added)) / denominator).toFixed(4)),
    change_ratio_basis: '首尾共享片段之外的新增与删除字符，除以原稿与终稿总长度（范围 0..1）'
  };
}

function draftScope(row) {
  const snapshot = parse(row?.product_scope, null);
  if (!snapshot || !['real', 'simulation'].includes(snapshot.environment)) {
    return { environment: null, product_id: null, product_version: null, source_scope_status: 'unverified' };
  }
  return {
    environment: snapshot.environment,
    product_id: normalizeNullable(snapshot.product_id, 200),
    product_version: normalizeNullable(snapshot.product_version, 200),
    source_scope_status: 'verified'
  };
}

function ranking(outcome, metrics) {
  const outcomeWeight = { failure: 40, success: 30, pending: 20, unknown: 10 }[outcome] ?? 0;
  const changeWeight = metrics.changed ? Math.min(30, Math.round(metrics.change_ratio * 30)) : 0;
  const reasons = [`业务结果：${{ failure: '失败', success: '成功', pending: '待跟进', unknown: '未知' }[outcome] || '未知'}`];
  if (metrics.changed) reasons.push(`草稿已人工改写，改稿幅度 ${Math.round(metrics.change_ratio * 100)}%`);
  else reasons.push('草稿正文未改动');
  return { priority_score: outcomeWeight + changeWeight, ranking_reasons: reasons };
}

function redactExperience(text) {
  return String(text ?? '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[邮箱已脱敏]')
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, '[手机号已脱敏]')
    .replace(/(?<!\d)\d{17}[\dXx](?!\d)/g, '[身份号已脱敏]')
    .trim();
}

function redactNullableExperience(value, limit) {
  const normalized = normalizeNullable(value, limit);
  return normalized == null ? null : redactExperience(normalized);
}

export function createSalesOps({ store, now = () => new Date() }) {
  assertApi(store?.raw, 500, 'SALES_OPS_STORE_REQUIRED', 'sales-ops 需要 openDatabase 返回的 store。');
  const db = store.raw;
  db.exec(`
    CREATE TABLE IF NOT EXISTS sales_ops_reviews (
      workspace_id TEXT NOT NULL, review_id TEXT NOT NULL, draft_id TEXT NOT NULL,
      opportunity_id TEXT NOT NULL, customer_id TEXT NOT NULL, environment TEXT,
      product_id TEXT, product_version TEXT, source_scope_status TEXT NOT NULL DEFAULT 'verified',
      outcome TEXT NOT NULL DEFAULT 'unknown', outcome_note TEXT,
      ai_suggested_reason TEXT, human_reason TEXT, approved_content TEXT, reviewer TEXT, approved_at TEXT,
      validation_status TEXT NOT NULL DEFAULT 'pending', validation_note TEXT, validated_by TEXT, validated_at TEXT,
      approval_status TEXT NOT NULL DEFAULT 'pending', experience_version INTEGER NOT NULL DEFAULT 0,
      create_idempotency_key TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(workspace_id, review_id),
      UNIQUE(workspace_id, draft_id), UNIQUE(workspace_id, create_idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS sales_ops_reviews_queue
      ON sales_ops_reviews(workspace_id, outcome, approval_status, updated_at);
    CREATE TABLE IF NOT EXISTS sales_ops_actions (
      workspace_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, action_type TEXT NOT NULL,
      target_id TEXT NOT NULL, request_fingerprint TEXT NOT NULL, response_json TEXT NOT NULL,
      created_at TEXT NOT NULL, PRIMARY KEY(workspace_id, idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS sales_ops_notifications (
      workspace_id TEXT NOT NULL, notification_id TEXT NOT NULL, task_id TEXT NOT NULL,
      opportunity_id TEXT, customer_id TEXT, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
      due_at TEXT NOT NULL, dedupe_key TEXT NOT NULL, read_at TEXT, revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(workspace_id, notification_id), UNIQUE(workspace_id, dedupe_key)
    );
    CREATE INDEX IF NOT EXISTS sales_ops_notifications_list
      ON sales_ops_notifications(workspace_id, read_at, due_at, created_at);
    CREATE TABLE IF NOT EXISTS sales_ops_scan_runs (
      workspace_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, response_json TEXT NOT NULL,
      created_at TEXT NOT NULL, PRIMARY KEY(workspace_id, idempotency_key)
    );
  `);
  const reviewColumns = db.prepare('PRAGMA table_info(sales_ops_reviews)').all();
  if (!reviewColumns.some(column => column.name === 'reviewer')) db.exec('ALTER TABLE sales_ops_reviews ADD COLUMN reviewer TEXT');
  if (!reviewColumns.some(column => column.name === 'approved_at')) db.exec('ALTER TABLE sales_ops_reviews ADD COLUMN approved_at TEXT');
  if (!reviewColumns.some(column => column.name === 'source_scope_status')) db.exec("ALTER TABLE sales_ops_reviews ADD COLUMN source_scope_status TEXT NOT NULL DEFAULT 'unverified'");
  if (!reviewColumns.some(column => column.name === 'validation_status')) db.exec("ALTER TABLE sales_ops_reviews ADD COLUMN validation_status TEXT NOT NULL DEFAULT 'pending'");
  if (!reviewColumns.some(column => column.name === 'validation_note')) db.exec('ALTER TABLE sales_ops_reviews ADD COLUMN validation_note TEXT');
  if (!reviewColumns.some(column => column.name === 'validated_by')) db.exec('ALTER TABLE sales_ops_reviews ADD COLUMN validated_by TEXT');
  if (!reviewColumns.some(column => column.name === 'validated_at')) db.exec('ALTER TABLE sales_ops_reviews ADD COLUMN validated_at TEXT');

  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const ensureWorkspace = workspaceId => assertApi(WORKSPACE_RE.test(String(workspaceId || '')), 400, 'INVALID_WORKSPACE_ID', 'workspace_id 格式无效。');
  const reviewRow = (workspaceId, reviewId) => one('SELECT * FROM sales_ops_reviews WHERE workspace_id=? AND review_id=?', workspaceId, reviewId);
  const notificationRow = (workspaceId, notificationId) => one('SELECT * FROM sales_ops_notifications WHERE workspace_id=? AND notification_id=?', workspaceId, notificationId);
  const mapReview = row => row && ({
    review_id: row.review_id, draft_id: row.draft_id, opportunity_id: row.opportunity_id, customer_id: row.customer_id,
    environment: row.environment, product_id: row.product_id, product_version: row.product_version,
    source_scope_status: row.source_scope_status,
    outcome: row.outcome, outcome_note: row.outcome_note, ai_suggested_reason: row.ai_suggested_reason,
    human_reason: row.human_reason, approved_content: row.approved_content, reviewer: row.reviewer, approved_at: row.approved_at,
    validation_status: row.validation_status, validation_note: row.validation_note,
    validated_by: row.validated_by, validated_at: row.validated_at,
    approval_status: row.approval_status, experience_version: row.experience_version,
    revision: row.revision, created_at: row.created_at, updated_at: row.updated_at
  });
  const mapNotification = row => row && ({
    notification_id: row.notification_id, task_id: row.task_id, opportunity_id: row.opportunity_id,
    customer_id: row.customer_id, kind: row.kind, title: row.title, body: row.body, due_at: row.due_at,
    read: Boolean(row.read_at), read_at: row.read_at, revision: row.revision,
    created_at: row.created_at, updated_at: row.updated_at
  });
  const actionReplay = (workspaceId, key, type, targetId, request) => {
    assertApi(key, 400, 'IDEMPOTENCY_KEY_REQUIRED', '写操作必须带幂等键。');
    const prior = one('SELECT * FROM sales_ops_actions WHERE workspace_id=? AND idempotency_key=?', workspaceId, key);
    if (!prior) return null;
    const expected = fingerprint(request);
    assertApi(prior.action_type === type && prior.target_id === targetId && prior.request_fingerprint === expected,
      409, 'IDEMPOTENCY_KEY_REUSE', '幂等键已用于不同操作。');
    return parse(prior.response_json, {});
  };
  const saveAction = (workspaceId, key, type, targetId, request, response) => {
    run('INSERT INTO sales_ops_actions VALUES (?,?,?,?,?,?,?)', workspaceId, key, type, targetId, fingerprint(request), json(response), nowIso(now));
  };
  const queueItem = row => {
    const scope = draftScope(row);
    const edit = parse(row.edit_record, null);
    const original = edit?.original_text ?? row.content ?? '';
    const finalText = edit?.final_text ?? row.final_text ?? '';
    const metrics = changeMetrics(original, finalText);
    const rank = ranking(row.review_outcome || 'unknown', metrics);
    return {
      review_id: row.review_id || null, draft_id: row.draft_id, opportunity_id: row.opportunity_id,
      customer_id: row.customer_id, ...scope, original_text: original, final_text: finalText,
      edit_record: edit, change_metrics: metrics,
      changed_draft_count: metrics.changed ? 1 : 0,
      edit_count: null, edit_count_basis: '未保存逐次编辑事件，不推测编辑次数',
      outcome: row.review_outcome || 'unknown', outcome_note: row.outcome_note || null,
      ai_suggested_reason: row.ai_suggested_reason || null, human_reason: row.human_reason || null,
      approval_status: row.approval_status || 'pending', revision: row.review_revision || null,
      ...rank, confirmed_at: row.updated_at
    };
  };

  const api = {
    captureChampionCandidates(workspaceId, opportunityId, input = {}) {
      ensureWorkspace(workspaceId);
      const opportunity = store._helpers.ensureOpportunity(workspaceId, opportunityId);
      const purchaseAt = input.purchased_at || nowIso(now);
      const cutoff = new Date(Date.parse(purchaseAt) - 30 * 86_400_000).toISOString();
      const drafts = all(`SELECT * FROM drafts WHERE workspace_id=? AND opportunity_id=?
        AND editor_role='champion' AND updated_at>=?
        AND status IN ('simulated_sent','manually_confirmed_sent','provider_confirmed_sent')
        AND final_text IS NOT NULL AND edit_record IS NOT NULL ORDER BY updated_at`, workspaceId, opportunityId, cutoff)
        .filter(row => parse(row.edit_record, {})?.changed === true);
      const created = [];
      for (const draft of drafts) {
        const edit = parse(draft.edit_record, {});
        const metrics = changeMetrics(edit.original_text ?? draft.content, edit.final_text ?? draft.final_text);
        const suggested = `销冠对AI原稿进行了${Math.round(metrics.change_ratio * 100)}%幅度的改写；可能涉及语气、提问顺序或异议处理，需销冠确认真实修改原因后才能成为正式经验。`;
        const result = api.createReview(workspaceId, {
          draft_id: draft.draft_id,
          outcome: 'success',
          outcome_note: `客户在该回复后30天内成交（成交时间：${purchaseAt}），仅代表相关性，不代表该句话单独促成成交。`,
          ai_suggested_reason: suggested,
          idempotency_key: `champion-success:${draft.draft_id}`
        });
        created.push(result.review);
      }
      return { opportunity_id: opportunity.opportunity_id, candidate_count: created.length, candidates: created };
    },

    createReview(workspaceId, input) {
      ensureWorkspace(workspaceId);
      assertApi(input?.draft_id, 400, 'DRAFT_ID_REQUIRED', '待复盘记录必须关联草稿。');
      assertApi(OUTCOMES.has(input.outcome), 400, 'INVALID_OUTCOME', '业务结果只能是 success/failure/pending/unknown。');
      assertApi(input.idempotency_key, 400, 'IDEMPOTENCY_KEY_REQUIRED', '记录业务结果必须带幂等键。');
      const requested = { draft_id: String(input.draft_id), outcome: input.outcome, outcome_note: normalizeNullable(input.outcome_note), ai_suggested_reason: normalizeNullable(input.ai_suggested_reason) };
      const priorKey = one('SELECT * FROM sales_ops_reviews WHERE workspace_id=? AND create_idempotency_key=?', workspaceId, input.idempotency_key);
      if (priorKey) {
        assertApi(priorKey.draft_id === requested.draft_id && priorKey.outcome === requested.outcome
          && priorKey.outcome_note === requested.outcome_note && priorKey.ai_suggested_reason === requested.ai_suggested_reason,
        409, 'IDEMPOTENCY_KEY_REUSE', '幂等键已用于不同复盘记录。');
        return { review: mapReview(priorKey), idempotent_replay: true };
      }
      const draft = one(`SELECT d.*,o.customer_id
        FROM drafts d JOIN opportunities o ON o.workspace_id=d.workspace_id AND o.opportunity_id=d.opportunity_id
        WHERE d.workspace_id=? AND d.draft_id=?`, workspaceId, requested.draft_id);
      assertApi(draft, 404, 'DRAFT_NOT_FOUND', '草稿不存在。');
      assertApi(CONFIRMED_DRAFT_STATUSES.has(draft.status) && draft.final_text && draft.edit_record,
        409, 'DRAFT_NOT_CONFIRMED', '只有已人工确认的草稿可进入业务结果复盘。');
      return transaction(db, () => {
        const existing = one('SELECT review_id FROM sales_ops_reviews WHERE workspace_id=? AND draft_id=?', workspaceId, requested.draft_id);
        assertApi(!existing, 409, 'REVIEW_ALREADY_EXISTS', '该草稿已有复盘记录。', { review_id: existing?.review_id });
        const scope = draftScope(draft);
        const at = nowIso(now); const reviewId = makeId('review');
        run(`INSERT INTO sales_ops_reviews(workspace_id,review_id,draft_id,opportunity_id,customer_id,environment,product_id,product_version,source_scope_status,outcome,outcome_note,ai_suggested_reason,approval_status,experience_version,create_idempotency_key,revision,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,1,?,?)`, workspaceId, reviewId, draft.draft_id, draft.opportunity_id, draft.customer_id,
        scope.environment, scope.product_id, scope.product_version, scope.source_scope_status, requested.outcome, requested.outcome_note,
        requested.ai_suggested_reason, 'pending', input.idempotency_key, at, at);
        return { review: mapReview(reviewRow(workspaceId, reviewId)), idempotent_replay: false };
      });
    },

    listReviews(workspaceId, filters = {}) {
      ensureWorkspace(workspaceId);
      const rows = all(`SELECT d.*,o.customer_id,
          r.review_id,r.outcome AS review_outcome,r.outcome_note,r.ai_suggested_reason,r.human_reason,
          r.approval_status,r.revision AS review_revision
        FROM drafts d JOIN opportunities o ON o.workspace_id=d.workspace_id AND o.opportunity_id=d.opportunity_id
        LEFT JOIN sales_ops_reviews r ON r.workspace_id=d.workspace_id AND r.draft_id=d.draft_id
        WHERE d.workspace_id=? AND d.status IN ('simulated_sent','manually_confirmed_sent','provider_confirmed_sent')
          AND d.final_text IS NOT NULL AND d.edit_record IS NOT NULL`, workspaceId)
        .map(queueItem)
        .filter(item => !filters.outcome || item.outcome === filters.outcome)
        .filter(item => !filters.approval_status || item.approval_status === filters.approval_status)
        .filter(item => !filters.environment || item.environment === filters.environment)
        .filter(item => !filters.product_id || item.product_id === filters.product_id)
        .filter(item => !filters.product_version || item.product_version === filters.product_version)
        .filter(item => !filters.opportunity_id || item.opportunity_id === filters.opportunity_id)
        .sort((left, right) => right.priority_score - left.priority_score || String(right.confirmed_at).localeCompare(String(left.confirmed_at)));
      return {
        items: rows,
        metrics: {
          draft_count: rows.length,
          changed_draft_count: rows.filter(item => item.change_metrics.changed).length,
          edit_count: null,
          edit_count_basis: '未保存逐次编辑事件，只统计被改写草稿数与改稿幅度'
        }
      };
    },

    getReview(workspaceId, reviewId) {
      ensureWorkspace(workspaceId); const row = reviewRow(workspaceId, reviewId);
      assertApi(row, 404, 'REVIEW_NOT_FOUND', '复盘记录不存在。');
      return mapReview(row);
    },

    patchReview(workspaceId, reviewId, input) {
      ensureWorkspace(workspaceId);
      const changes = input?.changes || {};
      const allowed = new Set(['outcome', 'outcome_note', 'human_reason', 'approved_content', 'approval_status', 'reviewer',
        'validation_status', 'validation_note', 'validated_by']);
      assertApi(Object.keys(changes).length > 0 && Object.keys(changes).every(key => allowed.has(key)), 400, 'UNSUPPORTED_CHANGE', '包含不支持的复盘字段。');
      const normalized = {
        ...changes,
        ...(Object.hasOwn(changes, 'outcome_note') ? { outcome_note: normalizeNullable(changes.outcome_note) } : {}),
        ...(Object.hasOwn(changes, 'human_reason') ? { human_reason: redactNullableExperience(changes.human_reason, 1000) } : {}),
        ...(Object.hasOwn(changes, 'approved_content') ? { approved_content: redactNullableExperience(changes.approved_content, 2000) } : {}),
        ...(Object.hasOwn(changes, 'reviewer') ? { reviewer: normalizeNullable(changes.reviewer, 160) } : {}),
        ...(Object.hasOwn(changes, 'validation_note') ? { validation_note: redactNullableExperience(changes.validation_note, 1000) } : {}),
        ...(Object.hasOwn(changes, 'validated_by') ? { validated_by: normalizeNullable(changes.validated_by, 160) } : {})
      };
      if (Object.hasOwn(normalized, 'outcome')) assertApi(OUTCOMES.has(normalized.outcome), 400, 'INVALID_OUTCOME', '业务结果无效。');
      if (Object.hasOwn(normalized, 'approval_status')) assertApi(APPROVALS.has(normalized.approval_status), 400, 'INVALID_APPROVAL_STATUS', '审批状态无效。');
      if (Object.hasOwn(normalized, 'validation_status')) assertApi(VALIDATIONS.has(normalized.validation_status), 400, 'INVALID_VALIDATION_STATUS', '验证状态无效。');
      const request = { expected_revision: Number(input.expected_revision), changes: normalized };
      const replay = actionReplay(workspaceId, input.idempotency_key, 'patch_review', reviewId, request);
      if (replay) return { ...replay, idempotent_replay: true };
      return transaction(db, () => {
        const current = reviewRow(workspaceId, reviewId);
        assertApi(current, 404, 'REVIEW_NOT_FOUND', '复盘记录不存在。');
        assertApi(Number(input.expected_revision) === current.revision, 409, 'REVISION_CONFLICT', '复盘版本已变更。', { current_revision: current.revision });
        const approvalMaterialChanged = ['outcome', 'human_reason', 'approved_content'].some(key => Object.hasOwn(normalized, key));
        const mustReopen = current.approval_status === 'approved' && approvalMaterialChanged && !Object.hasOwn(normalized, 'approval_status');
        const validationReset = current.validation_status === 'passed' && approvalMaterialChanged && !Object.hasOwn(normalized, 'validation_status');
        const next = {
          outcome: normalized.outcome ?? current.outcome,
          outcome_note: Object.hasOwn(normalized, 'outcome_note') ? normalized.outcome_note : current.outcome_note,
          human_reason: Object.hasOwn(normalized, 'human_reason') ? normalized.human_reason : current.human_reason,
          approved_content: Object.hasOwn(normalized, 'approved_content') ? normalized.approved_content : current.approved_content,
          approval_status: mustReopen ? 'pending' : (normalized.approval_status ?? current.approval_status),
          reviewer: mustReopen ? null : (Object.hasOwn(normalized, 'reviewer') ? normalized.reviewer : current.reviewer),
          validation_status: validationReset ? 'pending' : (normalized.validation_status ?? current.validation_status),
          validation_note: validationReset ? null : (Object.hasOwn(normalized, 'validation_note') ? normalized.validation_note : current.validation_note),
          validated_by: validationReset ? null : (Object.hasOwn(normalized, 'validated_by') ? normalized.validated_by : current.validated_by)
        };
        if (next.validation_status === 'passed') {
          assertApi(next.validation_note && next.validated_by, 400, 'VALIDATION_EVIDENCE_REQUIRED', '通过小范围验证前必须填写验证结果和验证人。');
        }
        if (['approved', 'rejected'].includes(next.approval_status)) {
          assertApi(next.human_reason, 400, 'HUMAN_REVIEW_REQUIRED', '审批或驳回前必须由人填写原因。');
          assertApi(next.reviewer, 400, 'REVIEWER_REQUIRED', '审批或驳回必须记录批准人。');
        }
        if (next.approval_status === 'approved') {
          assertApi(current.source_scope_status === 'verified', 409, 'SOURCE_SCOPE_UNVERIFIED', '旧草稿缺少确认时的产品与环境快照，不能批准为通用经验。');
          assertApi(['success', 'failure'].includes(next.outcome), 409, 'OUTCOME_NOT_FINAL', '只有成功或失败结果可批准为经验。');
          assertApi(next.human_reason && next.approved_content, 400, 'HUMAN_REVIEW_REQUIRED', '批准前必须由人填写原因和脱敏经验内容。');
          assertApi(!SENSITIVE_EXPERIENCE.test(`${next.human_reason} ${next.approved_content}`), 400, 'SENSITIVE_EXPERIENCE_CONTENT', '通用经验不得包含个人健康资料。');
          const source = one(`SELECT d.content,d.final_text,c.name FROM drafts d
            JOIN opportunities o ON o.workspace_id=d.workspace_id AND o.opportunity_id=d.opportunity_id
            JOIN customers c ON c.workspace_id=o.workspace_id AND c.customer_id=o.customer_id
            WHERE d.workspace_id=? AND d.draft_id=?`, workspaceId, current.draft_id);
          const combined = `${next.human_reason} ${next.approved_content}`;
          const names = [source?.name, ...all(`SELECT p.name FROM persons p JOIN opportunities o ON o.workspace_id=p.workspace_id AND o.customer_id=p.customer_id
            WHERE o.workspace_id=? AND o.opportunity_id=?`, workspaceId, current.opportunity_id).map(row => row.name)]
            .map(name => String(name || '').trim()).filter(Boolean);
          assertApi(names.every(name => !combined.includes(name)), 400, 'EXPERIENCE_NOT_DEIDENTIFIED', '通用经验不得包含客户或人物姓名。');
          const messageTexts = all('SELECT text FROM messages WHERE workspace_id=? AND opportunity_id=?', workspaceId, current.opportunity_id)
            .map(row => row.text);
          for (const raw of [source?.content, source?.final_text, ...messageTexts].filter(value => String(value || '').length >= 8)) {
            assertApi(!combined.includes(raw), 400, 'RAW_CHAT_NOT_ALLOWED', '通用经验不得复制原始草稿或原始对话。');
          }
          assertApi(next.validation_status === 'passed' && next.validation_note && next.validated_by,
            409, 'EXPERIENCE_VALIDATION_REQUIRED', '候选经验必须先完成小范围验证，才能进入正式经验库。');
        }
        const experienceBump = next.approval_status === 'approved'
          && (current.approval_status !== 'approved' || next.outcome !== current.outcome
            || next.approved_content !== current.approved_content || next.human_reason !== current.human_reason
            || next.reviewer !== current.reviewer) ? 1 : 0;
        const at = nowIso(now);
        const approvedAt = next.approval_status === 'approved' ? (experienceBump ? at : current.approved_at) : null;
        const validatedAt = next.validation_status === 'passed'
          ? (current.validation_status === 'passed' && !Object.hasOwn(normalized, 'validation_status') ? current.validated_at : at) : null;
        run(`UPDATE sales_ops_reviews SET outcome=?,outcome_note=?,human_reason=?,approved_content=?,approval_status=?,reviewer=?,approved_at=?,
          validation_status=?,validation_note=?,validated_by=?,validated_at=?,experience_version=experience_version+?,revision=revision+1,updated_at=? WHERE workspace_id=? AND review_id=?`,
        next.outcome, next.outcome_note, next.human_reason, next.approved_content, next.approval_status, next.reviewer,
        approvedAt, next.validation_status, next.validation_note, next.validated_by, validatedAt,
        experienceBump, at, workspaceId, reviewId);
        const response = { review: mapReview(reviewRow(workspaceId, reviewId)) };
        saveAction(workspaceId, input.idempotency_key, 'patch_review', reviewId, request, response);
        return { ...response, idempotent_replay: false };
      });
    },

    listApprovedExperiences(workspaceId, filters = {}) {
      ensureWorkspace(workspaceId);
      const rows = all(`SELECT r.* FROM sales_ops_reviews r
        JOIN drafts d ON d.workspace_id=r.workspace_id AND d.draft_id=r.draft_id
        WHERE r.workspace_id=? AND r.approval_status='approved' AND d.editor_role='champion'
        AND r.source_scope_status='verified' AND r.reviewer IS NOT NULL AND r.human_reason IS NOT NULL
        AND r.approved_content IS NOT NULL AND r.outcome='success' AND r.validation_status='passed'
        AND r.validation_note IS NOT NULL AND r.validated_by IS NOT NULL ORDER BY r.approved_at DESC`, workspaceId)
        .filter(row => !filters.environment || row.environment === filters.environment)
        .filter(row => !filters.product_id || row.product_id === filters.product_id)
        .filter(row => !filters.product_version || row.product_version === filters.product_version);
      return rows.map(row => ({
        experience_id: `${row.review_id}:v${row.experience_version}`,
        source_review_id: row.review_id,
        approval_status: row.approval_status,
        version: row.experience_version,
        environment: row.environment,
        product_id: row.product_id,
        product_version: row.product_version,
        source_scope_status: row.source_scope_status,
        outcome: row.outcome,
        reason: redactExperience(row.human_reason),
        content: redactExperience(row.approved_content),
        reviewer: row.reviewer,
        validation_status: row.validation_status,
        validation_note: row.validation_note,
        validated_by: row.validated_by,
        validated_at: row.validated_at,
        approved_at: row.approved_at
      }));
    },

    scanDueTasks(workspaceId, input = {}) {
      ensureWorkspace(workspaceId);
      assertApi(input.idempotency_key, 400, 'IDEMPOTENCY_KEY_REQUIRED', '到期扫描必须带幂等键。');
      const prior = one('SELECT response_json FROM sales_ops_scan_runs WHERE workspace_id=? AND idempotency_key=?', workspaceId, input.idempotency_key);
      if (prior) return { ...parse(prior.response_json, {}), idempotent_replay: true };
      return transaction(db, () => {
        const at = nowIso(now); const scanTime = parseInstant(at);
        const due = all(`SELECT * FROM tasks WHERE workspace_id=? AND due_at IS NOT NULL
          AND status IN ('open','in_progress') ORDER BY created_at`, workspaceId)
          .map(task => ({ task, dueTime: parseInstant(task.due_at) }))
          .filter(item => item.dueTime !== null && item.dueTime <= scanTime)
          .sort((left, right) => left.dueTime - right.dueTime || String(left.task.created_at).localeCompare(String(right.task.created_at)));
        let created = 0;
        for (const item of due) {
          const task = item.task;
          const normalizedDueAt = new Date(item.dueTime).toISOString();
          const dedupe = `task_due:${task.task_id}:${normalizedDueAt}`;
          const priorNotification = all('SELECT notification_id,due_at FROM sales_ops_notifications WHERE workspace_id=? AND task_id=?', workspaceId, task.task_id)
            .find(notification => parseInstant(notification.due_at) === item.dueTime);
          if (priorNotification) continue;
          run('INSERT INTO sales_ops_notifications VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', workspaceId, makeId('notice'), task.task_id,
            task.opportunity_id, task.customer_id, 'task_due', `待办已到期：${task.title || task.reason}`,
            `负责人：${task.owner}；原因：${task.reason}`, normalizedDueAt, dedupe, null, 1, at, at);
          created += 1;
        }
        const response = { scanned_task_count: due.length, created_notification_count: created, scanned_at: at };
        run('INSERT INTO sales_ops_scan_runs VALUES (?,?,?,?)', workspaceId, input.idempotency_key, json(response), at);
        return { ...response, idempotent_replay: false };
      });
    },

    listNotifications(workspaceId, filters = {}) {
      ensureWorkspace(workspaceId);
      return all('SELECT * FROM sales_ops_notifications WHERE workspace_id=? ORDER BY due_at DESC,created_at DESC', workspaceId)
        .map(mapNotification)
        .filter(item => filters.unread === undefined || (filters.unread ? !item.read : item.read))
        .filter(item => !filters.task_id || item.task_id === filters.task_id);
    },

    markNotificationRead(workspaceId, notificationId, input) {
      ensureWorkspace(workspaceId);
      const read = input?.changes?.read;
      assertApi(typeof read === 'boolean' && Object.keys(input.changes || {}).length === 1, 400, 'UNSUPPORTED_CHANGE', '通知只支持 read 状态变更。');
      const request = { expected_revision: Number(input.expected_revision), changes: { read } };
      const replay = actionReplay(workspaceId, input.idempotency_key, 'patch_notification', notificationId, request);
      if (replay) return { ...replay, idempotent_replay: true };
      return transaction(db, () => {
        const current = notificationRow(workspaceId, notificationId);
        assertApi(current, 404, 'NOTIFICATION_NOT_FOUND', '站内通知不存在。');
        assertApi(Number(input.expected_revision) === current.revision, 409, 'REVISION_CONFLICT', '通知版本已变更。', { current_revision: current.revision });
        const at = nowIso(now); const readAt = read ? (current.read_at || at) : null;
        run('UPDATE sales_ops_notifications SET read_at=?,revision=revision+1,updated_at=? WHERE workspace_id=? AND notification_id=?', readAt, at, workspaceId, notificationId);
        const response = { notification: mapNotification(notificationRow(workspaceId, notificationId)) };
        saveAction(workspaceId, input.idempotency_key, 'patch_notification', notificationId, request, response);
        return { ...response, idempotent_replay: false };
      });
    }
  };

  return api;
}

export function createSalesOpsApi({ store, salesOps = null, readJson, sendJson, now = () => new Date() }) {
  assertApi(typeof readJson === 'function' && typeof sendJson === 'function', 500, 'SALES_OPS_HTTP_HELPERS_REQUIRED', 'sales-ops API 缺少 JSON 读写依赖。');
  const service = salesOps || createSalesOps({ store, now });
  const ok = (res, data, traceId, status = 200) => sendJson(res, status, { data, trace_id: traceId });
  const workspace = req => {
    const value = String(req.headers['x-workspace-id'] || 'demo');
    assertApi(WORKSPACE_RE.test(value), 400, 'INVALID_WORKSPACE_ID', 'workspace_id 格式无效。');
    return value;
  };
  const body = async req => {
    try { return await readJson(req, 1_000_000); }
    catch (error) { throw new ApiError(error.message === 'REQUEST_TOO_LARGE' ? 413 : 400, 'INVALID_JSON', '请求 JSON 无效或过大。'); }
  };
  return async function routeSalesOps(req, res, url = new URL(req.url, 'http://127.0.0.1')) {
    if (!url.pathname.startsWith('/api/v2/sales-ops/')) return false;
    const traceId = `trace_${randomUUID()}`;
    try {
      const ws = workspace(req); let match;
      if (url.pathname === '/api/v2/sales-ops/reviews' && req.method === 'GET') {
        return ok(res, service.listReviews(ws, Object.fromEntries([...url.searchParams].filter(([, value]) => value !== ''))), traceId), true;
      }
      if (url.pathname === '/api/v2/sales-ops/reviews' && req.method === 'POST') return ok(res, service.createReview(ws, await body(req)), traceId, 201), true;
      if ((match = url.pathname.match(/^\/api\/v2\/sales-ops\/reviews\/([^/]+)$/)) && req.method === 'GET') return ok(res, service.getReview(ws, decodeURIComponent(match[1])), traceId), true;
      if (match && req.method === 'PATCH') return ok(res, service.patchReview(ws, decodeURIComponent(match[1]), await body(req)), traceId), true;
      if (url.pathname === '/api/v2/sales-ops/experiences' && req.method === 'GET') {
        return ok(res, service.listApprovedExperiences(ws, Object.fromEntries([...url.searchParams].filter(([, value]) => value !== ''))), traceId), true;
      }
      if (url.pathname === '/api/v2/sales-ops/notifications/scan' && req.method === 'POST') return ok(res, service.scanDueTasks(ws, await body(req)), traceId, 201), true;
      if (url.pathname === '/api/v2/sales-ops/notifications' && req.method === 'GET') {
        const unread = url.searchParams.has('unread') ? url.searchParams.get('unread') === 'true' : undefined;
        return ok(res, service.listNotifications(ws, { unread, task_id: url.searchParams.get('task_id') || undefined }), traceId), true;
      }
      if ((match = url.pathname.match(/^\/api\/v2\/sales-ops\/notifications\/([^/]+)$/)) && req.method === 'PATCH') return ok(res, service.markNotificationRead(ws, decodeURIComponent(match[1]), await body(req)), traceId), true;
      throw new ApiError(404, 'NOT_FOUND', '接口不存在。');
    } catch (error) {
      const known = error instanceof ApiError;
      if (!known) console.error(`[${traceId}] sales-ops request failed: ${error.name}: ${error.message}`);
      sendJson(res, known ? error.status : 500, {
        error: { code: known ? error.code : 'INTERNAL_ERROR', message: known ? error.message : '服务器无法完成请求。', details: known ? error.details : null },
        trace_id: traceId
      });
      return true;
    }
  };
}
