import { createHash, randomUUID } from 'node:crypto';
import { ApiError, assertApi } from '../errors.mjs';
import { isContextMessage } from '../memory-policy.mjs';

const WORKSPACE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const ENVIRONMENTS = new Set(['real', 'simulation']);
const CATALOG_STATUSES = new Set(['active', 'inactive']);
const APPROVAL_STATUSES = new Set(['pending', 'approved', 'rejected']);
const PRODUCT_SOURCE_KINDS = new Set(['official', 'simulation_fixture']);
const CASE_SOURCE_KINDS = new Set(['reviewed_outcome', 'simulation_fixture']);
const CASE_OUTCOMES = new Set(['success', 'failure', 'deferred', 'surrendered']);
const PURPOSE_CODES = new Set([
  'retirement', 'education', 'wealth_preservation', 'legacy_planning',
  'health_protection', 'life_protection', 'general_savings'
]);
const PURPOSE_ALIASES = new Map([
  ['retirement', 'retirement'], ['养老', 'retirement'], ['退休', 'retirement'],
  ['education', 'education'], ['教育', 'education'], ['留学', 'education'],
  ['wealth_preservation', 'wealth_preservation'], ['财富保全', 'wealth_preservation'], ['财富保值', 'wealth_preservation'], ['资产保全', 'wealth_preservation'],
  ['legacy_planning', 'legacy_planning'], ['财富传承', 'legacy_planning'], ['传承', 'legacy_planning'],
  ['health_protection', 'health_protection'], ['健康', 'health_protection'], ['医疗', 'health_protection'],
  ['life_protection', 'life_protection'], ['保障', 'life_protection'], ['身故', 'life_protection'],
  ['general_savings', 'general_savings'], ['储蓄', 'general_savings'], ['长期储蓄', 'general_savings'], ['资产配置', 'general_savings']
]);
const RULE_KEYS = new Set(['purpose_codes', 'insured_age', 'annual_budget', 'funds_usage_years', 'payment_years']);
const SOURCE_REF_KEYS = new Set(['source_id', 'title', 'version', 'section']);

const json = value => JSON.stringify(value ?? null);
const parse = (value, fallback = null) => {
  try { return value == null ? fallback : JSON.parse(value); } catch { return fallback; }
};
const text = (value, limit = 200) => String(value ?? '').trim().slice(0, limit);
const nullableText = (value, limit = 200) => text(value, limit) || null;
const nowIso = now => (now ? now() : new Date()).toISOString();
const sha256 = value => createHash('sha256').update(value).digest('hex');
const stable = value => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  }
  return value;
};
const canonical = value => JSON.stringify(stable(value));
const fingerprint = value => sha256(canonical(value));

function businessDate(now) {
  const date = now ? now() : new Date();
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
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

function normalizeDate(value, field, { nullable = false } = {}) {
  if ((value === null || value === undefined || value === '') && nullable) return null;
  assertApi(typeof value === 'string', 400, 'INVALID_DATE', `${field} 必须是 YYYY-MM-DD。`, { field });
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  assertApi(match, 400, 'INVALID_DATE', `${field} 必须是 YYYY-MM-DD。`, { field });
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText); const month = Number(monthText); const day = Number(dayText);
  const maxDay = month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;
  assertApi(year >= 1900 && year <= 2200 && day >= 1 && day <= maxDay, 400, 'INVALID_DATE', `${field} 不是有效日期。`, { field });
  return value;
}

function normalizeAsOf(value, now) {
  if (value === undefined || value === null || value === '') return businessDate(now);
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return normalizeDate(value, 'as_of');
  assertApi(typeof value === 'string' && !Number.isNaN(Date.parse(value)), 400, 'INVALID_AS_OF', 'as_of 必须是有效日期或 ISO 8601 时间。');
  return new Date(value).toISOString().slice(0, 10);
}

function normalizeTimestamp(value, field) {
  assertApi(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value)),
    400, 'INVALID_TIMESTAMP', `${field} 必须是 ISO 8601 时间。`, { field });
  return new Date(value).toISOString();
}

function finiteNumber(value, field, { integer = false, min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  assertApi(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    && (!integer || Number.isInteger(value)), 400, 'INVALID_RULE_VALUE', `${field} 必须是规则允许的数值。`, { field });
  return value;
}

function exactKeys(value, allowed, code, message) {
  assertApi(value && typeof value === 'object' && !Array.isArray(value), 400, code, message);
  assertApi(Object.keys(value).every(key => allowed.has(key)), 400, code, message, {
    unsupported: Object.keys(value).filter(key => !allowed.has(key))
  });
}

function normalizeSourceRefs(refs) {
  assertApi(Array.isArray(refs), 400, 'INVALID_SOURCE_REFS', 'source_refs 必须是数组。');
  const result = refs.map((ref, index) => {
    exactKeys(ref, SOURCE_REF_KEYS, 'INVALID_SOURCE_REF', '产品来源只允许 source_id/title/version/section。');
    const normalized = {
      source_id: text(ref.source_id, 160), title: text(ref.title, 240),
      version: text(ref.version, 120), section: text(ref.section, 240)
    };
    assertApi(Object.values(normalized).every(Boolean), 400, 'INVALID_SOURCE_REF', '产品来源字段不能为空。', { index });
    return normalized;
  });
  assertApi(new Set(result.map(ref => ref.source_id)).size === result.length, 400, 'DUPLICATE_SOURCE_REF', '产品来源标识不能重复。');
  return result;
}

function normalizeRange(input, field, { integer = false, maxLimit = Number.MAX_SAFE_INTEGER, currency = false } = {}) {
  const allowed = new Set(currency ? ['min', 'max', 'currency'] : ['min', 'max']);
  exactKeys(input, allowed, 'INVALID_PRODUCT_RULES', `${field} 规则字段无效。`);
  const min = finiteNumber(input.min, `${field}.min`, { integer, max: maxLimit });
  const max = input.max === undefined || input.max === null
    ? null : finiteNumber(input.max, `${field}.max`, { integer, max: maxLimit });
  assertApi(max === null || min <= max, 400, 'INVALID_PRODUCT_RULES', `${field} 的 min 不能大于 max。`);
  if (currency) assertApi(input.currency === 'CNY', 400, 'INVALID_PRODUCT_RULES', '预算规则当前只支持 CNY。');
  return { min, ...(max === null ? {} : { max }), ...(currency ? { currency: 'CNY' } : {}) };
}

function normalizeRules(input) {
  exactKeys(input, RULE_KEYS, 'INVALID_PRODUCT_RULES', '产品规则只允许 purpose_codes/insured_age/annual_budget/funds_usage_years/payment_years。');
  assertApi(Object.keys(input).length > 0, 400, 'INVALID_PRODUCT_RULES', '产品规则不能为空。');
  const result = {};
  if (input.purpose_codes !== undefined) {
    assertApi(Array.isArray(input.purpose_codes) && input.purpose_codes.length > 0, 400, 'INVALID_PRODUCT_RULES', 'purpose_codes 必须是非空有限枚举。');
    const codes = [...new Set(input.purpose_codes.map(code => text(code, 80)))];
    assertApi(codes.every(code => PURPOSE_CODES.has(code)), 400, 'INVALID_PRODUCT_RULES', 'purpose_codes 包含未支持值。');
    result.purpose_codes = codes.sort();
  }
  if (input.insured_age !== undefined) result.insured_age = normalizeRange(input.insured_age, 'insured_age', { integer: true, maxLimit: 120 });
  if (input.annual_budget !== undefined) result.annual_budget = normalizeRange(input.annual_budget, 'annual_budget', { currency: true, maxLimit: 1_000_000_000 });
  if (input.funds_usage_years !== undefined) result.funds_usage_years = normalizeRange(input.funds_usage_years, 'funds_usage_years', { integer: true, maxLimit: 100 });
  if (input.payment_years !== undefined) {
    assertApi(Array.isArray(input.payment_years) && input.payment_years.length > 0, 400, 'INVALID_PRODUCT_RULES', 'payment_years 必须是非空数组。');
    const years = [...new Set(input.payment_years.map((year, index) => finiteNumber(year, `payment_years[${index}]`, { integer: true, min: 1, max: 100 })))].sort((a, b) => a - b);
    result.payment_years = years;
  }
  return result;
}

function normalizePurpose(value) {
  const normalized = text(value, 120).toLowerCase();
  return PURPOSE_ALIASES.get(normalized) || 'unknown';
}

function band(value, width, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  const start = Math.floor(value / width) * width;
  return `${start}-${Math.min(max, start + width - 1)}`;
}

function makeCaseFeatures(profile) {
  return {
    purpose_code: normalizePurpose(profile.purpose),
    insured_age_band: band(profile.insured_age, 10, 120),
    annual_budget_band: band(profile.budget_amount, 10_000, 1_000_000_000),
    funds_usage_years_band: band(profile.funds_usage_years, 5, 100),
    payment_years: Number.isInteger(profile.requested_payment_years) ? profile.requested_payment_years : null
  };
}

function numericFact(facts, field, predicate = () => true) {
  const matches = facts.filter(fact => fact?.status === 'confirmed' && fact.field === field && predicate(fact)
    && typeof fact.value === 'number' && Number.isFinite(fact.value));
  const values = [...new Set(matches.map(fact => fact.value))];
  if (values.length !== 1) return { value: null, fact: null, conflict: values.length > 1 };
  return { value: values[0], fact: matches.find(fact => fact.value === values[0]), conflict: false };
}

function buildProfile(context) {
  const need = context?.need_profile && typeof context.need_profile === 'object' ? context.need_profile : {};
  const personIds = Array.isArray(need.person_ids) ? [...new Set(need.person_ids.map(value => text(value, 160)).filter(Boolean))] : [];
  const insuredPersonId = personIds.length === 1 ? personIds[0] : null;
  const facts = Array.isArray(context?.confirmed_facts)
    ? context.confirmed_facts.filter(fact => !fact.opportunity_id || fact.opportunity_id === context.opportunity_id) : [];
  const age = insuredPersonId
    ? numericFact(facts, 'age', fact => fact.person_id === insuredPersonId)
    : { value: null, fact: null, conflict: false };
  const usage = numericFact(facts, 'funds_usage_years', fact => !fact.person_id);
  const payment = numericFact(facts, 'payment_years', fact => !fact.person_id);
  const provenance = {
    purpose: 'opportunity_record', budget_amount: 'opportunity_record',
    insured_person: insuredPersonId ? 'opportunity_record' : null,
    insured_age: age.fact ? { kind: 'confirmed_fact', fact_id: age.fact.fact_id } : null,
    funds_usage_years: usage.fact ? { kind: 'confirmed_fact', fact_id: usage.fact.fact_id } : null,
    requested_payment_years: payment.fact ? { kind: 'confirmed_fact', fact_id: payment.fact.fact_id } : null
  };
  const profile = {
    schema_version: 'product-match-profile.v1',
    purpose: nullableText(need.purpose, 120),
    budget_amount: typeof need.budget_amount === 'number' && Number.isFinite(need.budget_amount) ? need.budget_amount : null,
    budget_currency: nullableText(need.budget_currency, 12),
    linked_person_count: personIds.length,
    insured_person_id: insuredPersonId,
    insured_age: age.value,
    funds_usage_years: usage.value,
    requested_payment_years: payment.value,
    provenance,
    context_versions: stable(context?.context_versions || {})
  };
  profile.case_features = makeCaseFeatures(profile);
  return { profile, conflicts: { insured_age: age.conflict, funds_usage_years: usage.conflict, payment_years: payment.conflict } };
}

function applicable(row, asOf, allowSimulationProducts) {
  if (row.environment === 'simulation' && !allowSimulationProducts) return false;
  return row.catalog_status === 'active' && row.approval_status === 'approved'
    && row.valid_from <= asOf && (!row.valid_to || row.valid_to >= asOf)
    && ((row.environment === 'real' && row.source_kind === 'official')
      || (row.environment === 'simulation' && row.source_kind === 'simulation_fixture'));
}

function productFingerprint(rows, environment) {
  const products = rows.map(row => ({
    product_id: row.product_id, product_version: row.product_version, name: row.name,
    environment: row.environment, catalog_status: row.catalog_status,
    valid_from: row.valid_from, valid_to: row.valid_to, approval_status: row.approval_status,
    reviewer: row.reviewer, approval_source: row.approval_source, source_kind: row.source_kind,
    source_refs: parse(row.source_refs, []), rules: parse(row.rules, {})
  })).sort((left, right) => `${left.product_id}:${left.product_version}`.localeCompare(`${right.product_id}:${right.product_version}`));
  return fingerprint({ schema_version: 'product-match-catalog.v1', environment, products });
}

function productDto(row) {
  return {
    product_id: row.product_id, product_version: row.product_version, name: row.name,
    environment: row.environment, catalog_status: row.catalog_status,
    valid_from: row.valid_from, valid_to: row.valid_to, approval_status: row.approval_status,
    reviewer: row.reviewer, approval_source: row.approval_source, source_kind: row.source_kind,
    source_refs: parse(row.source_refs, []), rules: parse(row.rules, {}),
    revision: row.revision, created_at: row.created_at, updated_at: row.updated_at
  };
}

function caseDto(row) {
  return {
    case_id: row.case_id, product_id: row.product_id, product_version: row.product_version,
    environment: row.environment, outcome: row.outcome, case_features: parse(row.case_features, {}),
    sharing_approved: Boolean(row.sharing_approved), reviewer: row.reviewer,
    approval_source: row.approval_source, source_kind: row.source_kind,
    snapshot_at: row.snapshot_at, revision: row.revision, created_at: row.created_at, updated_at: row.updated_at
  };
}

export function createProductMatchService({ store, now = () => new Date(), allowSimulationProducts = false }) {
  assertApi(store?.raw, 500, 'PRODUCT_MATCH_STORE_REQUIRED', 'product-match 需要 openDatabase 返回的 store。');
  const db = store.raw;
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_match_products (
      workspace_id TEXT NOT NULL, product_id TEXT NOT NULL, product_version TEXT NOT NULL, name TEXT NOT NULL,
      environment TEXT NOT NULL, catalog_status TEXT NOT NULL, valid_from TEXT NOT NULL, valid_to TEXT,
      approval_status TEXT NOT NULL, reviewer TEXT, approval_source TEXT, source_kind TEXT NOT NULL,
      source_refs TEXT NOT NULL, rules TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(workspace_id, environment, product_id, product_version)
    );
    CREATE INDEX IF NOT EXISTS product_match_products_catalog
      ON product_match_products(workspace_id, environment, catalog_status, approval_status, valid_from, valid_to);
    CREATE TABLE IF NOT EXISTS product_match_cases (
      workspace_id TEXT NOT NULL, case_id TEXT NOT NULL, source_opportunity_id TEXT NOT NULL,
      source_customer_id TEXT NOT NULL, recommendation_id TEXT NOT NULL,
      recommendation_generated_at TEXT NOT NULL, catalog_fingerprint TEXT NOT NULL,
      product_id TEXT NOT NULL, product_version TEXT NOT NULL, environment TEXT NOT NULL,
      outcome TEXT NOT NULL, case_features TEXT NOT NULL, sharing_approved INTEGER NOT NULL DEFAULT 0,
      reviewer TEXT NOT NULL, approval_source TEXT NOT NULL, source_kind TEXT NOT NULL, snapshot_at TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(workspace_id, case_id),
      UNIQUE(workspace_id, recommendation_id, product_id, product_version)
    );
    CREATE INDEX IF NOT EXISTS product_match_cases_retrieval
      ON product_match_cases(workspace_id, environment, product_id, product_version, sharing_approved, outcome);
    CREATE TABLE IF NOT EXISTS product_match_actions (
      workspace_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, action_type TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(workspace_id, idempotency_key)
    );
  `);

  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const ensureWorkspace = workspaceId => assertApi(WORKSPACE_RE.test(String(workspaceId || '')), 400, 'INVALID_WORKSPACE_ID', 'workspace_id 格式无效。');
  const actionReplay = (workspaceId, key, type, request) => {
    assertApi(key, 400, 'IDEMPOTENCY_KEY_REQUIRED', '写操作必须带幂等键。');
    const prior = one('SELECT * FROM product_match_actions WHERE workspace_id=? AND idempotency_key=?', workspaceId, key);
    if (!prior) return null;
    assertApi(prior.action_type === type && prior.request_fingerprint === fingerprint(request),
      409, 'IDEMPOTENCY_KEY_REUSE', '幂等键已用于不同写入。');
    return parse(prior.response_json, {});
  };
  const saveAction = (workspaceId, key, type, request, response, at) => {
    run('INSERT INTO product_match_actions VALUES (?,?,?,?,?,?)', workspaceId, key, type, fingerprint(request), json(response), at);
  };
  const productRow = (workspaceId, environment, productId, productVersion) => one(
    'SELECT * FROM product_match_products WHERE workspace_id=? AND environment=? AND product_id=? AND product_version=?',
    workspaceId, environment, productId, productVersion
  );
  const contextScope = context => {
    ensureWorkspace(context?.workspace_id);
    assertApi(context?.opportunity_id, 400, 'OPPORTUNITY_ID_REQUIRED', '产品匹配上下文缺少 opportunity_id。');
    assertApi(ENVIRONMENTS.has(context.environment), 400, 'INVALID_ENVIRONMENT', '产品匹配环境无效。');
    const opportunity = one('SELECT * FROM opportunities WHERE workspace_id=? AND opportunity_id=?', context.workspace_id, context.opportunity_id);
    assertApi(opportunity, 404, 'OPPORTUNITY_NOT_FOUND', '购买需求不存在。');
    assertApi(opportunity.customer_id === context.customer_id && opportunity.environment === context.environment,
      400, 'CONTEXT_SCOPE_MISMATCH', '匹配上下文与当前客户、需求或环境不一致。');
    const customer = one('SELECT * FROM customers WHERE workspace_id=? AND customer_id=?', context.workspace_id, opportunity.customer_id);
    return { opportunity, customer };
  };
  const staleContext = (context, scope) => {
    const versions = context.context_versions || {};
    if (versions.customer_revision !== scope.customer.revision
      || versions.profile_version !== scope.customer.profile_version
      || versions.opportunity_revision !== scope.opportunity.revision) return true;
    const messages = all('SELECT * FROM messages WHERE workspace_id=? AND opportunity_id=? ORDER BY occurred_at,created_at,rowid', context.workspace_id, context.opportunity_id)
      .filter(message => isContextMessage(message, scope.opportunity.environment));
    const latestCustomer = messages.findLast(message => message.role === 'customer');
    const latestConversation = messages.at(-1);
    return versions.latest_message_id !== latestCustomer?.message_id
      || versions.latest_conversation_message_id !== latestConversation?.message_id;
  };
  const usableProducts = (workspaceId, environment, asOf) => all(
    'SELECT * FROM product_match_products WHERE workspace_id=? AND environment=?', workspaceId, environment
  ).filter(row => applicable(row, asOf, allowSimulationProducts));

  const service = {
    putProduct(workspaceId, input = {}) {
      ensureWorkspace(workspaceId);
      const normalized = {
        product_id: text(input.product_id, 160), product_version: text(input.product_version, 160),
        name: text(input.name, 240), environment: input.environment,
        catalog_status: input.catalog_status, valid_from: normalizeDate(input.valid_from, 'valid_from'),
        valid_to: normalizeDate(input.valid_to, 'valid_to', { nullable: true }),
        approval_status: input.approval_status,
        reviewer: nullableText(input.reviewer, 160), approval_source: nullableText(input.approval_source, 240),
        source_kind: input.source_kind, source_refs: normalizeSourceRefs(input.source_refs || []),
        rules: normalizeRules(input.rules),
        expected_revision: input.expected_revision === undefined ? null : Number(input.expected_revision)
      };
      assertApi(normalized.product_id && normalized.product_version && normalized.name, 400, 'PRODUCT_FIELDS_REQUIRED', '产品标识、版本和名称不能为空。');
      assertApi(ENVIRONMENTS.has(normalized.environment), 400, 'INVALID_ENVIRONMENT', '产品环境无效。');
      assertApi(CATALOG_STATUSES.has(normalized.catalog_status), 400, 'INVALID_CATALOG_STATUS', '产品目录状态无效。');
      assertApi(APPROVAL_STATUSES.has(normalized.approval_status), 400, 'INVALID_APPROVAL_STATUS', '产品审批状态无效。');
      assertApi(PRODUCT_SOURCE_KINDS.has(normalized.source_kind), 400, 'INVALID_SOURCE_KIND', '产品来源类型无效。');
      assertApi(!normalized.valid_to || normalized.valid_from <= normalized.valid_to, 400, 'INVALID_VALIDITY_RANGE', '产品有效期起日不能晚于止日。');
      if (normalized.environment === 'real') assertApi(normalized.source_kind === 'official', 400, 'REAL_PRODUCT_OFFICIAL_SOURCE_REQUIRED', '真实产品只能使用正式来源。');
      if (normalized.environment === 'simulation') {
        assertApi(allowSimulationProducts, 409, 'SIMULATION_PRODUCTS_DISABLED', '演练产品目录未开启。');
        assertApi(normalized.source_kind === 'simulation_fixture', 400, 'SIMULATION_FIXTURE_SOURCE_REQUIRED', '演练产品必须明确标记为测试夹具。');
      }
      if (['approved', 'rejected'].includes(normalized.approval_status)) {
        assertApi(normalized.reviewer && normalized.approval_source, 400, 'PRODUCT_REVIEW_REQUIRED', '审批或驳回产品必须记录复核人与审批来源。');
      }
      if (normalized.approval_status === 'approved') assertApi(normalized.source_refs.length > 0, 400, 'PRODUCT_SOURCE_REQUIRED', '批准产品必须有可审计来源。');
      const request = normalized;
      const replay = actionReplay(workspaceId, input.idempotency_key, 'put_product', request);
      if (replay) return { ...replay, idempotent_replay: true };
      return transaction(db, () => {
        const current = productRow(workspaceId, normalized.environment, normalized.product_id, normalized.product_version);
        if (current) {
          assertApi(Number(normalized.expected_revision) === current.revision, 409, 'REVISION_CONFLICT', '产品目录版本已变更。', { current_revision: current.revision });
        } else {
          assertApi(normalized.expected_revision === null || normalized.expected_revision === 0, 400, 'EXPECTED_REVISION_NOT_ALLOWED', '新建产品不需要非零 expected_revision。');
        }
        const at = nowIso(now);
        if (current) {
          run(`UPDATE product_match_products SET name=?,catalog_status=?,valid_from=?,valid_to=?,approval_status=?,reviewer=?,approval_source=?,source_kind=?,source_refs=?,rules=?,revision=revision+1,updated_at=?
            WHERE workspace_id=? AND environment=? AND product_id=? AND product_version=?`,
          normalized.name, normalized.catalog_status, normalized.valid_from, normalized.valid_to,
          normalized.approval_status, normalized.reviewer, normalized.approval_source, normalized.source_kind,
          json(normalized.source_refs), json(normalized.rules), at, workspaceId, normalized.environment,
          normalized.product_id, normalized.product_version);
        } else {
          run(`INSERT INTO product_match_products VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
            workspaceId, normalized.product_id, normalized.product_version, normalized.name, normalized.environment,
            normalized.catalog_status, normalized.valid_from, normalized.valid_to, normalized.approval_status,
            normalized.reviewer, normalized.approval_source, normalized.source_kind, json(normalized.source_refs),
            json(normalized.rules), at, at);
        }
        const response = { product: productDto(productRow(workspaceId, normalized.environment, normalized.product_id, normalized.product_version)) };
        saveAction(workspaceId, input.idempotency_key, 'put_product', request, response, at);
        return { ...response, idempotent_replay: false };
      });
    },

    listProducts(workspaceId, filters = {}) {
      ensureWorkspace(workspaceId);
      assertApi(ENVIRONMENTS.has(filters.environment), 400, 'ENVIRONMENT_REQUIRED', '查询产品目录必须指定 real 或 simulation。');
      const asOf = normalizeAsOf(filters.as_of, now);
      const rows = usableProducts(workspaceId, filters.environment, asOf);
      return { items: rows.map(productDto), catalog_fingerprint: productFingerprint(rows, filters.environment), as_of: asOf };
    },

    evaluate(context) {
      const scope = contextScope(context);
      const asOf = businessDate(now);
      const rows = usableProducts(context.workspace_id, context.environment, asOf);
      const catalogFingerprint = productFingerprint(rows, context.environment);
      const { profile, conflicts } = buildProfile(context);
      const result = {
        schema_version: 'product-match-rules.v1', status: 'evaluated',
        catalog_fingerprint: catalogFingerprint, profile_snapshot: profile,
        candidates: [], missing_fields: [], risk_flags: []
      };
      if (context.environment === 'simulation' && !allowSimulationProducts) {
        return { ...result, status: 'needs_source', risk_flags: ['simulation_products_disabled'] };
      }
      if (staleContext(context, scope)) return { ...result, status: 'human_required', risk_flags: ['stale_context'] };
      if (scope.customer.marketing_opt_out) result.risk_flags.push('marketing_opt_out');
      if (scope.customer.human_handoff || scope.opportunity.human_handoff) result.risk_flags.push('human_handoff');
      if (scope.opportunity.purchased) result.risk_flags.push('opportunity_already_purchased');
      if (result.risk_flags.length) return { ...result, status: 'human_required' };
      if (!rows.length) return { ...result, status: 'needs_source', risk_flags: ['no_approved_applicable_product_source'] };
      const baseMissing = [];
      if (profile.case_features.purpose_code === 'unknown') baseMissing.push('purpose');
      if (profile.linked_person_count !== 1) baseMissing.push('insured_person');
      if (profile.budget_amount === null) baseMissing.push('budget_amount');
      if (profile.budget_amount !== null && profile.budget_currency !== 'CNY') baseMissing.push('budget_currency');
      if (profile.funds_usage_years === null) baseMissing.push('funds_usage_years');
      if (conflicts.insured_age) result.risk_flags.push('conflicting_insured_age');
      if (conflicts.funds_usage_years) result.risk_flags.push('conflicting_funds_usage_years');
      if (conflicts.payment_years) result.risk_flags.push('conflicting_payment_years');
      if (result.risk_flags.length) return { ...result, status: 'human_required' };
      const questionFor = field => ({
        purpose: '请确认本次需求的用途类别。', insured_person: '请明确本次需求唯一关联的被保人。',
        budget_amount: '请确认可用于年交保费的预算。', budget_currency: '请确认预算币种为 CNY。',
        funds_usage_years: '请确认这笔资金预计多少年内不需要使用。', insured_age: '请补录当前被保人已确认的年龄。'
      })[field];
      for (const row of rows) {
        const rules = parse(row.rules, {}); const citations = parse(row.source_refs, []);
        const citationIds = citations.map(ref => `${ref.source_id}#${ref.section}`);
        const reasons = []; const missing = [...baseMissing]; const failures = [];
        const ruleReason = (code, message) => reasons.push({ code, message, citation_ids: citationIds });
        const fail = (code, message) => failures.push({ code, message, citation_ids: citationIds });
        if (rules.purpose_codes && profile.case_features.purpose_code !== 'unknown') {
          if (rules.purpose_codes.includes(profile.case_features.purpose_code)) ruleReason('purpose_supported', '已确认需求用途在条款化规则支持范围内。');
          else fail('purpose_not_supported', '已确认需求用途不在本产品规则支持范围内。');
        }
        if (rules.insured_age) {
          if (profile.insured_age === null) missing.push('insured_age');
          else if (profile.insured_age < rules.insured_age.min || (rules.insured_age.max !== undefined && profile.insured_age > rules.insured_age.max)) {
            fail('insured_age_out_of_range', '已确认被保人年龄不在产品明示范围内。');
          } else ruleReason('insured_age_in_range', '已确认被保人年龄在产品明示范围内。');
        }
        if (rules.annual_budget && profile.budget_amount !== null && profile.budget_currency === 'CNY') {
          if (profile.budget_amount < rules.annual_budget.min || (rules.annual_budget.max !== undefined && profile.budget_amount > rules.annual_budget.max)) {
            fail('annual_budget_out_of_range', '已确认年预算不在产品明示范围内。');
          } else ruleReason('annual_budget_in_range', '已确认年预算在产品明示范围内。');
        }
        if (rules.funds_usage_years && profile.funds_usage_years !== null) {
          if (profile.funds_usage_years < rules.funds_usage_years.min
            || (rules.funds_usage_years.max !== undefined && profile.funds_usage_years > rules.funds_usage_years.max)) {
            fail('funds_usage_horizon_out_of_range', '已确认资金使用期限不在产品明示范围内。');
          } else ruleReason('funds_usage_horizon_in_range', '已确认资金使用期限在产品明示范围内。');
        }
        if (profile.requested_payment_years !== null && rules.payment_years
          && !rules.payment_years.includes(profile.requested_payment_years)) {
          fail('payment_years_not_supported', '已确认的交费期不在产品正式支持列表中。');
        } else if (profile.requested_payment_years !== null && rules.payment_years) {
          ruleReason('payment_years_supported', '已确认的交费期在产品正式支持列表中。');
        }
        const uniqueMissing = [...new Set(missing)];
        const status = failures.length ? 'not_matched' : uniqueMissing.length ? 'needs_information' : 'eligible_for_discussion';
        result.candidates.push({
          candidate_id: `candidate_${sha256(`${row.environment}:${row.product_id}:${row.product_version}`).slice(0, 20)}`,
          product_id: row.product_id, product_version: row.product_version, status,
          reasons: [...failures, ...reasons], missing_fields: uniqueMissing,
          questions: uniqueMissing.map(questionFor).filter(Boolean), citations,
          allowed_payment_years: rules.payment_years || []
        });
      }
      result.missing_fields = [...new Set(result.candidates.flatMap(candidate => candidate.missing_fields))];
      return result;
    },

    putCase(workspaceId, input = {}) {
      ensureWorkspace(workspaceId);
      assertApi(input.source_snapshot && typeof input.source_snapshot === 'object', 400, 'CASE_SOURCE_SNAPSHOT_REQUIRED', '案例必须绑定推荐生成时快照。');
      const source = input.source_snapshot;
      assertApi(source.decision === 'accepted', 400, 'ACCEPTED_RECOMMENDATION_REQUIRED', '只有销售已明确采纳的推荐可回流案例。');
      assertApi(source.profile_snapshot?.schema_version === 'product-match-profile.v1', 400, 'INVALID_PROFILE_SNAPSHOT', '案例来源画像快照版本无效。');
      const generatedAt = normalizeTimestamp(source.generated_at, 'source_snapshot.generated_at');
      const snapshotAt = normalizeTimestamp(input.snapshot_at, 'snapshot_at');
      assertApi(Date.parse(generatedAt) <= Date.parse(snapshotAt) && Date.parse(snapshotAt) <= Date.parse(nowIso(now)) + 300_000,
        400, 'INVALID_CASE_TIMELINE', '案例时间不能早于推荐快照或晚于当前时间。');
      assertApi(/^[a-f0-9]{64}$/.test(String(source.catalog_fingerprint || '')), 400, 'INVALID_CATALOG_FINGERPRINT', '案例来源缺少有效目录指纹。');
      const recomputedFeatures = makeCaseFeatures(source.profile_snapshot);
      assertApi(canonical(recomputedFeatures) === canonical(source.profile_snapshot.case_features), 400, 'CASE_FEATURES_MISMATCH', '案例特征必须与推荐生成时画像一致。');
      const opportunity = one('SELECT * FROM opportunities WHERE workspace_id=? AND opportunity_id=?', workspaceId, input.source_opportunity_id);
      assertApi(opportunity, 404, 'SOURCE_OPPORTUNITY_NOT_FOUND', '案例来源需求不存在。');
      const normalized = {
        case_id: nullableText(input.case_id, 180), source_opportunity_id: opportunity.opportunity_id,
        source_customer_id: opportunity.customer_id, recommendation_id: text(source.recommendation_id, 180),
        recommendation_generated_at: generatedAt, catalog_fingerprint: String(source.catalog_fingerprint),
        product_id: text(input.product_id, 160), product_version: text(input.product_version, 160),
        environment: input.environment, outcome: input.outcome, case_features: recomputedFeatures,
        sharing_approved: input.sharing_approved === true, reviewer: text(input.reviewer, 160),
        approval_source: text(input.approval_source, 240), source_kind: input.source_kind,
        snapshot_at: snapshotAt, expected_revision: input.expected_revision === undefined ? null : Number(input.expected_revision)
      };
      assertApi(normalized.recommendation_id && normalized.product_id && normalized.product_version, 400, 'CASE_FIELDS_REQUIRED', '案例缺少推荐或产品标识。');
      assertApi(ENVIRONMENTS.has(normalized.environment) && normalized.environment === opportunity.environment,
        400, 'CASE_ENVIRONMENT_MISMATCH', '案例环境必须与来源需求一致。');
      assertApi(CASE_OUTCOMES.has(normalized.outcome), 400, 'INVALID_CASE_OUTCOME', '案例结果必须明确为成功、失败、延期或退保。');
      assertApi(CASE_SOURCE_KINDS.has(normalized.source_kind), 400, 'INVALID_SOURCE_KIND', '案例来源类型无效。');
      assertApi(normalized.reviewer && normalized.approval_source, 400, 'CASE_REVIEW_REQUIRED', '案例必须记录人工复核标签和来源。');
      if (normalized.environment === 'real') assertApi(normalized.source_kind === 'reviewed_outcome', 400, 'REAL_CASE_REVIEWED_SOURCE_REQUIRED', '真实案例只能来自人工确认的业务结果。');
      if (normalized.environment === 'simulation') {
        assertApi(allowSimulationProducts, 409, 'SIMULATION_PRODUCTS_DISABLED', '演练案例功能未开启。');
        assertApi(normalized.source_kind === 'simulation_fixture', 400, 'SIMULATION_CASE_SOURCE_REQUIRED', '演练案例必须明确标记为测试夹具。');
      }
      assertApi(productRow(workspaceId, normalized.environment, normalized.product_id, normalized.product_version),
        404, 'CASE_PRODUCT_NOT_FOUND', '案例关联的产品版本不存在。');
      const request = normalized;
      const replay = actionReplay(workspaceId, input.idempotency_key, 'put_case', request);
      if (replay) return { ...replay, idempotent_replay: true };
      return transaction(db, () => {
        const current = normalized.case_id
          ? one('SELECT * FROM product_match_cases WHERE workspace_id=? AND case_id=?', workspaceId, normalized.case_id) : null;
        if (current) {
          assertApi(Number(normalized.expected_revision) === current.revision, 409, 'REVISION_CONFLICT', '案例版本已变更。', { current_revision: current.revision });
          assertApi(current.source_opportunity_id === normalized.source_opportunity_id
            && current.source_customer_id === normalized.source_customer_id
            && current.recommendation_id === normalized.recommendation_id
            && current.recommendation_generated_at === normalized.recommendation_generated_at
            && current.catalog_fingerprint === normalized.catalog_fingerprint
            && current.product_id === normalized.product_id && current.product_version === normalized.product_version
            && current.environment === normalized.environment && current.case_features === json(normalized.case_features),
          409, 'CASE_SOURCE_IMMUTABLE', '案例来源快照、产品和脱敏特征不能被改写。');
        } else {
          assertApi(normalized.expected_revision === null || normalized.expected_revision === 0, 400, 'EXPECTED_REVISION_NOT_ALLOWED', '新建案例不需要非零 expected_revision。');
          const duplicate = one('SELECT case_id FROM product_match_cases WHERE workspace_id=? AND recommendation_id=? AND product_id=? AND product_version=?',
            workspaceId, normalized.recommendation_id, normalized.product_id, normalized.product_version);
          assertApi(!duplicate, 409, 'CASE_ALREADY_EXISTS', '该推荐的产品结果已形成案例。', { case_id: duplicate?.case_id });
        }
        const caseId = current?.case_id || normalized.case_id || `case_${randomUUID()}`; const at = nowIso(now);
        if (current) {
          run(`UPDATE product_match_cases SET outcome=?,sharing_approved=?,reviewer=?,approval_source=?,source_kind=?,snapshot_at=?,revision=revision+1,updated_at=?
            WHERE workspace_id=? AND case_id=?`, normalized.outcome, normalized.sharing_approved ? 1 : 0,
          normalized.reviewer, normalized.approval_source, normalized.source_kind, normalized.snapshot_at, at, workspaceId, caseId);
        } else {
          run(`INSERT INTO product_match_cases VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
            workspaceId, caseId, normalized.source_opportunity_id, normalized.source_customer_id,
            normalized.recommendation_id, normalized.recommendation_generated_at, normalized.catalog_fingerprint,
            normalized.product_id, normalized.product_version, normalized.environment, normalized.outcome,
            json(normalized.case_features), normalized.sharing_approved ? 1 : 0, normalized.reviewer,
            normalized.approval_source, normalized.source_kind, normalized.snapshot_at, at, at);
        }
        const response = { case: caseDto(one('SELECT * FROM product_match_cases WHERE workspace_id=? AND case_id=?', workspaceId, caseId)) };
        saveAction(workspaceId, input.idempotency_key, 'put_case', request, response, at);
        return { ...response, idempotent_replay: false };
      });
    },

    listCases(workspaceId, filters = {}) {
      ensureWorkspace(workspaceId);
      if (filters.environment !== undefined) assertApi(ENVIRONMENTS.has(filters.environment), 400, 'INVALID_ENVIRONMENT', '案例环境无效。');
      let sharingApproved;
      if (filters.sharing_approved !== undefined) {
        assertApi(typeof filters.sharing_approved === 'boolean' || ['true', 'false'].includes(filters.sharing_approved),
          400, 'INVALID_BOOLEAN_FILTER', 'sharing_approved 只能是 true 或 false。');
        sharingApproved = filters.sharing_approved === true || filters.sharing_approved === 'true';
      }
      return all('SELECT * FROM product_match_cases WHERE workspace_id=? ORDER BY snapshot_at DESC,created_at DESC', workspaceId)
        .filter(row => !filters.environment || row.environment === filters.environment)
        .filter(row => !filters.product_id || row.product_id === filters.product_id)
        .filter(row => !filters.product_version || row.product_version === filters.product_version)
        .filter(row => !filters.outcome || row.outcome === filters.outcome)
        .filter(row => sharingApproved === undefined || Boolean(row.sharing_approved) === sharingApproved)
        .map(caseDto);
    },

    retrieveCases(context, candidate) {
      const scope = contextScope(context);
      const { profile } = buildProfile(context);
      const empty = (status, rejected = []) => ({ status, cases: [], rejected });
      if (staleContext(context, scope)) return empty('human_required', [{ reason: 'stale_context' }]);
      if (scope.customer.marketing_opt_out || scope.customer.human_handoff || scope.opportunity.human_handoff || scope.opportunity.purchased) {
        return empty('human_required', [{ reason: 'contact_or_opportunity_blocked' }]);
      }
      if (!candidate || candidate.status === 'not_matched') return empty('not_applicable', [{ reason: 'candidate_not_eligible_for_case_reference' }]);
      const asOf = businessDate(now);
      const product = usableProducts(context.workspace_id, context.environment, asOf)
        .find(row => row.product_id === candidate.product_id && row.product_version === candidate.product_version);
      if (!product) return empty('needs_source', [{ reason: 'candidate_product_not_in_current_catalog' }]);
      const expectedCandidateId = `candidate_${sha256(`${product.environment}:${product.product_id}:${product.product_version}`).slice(0, 20)}`;
      if (candidate.candidate_id !== expectedCandidateId) return empty('needs_source', [{ reason: 'candidate_identity_mismatch' }]);
      const rows = all(`SELECT * FROM product_match_cases WHERE workspace_id=? AND environment=? AND product_id=?
        AND product_version=? AND sharing_approved=1 ORDER BY snapshot_at DESC,created_at DESC`,
      context.workspace_id, context.environment, candidate.product_id, candidate.product_version);
      const rejected = [];
      const currentFeatures = profile.case_features;
      const labels = {
        purpose_code: '需求用途', insured_age_band: '被保人年龄段', annual_budget_band: '年预算区间',
        funds_usage_years_band: '资金使用期限段', payment_years: '交费年限'
      };
      const accepted = [];
      for (const row of rows) {
        if (row.source_opportunity_id === context.opportunity_id || row.source_customer_id === context.customer_id) {
          rejected.push({ case_id: row.case_id, reason: 'same_opportunity_or_customer' });
          continue;
        }
        const features = parse(row.case_features, {}); const similarities = []; const differences = [];
        for (const key of Object.keys(labels)) {
          if (currentFeatures[key] === null || currentFeatures[key] === 'unknown' || features[key] === null) continue;
          if (currentFeatures[key] === features[key]) similarities.push(`${labels[key]}相同`);
          else differences.push(`${labels[key]}不同`);
        }
        const purposeMatches = currentFeatures.purpose_code !== 'unknown'
          && currentFeatures.purpose_code === features.purpose_code;
        const anotherKeyMatches = ['insured_age_band', 'annual_budget_band', 'funds_usage_years_band', 'payment_years']
          .some(key => currentFeatures[key] !== null && currentFeatures[key] === features[key]);
        if (!purposeMatches || !anotherKeyMatches) {
          rejected.push({ case_id: row.case_id, reason: 'insufficient_similarity' });
          continue;
        }
        accepted.push({ row, similarities, differences });
      }
      accepted.sort((left, right) => right.similarities.length - left.similarities.length
        || left.differences.length - right.differences.length
        || String(right.row.snapshot_at).localeCompare(String(left.row.snapshot_at)));
      const outcomeLabel = { success: '成功', failure: '失败', deferred: '延期', surrendered: '退保' };
      const cases = accepted.slice(0, 5).map(({ row, similarities, differences }) => ({
        case_id: row.case_id, outcome: row.outcome, similarities, differences,
        reason: `该案例经人工确认的业务结果为“${outcomeLabel[row.outcome]}”，只作同类条件参考，不代表个人购买或成交概率。`,
        source_kind: row.source_kind
      }));
      return { status: cases.length ? 'found' : 'none', cases, rejected };
    }
  };

  return service;
}
