import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ApiError, assertApi } from './errors.mjs';
import { requiresSalesConfirmation } from './workspace-policy.mjs';
import { isContextMessage } from './memory-policy.mjs';
import { classifyConversationTurn } from '../ai/conversation-routing.mjs';
import { deterministicIntent } from '../ai/memory-proposal.mjs';
import { isDirectHumanRequest, isMarketingOptOutRequest, isReturnGuaranteeRequest, acquisitionChannel } from '../ai/customer-signals.mjs';
import {
  formatWechatJoinedLabel,
  installCustomerDateSchema,
  normalizeJoinedFilters,
  normalizeWechatJoinedActor,
  normalizeWechatJoinedOn,
  normalizeWechatJoinedSource
} from './customer-dates.mjs';

const json = value => JSON.stringify(value ?? null);
const parse = (value, fallback = null) => {
  try { return value == null ? fallback : JSON.parse(value); } catch { return fallback; }
};
const nowIso = now => (now ? now() : new Date()).toISOString();
const todayLocal = now => {
  const value = now ? now() : new Date();
  return `${String(value.getFullYear()).padStart(4, '0')}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
};
const id = prefix => `${prefix}_${randomUUID()}`;
const allowedMessageStates = new Set(['received', 'draft', 'copied', 'manually_confirmed_sent', 'provider_confirmed_sent', 'simulated_sent', 'failed']);

function finiteMoney(value, field, allowNull = true) {
  if (value === null && allowNull) return;
  assertApi(typeof value === 'number' && Number.isFinite(value) && value >= 0, 400, 'INVALID_AMOUNT', `${field} 必须是非负有限数，未知请使用 null。`, { field });
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

export function openDatabase(path, options = {}) {
  assertApi(path && path !== ':memory:' || path === ':memory:', 500, 'DATABASE_PATH_REQUIRED', '数据库路径未配置。');
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT OR IGNORE INTO schema_meta(key,value) VALUES ('schema_version','2');
    CREATE TABLE IF NOT EXISTS customers (
      workspace_id TEXT NOT NULL, customer_id TEXT NOT NULL, name TEXT NOT NULL,
      contact_preferences TEXT NOT NULL DEFAULT '{}', marketing_opt_out INTEGER NOT NULL DEFAULT 0,
      human_handoff INTEGER NOT NULL DEFAULT 0, handoff_owner TEXT, revision INTEGER NOT NULL DEFAULT 1,
      profile_version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(workspace_id, customer_id)
    );
    CREATE TABLE IF NOT EXISTS persons (
      workspace_id TEXT NOT NULL, person_id TEXT NOT NULL, customer_id TEXT NOT NULL,
      name TEXT, relationship TEXT, attributes TEXT NOT NULL DEFAULT '{}', revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(workspace_id, person_id),
      FOREIGN KEY(workspace_id, customer_id) REFERENCES customers(workspace_id, customer_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS opportunities (
      workspace_id TEXT NOT NULL, opportunity_id TEXT NOT NULL, customer_id TEXT NOT NULL,
      person_ids TEXT NOT NULL DEFAULT '[]', purpose TEXT, budget_amount REAL, budget_currency TEXT,
      stage TEXT NOT NULL DEFAULT 'new', status TEXT NOT NULL DEFAULT 'open', purchased INTEGER NOT NULL DEFAULT 0,
      human_handoff INTEGER NOT NULL DEFAULT 0, handoff_owner TEXT,
      product_id TEXT, product_version TEXT, policy_contract_version TEXT, environment TEXT NOT NULL DEFAULT 'real',
      sales_stage TEXT NOT NULL DEFAULT 'new_contact', intent_level TEXT NOT NULL DEFAULT 'unknown',
      intent_score INTEGER NOT NULL DEFAULT 0, intent_reason TEXT,
      processing_status TEXT NOT NULL DEFAULT 'normal', intent_updated_at TEXT,
      revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(workspace_id, opportunity_id),
      FOREIGN KEY(workspace_id, customer_id) REFERENCES customers(workspace_id, customer_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS messages (
      workspace_id TEXT NOT NULL, message_id TEXT NOT NULL, opportunity_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL,
      source TEXT NOT NULL, environment TEXT NOT NULL DEFAULT 'real', occurred_at TEXT NOT NULL, created_at TEXT NOT NULL,
      trace_id TEXT,session_id TEXT,
      PRIMARY KEY(workspace_id, message_id), UNIQUE(workspace_id, opportunity_id, idempotency_key),
      FOREIGN KEY(workspace_id, opportunity_id) REFERENCES opportunities(workspace_id, opportunity_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS messages_by_opportunity ON messages(workspace_id, opportunity_id, occurred_at, created_at);
    CREATE TABLE IF NOT EXISTS facts (
      workspace_id TEXT NOT NULL, fact_id TEXT NOT NULL, customer_id TEXT NOT NULL, person_id TEXT,
      opportunity_id TEXT, field TEXT NOT NULL, value TEXT NOT NULL, evidence_message_ids TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL, status TEXT NOT NULL, recorded_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
      idempotency_key TEXT,
      PRIMARY KEY(workspace_id, fact_id),
      FOREIGN KEY(workspace_id, customer_id) REFERENCES customers(workspace_id, customer_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS facts_by_scope ON facts(workspace_id, customer_id, opportunity_id, status);
    CREATE TABLE IF NOT EXISTS summaries (
      workspace_id TEXT NOT NULL, summary_id TEXT NOT NULL, opportunity_id TEXT NOT NULL, text TEXT NOT NULL,
      through_message_id TEXT, evidence_message_ids TEXT NOT NULL DEFAULT '[]', open_objections TEXT NOT NULL DEFAULT '[]',
      promises TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'confirmed', created_at TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1, idempotency_key TEXT, supersedes_summary_id TEXT,
      PRIMARY KEY(workspace_id, summary_id),
      FOREIGN KEY(workspace_id, opportunity_id) REFERENCES opportunities(workspace_id, opportunity_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS plans (
      workspace_id TEXT NOT NULL, plan_id TEXT NOT NULL, opportunity_id TEXT NOT NULL, plan_version INTEGER NOT NULL DEFAULT 1,
      revision INTEGER NOT NULL DEFAULT 1, condition_snapshot TEXT NOT NULL, annual_data TEXT NOT NULL DEFAULT '[]',
      sources TEXT NOT NULL DEFAULT '[]', confirmation_status TEXT NOT NULL DEFAULT 'proposed', stale INTEGER NOT NULL DEFAULT 0,
      stale_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(workspace_id, plan_id),
      FOREIGN KEY(workspace_id, opportunity_id) REFERENCES opportunities(workspace_id, opportunity_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS drafts (
      workspace_id TEXT NOT NULL, draft_id TEXT NOT NULL, opportunity_id TEXT NOT NULL, latest_message_id TEXT NOT NULL,
      context_versions TEXT NOT NULL, content TEXT NOT NULL, ai_result TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft_ready',
      revision INTEGER NOT NULL DEFAULT 1, stale INTEGER NOT NULL DEFAULT 0, stale_reason TEXT,
      final_text TEXT, delivery_mode TEXT, confirmation_key TEXT, edit_record TEXT,
      product_scope TEXT, editor_id TEXT, editor_role TEXT NOT NULL DEFAULT 'sales',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(workspace_id, draft_id),
      UNIQUE(workspace_id, draft_id, confirmation_key),
      FOREIGN KEY(workspace_id, opportunity_id) REFERENCES opportunities(workspace_id, opportunity_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS tasks (
      workspace_id TEXT NOT NULL, task_id TEXT NOT NULL, customer_id TEXT, opportunity_id TEXT, due_at TEXT,
      owner TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open', reason TEXT NOT NULL, result TEXT,
      idempotency_key TEXT, revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(workspace_id, task_id), UNIQUE(workspace_id, idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS opportunity_intent_events (
      workspace_id TEXT NOT NULL, event_id TEXT NOT NULL, opportunity_id TEXT NOT NULL,
      previous_level TEXT NOT NULL, previous_score INTEGER NOT NULL,
      next_level TEXT NOT NULL, next_score INTEGER NOT NULL, reason TEXT NOT NULL,
      evidence_message_ids TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL,
      occurred_at TEXT NOT NULL, PRIMARY KEY(workspace_id,event_id),
      FOREIGN KEY(workspace_id,opportunity_id) REFERENCES opportunities(workspace_id,opportunity_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS opportunity_intent_history
      ON opportunity_intent_events(workspace_id,opportunity_id,occurred_at);
    CREATE TABLE IF NOT EXISTS customer_business_events (
      workspace_id TEXT NOT NULL, event_id TEXT NOT NULL, customer_id TEXT NOT NULL,
      opportunity_id TEXT NOT NULL, message_id TEXT NOT NULL, event_type TEXT NOT NULL,
      payload TEXT NOT NULL, occurred_at TEXT NOT NULL,
      PRIMARY KEY(workspace_id,event_id), UNIQUE(workspace_id,message_id,event_type),
      FOREIGN KEY(workspace_id,message_id) REFERENCES messages(workspace_id,message_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS customer_business_event_history
      ON customer_business_events(workspace_id,customer_id,occurred_at);
  `);
  const opportunityColumns = db.prepare('PRAGMA table_info(opportunities)').all();
  if (!opportunityColumns.some(column => column.name === 'human_handoff')) db.exec('ALTER TABLE opportunities ADD COLUMN human_handoff INTEGER NOT NULL DEFAULT 0');
  if (!opportunityColumns.some(column => column.name === 'handoff_owner')) db.exec('ALTER TABLE opportunities ADD COLUMN handoff_owner TEXT');
  if (!opportunityColumns.some(column => column.name === 'sales_stage')) db.exec("ALTER TABLE opportunities ADD COLUMN sales_stage TEXT NOT NULL DEFAULT 'new_contact'");
  if (!opportunityColumns.some(column => column.name === 'intent_level')) db.exec("ALTER TABLE opportunities ADD COLUMN intent_level TEXT NOT NULL DEFAULT 'unknown'");
  if (!opportunityColumns.some(column => column.name === 'intent_score')) db.exec('ALTER TABLE opportunities ADD COLUMN intent_score INTEGER NOT NULL DEFAULT 0');
  if (!opportunityColumns.some(column => column.name === 'intent_reason')) db.exec('ALTER TABLE opportunities ADD COLUMN intent_reason TEXT');
  if (!opportunityColumns.some(column => column.name === 'processing_status')) db.exec("ALTER TABLE opportunities ADD COLUMN processing_status TEXT NOT NULL DEFAULT 'normal'");
  if (!opportunityColumns.some(column => column.name === 'intent_updated_at')) db.exec('ALTER TABLE opportunities ADD COLUMN intent_updated_at TEXT');
  const factColumns = db.prepare('PRAGMA table_info(facts)').all();
  const messageColumns = db.prepare('PRAGMA table_info(messages)').all();
  if (!messageColumns.some(column => column.name === 'trace_id')) db.exec('ALTER TABLE messages ADD COLUMN trace_id TEXT');
  if (!messageColumns.some(column => column.name === 'session_id')) db.exec('ALTER TABLE messages ADD COLUMN session_id TEXT');
  if (!factColumns.some(column => column.name === 'idempotency_key')) db.exec('ALTER TABLE facts ADD COLUMN idempotency_key TEXT');
  const summaryColumns = db.prepare('PRAGMA table_info(summaries)').all();
  if (!summaryColumns.some(column => column.name === 'revision')) db.exec('ALTER TABLE summaries ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
  if (!summaryColumns.some(column => column.name === 'idempotency_key')) db.exec('ALTER TABLE summaries ADD COLUMN idempotency_key TEXT');
  if (!summaryColumns.some(column => column.name === 'supersedes_summary_id')) db.exec('ALTER TABLE summaries ADD COLUMN supersedes_summary_id TEXT');
  const taskColumns = db.prepare('PRAGMA table_info(tasks)').all();
  if (!taskColumns.some(column => column.name === 'title')) db.exec("ALTER TABLE tasks ADD COLUMN title TEXT NOT NULL DEFAULT ''");
  const draftColumns = db.prepare('PRAGMA table_info(drafts)').all();
  if (!draftColumns.some(column => column.name === 'product_scope')) db.exec('ALTER TABLE drafts ADD COLUMN product_scope TEXT');
  if (!draftColumns.some(column => column.name === 'editor_id')) db.exec('ALTER TABLE drafts ADD COLUMN editor_id TEXT');
  if (!draftColumns.some(column => column.name === 'editor_role')) db.exec("ALTER TABLE drafts ADD COLUMN editor_role TEXT NOT NULL DEFAULT 'sales'");
  installCustomerDateSchema(db);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS facts_idempotency ON facts(workspace_id, customer_id, idempotency_key) WHERE idempotency_key IS NOT NULL');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS summaries_idempotency ON summaries(workspace_id, opportunity_id, idempotency_key) WHERE idempotency_key IS NOT NULL');

  const now = options.now || (() => new Date());
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const customer = (ws, cid) => one('SELECT * FROM customers WHERE workspace_id=? AND customer_id=?', ws, cid);
  const opportunity = (ws, oid) => one('SELECT * FROM opportunities WHERE workspace_id=? AND opportunity_id=?', ws, oid);
  const ensureCustomer = (ws, cid) => {
    const row = customer(ws, cid);
    assertApi(row, 404, 'CUSTOMER_NOT_FOUND', '客户不存在。');
    return row;
  };
  const ensureOpportunity = (ws, oid) => {
    const row = opportunity(ws, oid);
    assertApi(row, 404, 'OPPORTUNITY_NOT_FOUND', '购买需求不存在。');
    return row;
  };
  const conversationState = (ws, oid, environment) => {
    const eligible = all('SELECT * FROM messages WHERE workspace_id=? AND opportunity_id=? ORDER BY occurred_at,created_at,rowid', ws, oid).filter(message => isContextMessage(message, environment));
    return { latestCustomer: eligible.findLast(message => message.role === 'customer') || null, latestConversation: eligible.at(-1) || null };
  };
  const staleForOpportunity = (ws, oid, reason) => {
    run('UPDATE plans SET stale=1, stale_reason=?, revision=revision+CASE WHEN stale=0 THEN 1 ELSE 0 END, updated_at=? WHERE workspace_id=? AND opportunity_id=?', reason, nowIso(now), ws, oid);
    run("UPDATE drafts SET stale=1, stale_reason=?, revision=revision+CASE WHEN stale=0 THEN 1 ELSE 0 END, updated_at=? WHERE workspace_id=? AND opportunity_id=? AND status NOT IN ('simulated_sent','manually_confirmed_sent','provider_confirmed_sent')", reason, nowIso(now), ws, oid);
  };
  const recordJoinedDateAudit = (ws, cid, beforeOn, afterOn, beforeSource, afterSource, actor, at) => {
    run(`INSERT INTO customer_joined_date_audit(workspace_id,audit_id,customer_id,before_on,after_on,before_source,after_source,actor,changed_at)
      VALUES (?,?,?,?,?,?,?,?,?)`, ws, id('cja'), cid, beforeOn, afterOn, beforeSource || 'unknown', afterSource || 'unknown', actor, at);
  };
  const mapCustomer = row => ({
    customer_id: row.customer_id, name: row.name, revision: row.revision, profile_version: row.profile_version,
    contact_preferences: parse(row.contact_preferences, {}), marketing_opt_out: Boolean(row.marketing_opt_out),
    human_handoff: Boolean(row.human_handoff), handoff_owner: row.handoff_owner,
    wechat_joined_on: row.wechat_joined_on || null,
    wechat_joined_source: row.wechat_joined_source || 'unknown',
    wechat_joined_label: formatWechatJoinedLabel(row.wechat_joined_on || null),
    updated_at: row.updated_at
  });
  const mapOpportunity = row => ({
    opportunity_id: row.opportunity_id, customer_id: row.customer_id, person_ids: parse(row.person_ids, []), purpose: row.purpose,
    budget_amount: row.budget_amount, budget_currency: row.budget_currency, stage: row.stage, status: row.status,
    purchased: Boolean(row.purchased), human_handoff: Boolean(row.human_handoff), handoff_owner: row.handoff_owner,
    sales_stage: row.sales_stage || 'new_contact', intent_level: row.intent_level || 'unknown',
    intent_score: Number(row.intent_score) || 0, intent_reason: row.intent_reason || null,
    processing_status: row.processing_status || 'normal', intent_updated_at: row.intent_updated_at || null,
    product_id: row.product_id, product_version: row.product_version,
    policy_contract_version: row.policy_contract_version, environment: row.environment, revision: row.revision, updated_at: row.updated_at
  });

  return {
    path,
    raw: db,
    close: () => db.close(),
    createCustomer(ws, input) {
      return transaction(db, () => {
        const at = nowIso(now); const cid = input.customer_id || id('cus');
        assertApi(input.name && String(input.name).trim(), 400, 'NAME_REQUIRED', '客户名称不能为空。');
        const hasJoinedOn = Object.hasOwn(input, 'wechat_joined_on');
        const hasJoinedSource = Object.hasOwn(input, 'wechat_joined_source');
        const hasJoinedActor = Object.hasOwn(input, 'wechat_joined_actor');
        assertApi(!hasJoinedActor || hasJoinedOn || hasJoinedSource, 400, 'WECHAT_JOINED_AUDIT_WITHOUT_CHANGE', 'wechat_joined_actor 只能随加入日期或来源一起提交。');
        const joinedOn = hasJoinedOn ? normalizeWechatJoinedOn(input.wechat_joined_on, { max: todayLocal(now) }) : null;
        assertApi(!joinedOn || hasJoinedSource, 400, 'WECHAT_JOINED_SOURCE_REQUIRED', '记录加入日期时必须明确来源。');
        const joinedSource = hasJoinedSource ? normalizeWechatJoinedSource(input.wechat_joined_source, { required: true }) : 'unknown';
        const joinedActor = normalizeWechatJoinedActor(input.wechat_joined_actor);
        try {
          run(`INSERT INTO customers(workspace_id,customer_id,name,contact_preferences,marketing_opt_out,human_handoff,handoff_owner,revision,profile_version,created_at,updated_at,wechat_joined_on,wechat_joined_source)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, ws, cid, String(input.name).trim(), json(input.contact_preferences || {}), input.marketing_opt_out ? 1 : 0, input.human_handoff ? 1 : 0, input.handoff_owner || null, 1, 1, at, at, joinedOn, joinedSource);
        } catch (error) {
          if (error.code === 'ERR_SQLITE_ERROR') throw new ApiError(409, 'CUSTOMER_EXISTS', '客户标识已存在。');
          throw error;
        }
        if (hasJoinedOn || hasJoinedSource) recordJoinedDateAudit(ws, cid, null, joinedOn, 'unknown', joinedSource, joinedActor, at);
        return mapCustomer(customer(ws, cid));
      });
    },
    listCustomers(ws, filters = {}) {
      const joined = normalizeJoinedFilters(filters);
      const conditions = ['workspace_id=?']; const args = [ws];
      if (joined.joined_on) { conditions.push('wechat_joined_on=?'); args.push(joined.joined_on); }
      if (joined.joined_from) { conditions.push('wechat_joined_on>=?'); args.push(joined.joined_from); }
      if (joined.joined_to) { conditions.push('wechat_joined_on<=?'); args.push(joined.joined_to); }
      return all(`SELECT * FROM customers WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC`, ...args).map(mapCustomer);
    },
    getCustomer(ws, cid) {
      const c = ensureCustomer(ws, cid);
      const persons = all('SELECT * FROM persons WHERE workspace_id=? AND customer_id=? ORDER BY created_at', ws, cid).map(row => ({ person_id: row.person_id, customer_id: row.customer_id, name: row.name, relationship: row.relationship, attributes: parse(row.attributes, {}), revision: row.revision }));
      const opportunities = all('SELECT * FROM opportunities WHERE workspace_id=? AND customer_id=? ORDER BY created_at', ws, cid).map(mapOpportunity);
      const facts = all('SELECT * FROM facts WHERE workspace_id=? AND customer_id=? ORDER BY recorded_at', ws, cid).map(row => ({ ...row, value: parse(row.value), evidence_message_ids: parse(row.evidence_message_ids, []) }));
      const business_events = all('SELECT * FROM customer_business_events WHERE workspace_id=? AND customer_id=? ORDER BY occurred_at,event_id', ws, cid)
        .map(row => ({ ...row, payload: parse(row.payload, {}), evidence_message_ids: [row.message_id] }));
      return { ...mapCustomer(c), persons, opportunities, facts, business_events };
    },
    patchCustomer(ws, cid, expected, changes = {}) {
      return transaction(db, () => {
        const current = ensureCustomer(ws, cid);
        const factChanges = Array.isArray(changes.fact_changes) ? changes.fact_changes : [];
        if (factChanges.length) {
          assertApi(factChanges.every(fact => fact.idempotency_key), 400, 'FACT_IDEMPOTENCY_KEY_REQUIRED', '每条事实变更必须带幂等键。');
          const priorFacts = factChanges.map(fact => one('SELECT * FROM facts WHERE workspace_id=? AND customer_id=? AND idempotency_key=?', ws, cid, fact.idempotency_key));
          if (priorFacts.some(Boolean)) {
            assertApi(priorFacts.every(Boolean) && Object.keys(changes).every(key => key === 'fact_changes'), 409, 'IDEMPOTENCY_PARTIAL_REPLAY', '事实变更幂等键不能与新变更混用。');
            for (let index = 0; index < factChanges.length; index += 1) {
              const requested = factChanges[index]; const prior = priorFacts[index];
              const matchingStatus = prior.status === requested.status || (requested.status === 'confirmed' && prior.status === 'conflicted');
              const matches = prior.field === requested.field && prior.value === json(requested.value)
                && prior.person_id === (requested.person_id || null) && prior.opportunity_id === (requested.opportunity_id || null)
                && prior.source === (requested.source || 'human') && matchingStatus
                && prior.evidence_message_ids === json(requested.evidence_message_ids || []);
              assertApi(matches, 409, 'IDEMPOTENCY_KEY_REUSE', '事实变更幂等键已用于不同内容。', { idempotency_key: requested.idempotency_key });
            }
            return this.getCustomer(ws, cid);
          }
        }
        assertApi(Number(expected) === current.revision, 409, 'REVISION_CONFLICT', '客户版本已变更，请刷新后重试。', { current_revision: current.revision });
        const permitted = new Set(['name', 'contact_preferences', 'marketing_opt_out', 'human_handoff', 'handoff_owner', 'fact_changes', 'wechat_joined_on', 'wechat_joined_source', 'wechat_joined_actor']);
        assertApi(Object.keys(changes).every(key => permitted.has(key)), 400, 'UNSUPPORTED_CHANGE', '包含不支持的客户字段。');
        const at = nowIso(now);
        const hasJoinedOn = Object.hasOwn(changes, 'wechat_joined_on');
        const hasJoinedSource = Object.hasOwn(changes, 'wechat_joined_source');
        const hasJoinedActor = Object.hasOwn(changes, 'wechat_joined_actor');
        assertApi(!hasJoinedActor || hasJoinedOn || hasJoinedSource, 400, 'WECHAT_JOINED_AUDIT_WITHOUT_CHANGE', 'wechat_joined_actor 只能随加入日期或来源一起提交。');
        const joinedOn = hasJoinedOn ? normalizeWechatJoinedOn(changes.wechat_joined_on, { max: todayLocal(now) }) : current.wechat_joined_on;
        if (hasJoinedOn && joinedOn && !current.wechat_joined_on) assertApi(hasJoinedSource, 400, 'WECHAT_JOINED_SOURCE_REQUIRED', '补录加入日期时必须明确来源。');
        const joinedSource = hasJoinedSource
          ? normalizeWechatJoinedSource(changes.wechat_joined_source, { required: true })
          : hasJoinedOn && joinedOn === null ? 'unknown' : (current.wechat_joined_source || 'unknown');
        const joinedActor = normalizeWechatJoinedActor(changes.wechat_joined_actor);
        const next = {
          name: changes.name === undefined ? current.name : String(changes.name).trim(),
          contact: changes.contact_preferences === undefined ? current.contact_preferences : json(changes.contact_preferences),
          optout: changes.marketing_opt_out === undefined ? current.marketing_opt_out : (changes.marketing_opt_out ? 1 : 0),
          handoff: changes.human_handoff === undefined ? current.human_handoff : (changes.human_handoff ? 1 : 0),
          owner: changes.handoff_owner === undefined ? current.handoff_owner : changes.handoff_owner
        };
        assertApi(next.name, 400, 'NAME_REQUIRED', '客户名称不能为空。');
        run('UPDATE customers SET name=?,contact_preferences=?,marketing_opt_out=?,human_handoff=?,handoff_owner=?,wechat_joined_on=?,wechat_joined_source=?,revision=revision+1,profile_version=profile_version+1,updated_at=? WHERE workspace_id=? AND customer_id=?', next.name, next.contact, next.optout, next.handoff, next.owner, joinedOn, joinedSource, at, ws, cid);
        if ((hasJoinedOn || hasJoinedSource) && (current.wechat_joined_on !== joinedOn || (current.wechat_joined_source || 'unknown') !== joinedSource)) {
          recordJoinedDateAudit(ws, cid, current.wechat_joined_on, joinedOn, current.wechat_joined_source || 'unknown', joinedSource, joinedActor, at);
        }
        for (const fact of factChanges) {
          assertApi(fact.field && fact.value !== undefined, 400, 'INVALID_FACT', '事实必须包含 field 和 value。');
          const evidence = Array.isArray(fact.evidence_message_ids) ? fact.evidence_message_ids : [];
          assertApi(evidence.length > 0 || fact.source === 'human', 400, 'FACT_EVIDENCE_REQUIRED', '确认事实必须有消息证据或标记为人工来源。');
          assertApi(['proposed', 'confirmed', 'conflicted'].includes(fact.status), 400, 'INVALID_FACT_STATUS', '事实状态无效。');
          if (fact.opportunity_id) {
            const factOpportunity = ensureOpportunity(ws, fact.opportunity_id);
            assertApi(factOpportunity.customer_id === cid, 400, 'OPPORTUNITY_SCOPE_MISMATCH', '购买需求不属于该客户。');
          }
          if (fact.person_id) assertApi(one('SELECT 1 FROM persons WHERE workspace_id=? AND customer_id=? AND person_id=?', ws, cid, fact.person_id), 400, 'PERSON_SCOPE_MISMATCH', '人物不属于该客户。');
          for (const messageId of evidence) {
            const evidenceRow = one(`SELECT m.*,o.customer_id,o.environment AS opportunity_environment FROM messages m JOIN opportunities o ON o.workspace_id=m.workspace_id AND o.opportunity_id=m.opportunity_id
              WHERE m.workspace_id=? AND m.message_id=? AND o.customer_id=? AND (? IS NULL OR m.opportunity_id=?)`, ws, messageId, cid, fact.opportunity_id || null, fact.opportunity_id || null);
            assertApi(evidenceRow, 400, 'EVIDENCE_SCOPE_MISMATCH', '事实证据消息不属于该客户或购买需求。', { message_id: messageId });
            assertApi(isContextMessage(evidenceRow, evidenceRow.opportunity_environment), 400, 'FACT_EVIDENCE_INVALID', '事实证据必须是可进入记忆的已收到或已发送消息。', { message_id: messageId });
          }
          const conflicts = all("SELECT fact_id FROM facts WHERE workspace_id=? AND customer_id=? AND field=? AND person_id IS ? AND opportunity_id IS ? AND status IN ('confirmed','conflicted') AND value<>?", ws, cid, fact.field, fact.person_id || null, fact.opportunity_id || null, json(fact.value));
          const status = conflicts.length && fact.status === 'confirmed' ? 'conflicted' : fact.status;
          if (status === 'conflicted') for (const conflict of conflicts) run("UPDATE facts SET status='conflicted',revision=revision+1 WHERE workspace_id=? AND fact_id=?", ws, conflict.fact_id);
          run(`INSERT INTO facts(workspace_id,fact_id,customer_id,person_id,opportunity_id,field,value,evidence_message_ids,source,status,recorded_at,revision,idempotency_key)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, ws, fact.fact_id || id('fact'), cid, fact.person_id || null, fact.opportunity_id || null, fact.field, json(fact.value), json(evidence), fact.source || 'human', status, at, 1, fact.idempotency_key);
          if (status === 'conflicted') {
            const taskKey = `fact-conflict:${cid}:${fact.opportunity_id || 'customer'}:${fact.person_id || 'all'}:${fact.field}`;
            const values = all("SELECT value FROM facts WHERE workspace_id=? AND customer_id=? AND field=? AND person_id IS ? AND opportunity_id IS ? AND status='conflicted' ORDER BY recorded_at,rowid", ws, cid, fact.field, fact.person_id || null, fact.opportunity_id || null)
              .map(row => parse(row.value)).map(value => typeof value === 'object' ? json(value) : String(value));
            const fieldLabel = ({ budget_amount: '预算金额', age: '年龄', purpose: '购买用途' })[fact.field] || fact.field;
            const reason = `${fieldLabel}存在互相冲突的证据：${[...new Set(values)].join('、')}。请销售核对客户原话、图片/OCR和语音/ASR，人工确认后再进入产品匹配。`;
            const priorTask = one('SELECT * FROM tasks WHERE workspace_id=? AND idempotency_key=?', ws, taskKey);
            if (priorTask) run("UPDATE tasks SET status='open',owner='sales',title='核对冲突客户资料',reason=?,result=NULL,revision=revision+1,updated_at=? WHERE workspace_id=? AND task_id=?", reason, at, ws, priorTask.task_id);
            else run('INSERT INTO tasks(workspace_id,task_id,customer_id,opportunity_id,due_at,owner,title,status,reason,result,idempotency_key,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
              ws, id('task'), cid, fact.opportunity_id || null, at, 'sales', '核对冲突客户资料', 'open', reason, null, taskKey, 1, at, at);
            if (fact.opportunity_id) run("UPDATE opportunities SET processing_status='waiting_sales_review',updated_at=? WHERE workspace_id=? AND opportunity_id=?", at, ws, fact.opportunity_id);
          }
        }
        const reason = next.optout ? 'marketing_opt_out' : next.handoff ? 'human_handoff' : 'customer_profile_changed';
        for (const row of all('SELECT opportunity_id FROM opportunities WHERE workspace_id=? AND customer_id=?', ws, cid)) staleForOpportunity(ws, row.opportunity_id, reason);
        return this.getCustomer(ws, cid);
      });
    },
    listCustomerDateAudit(ws, cid) {
      ensureCustomer(ws, cid);
      return all(`SELECT audit_id,customer_id,before_on,after_on,before_source,after_source,actor,changed_at
        FROM customer_joined_date_audit WHERE workspace_id=? AND customer_id=? ORDER BY changed_at,rowid`, ws, cid);
    },
    addPerson(ws, cid, input) {
      return transaction(db, () => {
        ensureCustomer(ws, cid); const at = nowIso(now); const pid = input.person_id || id('per');
        assertApi(input.relationship || input.name, 400, 'PERSON_DETAILS_REQUIRED', '请至少填写人物名称或关系。');
        const attributes = { ...(input.attributes || {}) };
        if (input.age !== undefined) attributes.age = input.age;
        if (input.gender !== undefined) attributes.gender = input.gender;
        run('INSERT INTO persons VALUES (?,?,?,?,?,?,?,?,?)', ws, pid, cid, input.name || null, input.relationship || null, json(attributes), 1, at, at);
        run('UPDATE customers SET revision=revision+1,profile_version=profile_version+1,updated_at=? WHERE workspace_id=? AND customer_id=?', at, ws, cid);
        return { person_id: pid, customer_id: cid, name: input.name || null, relationship: input.relationship || null, attributes, revision: 1 };
      });
    },
    addOpportunity(ws, cid, input) {
      ensureCustomer(ws, cid);
      const hasBudgetAmount = Object.hasOwn(input, 'budget_amount');
      const hasBudgetAlias = Object.hasOwn(input, 'budget');
      if (hasBudgetAmount && hasBudgetAlias) assertApi(Object.is(input.budget_amount, input.budget), 400, 'BUDGET_FIELDS_CONFLICT', 'budget_amount 与兼容字段 budget 不能矛盾。');
      const budgetAmount = hasBudgetAmount ? input.budget_amount : hasBudgetAlias ? input.budget : null;
      finiteMoney(budgetAmount, 'budget_amount');
      assertApi(!input.budget_currency || input.budget_currency === 'CNY', 400, 'INVALID_CURRENCY', '当前批次预算币种只支持 CNY。');
      assertApi(['real', 'simulation'].includes(input.environment || 'real'), 400, 'INVALID_ENVIRONMENT', '购买需求环境只能是 real 或 simulation。');
      assertApi(!input.sales_stage || ['new_contact','discovery','solution_discussion','closing','won','paused'].includes(input.sales_stage), 400, 'INVALID_SALES_STAGE', '销售阶段无效。');
      assertApi(!input.processing_status || ['normal','waiting_customer','waiting_sales_review','human_handoff','marketing_opt_out','purchased_service'].includes(input.processing_status), 400, 'INVALID_PROCESSING_STATUS', '处理状态无效。');
      const personIds = Array.isArray(input.person_ids) ? input.person_ids : (input.person_id ? [input.person_id] : []);
      for (const pid of personIds) assertApi(one('SELECT 1 FROM persons WHERE workspace_id=? AND customer_id=? AND person_id=?', ws, cid, pid), 400, 'PERSON_SCOPE_MISMATCH', '人物不属于该客户。');
      const at = nowIso(now); const oid = input.opportunity_id || id('opp');
      const salesStage = input.purchased ? 'won' : (input.sales_stage || 'new_contact');
      const processingStatus = input.purchased ? 'purchased_service' : input.human_handoff ? 'human_handoff' : (input.processing_status || 'normal');
      run(`INSERT INTO opportunities(workspace_id,opportunity_id,customer_id,person_ids,purpose,budget_amount,budget_currency,stage,status,purchased,human_handoff,handoff_owner,product_id,product_version,policy_contract_version,environment,revision,created_at,updated_at,sales_stage,processing_status)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, ws, oid, cid, json(personIds), input.purpose || null, budgetAmount, input.budget_currency || (budgetAmount == null ? null : 'CNY'), input.stage || 'new', input.status || 'open', input.purchased ? 1 : 0, input.human_handoff ? 1 : 0, input.handoff_owner || null, input.product_id || null, input.product_version || null, input.policy_contract_version || null, input.environment || 'real', 1, at, at, salesStage, processingStatus);
      return mapOpportunity(opportunity(ws, oid));
    },
    patchOpportunity(ws, oid, expected, changes = {}) {
      return transaction(db, () => {
        const current = ensureOpportunity(ws, oid);
        assertApi(Number(expected) === current.revision, 409, 'REVISION_CONFLICT', '购买需求版本已变更。', { current_revision: current.revision });
        const fields = ['person_ids','purpose','budget_amount','budget_currency','stage','status','purchased','human_handoff','handoff_owner','product_id','product_version','policy_contract_version','environment','sales_stage','processing_status'];
        assertApi(Object.keys(changes).every(key => fields.includes(key)), 400, 'UNSUPPORTED_CHANGE', '包含不支持的需求字段。');
        if ('budget_amount' in changes) finiteMoney(changes.budget_amount, 'budget_amount');
        if ('budget_currency' in changes) assertApi(!changes.budget_currency || changes.budget_currency === 'CNY', 400, 'INVALID_CURRENCY', '当前批次预算币种只支持 CNY。');
        if ('environment' in changes) assertApi(['real', 'simulation'].includes(changes.environment), 400, 'INVALID_ENVIRONMENT', '购买需求环境只能是 real 或 simulation。');
        if ('sales_stage' in changes) assertApi(['new_contact','discovery','solution_discussion','closing','won','paused'].includes(changes.sales_stage), 400, 'INVALID_SALES_STAGE', '销售阶段无效。');
        if ('processing_status' in changes) assertApi(['normal','waiting_customer','waiting_sales_review','human_handoff','marketing_opt_out','purchased_service'].includes(changes.processing_status), 400, 'INVALID_PROCESSING_STATUS', '处理状态无效。');
        const personIds = changes.person_ids ?? parse(current.person_ids, []);
        for (const pid of personIds) assertApi(one('SELECT 1 FROM persons WHERE workspace_id=? AND customer_id=? AND person_id=?', ws, current.customer_id, pid), 400, 'PERSON_SCOPE_MISMATCH', '人物不属于该客户。');
        const values = fields.map(field => field === 'person_ids' ? json(personIds) : ['purchased','human_handoff'].includes(field) ? ((changes[field] ?? current[field]) ? 1 : 0) : (changes[field] === undefined ? current[field] : changes[field]));
        const at = nowIso(now);
        run(`UPDATE opportunities SET ${fields.map(field => `${field}=?`).join(',')},revision=revision+1,updated_at=? WHERE workspace_id=? AND opportunity_id=?`, ...values, at, ws, oid);
        if (changes.purchased === true) run("UPDATE opportunities SET sales_stage='won',processing_status='purchased_service' WHERE workspace_id=? AND opportunity_id=?", ws, oid);
        else if (changes.human_handoff === true) run("UPDATE opportunities SET processing_status='human_handoff' WHERE workspace_id=? AND opportunity_id=?", ws, oid);
        staleForOpportunity(ws, oid, 'opportunity_conditions_changed');
        return mapOpportunity(opportunity(ws, oid));
      });
    },
    addMessage(ws, oid, input) {
      const opp = ensureOpportunity(ws, oid);
      assertApi(input.idempotency_key, 400, 'IDEMPOTENCY_KEY_REQUIRED', '消息必须带幂等键。');
      const prior = one('SELECT * FROM messages WHERE workspace_id=? AND opportunity_id=? AND idempotency_key=?', ws, oid, input.idempotency_key);
      if (prior) {
        assertApi(prior.role === input.role && prior.text === String(input.text || '').trim()
          && prior.status === input.status && prior.source === (input.source || 'manual')
          && prior.environment === (input.environment || opp.environment)
          && (!input.message_id || input.message_id === prior.message_id)
          && (!input.occurred_at || input.occurred_at === prior.occurred_at),
        409, 'IDEMPOTENCY_KEY_REUSE', '消息幂等键已用于不同内容。');
        return { message: { ...prior }, idempotent_replay: true };
      }
      assertApi(['customer','sales'].includes(input.role), 400, 'INVALID_MESSAGE_ROLE', '消息角色无效。');
      assertApi(input.text && String(input.text).trim(), 400, 'MESSAGE_TEXT_REQUIRED', '消息内容不能为空。');
      assertApi(allowedMessageStates.has(input.status), 400, 'INVALID_MESSAGE_STATUS', '消息状态无效。');
      assertApi(['manual', 'simulation', 'wecom', 'media_transcription', 'draft_confirmation'].includes(input.source || 'manual'), 400, 'INVALID_MESSAGE_SOURCE', '消息来源无效。');
      if (input.role === 'customer') assertApi(input.status === 'received', 400, 'CUSTOMER_MESSAGE_STATE_INVALID', '客户消息只能记录为 received。');
      if (input.role === 'sales') assertApi(input.status !== 'received', 400, 'SALES_MESSAGE_STATE_INVALID', '销售消息不能记录为 received。');
      const environment = input.environment || opp.environment;
      assertApi(environment === opp.environment, 400, 'MESSAGE_ENVIRONMENT_MISMATCH', '消息环境必须与购买需求环境一致。');
      assertApi(input.status !== 'simulated_sent' || (environment === 'simulation' && opp.environment === 'simulation'), 400, 'SIMULATION_SCOPE_REQUIRED', '模拟发送只能写入演练需求的演练上下文。');
      const mid = input.message_id || id('msg'); const at = nowIso(now); const occurred = input.occurred_at || at;
      assertApi(!Number.isNaN(Date.parse(occurred)), 400, 'INVALID_OCCURRED_AT', 'occurred_at 必须是 ISO 8601 时间。');
      return transaction(db, () => {
        run(`INSERT INTO messages(workspace_id,message_id,opportunity_id,idempotency_key,role,text,status,source,environment,occurred_at,created_at,trace_id,session_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, ws, mid, oid, input.idempotency_key, input.role, String(input.text).trim(), input.status,
        input.source || 'manual', environment, occurred, at, input.trace_id || null, input.session_id || null);
        let staleReason = 'new_conversation_message';
        if (input.role === 'customer') {
          const customerText = String(input.text);
          const channel = acquisitionChannel(customerText);
          if (channel) run(`INSERT INTO customer_business_events(workspace_id,event_id,customer_id,opportunity_id,message_id,event_type,payload,occurred_at)
            VALUES (?,?,?,?,?,?,?,?)`, ws, id('event'), opp.customer_id, oid, mid, 'acquisition_source',
          json({ channel, status: 'observed', source: 'customer_statement' }), at);
          const explicitIntent = deterministicIntent([{ role: 'customer', text: customerText, message_id: mid }]);
          const intentUpdate = requiresSalesConfirmation(ws) || explicitIntent?.preserve_current ? null : explicitIntent;
          const optOut = isMarketingOptOutRequest(customerText);
          const localHandoff = isDirectHumanRequest(customerText) || isReturnGuaranteeRequest(customerText);
          const globalHandoff = /投诉|监管举报/.test(customerText);
          if (optOut || globalHandoff) run('UPDATE customers SET marketing_opt_out=CASE WHEN ? THEN 1 ELSE marketing_opt_out END,human_handoff=1,handoff_owner=COALESCE(handoff_owner,?),revision=revision+1,profile_version=profile_version+1,updated_at=? WHERE workspace_id=? AND customer_id=?', optOut ? 1 : 0, 'unassigned', at, ws, opp.customer_id);
          if (localHandoff) run('UPDATE opportunities SET human_handoff=1,revision=revision+1,updated_at=? WHERE workspace_id=? AND opportunity_id=?', at, ws, oid);
          if (globalHandoff) {
            const taskKey = `safety-task:${oid}:${mid}:complaint`;
            if (!one('SELECT 1 FROM tasks WHERE workspace_id=? AND idempotency_key=?', ws, taskKey)) {
              run('INSERT INTO tasks(workspace_id,task_id,customer_id,opportunity_id,due_at,owner,title,status,reason,result,idempotency_key,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                ws, id('task'), opp.customer_id, oid, at, 'unassigned', '投诉人工接管', 'open', '客户发起投诉；停止AI销售话术，由人工记录投诉事件并接管处理。', null, taskKey, 1, at, at);
            }
            const complaintTask = one('SELECT task_id FROM tasks WHERE workspace_id=? AND idempotency_key=?', ws, taskKey);
            run(`INSERT INTO customer_business_events(workspace_id,event_id,customer_id,opportunity_id,message_id,event_type,payload,occurred_at)
              VALUES (?,?,?,?,?,?,?,?)`, ws, id('event'), opp.customer_id, oid, mid, 'complaint',
            json({ status: 'open', owner: 'unassigned', due_at: at, task_id: complaintTask.task_id, description: customerText }), at);
          }
          if (optOut) {
            const marketingTasks = all(`SELECT task_id FROM tasks WHERE workspace_id=? AND customer_id=? AND status IN ('open','in_progress')
              AND (title LIKE '%回访%' OR title LIKE '%跟进%' OR title LIKE '%行动信号%' OR reason LIKE '%follow_up%' OR reason LIKE '%interest_%')`, ws, opp.customer_id);
            run(`UPDATE tasks SET status='cancelled',result='客户已拒绝营销，自动取消未执行的营销跟进任务。',revision=revision+1,updated_at=?
              WHERE workspace_id=? AND customer_id=? AND status IN ('open','in_progress')
              AND (title LIKE '%回访%' OR title LIKE '%跟进%' OR title LIKE '%行动信号%' OR reason LIKE '%follow_up%' OR reason LIKE '%interest_%')`, at, ws, opp.customer_id);
            run('INSERT INTO tasks(workspace_id,task_id,customer_id,opportunity_id,due_at,owner,title,status,reason,result,idempotency_key,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
              ws, id('task'), opp.customer_id, oid, at, 'unassigned', '拒绝营销人工处理', 'open',
              '客户已拒绝营销；AI保持沉默，人工核实停止触达及任务取消。不得主动营销；客户后续主动发起的服务请求由人工处理。',
              null, `safety-task:${oid}:${mid}:marketing-opt-out`, 1, at, at);
            const handlingTask = one('SELECT task_id FROM tasks WHERE workspace_id=? AND idempotency_key=?', ws, `safety-task:${oid}:${mid}:marketing-opt-out`);
            const remainingMarketing = one(`SELECT COUNT(*) AS count FROM tasks WHERE workspace_id=? AND customer_id=? AND status IN ('open','in_progress')
              AND (title LIKE '%回访%' OR title LIKE '%跟进%' OR title LIKE '%行动信号%' OR reason LIKE '%follow_up%' OR reason LIKE '%interest_%')`, ws, opp.customer_id);
            run(`INSERT INTO customer_business_events(workspace_id,event_id,customer_id,opportunity_id,message_id,event_type,payload,occurred_at)
              VALUES (?,?,?,?,?,?,?,?)`, ws, id('event'), opp.customer_id, oid, mid, 'marketing_opt_out',
            json({ status: 'applied', ai_response: 'silent', human_handoff: true, task_id: handlingTask.task_id,
              cancellation_executed: true, cancelled_marketing_task_ids: marketingTasks.map(task => task.task_id),
              cancelled_marketing_task_count: marketingTasks.length, remaining_marketing_task_count: remainingMarketing.count }), at);
          }
          let processing = optOut ? 'marketing_opt_out'
            : (localHandoff || globalHandoff) ? 'human_handoff'
              : opp.purchased ? 'purchased_service'
                : ['human_handoff','marketing_opt_out','purchased_service'].includes(opp.processing_status)
                  ? opp.processing_status : 'normal';
          let salesStage = !requiresSalesConfirmation(ws) && opp.sales_stage === 'new_contact' ? 'discovery' : opp.sales_stage;
          if (intentUpdate?.reason === 'interest_paused') salesStage = 'paused';
          else if (intentUpdate?.level === 'high') salesStage = 'solution_discussion';
          if (!requiresSalesConfirmation(ws) && !['human_handoff','marketing_opt_out','purchased_service'].includes(processing)) {
            if (explicitIntent?.recommended_action === 'human_close') processing = 'waiting_sales_review';
            else if (explicitIntent?.recommended_action === 'follow_up') processing = 'waiting_customer';
            else if (explicitIntent?.recommended_action === 'stop_marketing') processing = 'marketing_opt_out';
          }
          run(`UPDATE opportunities SET sales_stage=?,processing_status=?,
            intent_level=COALESCE(?,intent_level),intent_score=COALESCE(?,intent_score),intent_reason=COALESCE(?,intent_reason),
            intent_updated_at=CASE WHEN ? IS NULL THEN intent_updated_at ELSE ? END,updated_at=?
            WHERE workspace_id=? AND opportunity_id=?`, salesStage, processing,
          intentUpdate?.level ?? null, intentUpdate?.score ?? null, intentUpdate?.reason ?? null,
          intentUpdate?.level ?? null, at, at, ws, oid);
          if (intentUpdate) {
            run(`INSERT INTO opportunity_intent_events(workspace_id,event_id,opportunity_id,previous_level,previous_score,next_level,next_score,reason,evidence_message_ids,source,occurred_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`, ws, id('intent'), oid, opp.intent_level || 'unknown', Number(opp.intent_score) || 0,
            intentUpdate.level, intentUpdate.score, intentUpdate.reason, json([mid]), 'deterministic_message_signal', at);
          }
          if (!requiresSalesConfirmation(ws) && explicitIntent && ['human_close','follow_up'].includes(explicitIntent.recommended_action)
            && (!ensureCustomer(ws, opp.customer_id).marketing_opt_out || explicitIntent.reason === 'requested_human_contact')) {
              const future = ['future_follow_up_timing','interest_paused'].includes(explicitIntent.reason);
              const due = new Date(at); due.setUTCDate(due.getUTCDate() + (future ? 180 : 0));
              const taskKey = `intent-task:${oid}:${mid}`;
              if (!one('SELECT 1 FROM tasks WHERE workspace_id=? AND idempotency_key=?', ws, taskKey)) {
                const humanRequested = explicitIntent.reason === 'requested_human_contact';
                run('INSERT INTO tasks(workspace_id,task_id,customer_id,opportunity_id,due_at,owner,title,status,reason,result,idempotency_key,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                  ws, id('task'), opp.customer_id, oid, due.toISOString(), 'sales', future ? '按客户约定时间回访'
                    : humanRequested ? '尽快联系客户（人工接管）' : '优先处理客户行动信号', 'open', explicitIntent.reason, null, taskKey, 1, at, at);
              }
          }
          staleReason = optOut ? 'marketing_opt_out' : (localHandoff || globalHandoff) ? 'human_handoff' : 'new_customer_message';
        }
        const inserted = one('SELECT * FROM messages WHERE workspace_id=? AND message_id=?', ws, mid);
        if (isContextMessage(inserted, opp.environment)) staleForOpportunity(ws, oid, staleReason);
        return { message: inserted, idempotent_replay: false };
      });
    },
    listMessages(ws, oid) { ensureOpportunity(ws, oid); return all('SELECT * FROM messages WHERE workspace_id=? AND opportunity_id=? ORDER BY occurred_at,created_at,rowid', ws, oid); },
    recordOpportunityIntent(ws, oid, input = {}) {
      const current = ensureOpportunity(ws, oid);
      const level = String(input.level || 'unknown');
      const score = Number(input.score);
      assertApi(['unknown','low','medium','high'].includes(level), 400, 'INVALID_INTENT_LEVEL', '意向等级无效。');
      assertApi(Number.isInteger(score) && score >= 0 && score <= 100, 400, 'INVALID_INTENT_SCORE', '意向分必须为 0—100 整数。');
      const evidence = Array.isArray(input.evidence_message_ids) ? [...new Set(input.evidence_message_ids.filter(Boolean))] : [];
      const reason = String(input.reason || '暂无明确购买行动信号').trim().slice(0, 1000);
      const source = String(input.source || 'b1_intent').trim().slice(0, 120);
      const recommendedAction = String(input.recommended_action || 'continue_discovery');
      const at = input.occurred_at || nowIso(now);
      assertApi(!Number.isNaN(Date.parse(at)), 400, 'INVALID_INTENT_TIME', '意向变化时间无效。');
      const desiredStage = requiresSalesConfirmation(ws) ? current.sales_stage : reason === 'interest_paused' ? 'paused'
        : level === 'high' ? 'solution_discussion'
          : (level === 'medium' && current.sales_stage === 'new_contact' ? 'discovery' : current.sales_stage);
      const protectedProcessing = ['human_handoff','marketing_opt_out','purchased_service'].includes(current.processing_status);
      const desiredProcessing = protectedProcessing || requiresSalesConfirmation(ws) ? current.processing_status
        : recommendedAction === 'human_close' ? 'waiting_sales_review'
          : recommendedAction === 'follow_up' ? 'waiting_customer'
            : recommendedAction === 'stop_marketing' ? 'marketing_opt_out'
              : current.processing_status;
      const intentChanged = current.intent_level !== level || Number(current.intent_score) !== score || current.intent_reason !== reason;
      const workflowChanged = current.sales_stage !== desiredStage || current.processing_status !== desiredProcessing;
      if (!intentChanged && !workflowChanged) return mapOpportunity(current);
      return transaction(db, () => {
        if (intentChanged) {
          run(`INSERT INTO opportunity_intent_events(workspace_id,event_id,opportunity_id,previous_level,previous_score,next_level,next_score,reason,evidence_message_ids,source,occurred_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`, ws, id('intent'), oid, current.intent_level || 'unknown', Number(current.intent_score) || 0,
          level, score, reason, json(evidence), source, at);
        }
        run('UPDATE opportunities SET intent_level=?,intent_score=?,intent_reason=?,intent_updated_at=?,sales_stage=?,processing_status=?,updated_at=? WHERE workspace_id=? AND opportunity_id=?',
          level, score, reason, at, desiredStage, desiredProcessing, at, ws, oid);
        return mapOpportunity(opportunity(ws, oid));
      });
    },
    listOpportunityIntentEvents(ws, oid) {
      ensureOpportunity(ws, oid);
      return all('SELECT * FROM opportunity_intent_events WHERE workspace_id=? AND opportunity_id=? ORDER BY occurred_at,rowid', ws, oid)
        .map(row => ({ ...row, evidence_message_ids: parse(row.evidence_message_ids, []) }));
    },
    decayOpportunityIntents(ws, asOf = nowIso(now)) {
      if (requiresSalesConfirmation(ws)) return { scanned: 0, changed: 0, as_of: asOf };
      const atMs = Date.parse(asOf);
      assertApi(Number.isFinite(atMs), 400, 'INVALID_INTENT_TIME', '意向衰减时间无效。');
      const rows = all(`SELECT * FROM opportunities WHERE workspace_id=? AND intent_updated_at IS NOT NULL
        AND processing_status IN ('normal','waiting_customer') AND intent_level IN ('high','medium')`, ws);
      let changed = 0;
      for (const row of rows) {
        const idleDays = Math.floor((atMs - Date.parse(row.intent_updated_at)) / 86_400_000);
        const shouldDrop = row.intent_level === 'high' ? idleDays >= 14 : idleDays >= 30;
        if (!shouldDrop) continue;
        const nextLevel = row.intent_level === 'high' ? 'medium' : 'low';
        const nextScore = row.intent_level === 'high' ? Math.min(69, Math.max(40, Number(row.intent_score) - 15))
          : Math.min(39, Math.max(0, Number(row.intent_score) - 20));
        this.recordOpportunityIntent(ws, row.opportunity_id, {
          level: nextLevel, score: nextScore,
          reason: `${idleDays}天未出现新的明确购买行动信号，意向自动降一级`,
          evidence_message_ids: [], source: 'time_decay', occurred_at: asOf
        });
        changed += 1;
      }
      return { scanned: rows.length, changed, as_of: asOf };
    },
    addSummary(ws, oid, input) {
      return transaction(db, () => {
        const opp = ensureOpportunity(ws, oid);
        const status = input.status || 'confirmed';
        assertApi(['confirmed', 'failed'].includes(status), 400, 'INVALID_SUMMARY_STATUS', '摘要状态无效。');
        assertApi(input.idempotency_key, 400, 'SUMMARY_IDEMPOTENCY_KEY_REQUIRED', '摘要写入必须带幂等键。');
        assertApi(input.text && String(input.text).trim(), 400, 'SUMMARY_TEXT_REQUIRED', '摘要不能为空。');
        const evidence = Array.isArray(input.evidence_message_ids) ? input.evidence_message_ids : [];
        const prior = one('SELECT * FROM summaries WHERE workspace_id=? AND opportunity_id=? AND idempotency_key=?', ws, oid, input.idempotency_key);
        if (prior) {
          const matches = prior.text === String(input.text).trim() && prior.through_message_id === (input.through_message_id || null)
            && prior.evidence_message_ids === json(evidence) && prior.open_objections === json(input.open_objections || [])
            && prior.promises === json(input.promises || []) && (prior.status === status || (status === 'confirmed' && prior.status === 'superseded'));
          assertApi(matches, 409, 'IDEMPOTENCY_KEY_REUSE', '摘要幂等键已用于不同内容。');
          return { summary: { ...prior, evidence_message_ids: parse(prior.evidence_message_ids, []), open_objections: parse(prior.open_objections, []), promises: parse(prior.promises, []) }, idempotent_replay: true };
        }
        assertApi(Number(input.expected_revision) === opp.revision, 409, 'REVISION_CONFLICT', '购买需求版本已变更。', { current_revision: opp.revision });
        let supersedes = null;
        if (status === 'confirmed') {
          assertApi(input.through_message_id, 400, 'SUMMARY_BOUNDARY_REQUIRED', '确认摘要必须记录覆盖到哪条消息。');
          assertApi(evidence.length > 0 && new Set(evidence).size === evidence.length, 400, 'SUMMARY_EVIDENCE_REQUIRED', '确认摘要必须包含不重复的证据消息。');
          const messages = all('SELECT * FROM messages WHERE workspace_id=? AND opportunity_id=? ORDER BY occurred_at,created_at,rowid', ws, oid);
          const boundaryIndex = messages.findIndex(message => message.message_id === input.through_message_id);
          const boundary = boundaryIndex >= 0 ? messages[boundaryIndex] : null;
          assertApi(boundary && isContextMessage(boundary, opp.environment), 400, 'SUMMARY_BOUNDARY_INVALID', '摘要覆盖位置必须是当前需求中可进入记忆的消息。');
          for (const messageId of evidence) {
            const evidenceIndex = messages.findIndex(message => message.message_id === messageId);
            const message = evidenceIndex >= 0 ? messages[evidenceIndex] : null;
            assertApi(message && isContextMessage(message, opp.environment), 400, 'SUMMARY_EVIDENCE_INVALID', '摘要证据必须是当前需求中可进入记忆的消息。', { message_id: messageId });
            assertApi(evidenceIndex <= boundaryIndex, 400, 'SUMMARY_EVIDENCE_AFTER_BOUNDARY', '摘要证据不能超出覆盖边界。', { message_id: messageId, through_message_id: input.through_message_id });
          }
          const previous = one("SELECT summary_id FROM summaries WHERE workspace_id=? AND opportunity_id=? AND status='confirmed' ORDER BY created_at DESC,rowid DESC LIMIT 1", ws, oid);
          supersedes = previous?.summary_id || null;
          if (previous) run("UPDATE summaries SET status='superseded',revision=revision+1 WHERE workspace_id=? AND summary_id=?", ws, previous.summary_id);
        }
        const sid = input.summary_id || id('sum'); const at = nowIso(now);
        run(`INSERT INTO summaries(workspace_id,summary_id,opportunity_id,text,through_message_id,evidence_message_ids,open_objections,promises,status,created_at,revision,idempotency_key,supersedes_summary_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)`, ws, sid, oid, String(input.text).trim(), input.through_message_id || null, json(evidence), json(input.open_objections || []), json(input.promises || []), status, at, input.idempotency_key, supersedes);
        if (status === 'confirmed') {
          run('UPDATE opportunities SET revision=revision+1,updated_at=? WHERE workspace_id=? AND opportunity_id=?', at, ws, oid);
          staleForOpportunity(ws, oid, 'summary_confirmed');
        }
        const saved = one('SELECT * FROM summaries WHERE workspace_id=? AND summary_id=?', ws, sid);
        return { summary: { ...saved, evidence_message_ids: evidence, open_objections: input.open_objections || [], promises: input.promises || [] }, idempotent_replay: false };
      });
    },
    savePlan(ws, oid, input) {
      const opp = ensureOpportunity(ws, oid);
      assertApi(Number(input.expected_revision) === opp.revision, 409, 'REVISION_CONFLICT', '购买需求版本已变更。', { current_revision: opp.revision });
      assertApi(input.condition_snapshot && typeof input.condition_snapshot === 'object', 400, 'CONDITION_SNAPSHOT_REQUIRED', '方案必须绑定客户条件快照。');
      assertApi(Array.isArray(input.annual_data), 400, 'ANNUAL_DATA_REQUIRED', '方案必须包含年度数据。');
      const years = [];
      for (const [index, row] of input.annual_data.entries()) {
        assertApi(Number.isInteger(row.year) && row.year > 0, 400, 'INVALID_PLAN_YEAR', '保单年度必须是正整数。', { index });
        assertApi(!years.includes(row.year), 400, 'DUPLICATE_PLAN_YEAR', '保单年度不能重复。', { year: row.year }); years.push(row.year);
        for (const field of ['premium','benefit','cash_value','death_benefit']) if (field in row) finiteMoney(row[field], field);
      }
      years.sort((a,b)=>a-b);
      if (input.confirmation_status === 'confirmed') {
        for (let i=1;i<years.length;i++) assertApi(years[i] === years[i-1]+1, 422, 'MISSING_PLAN_YEAR', '确认方案不能跳过保单年度。', { previous: years[i-1], next: years[i] });
        for (const row of input.annual_data) for (const field of ['premium','benefit','cash_value']) assertApi(row[field] !== null && row[field] !== undefined, 422, 'UNKNOWN_CONFIRMED_PLAN_VALUE', '确认方案不能把未知金额当作 0。', { year: row.year, field });
      }
      const authoritativeSnapshot = { ...input.condition_snapshot, customer_id: opp.customer_id, opportunity_id: oid, opportunity_revision: opp.revision, person_ids: parse(opp.person_ids, []), purpose: opp.purpose, budget_amount: opp.budget_amount, budget_currency: opp.budget_currency, product_id: opp.product_id, product_version: opp.product_version };
      const pid = input.plan_id || id('plan'); const at = nowIso(now);
      run('INSERT INTO plans VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', ws, pid, oid, input.plan_version || 1, 1, json(authoritativeSnapshot), json(input.annual_data), json(input.sources || []), input.confirmation_status || 'proposed', 0, null, at, at);
      return this.getPlans(ws, oid).find(item => item.plan_id === pid);
    },
    getPlans(ws, oid) { ensureOpportunity(ws, oid); return all('SELECT * FROM plans WHERE workspace_id=? AND opportunity_id=? ORDER BY created_at DESC', ws, oid).map(row => ({ ...row, condition_snapshot: parse(row.condition_snapshot, {}), annual_data: parse(row.annual_data, []), sources: parse(row.sources, []), stale: Boolean(row.stale) })); },
    saveDraft(ws, oid, latestMessageId, expectedRevision, aiResult, context) {
      const opp = ensureOpportunity(ws, oid);
      const customer = ensureCustomer(ws, opp.customer_id);
      assertApi(Number(expectedRevision) === opp.revision, 409, 'REVISION_CONFLICT', '需求版本已变更。', { current_revision: opp.revision });
      assertApi(context.context_versions?.customer_revision === customer.revision
        && context.context_versions?.profile_version === customer.profile_version,
      409, 'STALE_CONTEXT', '生成期间客户状态或已确认画像已变化，旧结果未保存。');
      const state = conversationState(ws, oid, opp.environment);
      assertApi(state.latestCustomer, 409, 'NO_CUSTOMER_MESSAGE', '该购买需求还没有合格的客户消息。');
      assertApi(latestMessageId && latestMessageId === state.latestCustomer.message_id, 409, 'STALE_CONTEXT', '已有更新的客户消息，请重新生成草稿。', { latest_message_id: state.latestCustomer.message_id });
      const snapshotConversationId = context.context_versions?.latest_conversation_message_id;
      assertApi(snapshotConversationId, 409, 'STALE_CONTEXT_SNAPSHOT', '上下文缺少双向会话末尾快照，请重新生成。');
      assertApi(snapshotConversationId === state.latestConversation?.message_id, 409, 'STALE_CONTEXT', '生成期间双向会话已变更，旧结果未保存。', { latest_conversation_message_id: state.latestConversation?.message_id || null });
      const did = id('draft'); const at = nowIso(now);
      const productScope = context.product_scope && typeof context.product_scope === 'object'
        ? { ...context.product_scope, environment: context.environment || opp.environment }
        : null;
      run('INSERT INTO drafts(workspace_id,draft_id,opportunity_id,latest_message_id,context_versions,content,ai_result,status,revision,stale,product_scope,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,1,0,?,?,?)', ws, did, oid, latestMessageId, json(context.context_versions), String(aiResult.draft || ''), json(aiResult), aiResult.status || 'error', productScope ? json(productScope) : null, at, at);
      return this.getDraft(ws, did);
    },
    getDraft(ws, did) { const row = one('SELECT * FROM drafts WHERE workspace_id=? AND draft_id=?', ws, did); assertApi(row, 404, 'DRAFT_NOT_FOUND', '草稿不存在。'); return { ...row, context_versions: parse(row.context_versions, {}), ai_result: parse(row.ai_result, {}), edit_record: parse(row.edit_record), product_scope: parse(row.product_scope), stale: Boolean(row.stale) }; },
    getLatestDraft(ws, oid, latestMessageId = null) {
      ensureOpportunity(ws, oid);
      const row = latestMessageId
        ? one('SELECT * FROM drafts WHERE workspace_id=? AND opportunity_id=? AND latest_message_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1', ws, oid, latestMessageId)
        : one('SELECT * FROM drafts WHERE workspace_id=? AND opportunity_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1', ws, oid);
      return row ? { ...row, context_versions: parse(row.context_versions, {}), ai_result: parse(row.ai_result, {}), edit_record: parse(row.edit_record), product_scope: parse(row.product_scope), stale: Boolean(row.stale) } : null;
    },
    confirmDraft(ws, did, input) {
      return transaction(db, () => {
        const row = one('SELECT * FROM drafts WHERE workspace_id=? AND draft_id=?', ws, did);
        assertApi(row, 404, 'DRAFT_NOT_FOUND', '草稿不存在。');
        if (row.confirmation_key === input.idempotency_key && row.final_text) return { draft: this.getDraft(ws, did), idempotent_replay: true };
        assertApi(input.idempotency_key, 400, 'IDEMPOTENCY_KEY_REQUIRED', '确认草稿必须带幂等键。');
        assertApi(row.status === 'draft_ready', 409, 'DRAFT_NOT_READY', '只有待销售审核的草稿可以确认。', { current_status: row.status });
        assertApi(Number(input.expected_revision) === row.revision, 409, 'REVISION_CONFLICT', '草稿版本已变更。', { current_revision: row.revision });
        assertApi(!row.stale, 409, 'STALE_DRAFT', '草稿已过期，不能确认。', { reason: row.stale_reason });
        assertApi(['simulation','manual_record'].includes(input.delivery_mode), 400, 'DELIVERY_MODE_NOT_ALLOWED', '本批次只允许 simulation 或 manual_record，不会真实发送。');
        assertApi(input.final_text && String(input.final_text).trim(), 400, 'FINAL_TEXT_REQUIRED', '最终文本不能为空。');
        assertApi(['sales','champion'].includes(input.editor_role || 'sales'), 400, 'INVALID_EDITOR_ROLE', '草稿编辑者角色无效。');
        const opp = ensureOpportunity(ws, row.opportunity_id); const cust = ensureCustomer(ws, opp.customer_id);
        const contextVersions = parse(row.context_versions, {});
        assertApi(contextVersions.latest_conversation_message_id, 409, 'STALE_CONTEXT_SNAPSHOT', '旧草稿缺少双向会话末尾快照，不能默认为有效。');
        const state = conversationState(ws, row.opportunity_id, opp.environment);
        assertApi(contextVersions.latest_conversation_message_id === state.latestConversation?.message_id, 409, 'STALE_CONTEXT', '草稿生成后双向会话已变更。', { latest_conversation_message_id: state.latestConversation?.message_id || null });
        const savedScope = parse(row.product_scope, {});
        const savedAi = parse(row.ai_result, {});
        const contractService = savedAi.interaction_type === 'contract_service'
          && Boolean(savedScope?.policy_contract_version)
          && savedScope.policy_contract_version === opp.policy_contract_version
          && classifyConversationTurn({ latest_message: state.latestCustomer?.text,
            contact_state: { purchased_for_opportunity: Boolean(opp.purchased), human_handoff: Boolean(cust.human_handoff || opp.human_handoff), marketing_opt_out: Boolean(cust.marketing_opt_out) },
            product_scope: savedScope }) === 'service';
        assertApi(!cust.marketing_opt_out || contractService, 409, 'MARKETING_OPT_OUT', '客户已拒收营销，仅可确认当前绑定合同的服务草稿。');
        assertApi(!cust.human_handoff && !opp.human_handoff, 409, 'HUMAN_HANDOFF_ACTIVE', '当前已转人工接手，不能由助手确认草稿。');
        const finalText = String(input.final_text).trim(); const at = nowIso(now);
        const editorRole = input.editor_role || 'sales';
        const editorId = String(input.editor_id || editorRole).trim().slice(0, 160);
        const edit = { original_text: row.content, final_text: finalText, changed: row.content !== finalText, editor_id: editorId, editor_role: editorRole, recorded_at: at };
        run('UPDATE drafts SET final_text=?,delivery_mode=?,confirmation_key=?,edit_record=?,editor_id=?,editor_role=?,status=?,revision=revision+1,updated_at=? WHERE workspace_id=? AND draft_id=?', finalText, input.delivery_mode, input.idempotency_key, json(edit), editorId, editorRole, input.delivery_mode === 'simulation' ? 'simulated_sent' : 'manually_confirmed_sent', at, ws, did);
        this.addMessage(ws, row.opportunity_id, { idempotency_key: `draft-confirm:${input.idempotency_key}`, role: 'sales', text: finalText, status: input.delivery_mode === 'simulation' ? 'simulated_sent' : 'manually_confirmed_sent', source: 'draft_confirmation', environment: input.delivery_mode === 'simulation' ? 'simulation' : opp.environment, occurred_at: at });
        const nextStage = savedScope?.product_id ? 'closing' : (opp.sales_stage === 'new_contact' ? 'discovery' : opp.sales_stage);
        run('UPDATE opportunities SET sales_stage=?,processing_status=CASE WHEN processing_status IN (\'human_handoff\',\'marketing_opt_out\',\'purchased_service\') THEN processing_status ELSE \'waiting_customer\' END,updated_at=? WHERE workspace_id=? AND opportunity_id=?', nextStage, at, ws, row.opportunity_id);
        return { draft: this.getDraft(ws, did), idempotent_replay: false };
      });
    },
    createTask(ws, input) {
      if (input.idempotency_key) { const prior = one('SELECT * FROM tasks WHERE workspace_id=? AND idempotency_key=?', ws, input.idempotency_key); if (prior) return { task: prior, idempotent_replay: true }; }
      if (input.customer_id) ensureCustomer(ws, input.customer_id);
      if (input.opportunity_id) {
        const taskOpportunity = ensureOpportunity(ws, input.opportunity_id);
        assertApi(!input.customer_id || taskOpportunity.customer_id === input.customer_id, 400, 'TASK_SCOPE_MISMATCH', '任务的客户与购买需求不匹配。');
      }
      assertApi(input.owner && input.reason, 400, 'TASK_FIELDS_REQUIRED', '任务必须包含 owner 和 reason。');
      if (input.due_at) assertApi(!Number.isNaN(Date.parse(input.due_at)), 400, 'INVALID_DUE_AT', 'due_at 必须是 ISO 8601 时间。');
      const tid = input.task_id || id('task'); const at = nowIso(now);
      run('INSERT INTO tasks(workspace_id,task_id,customer_id,opportunity_id,due_at,owner,title,status,reason,result,idempotency_key,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', ws, tid, input.customer_id || null, input.opportunity_id || null, input.due_at || null, input.owner, input.title || input.reason, input.status || 'open', input.reason, input.result || null, input.idempotency_key || null, 1, at, at);
      return { task: one('SELECT * FROM tasks WHERE workspace_id=? AND task_id=?', ws, tid), idempotent_replay: false };
    },
    listTasks(ws, filters = {}) {
      const rows = all('SELECT * FROM tasks WHERE workspace_id=? ORDER BY CASE WHEN due_at IS NULL THEN 1 ELSE 0 END,due_at,created_at', ws);
      const current = now();
      return rows.filter(row => !filters.status || row.status === filters.status).map(row => ({ ...row, overdue: Boolean(row.due_at && ['open','in_progress'].includes(row.status) && new Date(row.due_at) < current) }));
    },
    patchTask(ws, tid, expected, changes = {}) {
      const row = one('SELECT * FROM tasks WHERE workspace_id=? AND task_id=?', ws, tid); assertApi(row, 404, 'TASK_NOT_FOUND', '任务不存在。');
      assertApi(Number(expected) === row.revision, 409, 'REVISION_CONFLICT', '任务版本已变更。', { current_revision: row.revision });
      const fields = ['due_at','owner','title','status','reason','result']; assertApi(Object.keys(changes).every(key => fields.includes(key)), 400, 'UNSUPPORTED_CHANGE', '包含不支持的任务字段。');
      if ('status' in changes) assertApi(['open','in_progress','completed','cancelled'].includes(changes.status), 400, 'INVALID_TASK_STATUS', '任务状态无效。');
      const at = nowIso(now); const values = fields.map(field => changes[field] === undefined ? row[field] : changes[field]);
      run(`UPDATE tasks SET ${fields.map(field => `${field}=?`).join(',')},revision=revision+1,updated_at=? WHERE workspace_id=? AND task_id=?`, ...values, at, ws, tid);
      return one('SELECT * FROM tasks WHERE workspace_id=? AND task_id=?', ws, tid);
    },
    _helpers: { one, all, run, ensureCustomer, ensureOpportunity }
  };
}
