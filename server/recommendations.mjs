import { createHash, randomUUID } from 'node:crypto';
import { assertApi } from './errors.mjs';
import { buildContext } from './context.mjs';

const json = value => JSON.stringify(value);
const parse = value => value == null ? null : JSON.parse(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const fingerprint = value => createHash('sha256').update(json(canonical(value))).digest('hex');
const same = (a, b) => fingerprint(a) === fingerprint(b);
const stableAcceptanceVersions = value => ({
  customer_revision: value?.customer_revision ?? null,
  opportunity_revision: value?.opportunity_revision ?? null,
  profile_version: value?.profile_version ?? null
});
const STATES = new Set(['ready', 'needs_information', 'not_matched', 'needs_source', 'human_required', 'unavailable', 'invalid_output']);
const key = input => {
  assertApi(typeof input?.idempotency_key === 'string' && input.idempotency_key.trim() && input.idempotency_key.length <= 160,
    400, 'IDEMPOTENCY_KEY_REQUIRED', '请提供不超过160字的幂等键。');
  return input.idempotency_key;
};
function activeContact(context) {
  assertApi(!context.contact_state?.marketing_opt_out, 409, 'MARKETING_OPT_OUT', '客户已拒收营销，不继续推荐。');
  assertApi(!context.contact_state?.human_handoff, 409, 'HUMAN_HANDOFF_ACTIVE', '当前由人工处理，不继续推荐。');
  assertApi(!context.contact_state?.purchased_for_opportunity, 409, 'PURCHASED_OPPORTUNITY', '当前需求已购买，请进入服务或创建新的购买需求。');
}
function atomic(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = work(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

/** Stored recommendations are snapshots, not model-written customer/product decisions. */
export function createRecommendationService({ store, evaluate, generate, putCase = null, now = () => new Date() }) {
  const db = store.raw;
  db.exec(`
    CREATE TABLE IF NOT EXISTS recommendations (
      workspace_id TEXT NOT NULL, recommendation_id TEXT NOT NULL, opportunity_id TEXT NOT NULL,
      customer_id TEXT NOT NULL, environment TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      result_json TEXT NOT NULL, rules_json TEXT NOT NULL, context_versions TEXT NOT NULL,
      catalog_fingerprint TEXT NOT NULL, generation_key TEXT NOT NULL, generation_fingerprint TEXT NOT NULL,
      accepted_context_versions TEXT, selection_json TEXT, reviewer TEXT, reason TEXT,
      revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(workspace_id,recommendation_id), UNIQUE(workspace_id,opportunity_id,generation_key),
      FOREIGN KEY(workspace_id,opportunity_id) REFERENCES opportunities(workspace_id,opportunity_id)
    );
    CREATE TABLE IF NOT EXISTS recommendation_decisions (
      workspace_id TEXT NOT NULL, recommendation_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL, action TEXT NOT NULL, reviewer TEXT NOT NULL, reason TEXT,
      before_json TEXT NOT NULL, after_json TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(workspace_id,recommendation_id,idempotency_key)
    );
  `);
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const rowFor = (ws, rid) => {
    const row = one('SELECT * FROM recommendations WHERE workspace_id=? AND recommendation_id=?', ws, rid);
    assertApi(row, 404, 'RECOMMENDATION_NOT_FOUND', '推荐记录不存在。');
    return row;
  };
  const contextFor = (ws, oid, telemetry = {}) => buildContext(store, ws, oid, { asOf: now().toISOString(), ...telemetry });
  const current = row => {
    const context = contextFor(row.workspace_id, row.opportunity_id);
    const rules = evaluate(context);
    const versions = parse(row.status === 'accepted' ? row.accepted_context_versions : row.context_versions);
    // Pending recommendations are point-in-time proposals: any new message must
    // invalidate them before a human accepts one. Once accepted, ordinary chat
    // turns must not silently remove the confirmed product from the sales
    // context. Only customer/profile/opportunity changes (or catalog changes)
    // require a new product confirmation.
    const expectedVersions = row.status === 'accepted' ? stableAcceptanceVersions(versions) : versions;
    const actualVersions = row.status === 'accepted' ? stableAcceptanceVersions(context.context_versions) : context.context_versions;
    const stale = !same(expectedVersions, actualVersions) || row.catalog_fingerprint !== rules.catalog_fingerprint
      || row.environment !== context.environment;
    return { context, rules, stale };
  };
  const dto = (row, { checkFreshness = true } = {}) => ({
    recommendation_id: row.recommendation_id, opportunity_id: row.opportunity_id, customer_id: row.customer_id,
    environment: row.environment, status: row.status, revision: row.revision,
    result: parse(row.result_json), context_versions: parse(row.context_versions),
    catalog_fingerprint: row.catalog_fingerprint, selection: parse(row.selection_json),
    reviewer: row.reviewer, reason: row.reason,
    stale: checkFreshness && row.status !== 'rejected' ? current(row).stale : false,
    created_at: row.created_at, updated_at: row.updated_at
  });
  const validateResult = (result, context, rules) => {
    assertApi(result?.schema_version === 'product-match.v1' && STATES.has(result.status) && Array.isArray(result.candidates),
      502, 'INVALID_MATCH_RESULT', '匹配工作流返回结构无效。');
    assertApi(same(result.context_versions, context.context_versions) && result.catalog_fingerprint === rules.catalog_fingerprint,
      502, 'MATCH_SNAPSHOT_MISMATCH', '工作流返回的画像或产品目录版本不匹配。');
    const seen = new Set();
    for (const candidate of result.candidates) {
      const basis = rules.candidates.find(item => item.candidate_id === candidate.candidate_id);
      assertApi(basis && !seen.has(candidate.candidate_id)
        && candidate.product_id === basis.product_id && candidate.product_version === basis.product_version
        && candidate.status === basis.status && same(candidate.citations, basis.citations)
        && same(candidate.allowed_payment_years, basis.allowed_payment_years),
      502, 'MATCH_RULES_CHANGED_BY_MODEL', '模型不能新增产品、改写规则判断或产品证据。');
      seen.add(candidate.candidate_id);
    }
    if (result.status === 'ready') assertApi(result.candidates.some(item => item.status === 'eligible_for_discussion'),
      502, 'MATCH_WITHOUT_ELIGIBLE_CANDIDATE', '没有可讨论方案，不能返回可采纳推荐。');
  };
  const service = {
    async generate(ws, oid, input = {}) {
      let generationKey = key(input);
      // Trace/session/evaluation ids are telemetry, not recommendation inputs.
      // Retries of the same semantic request may legitimately carry a new
      // trace, so they must still replay the original recommendation.
      const requestFingerprint = fingerprint({
        latest_message_id: input.latest_message_id,
        expected_revision: input.expected_revision,
        expected_context_versions: input.expected_context_versions
      });
      store._helpers.ensureOpportunity(ws, oid);
      let prior = one('SELECT * FROM recommendations WHERE workspace_id=? AND opportunity_id=? AND generation_key=?', ws, oid, generationKey);
      if (prior) {
        const priorVersions = parse(prior.context_versions) || {};
        const sameSemanticRequest = input.latest_message_id === priorVersions.latest_message_id
          && Number(input.expected_revision) === Number(priorVersions.opportunity_revision)
          && (input.expected_context_versions === undefined || same(input.expected_context_versions, priorVersions));
        assertApi(sameSemanticRequest, 409, 'IDEMPOTENCY_KEY_REUSE', '幂等键已用于不同生成请求。');
        const priorState = dto(prior);
        if (!priorState.stale) return { ...priorState, idempotent_replay: true };
        // A catalog release can stale a pending recommendation without changing
        // the conversation/profile versions. Regenerate under a deterministic
        // catalog-scoped key so a retry sees the new approved rules.
        const currentCatalog = current(prior).rules.catalog_fingerprint;
        generationKey = `${generationKey.slice(0, 140)}:catalog:${currentCatalog.slice(0, 12)}`;
        prior = one('SELECT * FROM recommendations WHERE workspace_id=? AND opportunity_id=? AND generation_key=?', ws, oid, generationKey);
        if (prior) return { ...dto(prior), idempotent_replay: true };
      }
      const context = contextFor(ws, oid, {
        traceId: input.trace_id || null, sessionId: input.session_id || null,
        caseId: input.case_id || null, evalRunId: input.eval_run_id || null
      });
      activeContact(context);
      assertApi(input.latest_message_id === context.latest_message_id && Number(input.expected_revision) === context.context_versions.opportunity_revision,
        409, 'STALE_CONTEXT', '消息或需求已经变化，请刷新后重试。');
      assertApi(input.expected_context_versions === undefined || same(input.expected_context_versions, context.context_versions),
        409, 'STALE_CONTEXT', '记忆审核期间画像或会话版本已变化，请刷新上下文后重试。');
      const rules = evaluate(context);
      const result = await generate(context, rules);
      validateResult(result, context, rules);
      return atomic(db, () => {
        const newest = contextFor(ws, oid);
        const newestRules = evaluate(newest);
        activeContact(newest);
        assertApi(same(context.context_versions, newest.context_versions) && context.environment === newest.environment
          && rules.catalog_fingerprint === newestRules.catalog_fingerprint,
        409, 'STALE_CONTEXT', '生成期间客户信息或产品规则变化，请重新生成。');
        const concurrent = one('SELECT * FROM recommendations WHERE workspace_id=? AND opportunity_id=? AND generation_key=?', ws, oid, generationKey);
        if (concurrent) {
          assertApi(concurrent.generation_fingerprint === requestFingerprint, 409, 'IDEMPOTENCY_KEY_REUSE', '并行请求复用了不同内容的幂等键。');
          return { ...dto(concurrent), idempotent_replay: true };
        }
        const rid = `recommendation_${randomUUID()}`;
        const at = now().toISOString();
        db.prepare(`INSERT INTO recommendations(workspace_id,recommendation_id,opportunity_id,customer_id,environment,
          result_json,rules_json,context_versions,catalog_fingerprint,generation_key,generation_fingerprint,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(ws, rid, oid, context.customer_id, context.environment,
          json(result), json(rules), json(context.context_versions), rules.catalog_fingerprint, generationKey, requestFingerprint, at, at);
        return { ...dto(rowFor(ws, rid)), idempotent_replay: false };
      });
    },
    get(ws, rid) { return dto(rowFor(ws, rid)); },
    list(ws, oid) {
      store._helpers.ensureOpportunity(ws, oid);
      return db.prepare('SELECT * FROM recommendations WHERE workspace_id=? AND opportunity_id=? ORDER BY created_at DESC,rowid DESC').all(ws, oid).map(row => dto(row));
    },
    listAll(ws, filters = {}) {
      const status = String(filters.status || '').trim();
      assertApi(!status || ['pending', 'accepted', 'rejected'].includes(status), 400, 'INVALID_RECOMMENDATION_STATUS', '推荐状态筛选无效。');
      const rows = status
        ? db.prepare('SELECT * FROM recommendations WHERE workspace_id=? AND status=? ORDER BY created_at DESC,rowid DESC').all(ws, status)
        : db.prepare('SELECT * FROM recommendations WHERE workspace_id=? ORDER BY created_at DESC,rowid DESC').all(ws);
      return rows.map(row => dto(row));
    },
    decide(ws, rid, action, input = {}) {
      assertApi(['accept', 'reject'].includes(action), 400, 'INVALID_DECISION', '只能采纳或拒绝推荐。');
      key(input);
      assertApi(typeof input.reviewer === 'string' && input.reviewer.trim() && input.reviewer.length <= 160,
        400, 'REVIEWER_REQUIRED', '请记录确认人；该字段不是已验证的企业身份。');
      assertApi(input.reason == null || typeof input.reason === 'string' && input.reason.length <= 2000, 400, 'INVALID_REASON', '原因过长或格式无效。');
      if (action === 'reject') assertApi(input.reason?.trim(), 400, 'REASON_REQUIRED', '拒绝时请记录原因。');
      const requestFingerprint = fingerprint({ action, input });
      return atomic(db, () => {
        const row = rowFor(ws, rid);
        const replay = one('SELECT * FROM recommendation_decisions WHERE workspace_id=? AND recommendation_id=? AND idempotency_key=?', ws, rid, input.idempotency_key);
        if (replay) {
          assertApi(replay.request_fingerprint === requestFingerprint, 409, 'IDEMPOTENCY_KEY_REUSE', '幂等键已用于不同确认内容。');
          return { ...dto(row), idempotent_replay: true };
        }
        assertApi(row.status === 'pending', 409, 'RECOMMENDATION_ALREADY_REVIEWED', '该推荐已处理。');
        assertApi(Number(input.expected_revision) === row.revision, 409, 'REVISION_CONFLICT', '推荐记录版本已变化。');
        let selection = null;
        let acceptedContext = null;
        if (action === 'accept') {
          const { context, rules, stale } = current(row);
          activeContact(context);
          assertApi(!stale, 409, 'RECOMMENDATION_STALE', '画像、消息或产品资料已变化，请重新生成推荐。');
          const result = parse(row.result_json);
          assertApi(result.status === 'ready', 409, 'RECOMMENDATION_NOT_READY', '该结果还不能采纳，需补信息、正式资料或接通工作流。');
          const selected = result.candidates.find(item => item.candidate_id === input.candidate_id);
          const currentCandidate = rules.candidates.find(item => item.candidate_id === input.candidate_id);
          assertApi(selected?.status === 'eligible_for_discussion' && currentCandidate?.status === 'eligible_for_discussion',
            409, 'CANDIDATE_NOT_ELIGIBLE', '不能采纳不匹配、缺信息或不存在的方案。');
          const term = input.selected_payment_years ?? null;
          assertApi(term === null || Number.isInteger(term) && selected.allowed_payment_years.includes(term),
            400, 'UNSUPPORTED_PAYMENT_TERM', '交费期必须由该产品版本明确支持。');
          selection = { ...selected, selected_payment_years: term };
          store.patchOpportunity(ws, row.opportunity_id, context.context_versions.opportunity_revision, {
            product_id: selected.product_id, product_version: selected.product_version, policy_contract_version: null,
            sales_stage: 'solution_discussion', processing_status: 'waiting_sales_review'
          });
          acceptedContext = contextFor(ws, row.opportunity_id).context_versions;
        }
        const at = now().toISOString();
        db.prepare(`UPDATE recommendations SET status=?,selection_json=?,accepted_context_versions=?,reviewer=?,reason=?,
          revision=revision+1,updated_at=? WHERE workspace_id=? AND recommendation_id=?`).run(
          action === 'accept' ? 'accepted' : 'rejected', json(selection), json(acceptedContext), input.reviewer.trim(), input.reason?.trim() || null, at, ws, rid);
        const after = rowFor(ws, rid);
        db.prepare('INSERT INTO recommendation_decisions VALUES (?,?,?,?,?,?,?,?,?,?)').run(ws, rid, input.idempotency_key,
          requestFingerprint, action, input.reviewer.trim(), input.reason?.trim() || null,
          json(dto(row, { checkFreshness: false })), json(dto(after, { checkFreshness: false })), at);
        return { ...dto(after), idempotent_replay: false };
      });
    },
    recordOutcome(ws, rid, input = {}) {
      key(input);
      assertApi(putCase, 503, 'CASE_SERVICE_UNAVAILABLE', '案例服务尚未接通。');
      const allowed = new Set(['idempotency_key', 'outcome', 'sharing_approved', 'reviewer', 'approval_source', 'snapshot_at', 'case_id', 'expected_revision']);
      assertApi(Object.keys(input).every(field => allowed.has(field)), 400, 'UNSUPPORTED_CHANGE', '案例必须使用推荐时的产品和画像快照，不能自行替换。');
      const row = rowFor(ws, rid);
      assertApi(row.status === 'accepted', 409, 'RECOMMENDATION_NOT_ACCEPTED', '请先确认推荐，再记录该建议的业务结果。');
      assertApi(typeof input.snapshot_at === 'string' && Number.isFinite(Date.parse(input.snapshot_at)),
        400, 'OUTCOME_TIME_REQUIRED', '请记录业务结果发生时间；重试应沿用同一时间，不能用当前日期补造历史结果。');
      const selected = parse(row.selection_json);
      const rules = parse(row.rules_json);
      return putCase(ws, {
        ...input,
        source_opportunity_id: row.opportunity_id,
        source_snapshot: {
          recommendation_id: rid, generated_at: row.created_at, decision: 'accepted',
          catalog_fingerprint: row.catalog_fingerprint, profile_snapshot: rules.profile_snapshot,
          product_id: selected.product_id, product_version: selected.product_version, environment: row.environment
        },
        product_id: selected.product_id, product_version: selected.product_version, environment: row.environment,
        source_kind: row.environment === 'simulation' ? 'simulation_fixture' : 'reviewed_outcome',
        snapshot_at: input.snapshot_at
      });
    },
    getConfirmed(context) {
      const row = one("SELECT * FROM recommendations WHERE workspace_id=? AND opportunity_id=? AND status='accepted' ORDER BY updated_at DESC,rowid DESC LIMIT 1",
        context.workspace_id, context.opportunity_id);
      if (!row || current(row).stale) return null;
      if (context.contact_state?.marketing_opt_out || context.contact_state?.human_handoff || context.contact_state?.purchased_for_opportunity) return null;
      const selected = parse(row.selection_json);
      if (context.product_scope.product_id !== selected.product_id || context.product_scope.product_version !== selected.product_version) return null;
      return {
        schema_version: 'confirmed-product-match.v1', recommendation_id: row.recommendation_id,
        candidate_id: selected.candidate_id, product_id: selected.product_id, product_version: selected.product_version,
        status: 'human_confirmed', selected_payment_years: selected.selected_payment_years,
        reasons: selected.reasons, citations: selected.citations, case_references: selected.case_references || [],
        explanation: selected.explanation || '', context_versions: parse(row.accepted_context_versions),
        catalog_fingerprint: row.catalog_fingerprint, reviewer: row.reviewer, confirmed_at: row.updated_at
      };
    }
  };
  return service;
}
