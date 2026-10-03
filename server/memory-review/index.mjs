import { createHash, randomUUID } from 'node:crypto';
import { ApiError, assertApi } from '../errors.mjs';
import { requiresSalesConfirmation } from '../workspace-policy.mjs';
import { buildContext } from '../context.mjs';
import { isContextMessage } from '../memory-policy.mjs';

const WORKSPACE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const FACT_FIELD_RE = /^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/;
// Approximate quantities are still useful review candidates. For example,
// “每年预算大概2万元” should create a pending solution-profile proposal,
// not discard every fact extracted from that message. Truly tentative or
// negated statements remain blocked here.
const UNSAFE_FACT_EVIDENCE = /(?:不确定|待确认|尚未确认|还没定|没有确定|不清楚|说不准|可能|也许|不是|并非|没有|不考虑|对比|比较)/i;
const DIRECT_CONSTRAINT_FIELD = /^(?:contact_preference|marketing_opt_out|liquidity_constraint)$/;
const FIELD_EVIDENCE_CUES = [
  [/(?:^|_)(?:age|insured_person_age|daughter_age|son_age|child_age|parent_age|spouse_age)(?:_|$)/, /(?:\d{1,3}\s*岁|年龄)/],
  [/(?:^|_)(?:budget|annual_budget|annual_budget_amount|annual_budget_max|monthly_budget)(?:_|$)/, /(?:预算|每年|每月|[\d一二三四五六七八九十百千万两]+\s*(?:万)?元)/],
  [/(?:^|_)(?:relationship|insured_person_relationship|insured_person)(?:_|$)/, /(?:本人|自己|妈妈|母亲|爸爸|父亲|女儿|儿子|孩子|配偶|妻子|丈夫)/],
  [/(?:^|_)(?:purpose|purpose_code)(?:_|$)/, /(?:养老|教育|储备|传承|保障|医疗|健康)/],
  [/(?:^|_)(?:funds_usage_years|payment_years)(?:_|$)/, /(?:\d+\s*年|年内|缴费|交费)/]
];
const FINAL_STATUSES = new Set(['approved', 'rejected', 'expired', 'observed']);

const json = value => JSON.stringify(value ?? null);
const parse = (value, fallback = null) => {
  try { return value == null ? fallback : JSON.parse(value); } catch { return fallback; }
};
const nowIso = now => {
  const value = typeof now === 'function' ? now() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
};
const identifier = prefix => `${prefix}_${randomUUID()}`;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const trimmed = (value, max) => String(value ?? '').trim().slice(0, max);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key] === undefined ? null : value[key])]));
  return value === undefined ? null : value;
}

function requestFingerprint(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

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

function createSchema(store) {
  store.raw.exec(`
    CREATE TABLE IF NOT EXISTS memory_review_proposals (
      workspace_id TEXT NOT NULL,
      proposal_id TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      opportunity_id TEXT NOT NULL,
      environment TEXT NOT NULL,
      generation_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      facts TEXT NOT NULL DEFAULT '[]',
      summary TEXT NOT NULL,
      source_message_ids TEXT NOT NULL DEFAULT '[]',
      context_versions TEXT NOT NULL,
      model_proposal TEXT NOT NULL,
      intent TEXT NOT NULL DEFAULT '{}',
      review_mode TEXT NOT NULL DEFAULT 'solution_profile_card',
      provider TEXT NOT NULL,
      workflow_run_id TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      reviewer TEXT,
      rejection_reason TEXT,
      approved_fact_ids TEXT NOT NULL DEFAULT '[]',
      approved_summary_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      reviewed_at TEXT,
      PRIMARY KEY(workspace_id, proposal_id),
      UNIQUE(workspace_id, opportunity_id, generation_key),
      FOREIGN KEY(workspace_id, opportunity_id) REFERENCES opportunities(workspace_id, opportunity_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS memory_review_queue
      ON memory_review_proposals(workspace_id, status, opportunity_id, created_at);
    CREATE TABLE IF NOT EXISTS memory_review_reviews (
      workspace_id TEXT NOT NULL,
      review_id TEXT NOT NULL,
      proposal_id TEXT NOT NULL,
      action TEXT NOT NULL,
      reviewer TEXT NOT NULL,
      reason TEXT,
      before_payload TEXT,
      after_payload TEXT,
      idempotency_key TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(workspace_id, review_id),
      UNIQUE(workspace_id, proposal_id, idempotency_key),
      FOREIGN KEY(workspace_id, proposal_id) REFERENCES memory_review_proposals(workspace_id, proposal_id) ON DELETE CASCADE
    );
  `);
  const proposalColumns = store.raw.prepare('PRAGMA table_info(memory_review_proposals)').all();
  if (!proposalColumns.some(column => column.name === 'model_proposal')) store.raw.exec("ALTER TABLE memory_review_proposals ADD COLUMN model_proposal TEXT NOT NULL DEFAULT '{}'");
  if (!proposalColumns.some(column => column.name === 'intent')) store.raw.exec("ALTER TABLE memory_review_proposals ADD COLUMN intent TEXT NOT NULL DEFAULT '{}'");
  if (!proposalColumns.some(column => column.name === 'review_mode')) store.raw.exec("ALTER TABLE memory_review_proposals ADD COLUMN review_mode TEXT NOT NULL DEFAULT 'solution_profile_card'");
  const reviewColumns = store.raw.prepare('PRAGMA table_info(memory_review_reviews)').all();
  if (!reviewColumns.some(column => column.name === 'request_fingerprint')) store.raw.exec("ALTER TABLE memory_review_reviews ADD COLUMN request_fingerprint TEXT NOT NULL DEFAULT ''");
}

function relevantVersions(value = {}) {
  return {
    customer_revision: Number(value.customer_revision),
    opportunity_revision: Number(value.opportunity_revision),
    profile_version: Number(value.profile_version),
    latest_message_id: value.latest_message_id || null,
    latest_conversation_message_id: value.latest_conversation_message_id || null
  };
}

function sameVersions(left, right) {
  return JSON.stringify(relevantVersions(left)) === JSON.stringify(relevantVersions(right));
}

function currentVersions(store, workspaceId, opportunityId) {
  const { one, all, ensureOpportunity } = store._helpers;
  const opportunity = ensureOpportunity(workspaceId, opportunityId);
  const customer = one('SELECT revision,profile_version FROM customers WHERE workspace_id=? AND customer_id=?', workspaceId, opportunity.customer_id);
  const messages = all('SELECT * FROM messages WHERE workspace_id=? AND opportunity_id=? ORDER BY occurred_at,created_at,rowid', workspaceId, opportunityId)
    .filter(message => isContextMessage(message, opportunity.environment));
  const latestCustomer = messages.findLast(message => message.role === 'customer') || null;
  return {
    customer_revision: customer.revision,
    opportunity_revision: opportunity.revision,
    profile_version: customer.profile_version,
    latest_message_id: latestCustomer?.message_id || null,
    latest_conversation_message_id: messages.at(-1)?.message_id || null
  };
}

function mapProposal(store, row, includeReviews = false) {
  const proposal = {
    schema_version: 'memory-proposal.v1',
    proposal_id: row.proposal_id,
    customer_id: row.customer_id,
    opportunity_id: row.opportunity_id,
    environment: row.environment,
    status: row.status,
    facts: parse(row.facts, []),
    summary: parse(row.summary, {}),
    source_message_ids: parse(row.source_message_ids, []),
    context_versions: parse(row.context_versions, {}),
    original_proposal: parse(row.model_proposal, {}),
    intent: parse(row.intent, {}),
    review_mode: row.review_mode || 'solution_profile_card',
    trace: { provider: row.provider, workflow_run_id: row.workflow_run_id },
    revision: row.revision,
    reviewer: row.reviewer,
    rejection_reason: row.rejection_reason,
    approved_fact_ids: parse(row.approved_fact_ids, []),
    approved_summary_id: row.approved_summary_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    reviewed_at: row.reviewed_at
  };
  if (includeReviews) proposal.reviews = store._helpers.all(
    'SELECT review_id,action,reviewer,reason,before_payload,after_payload,created_at FROM memory_review_reviews WHERE workspace_id=? AND proposal_id=? ORDER BY created_at,rowid',
    row.workspace_id, row.proposal_id
  ).map(review => ({
    ...review,
    before_payload: parse(review.before_payload),
    after_payload: parse(review.after_payload)
  }));
  return proposal;
}

function candidatePayload(row) {
  return { facts: parse(row.facts, []), summary: parse(row.summary, {}) };
}

function normalizeStringList(value, field, status) {
  assertApi(Array.isArray(value), status, 'INVALID_MEMORY_PROPOSAL', `${field} 必须是数组。`, { field });
  assertApi(value.every(item => typeof item === 'string'), status, 'INVALID_MEMORY_PROPOSAL', `${field} 只能包含字符串。`, { field });
  const result = value.map(item => trimmed(item, 500)).filter(Boolean);
  assertApi(result.length === value.length && result.length <= 50, status, 'INVALID_MEMORY_PROPOSAL', `${field} 包含无效或过多内容。`, { field });
  return result;
}

function factEvidenceIsConfirmed(field, customerEvidenceText) {
  if (DIRECT_CONSTRAINT_FIELD.test(field)) return true;
  // A customer lowering an affordability ceiling (for example, “现在可能只能
  // 先考虑1万”) is actionable as a human-reviewed budget change even though
  // the wording is approximate. This is different from an unbounded guess such
  // as “预算可能一万，还没定”, which must still be discarded.
  if (/(?:^|_)(?:budget|annual_budget|annual_budget_amount|annual_budget_max|monthly_budget)(?:_|$)/.test(field)
      && /(?:只能|最多|上限).{0,8}(?:先)?考虑\s*[\d一二两三四五六七八九十百千万]+\s*(?:万|千)?(?:元)?/.test(customerEvidenceText)) return true;
  if (!UNSAFE_FACT_EVIDENCE.test(customerEvidenceText)) return true;
  const cue = FIELD_EVIDENCE_CUES.find(([fieldPattern]) => fieldPattern.test(field))?.[1];
  if (!cue) return false;
  // Judge uncertainty inside the clause that actually states this field. This
  // keeps an explicit profile fact such as “预算2万” when a different clause
  // says “但三年内可能用钱”, while still rejecting “预算可能1万，还没定”.
  return customerEvidenceText
    .split(/(?:[，。；;！？\n]|但|不过|可是)+/)
    .map(part => part.trim())
    .filter(Boolean)
    .some(part => cue.test(part) && !UNSAFE_FACT_EVIDENCE.test(part));
}

function validateMemoryPayload(store, workspaceId, opportunityId, rawFacts, rawSummary, errorStatus = 400) {
  const { one, all, ensureOpportunity } = store._helpers;
  const opportunity = ensureOpportunity(workspaceId, opportunityId);
  const customerId = opportunity.customer_id;
  const personIds = new Set(parse(opportunity.person_ids, []));
  assertApi(Array.isArray(rawFacts) && rawFacts.length <= 20, errorStatus, 'INVALID_MEMORY_PROPOSAL', 'facts 必须是最多 20 项的数组。');
  assertApi(object(rawSummary), errorStatus, 'INVALID_MEMORY_PROPOSAL', 'summary 必须是对象。');
  const messages = all('SELECT * FROM messages WHERE workspace_id=? AND opportunity_id=? ORDER BY occurred_at,created_at,rowid', workspaceId, opportunityId);
  const indexById = new Map(messages.map((message, index) => [message.message_id, index]));
  const rowById = new Map(messages.map(message => [message.message_id, message]));
  const validateEvidence = (ids, field, { requireCustomer = false } = {}) => {
    assertApi(Array.isArray(ids) && ids.length > 0 && ids.length <= 20 && new Set(ids).size === ids.length, errorStatus, 'INVALID_MEMORY_PROPOSAL', `${field} 必须包含不重复的证据消息。`, { field });
    let customerEvidence = false;
    for (const messageId of ids) {
      assertApi(typeof messageId === 'string' && messageId.length <= 200, errorStatus, 'INVALID_MEMORY_PROPOSAL', '证据消息标识无效。', { message_id: messageId });
      const message = rowById.get(messageId);
      assertApi(message && isContextMessage(message, opportunity.environment), errorStatus, 'MEMORY_EVIDENCE_INVALID', '证据必须来自当前需求、同环境的合格消息。', { message_id: messageId });
      if (message.role === 'customer') customerEvidence = true;
    }
    assertApi(!requireCustomer || customerEvidence, errorStatus, 'MEMORY_CUSTOMER_EVIDENCE_REQUIRED', '确认事实至少需要一条合格客户消息作为证据。');
    return [...ids];
  };

  const seenScopes = new Map();
  const facts = rawFacts.map((fact, index) => {
    assertApi(object(fact), errorStatus, 'INVALID_MEMORY_PROPOSAL', '事实提议必须是对象。', { index });
    assertApi(FACT_FIELD_RE.test(fact.field || ''), errorStatus, 'INVALID_MEMORY_PROPOSAL', '事实字段名无效。', { index });
    let serializedValue;
    try { serializedValue = json(fact.value); } catch {}
    assertApi(fact.value !== undefined && typeof serializedValue === 'string' && serializedValue.length <= 4000, errorStatus, 'INVALID_MEMORY_PROPOSAL', '事实值缺失、不可序列化或过长。', { index });
    assertApi(fact.status === 'proposed', errorStatus, 'INVALID_MEMORY_PROPOSAL', '模型只能提出 proposed 事实。', { index });
    assertApi(fact.opportunity_id === opportunityId, errorStatus, 'MEMORY_SCOPE_MISMATCH', '事实必须明确归属当前购买需求。', { index });
    const personId = fact.person_id || null;
    if (personId) {
      assertApi(personIds.has(personId) && one('SELECT 1 FROM persons WHERE workspace_id=? AND customer_id=? AND person_id=?', workspaceId, customerId, personId), errorStatus, 'MEMORY_PERSON_SCOPE_MISMATCH', '事实人物不属于当前购买需求。', { index, person_id: personId });
    }
    const evidenceMessageIds = validateEvidence(fact.evidence_message_ids, `facts[${index}].evidence_message_ids`, { requireCustomer: true });
    const customerEvidenceText = evidenceMessageIds.map(messageId => rowById.get(messageId)).filter(message => message.role === 'customer').map(message => message.text).join('\n');
    assertApi(factEvidenceIsConfirmed(fact.field, customerEvidenceText), errorStatus, 'MEMORY_FACT_NOT_CONFIRMED', '否定、待确定或对比表达不能直接成为确认事实。', { index });
    const scope = `${fact.field}\u0000${personId || ''}\u0000${opportunityId}`;
    assertApi(!seenScopes.has(scope), errorStatus, 'MEMORY_FACT_DUPLICATE', '同一候选不能重复提出相同作用域的事实。', { index, field: fact.field });
    seenScopes.set(scope, serializedValue);
    return { field: fact.field, value: fact.value, person_id: personId, opportunity_id: opportunityId, evidence_message_ids: evidenceMessageIds, status: 'proposed' };
  });

  const summaryText = trimmed(rawSummary.text, 8000);
  assertApi(summaryText && summaryText === String(rawSummary.text).trim(), errorStatus, 'INVALID_MEMORY_PROPOSAL', '摘要不能为空或超过 8000 字符。');
  const evidenceMessageIds = validateEvidence(rawSummary.evidence_message_ids, 'summary.evidence_message_ids');
  assertApi(typeof rawSummary.through_message_id === 'string', errorStatus, 'INVALID_MEMORY_PROPOSAL', '摘要必须包含覆盖边界。');
  const boundary = rowById.get(rawSummary.through_message_id);
  assertApi(boundary && isContextMessage(boundary, opportunity.environment), errorStatus, 'MEMORY_SUMMARY_BOUNDARY_INVALID', '摘要边界必须是当前需求、同环境的合格消息。');
  const boundaryIndex = indexById.get(rawSummary.through_message_id);
  for (const messageId of evidenceMessageIds) assertApi(indexById.get(messageId) <= boundaryIndex, errorStatus, 'MEMORY_SUMMARY_EVIDENCE_AFTER_BOUNDARY', '摘要证据不能晚于覆盖边界。', { message_id: messageId });
  const summary = {
    text: summaryText,
    through_message_id: rawSummary.through_message_id,
    evidence_message_ids: evidenceMessageIds,
    open_objections: normalizeStringList(rawSummary.open_objections || [], 'summary.open_objections', errorStatus),
    promises: normalizeStringList(rawSummary.promises || [], 'summary.promises', errorStatus)
  };
  const sourceMessageIds = [...new Set([
    ...facts.flatMap(fact => fact.evidence_message_ids),
    ...summary.evidence_message_ids,
    summary.through_message_id
  ])];
  return { facts, summary, sourceMessageIds, opportunity };
}

function validateModelProposal(store, workspaceId, opportunityId, proposal, context) {
  assertApi(object(proposal), 502, 'INVALID_MEMORY_PROPOSAL', '模型未返回记忆候选对象。');
  assertApi(proposal.schema_version === 'memory-proposal.v1', 502, 'INVALID_MEMORY_PROPOSAL', '模型记忆候选版本无效。');
  if (proposal.status === 'insufficient_evidence') throw new ApiError(422, 'MEMORY_PROPOSAL_INSUFFICIENT_EVIDENCE', '当前证据不足，未创建长期记忆候选。');
  if (proposal.status === 'error' || proposal.status === 'unavailable') {
    const balance = Array.isArray(proposal.missing_evidence) && proposal.missing_evidence.includes('DIFY_INSUFFICIENT_BALANCE');
    throw new ApiError(503, balance ? 'MEMORY_MODEL_BALANCE_INSUFFICIENT' : 'MEMORY_WORKFLOW_UNAVAILABLE',
      balance ? '记忆模型余额不足，后台提取已暂停。' : '记忆工作流暂时不可用，请稍后重试。');
  }
  assertApi(proposal.status === 'proposed', 502, 'INVALID_MEMORY_PROPOSAL', '模型记忆候选状态无效。');
  assertApi(sameVersions(proposal.context_versions, context.context_versions), 502, 'MEMORY_PROPOSAL_CONTEXT_MISMATCH', '模型返回的上下文版本与生成输入不一致。');
  assertApi(object(proposal.trace) && trimmed(proposal.trace.provider, 160) && trimmed(proposal.trace.workflow_run_id, 200), 502, 'INVALID_MEMORY_PROPOSAL', '模型候选必须包含提供商运行标识。');
  let modelProposalJson;
  try { modelProposalJson = json(proposal); } catch {}
  assertApi(typeof modelProposalJson === 'string' && modelProposalJson.length <= 200_000, 502, 'INVALID_MEMORY_PROPOSAL', '模型候选不可序列化或过大。');
  const contextMessages = new Map((Array.isArray(context.recent_messages) ? context.recent_messages : [])
    .map(message => [message?.message_id, message]));
  const rawModelFacts = Array.isArray(proposal.facts) ? proposal.facts : [];
  const safeModelFacts = rawModelFacts.filter(fact => {
    const field = String(fact?.field || '');
    const customerEvidenceText = (Array.isArray(fact?.evidence_message_ids) ? fact.evidence_message_ids : [])
      .map(messageId => contextMessages.get(messageId))
      .filter(message => message?.role === 'customer')
      .map(message => message.text)
      .join('\n');
    return factEvidenceIsConfirmed(field, customerEvidenceText);
  });
  // A mixed model response must not lose valid facts because one sibling fact
  // overreaches. If every fact is unsafe, keep the original list so the normal
  // fail-closed validation still rejects the proposal.
  const factsForValidation = safeModelFacts.length > 0 ? safeModelFacts : rawModelFacts;
  const validated = validateMemoryPayload(store, workspaceId, opportunityId, factsForValidation, proposal.summary, 502);
  const originalIntent = proposal.intent && typeof proposal.intent === 'object' && !Array.isArray(proposal.intent) ? proposal.intent : {};
  const intent = {
    level: ['unknown','low','medium','high'].includes(originalIntent.level) ? originalIntent.level : 'unknown',
    score: Number.isFinite(Number(originalIntent.score)) ? Math.max(0, Math.min(100, Math.round(Number(originalIntent.score)))) : 0,
    reason: trimmed(originalIntent.reason || '暂无明确购买行动信号', 1000),
    recommended_action: trimmed(originalIntent.recommended_action || 'continue_discovery', 120),
    preserve_current: originalIntent.preserve_current === true,
    signals: Array.isArray(originalIntent.signals) ? originalIntent.signals.slice(0, 20) : [],
    evidence_message_ids: Array.isArray(originalIntent.evidence_message_ids)
      ? [...new Set(originalIntent.evidence_message_ids.filter(messageId => validated.sourceMessageIds.includes(messageId)))] : []
  };
  const MATCH_IMPACT_FIELDS = new Set(['age','daughter_age','son_age','child_age','parent_age','spouse_age','budget','annual_budget','monthly_budget','funds_usage_years','payment_years','purpose','insured_person','relationship','liquidity_constraint',
    'insured_person_relationship','insured_person_age','purpose_code','annual_budget_amount','annual_budget_max']);
  const SENSITIVE_FIELDS = new Set(['health_status','medical_history','income','financial_account','minor_information']);
  const facts = validated.facts.map(fact => {
    const existing = store._helpers.all(`SELECT value,status FROM facts WHERE workspace_id=? AND customer_id=? AND field=? AND person_id IS ? AND opportunity_id IS ? AND status IN ('confirmed','conflicted')`,
      workspaceId, validated.opportunity.customer_id, fact.field, fact.person_id, fact.opportunity_id);
    const conflict = existing.some(row => row.status === 'conflicted' || row.value !== json(fact.value));
    return { ...fact, review_tier: conflict ? 'conflict' : SENSITIVE_FIELDS.has(fact.field) ? 'sensitive'
      : MATCH_IMPACT_FIELDS.has(fact.field) ? 'solution_impact' : 'observation' };
  });
  const reviewMode = facts.some(fact => fact.review_tier === 'conflict') ? 'conflict_review'
    : facts.some(fact => ['sensitive','solution_impact'].includes(fact.review_tier)) ? 'solution_profile_card'
      : 'observation_only';
  return {
    ...validated,
    facts,
    intent,
    reviewMode,
    modelProposalJson,
    provider: trimmed(proposal.trace.provider, 160),
    workflowRunId: trimmed(proposal.trace.workflow_run_id, 200)
  };
}

function insertReview(store, workspaceId, proposalId, action, reviewer, reason, beforePayload, afterPayload, idempotencyKey, fingerprint, at) {
  store._helpers.run(`INSERT INTO memory_review_reviews(workspace_id,review_id,proposal_id,action,reviewer,reason,before_payload,after_payload,idempotency_key,request_fingerprint,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, workspaceId, identifier('mrr'), proposalId, action, reviewer, reason || null, json(beforePayload), json(afterPayload), idempotencyKey, fingerprint, at);
}

function priorReview(store, workspaceId, proposalId, idempotencyKey, action, fingerprint) {
  const prior = store._helpers.one('SELECT * FROM memory_review_reviews WHERE workspace_id=? AND proposal_id=? AND idempotency_key=?', workspaceId, proposalId, idempotencyKey);
  if (!prior) return null;
  assertApi(prior.action === action && prior.request_fingerprint === fingerprint, 409, 'IDEMPOTENCY_KEY_REUSE', '审核幂等键已用于不同请求内容。', { idempotency_key: idempotencyKey });
  return prior;
}

function changedVersionFields(snapshot, current) {
  const before = relevantVersions(snapshot);
  const after = relevantVersions(current);
  return Object.keys(before).filter(field => before[field] !== after[field]);
}

function expireIfStale(store, workspaceId, row, now) {
  if (row.status !== 'pending') return row;
  const current = currentVersions(store, workspaceId, row.opportunity_id);
  const changed = changedVersionFields(parse(row.context_versions, {}), current);
  if (!changed.length) return row;
  const at = nowIso(now);
  transaction(store.raw, () => {
    const fresh = store._helpers.one('SELECT * FROM memory_review_proposals WHERE workspace_id=? AND proposal_id=?', workspaceId, row.proposal_id);
    if (fresh?.status !== 'pending') return;
    store._helpers.run(`UPDATE memory_review_proposals SET status='expired',revision=revision+1,updated_at=?,reviewed_at=?,rejection_reason=?
      WHERE workspace_id=? AND proposal_id=?`, at, at, `context_changed:${changed.join(',')}`, workspaceId, row.proposal_id);
    const expirationKey = `expire:${json(current)}`;
    insertReview(store, workspaceId, row.proposal_id, 'expired', 'system', `context_changed:${changed.join(',')}`, candidatePayload(fresh), candidatePayload(fresh), expirationKey,
      requestFingerprint({ action: 'expired', current }), at);
  });
  return store._helpers.one('SELECT * FROM memory_review_proposals WHERE workspace_id=? AND proposal_id=?', workspaceId, row.proposal_id);
}

function loadProposal(store, workspaceId, proposalId, now, { refresh = true } = {}) {
  let row = store._helpers.one('SELECT * FROM memory_review_proposals WHERE workspace_id=? AND proposal_id=?', workspaceId, proposalId);
  assertApi(row, 404, 'MEMORY_PROPOSAL_NOT_FOUND', '记忆候选不存在。');
  if (refresh) row = expireIfStale(store, workspaceId, row, now);
  return row;
}

function requirePending(row) {
  if (row.status === 'expired') throw new ApiError(409, 'MEMORY_PROPOSAL_EXPIRED', '生成候选后上下文已变化，请重新生成。', { current_revision: row.revision, reason: row.rejection_reason });
  assertApi(row.status === 'pending', 409, 'MEMORY_PROPOSAL_NOT_PENDING', '只有待确认候选可以执行该操作。', { current_status: row.status });
}

function reviewer(input) {
  const raw = String(input.reviewer ?? '').trim();
  assertApi(raw && raw.length <= 160, 400, 'REVIEWER_REQUIRED', '审核操作必须记录不超过 160 字符的 reviewer。');
  const value = raw;
  return value;
}

function idempotencyKey(input) {
  const raw = String(input.idempotency_key ?? '').trim();
  assertApi(raw && raw.length <= 200, 400, 'IDEMPOTENCY_KEY_REQUIRED', '写操作必须带不超过 200 字符的幂等键。');
  const value = raw;
  return value;
}

function assertExpectedRevision(row, value) {
  assertApi(Number(value) === row.revision, 409, 'REVISION_CONFLICT', '记忆候选版本已变更。', { current_revision: row.revision });
}

function preflightFactConflicts(store, workspaceId, customerId, facts) {
  for (const fact of facts) {
    const rows = store._helpers.all(`SELECT fact_id,value,status FROM facts
      WHERE workspace_id=? AND customer_id=? AND field=? AND person_id IS ? AND opportunity_id IS ? AND status IN ('confirmed','conflicted')`,
    workspaceId, customerId, fact.field, fact.person_id, fact.opportunity_id);
    const serialized = json(fact.value);
    const conflicting = rows.find(row => row.status === 'conflicted' || row.value !== serialized);
    assertApi(!conflicting, 409, 'MEMORY_FACT_CONFLICT', '候选事实与现有记忆冲突，必须人工编辑或驳回。', { field: fact.field, fact_id: conflicting?.fact_id || null });
  }
}

function factMatchesOriginal(fact, originalFacts) {
  return originalFacts.some(original => original?.field === fact.field
    && (original.person_id || null) === (fact.person_id || null)
    && original.opportunity_id === fact.opportunity_id
    && JSON.stringify(canonical(original.value)) === JSON.stringify(canonical(fact.value)));
}

export function createMemoryReviewApi({ store, proposeMemory = null, readJson, sendJson, now = () => new Date() }) {
  assertApi(store?.raw && store?._helpers, 500, 'MEMORY_REVIEW_STORE_REQUIRED', '记忆审核服务需要数据库。');
  assertApi(typeof readJson === 'function' && typeof sendJson === 'function', 500, 'MEMORY_REVIEW_HTTP_REQUIRED', '记忆审核服务缺少 HTTP 依赖。');
  createSchema(store);
  const profileFields = new Set(['insured_person_relationship', 'insured_person_age', 'purpose_code', 'annual_budget_amount']);
  const relationshipCode = value => ({
    '本人': 'self', self: 'self', '妈妈': 'mother', '母亲': 'mother', mother: 'mother',
    '爸爸': 'father', '父亲': 'father', father: 'father', '孩子': 'child', child: 'child',
    '儿子': 'son', son: 'son', '女儿': 'daughter', daughter: 'daughter', '配偶': 'spouse', spouse: 'spouse'
  })[String(value || '').trim()] || null;
  const relationshipName = { self: '本人', mother: '妈妈', father: '爸爸', child: '孩子', son: '儿子', daughter: '女儿', spouse: '配偶' };

  function applyApprovedProfile(ws, row, facts) {
    let opportunity = store._helpers.ensureOpportunity(ws, row.opportunity_id);
    const relationshipFact = facts.find(fact => fact.field === 'insured_person_relationship');
    const ageFact = facts.find(fact => fact.field === 'insured_person_age');
    const purposeFact = facts.find(fact => fact.field === 'purpose_code');
    const budgetFact = facts.find(fact => fact.field === 'annual_budget_amount');
    const changes = {};
    let insuredPersonId = null;
    const peopleByRelationship = new Map();
    const ensurePerson = relationship => {
      if (!relationship || !relationshipName[relationship]) return null;
      if (peopleByRelationship.has(relationship)) return peopleByRelationship.get(relationship);
      const people = store._helpers.all('SELECT * FROM persons WHERE workspace_id=? AND customer_id=? ORDER BY created_at,rowid', ws, row.customer_id);
      const existing = people.find(person => relationshipCode(person.relationship) === relationship);
      const personId = existing?.person_id || store.addPerson(ws, row.customer_id, {
        relationship,
        name: relationshipName[relationship]
      }).person_id;
      peopleByRelationship.set(relationship, personId);
      return personId;
    };
    const scopedRelationshipFacts = facts.filter(fact => /^person_relationship_(self|mother|father|child|son|daughter|spouse)$/.test(fact.field));
    const scopedAgeFacts = facts.filter(fact => /^person_age_(self|mother|father|child|son|daughter|spouse)$/.test(fact.field));
    for (const fact of scopedRelationshipFacts) ensurePerson(relationshipCode(fact.value) || fact.field.slice('person_relationship_'.length));
    const relationship = relationshipCode(relationshipFact?.value);
    if (relationship) {
      insuredPersonId = relationshipFact?.person_id || ensurePerson(relationship);
      changes.person_ids = [insuredPersonId];
    } else {
      const linked = parse(opportunity.person_ids, []);
      if (linked.length === 1) insuredPersonId = linked[0];
    }
    if (purposeFact && typeof purposeFact.value === 'string') changes.purpose = purposeFact.value;
    if (budgetFact && Number.isFinite(Number(budgetFact.value))) {
      changes.budget_amount = Number(budgetFact.value);
      changes.budget_currency = 'CNY';
    }
    if (Object.keys(changes).length) opportunity = store.patchOpportunity(ws, row.opportunity_id, opportunity.revision, changes);

    const memoryFacts = facts.filter(fact => !profileFields.has(fact.field)
      && !/^person_(?:relationship|age)_(?:self|mother|father|child|son|daughter|spouse)$/.test(fact.field));
    const addPersonFact = fact => {
      const duplicate = memoryFacts.find(item => item.field === fact.field && item.person_id === fact.person_id);
      if (!duplicate) memoryFacts.push(fact);
      else if (duplicate.value === fact.value) {
        duplicate.evidence_message_ids = [...new Set([...duplicate.evidence_message_ids, ...fact.evidence_message_ids])];
      }
    };
    for (const fact of scopedRelationshipFacts) {
      const relationship = relationshipCode(fact.value) || fact.field.slice('person_relationship_'.length);
      const personId = ensurePerson(relationship);
      if (personId) addPersonFact({ ...fact, field: 'relationship', value: relationship, person_id: personId });
    }
    for (const fact of scopedAgeFacts) {
      const relationship = fact.field.slice('person_age_'.length);
      const personId = ensurePerson(relationship);
      if (personId) addPersonFact({ ...fact, field: 'age', person_id: personId });
    }
    if (ageFact) {
      assertApi(insuredPersonId, 400, 'PROFILE_PERSON_REQUIRED', '年龄候选必须先绑定本次需求的被保人。');
      addPersonFact({ ...ageFact, field: 'age', person_id: insuredPersonId });
    }
    const liquidityFact = memoryFacts.find(fact => fact.field === 'liquidity_constraint');
    const hasUsageHorizon = memoryFacts.some(fact => fact.field === 'funds_usage_years');
    if (liquidityFact?.value === 'may_need_within_3_years' && !hasUsageHorizon) {
      memoryFacts.push({
        ...liquidityFact,
        field: 'funds_usage_years',
        value: 3,
        person_id: null
      });
    }
    return { opportunity, facts: memoryFacts };
  }
  const ok = (res, data, traceId, status = 200) => sendJson(res, status, { data, trace_id: traceId });
  const workspace = req => {
    const value = String(req.headers['x-workspace-id'] || 'demo');
    assertApi(WORKSPACE_RE.test(value), 400, 'INVALID_WORKSPACE_ID', 'workspace_id 格式无效。');
    return value;
  };
  const body = async req => {
    try {
      const value = await readJson(req, 1_000_000);
      assertApi(object(value), 400, 'INVALID_JSON', '请求 JSON 必须是对象。');
      return value;
    }
    catch (error) { throw new ApiError(error.message === 'REQUEST_TOO_LARGE' ? 413 : 400, 'INVALID_JSON', '请求 JSON 无效或过大。'); }
  };

  async function generateProposal(ws, opportunityId, input = {}) {
    assertApi(WORKSPACE_RE.test(String(ws || '')), 400, 'INVALID_WORKSPACE_ID', 'workspace_id 格式无效。');
    assertApi(typeof proposeMemory === 'function', 503, 'MEMORY_MODEL_NOT_CONFIGURED', '长期记忆提议模型尚未配置；未使用模板冒充模型。');
    const key = idempotencyKey(input);
    const context = buildContext(store, ws, opportunityId, {
      traceId: input.trace_id || null, sessionId: input.session_id || null,
      caseId: input.case_id || null, evalRunId: input.eval_run_id || null
    });
    if (input.latest_message_id !== undefined) {
      assertApi(input.latest_message_id === context.latest_message_id, 409, 'MEMORY_PROPOSAL_STALE', '后台记忆请求的客户消息已变化，未调用模型。');
      assertApi(!key.startsWith('background-memory:') || key === `background-memory:${input.latest_message_id}`,
        409, 'IDEMPOTENCY_KEY_REUSE', '后台记忆幂等键与请求消息不一致。');
    }
    const existing = store._helpers.one('SELECT * FROM memory_review_proposals WHERE workspace_id=? AND opportunity_id=? AND generation_key=?', ws, opportunityId, key);
    if (existing) {
      assertApi(input.latest_message_id === undefined || parse(existing.context_versions, {}).latest_message_id === input.latest_message_id,
        409, 'IDEMPOTENCY_KEY_REUSE', '记忆幂等键已用于另一条客户消息。');
      const refreshed = expireIfStale(store, ws, existing, now);
      return { ...mapProposal(store, refreshed, true), idempotent_replay: true };
    }
    let modelProposal;
    try { modelProposal = await proposeMemory(context); }
    catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(502, 'MEMORY_PROPOSAL_FAILED', '长期记忆提议生成失败，请稍后重试。');
    }
    const validated = validateModelProposal(store, ws, opportunityId, modelProposal, context);
    const current = currentVersions(store, ws, opportunityId);
    assertApi(sameVersions(context.context_versions, current), 409, 'MEMORY_PROPOSAL_STALE', '生成期间上下文已变化，候选未保存。', { current_versions: current });
    const proposalId = identifier('mrp');
    const at = nowIso(now);
    const initialStatus = !requiresSalesConfirmation(ws) && validated.reviewMode === 'observation_only' ? 'observed' : 'pending';
    try {
      store._helpers.run(`INSERT INTO memory_review_proposals(workspace_id,proposal_id,customer_id,opportunity_id,environment,generation_key,status,facts,summary,source_message_ids,context_versions,model_proposal,intent,review_mode,provider,workflow_run_id,revision,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`, ws, proposalId, context.customer_id, opportunityId, context.environment, key, initialStatus,
      json(validated.facts), json(validated.summary), json(validated.sourceMessageIds), json(relevantVersions(context.context_versions)), validated.modelProposalJson,
      json(validated.intent), validated.reviewMode, validated.provider, validated.workflowRunId, at, at);
    } catch (error) {
      const replay = store._helpers.one('SELECT * FROM memory_review_proposals WHERE workspace_id=? AND opportunity_id=? AND generation_key=?', ws, opportunityId, key);
      if (replay) return { ...mapProposal(store, replay, true), idempotent_replay: true };
      throw error;
    }
    const intentOpportunity = requiresSalesConfirmation(ws) || validated.intent.preserve_current
      ? store._helpers.ensureOpportunity(ws, opportunityId)
      : store.recordOpportunityIntent(ws, opportunityId, { ...validated.intent, source: 'b1_intent' });
    // Direct human-contact requests are applied synchronously when the customer
    // message is ingested. The background B1 pass may describe the same signal,
    // but must neither overwrite the existing commercial intent nor create a
    // duplicate operational task for it.
    if (!requiresSalesConfirmation(ws) && !store._helpers.ensureCustomer(ws, context.customer_id).marketing_opt_out
      && !validated.intent.preserve_current && ['human_close', 'follow_up'].includes(validated.intent.recommended_action)) {
      const future = validated.intent.reason === 'future_follow_up_timing';
      const due = new Date(at);
      due.setUTCDate(due.getUTCDate() + (future ? 180 : 0));
      const taskEvidenceId = validated.intent.evidence_message_ids?.at(-1) || proposalId;
      store.createTask(ws, {
        customer_id: intentOpportunity.customer_id,
        opportunity_id: opportunityId,
        owner: 'sales',
        title: future ? '按客户约定时间回访' : '优先处理客户行动信号',
        reason: validated.intent.reason || validated.intent.recommended_action,
        due_at: due.toISOString(),
        idempotency_key: `intent-task:${opportunityId}:${taskEvidenceId}`
      });
    }
    const saved = store._helpers.one('SELECT * FROM memory_review_proposals WHERE workspace_id=? AND proposal_id=?', ws, proposalId);
    return { ...mapProposal(store, saved, true), idempotent_replay: false };
  }

  function findProposal(ws, opportunityId, generationKey) {
    assertApi(WORKSPACE_RE.test(String(ws || '')), 400, 'INVALID_WORKSPACE_ID', 'workspace_id 格式无效。');
    const row = store._helpers.one('SELECT * FROM memory_review_proposals WHERE workspace_id=? AND opportunity_id=? AND generation_key=?', ws, opportunityId, generationKey);
    if (!row) return null;
    return mapProposal(store, expireIfStale(store, ws, row, now), true);
  }

  const routeMemoryReview = async function routeMemoryReview(req, res, url = new URL(req.url, 'http://127.0.0.1')) {
    if (!url.pathname.startsWith('/api/v2/memory-review/')) return false;
    const traceId = `trace_${randomUUID()}`;
    try {
      const ws = workspace(req);
      let match;
      if ((match = url.pathname.match(/^\/api\/v2\/memory-review\/opportunities\/([^/]+)\/proposals$/)) && req.method === 'POST') {
        const opportunityId = decodeURIComponent(match[1]);
        const input = await body(req);
        const result = await generateProposal(ws, opportunityId, input);
        return ok(res, result, traceId, result.idempotent_replay ? 200 : 201), true;
      }

      if (url.pathname === '/api/v2/memory-review/proposals' && req.method === 'GET') {
        const status = url.searchParams.get('status');
        const opportunityId = url.searchParams.get('opportunity_id');
        assertApi(!status || ['pending', ...FINAL_STATUSES].includes(status), 400, 'INVALID_MEMORY_STATUS', '记忆候选状态筛选无效。');
        let rows = store._helpers.all('SELECT * FROM memory_review_proposals WHERE workspace_id=? ORDER BY created_at DESC,rowid DESC', ws);
        rows = rows.map(row => expireIfStale(store, ws, row, now));
        if (status) rows = rows.filter(row => row.status === status);
        if (opportunityId) rows = rows.filter(row => row.opportunity_id === opportunityId);
        return ok(res, rows.map(row => mapProposal(store, row)), traceId), true;
      }

      if ((match = url.pathname.match(/^\/api\/v2\/memory-review\/proposals\/([^/]+)$/)) && req.method === 'GET') {
        const row = loadProposal(store, ws, decodeURIComponent(match[1]), now);
        return ok(res, mapProposal(store, row, true), traceId), true;
      }

      if (match && req.method === 'PATCH') {
        const proposalId = decodeURIComponent(match[1]);
        const input = await body(req);
        const key = idempotencyKey(input);
        const actor = reviewer(input);
        const reason = trimmed(input.reason, 1000) || null;
        const fingerprint = requestFingerprint({
          action: 'edited', expected_revision: Number(input.expected_revision), reviewer: actor, reason,
          facts: Object.hasOwn(input, 'facts') ? input.facts : { __omitted: true },
          summary: Object.hasOwn(input, 'summary') ? input.summary : { __omitted: true }
        });
        const prior = priorReview(store, ws, proposalId, key, 'edited', fingerprint);
        if (prior) return ok(res, { ...mapProposal(store, loadProposal(store, ws, proposalId, now, { refresh: false }), true), idempotent_replay: true }, traceId), true;
        let row = loadProposal(store, ws, proposalId, now);
        requirePending(row);
        assertExpectedRevision(row, input.expected_revision);
        assertApi(input.facts !== undefined || input.summary !== undefined, 400, 'MEMORY_EDIT_REQUIRED', '编辑必须提供 facts 或 summary。');
        const before = candidatePayload(row);
        const validated = validateMemoryPayload(store, ws, row.opportunity_id, input.facts ?? before.facts, input.summary ?? before.summary);
        const at = nowIso(now);
        transaction(store.raw, () => {
          row = loadProposal(store, ws, proposalId, now, { refresh: false });
          requirePending(row);
          assertExpectedRevision(row, input.expected_revision);
          store._helpers.run(`UPDATE memory_review_proposals SET facts=?,summary=?,source_message_ids=?,revision=revision+1,updated_at=? WHERE workspace_id=? AND proposal_id=?`,
            json(validated.facts), json(validated.summary), json(validated.sourceMessageIds), at, ws, proposalId);
          insertReview(store, ws, proposalId, 'edited', actor, reason, before, { facts: validated.facts, summary: validated.summary }, key, fingerprint, at);
        });
        return ok(res, { ...mapProposal(store, loadProposal(store, ws, proposalId, now, { refresh: false }), true), idempotent_replay: false }, traceId), true;
      }

      if ((match = url.pathname.match(/^\/api\/v2\/memory-review\/proposals\/([^/]+)\/approve$/)) && req.method === 'POST') {
        const proposalId = decodeURIComponent(match[1]);
        const input = await body(req);
        const key = idempotencyKey(input);
        const actor = reviewer(input);
        const reason = trimmed(input.reason, 1000) || null;
        const fingerprint = requestFingerprint({ action: 'approved', expected_revision: Number(input.expected_revision), reviewer: actor, reason });
        const prior = priorReview(store, ws, proposalId, key, 'approved', fingerprint);
        if (prior) return ok(res, { ...mapProposal(store, loadProposal(store, ws, proposalId, now, { refresh: false }), true), idempotent_replay: true }, traceId), true;
        let row = loadProposal(store, ws, proposalId, now);
        requirePending(row);
        assertExpectedRevision(row, input.expected_revision);
        const payload = candidatePayload(row);
        const validated = validateMemoryPayload(store, ws, row.opportunity_id, payload.facts, payload.summary);
        const originalFacts = parse(row.model_proposal, {}).facts || [];
        const at = nowIso(now);
        transaction(store.raw, () => {
          row = loadProposal(store, ws, proposalId, now, { refresh: false });
          requirePending(row);
          assertExpectedRevision(row, input.expected_revision);
          const current = currentVersions(store, ws, row.opportunity_id);
          assertApi(sameVersions(parse(row.context_versions, {}), current), 409, 'MEMORY_PROPOSAL_EXPIRED', '生成候选后上下文已变化，请重新生成。', { current_versions: current });
          const approvedProfile = applyApprovedProfile(ws, row, validated.facts);
          preflightFactConflicts(store, ws, row.customer_id, approvedProfile.facts);
          if (approvedProfile.facts.length) {
            const customer = store._helpers.ensureCustomer(ws, row.customer_id);
            store.patchCustomer(ws, row.customer_id, customer.revision, {
              fact_changes: approvedProfile.facts.map((fact, index) => ({
                ...fact,
                idempotency_key: `memory-review:${proposalId}:fact:${index}`,
                status: 'confirmed',
                source: factMatchesOriginal(fact, originalFacts) ? 'message' : 'human'
              }))
            });
          }
          const candidateIntent = parse(row.intent, {});
          if (requiresSalesConfirmation(ws) && !candidateIntent.preserve_current) {
            store.recordOpportunityIntent(ws, row.opportunity_id, { ...candidateIntent, source: 'sales_confirmed_b1' });
          }
          const opportunity = store._helpers.ensureOpportunity(ws, row.opportunity_id);
          const summaryResult = store.addSummary(ws, row.opportunity_id, {
            ...validated.summary,
            expected_revision: opportunity.revision,
            idempotency_key: `memory-review:${proposalId}:summary`,
            status: 'confirmed'
          });
          const factIds = approvedProfile.facts.map((_, index) => store._helpers.one(
            'SELECT fact_id FROM facts WHERE workspace_id=? AND customer_id=? AND idempotency_key=?', ws, row.customer_id, `memory-review:${proposalId}:fact:${index}`
          )?.fact_id).filter(Boolean);
          store._helpers.run(`UPDATE memory_review_proposals SET status='approved',reviewer=?,approved_fact_ids=?,approved_summary_id=?,revision=revision+1,updated_at=?,reviewed_at=?
            WHERE workspace_id=? AND proposal_id=?`, actor, json(factIds), summaryResult.summary.summary_id, at, at, ws, proposalId);
          insertReview(store, ws, proposalId, 'approved', actor, reason, payload,
            { facts: approvedProfile.facts, summary: validated.summary, approved_fact_ids: factIds, approved_summary_id: summaryResult.summary.summary_id }, key, fingerprint, at);
        });
        return ok(res, { ...mapProposal(store, loadProposal(store, ws, proposalId, now, { refresh: false }), true), idempotent_replay: false }, traceId), true;
      }

      if ((match = url.pathname.match(/^\/api\/v2\/memory-review\/proposals\/([^/]+)\/reject$/)) && req.method === 'POST') {
        const proposalId = decodeURIComponent(match[1]);
        const input = await body(req);
        const key = idempotencyKey(input);
        const actor = reviewer(input);
        const reason = trimmed(input.reason, 1000);
        assertApi(reason, 400, 'REJECTION_REASON_REQUIRED', '驳回必须记录原因。');
        const fingerprint = requestFingerprint({ action: 'rejected', expected_revision: Number(input.expected_revision), reviewer: actor, reason });
        const prior = priorReview(store, ws, proposalId, key, 'rejected', fingerprint);
        if (prior) return ok(res, { ...mapProposal(store, loadProposal(store, ws, proposalId, now, { refresh: false }), true), idempotent_replay: true }, traceId), true;
        let row = loadProposal(store, ws, proposalId, now);
        requirePending(row);
        assertExpectedRevision(row, input.expected_revision);
        const before = candidatePayload(row);
        const at = nowIso(now);
        transaction(store.raw, () => {
          row = loadProposal(store, ws, proposalId, now, { refresh: false });
          requirePending(row);
          assertExpectedRevision(row, input.expected_revision);
          store._helpers.run(`UPDATE memory_review_proposals SET status='rejected',reviewer=?,rejection_reason=?,revision=revision+1,updated_at=?,reviewed_at=? WHERE workspace_id=? AND proposal_id=?`,
            actor, reason, at, at, ws, proposalId);
          insertReview(store, ws, proposalId, 'rejected', actor, reason, before, before, key, fingerprint, at);
        });
        return ok(res, { ...mapProposal(store, loadProposal(store, ws, proposalId, now, { refresh: false }), true), idempotent_replay: false }, traceId), true;
      }

      throw new ApiError(404, 'NOT_FOUND', '接口不存在。');
    } catch (error) {
      const known = error instanceof ApiError;
      if (!known) console.error(`[${traceId}] memory review failed: ${error.name}: ${error.message}`);
      sendJson(res, known ? error.status : 500, {
        error: {
          code: known ? error.code : 'INTERNAL_ERROR',
          message: known ? error.message : '服务器处理失败。',
          details: known ? error.details : null
        },
        trace_id: traceId
      });
      return true;
    }
  };
  routeMemoryReview.generateProposal = generateProposal;
  routeMemoryReview.findProposal = findProposal;
  return routeMemoryReview;
}
