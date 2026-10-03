import { randomUUID } from 'node:crypto';
import { assertApi } from './errors.mjs';

const json = value => JSON.stringify(value ?? null);
const parse = (value, fallback = null) => { try { return value == null ? fallback : JSON.parse(value); } catch { return fallback; } };

function number(value) {
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : null;
}

export function difyUsage(payload) {
  const data = payload?.data || payload || {};
  const usage = data.usage || data.metadata?.usage || {};
  const inputTokens = number(usage.prompt_tokens ?? usage.input_tokens ?? data.input_tokens);
  const outputTokens = number(usage.completion_tokens ?? usage.output_tokens ?? data.output_tokens);
  const totalTokens = number(data.total_tokens ?? usage.total_tokens)
    ?? ((inputTokens ?? 0) + (outputTokens ?? 0));
  // DeepSeek Flash 高峰价格作为保守成本上界：输入 2 元/M，输出 8 元/M。
  const estimatedCostCny = inputTokens !== null || outputTokens !== null
    ? ((inputTokens ?? 0) * 2 + (outputTokens ?? 0) * 8) / 1_000_000
    : (totalTokens * 8) / 1_000_000;
  return { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: totalTokens, estimated_cost_cny: estimatedCostCny };
}

export function createAiBudgetService({ store, now = () => new Date(), limitCny = 10 } = {}) {
  assertApi(store?.raw, 500, 'AI_BUDGET_STORE_REQUIRED', 'AI 成本服务需要数据库。');
  const db = store.raw;
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_usage_events (
      workspace_id TEXT NOT NULL,event_id TEXT NOT NULL,customer_id TEXT NOT NULL,opportunity_id TEXT,
      workflow TEXT NOT NULL,provider_run_id TEXT,idempotency_key TEXT,
      input_tokens INTEGER,output_tokens INTEGER,total_tokens INTEGER NOT NULL,
      estimated_cost_cny REAL NOT NULL,raw_usage TEXT NOT NULL,created_at TEXT NOT NULL,
      PRIMARY KEY(workspace_id,event_id),UNIQUE(workspace_id,idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS ai_usage_customer ON ai_usage_events(workspace_id,customer_id,created_at);
  `);
  const status = (workspaceId, customerId) => {
    const totals = db.prepare(`SELECT COALESCE(SUM(total_tokens),0) AS tokens,COALESCE(SUM(estimated_cost_cny),0) AS cost
      FROM ai_usage_events WHERE workspace_id=? AND customer_id=?`).get(workspaceId, customerId);
    const cost = Number(totals.cost) || 0;
    const percent = Math.min(999, Math.round(cost / limitCny * 1000) / 10);
    const state = cost >= limitCny ? 'stopped' : cost >= limitCny * 0.7 ? 'warning' : 'normal';
    return {
      customer_id: customerId, limit_cny: limitCny, used_cny: Math.round(cost * 10000) / 10000,
      remaining_cny: Math.max(0, Math.round((limitCny - cost) * 10000) / 10000),
      used_percent: percent, total_tokens: Number(totals.tokens) || 0, state,
      ai_mode: state === 'stopped' ? 'human_only' : state === 'warning' ? 'essential_only' : 'normal',
      nonessential_ai_enabled: state === 'normal',
      alert: state === 'stopped' ? '该客户 AI 成本已达10元上限，已停止所有 AI 调用，请人工接管。'
        : state === 'warning' ? '该客户 AI 成本已达70%，只保留必要AI调用并减少非必要分析。' : null
    };
  };
  return {
    status,
    assertAvailable(workspaceId, customerId) {
      const value = status(workspaceId, customerId);
      assertApi(value.state !== 'stopped', 409, 'AI_BUDGET_EXHAUSTED', value.alert, value);
      return value;
    },
    assertNonessentialAvailable(workspaceId, customerId) {
      const value = status(workspaceId, customerId);
      assertApi(value.state === 'normal', 409,
        value.state === 'stopped' ? 'AI_BUDGET_EXHAUSTED' : 'AI_BUDGET_ESSENTIAL_ONLY',
        value.alert, value);
      return value;
    },
    record({ workspace_id, customer_id, opportunity_id = null, workflow, provider_run_id = null, idempotency_key = null, payload }) {
      if (!workspace_id || !customer_id || !workflow) return null;
      if (idempotency_key) {
        const prior = db.prepare('SELECT * FROM ai_usage_events WHERE workspace_id=? AND idempotency_key=?').get(workspace_id, idempotency_key);
        if (prior) return { ...prior, raw_usage: parse(prior.raw_usage, {}) };
      }
      const usage = difyUsage(payload);
      const eventId = `usage_${randomUUID()}`;
      const at = now().toISOString();
      db.prepare(`INSERT INTO ai_usage_events(workspace_id,event_id,customer_id,opportunity_id,workflow,provider_run_id,idempotency_key,input_tokens,output_tokens,total_tokens,estimated_cost_cny,raw_usage,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(workspace_id,eventId,customer_id,opportunity_id,workflow,provider_run_id,idempotency_key,
      usage.input_tokens,usage.output_tokens,usage.total_tokens,usage.estimated_cost_cny,json(usage),at);
      const budget = status(workspace_id, customer_id);
      const customerExists = db.prepare('SELECT 1 FROM customers WHERE workspace_id=? AND customer_id=?').get(workspace_id, customer_id);
      if (budget.state === 'stopped' && customerExists) {
        store.createTask(workspace_id, {
          customer_id, opportunity_id, due_at: at, owner: 'sales', title: 'AI费用达到上限，请人工接管',
          reason: `该客户累计AI费用已达到${budget.used_cny}元，系统已停止AI调用，现有对话与客户资料保留，由销售继续处理。`,
          idempotency_key: `ai-budget-handoff:${customer_id}`
        });
      }
      return { event_id: eventId, ...usage, budget };
    },
    list(workspaceId, customerId) {
      return db.prepare('SELECT * FROM ai_usage_events WHERE workspace_id=? AND customer_id=? ORDER BY created_at,rowid').all(workspaceId, customerId)
        .map(row => ({ ...row, raw_usage: parse(row.raw_usage, {}) }));
    }
  };
}

export function usageScopeFromDifyInput(payload = {}) {
  if (payload.observability && typeof payload.observability === 'object') {
    return {
      workspace_id: payload.observability.workspace_id || null,
      customer_id: payload.observability.customer_id || null,
      opportunity_id: payload.observability.opportunity_id || null,
      idempotency_key: payload.observability.latest_message_id || null,
      trace_id: payload.observability.trace_id || null,
      session_id: payload.observability.session_id || null,
      case_id: payload.observability.case_id || null,
      eval_run_id: payload.observability.eval_run_id || null
    };
  }
  try {
    const context = JSON.parse(String(payload.inputs?.context_json || '{}'));
    return {
      workspace_id: context.workspace_id || null,
      customer_id: context.customer_id || null,
      opportunity_id: context.opportunity_id || null,
      idempotency_key: context.latest_message_id || null,
      trace_id: context.trace_id || null,
      session_id: context.session_id || null,
      case_id: context.evaluation?.case_id || null,
      eval_run_id: context.evaluation?.eval_run_id || null
    };
  } catch { return {}; }
}
