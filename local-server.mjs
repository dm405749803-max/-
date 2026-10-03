import { createDeepSeekRunner } from './server/deepseek-client.mjs';
import { createServer } from 'node:http';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './server/database.mjs';
import { createV2Api } from './server/api.mjs';
import { createCopilotApi, COPILOT_WORKSPACE } from './server/copilot.mjs';
import { createDifyWorkflowRunner } from './server/dify-workflow.mjs';
import { createDashScopeTranscriber } from './server/media-transcription.mjs';
import { createConversationOrchestrator } from './server/conversation-orchestrator.mjs';
import { createAiBudgetService, difyUsage, usageScopeFromDifyInput } from './server/ai-budget.mjs';
import { createKnowledgeSafetyService } from './server/knowledge-safety.mjs';
import { createObservabilityService } from './server/observability.mjs';
import { createLangfuseExporter } from './server/langfuse-exporter.mjs';
import { createEvaluationGateway } from './server/evaluation-gateway.mjs';
import { retrieveKnowledge } from './knowledge/retrieve.mjs';

let createDifyRunner = createDifyWorkflowRunner;
try {
  ({ createDifyRunner } = await import('./dify/client.mjs'));
} catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND' || !String(error.message).includes('/dify/client.mjs')) throw error;
}

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(ROOT, 'dist');
const DATA_DIR = join(ROOT, '.local-data');
const STATE_FILE = join(DATA_DIR, 'workbench-state.json');
const EVALUATION_CASES_FILE = join(ROOT, 'evaluation', 'sales-v1-cases.json');
const EVALUATION_RESULTS_FILE = join(DATA_DIR, 'evaluation-results.json');
const DOCUMENT_EXTRACTOR = join(ROOT, 'scripts', 'extract-document.swift');
const execFile = promisify(execFileCallback);

async function loadLocalEnv() {
  try {
    const text = await readFile(join(ROOT, '.env.local'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const index = trimmed.indexOf('=');
      if (index < 1) continue;
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

await loadLocalEnv();

const PORT = Number(process.env.LOCAL_PORT || 8788);
const DIFY_BASE = String(process.env.DIFY_API_BASE_URL || 'http://localhost/v1').replace(/\/$/, '');
const DEEPSEEK_KEY = String(process.env.DEEPSEEK_API_KEY || '');
const DIFY_KEY = String(process.env.DIFY_APP_API_KEY || '');
const DIFY_SALES_TIMEOUT_MS = Math.max(30_000, Math.min(120_000, Number(process.env.DIFY_SALES_TIMEOUT_MS) || 60_000));
const BACKEND_B1_ENABLED = process.env.TONGPIN_ENABLE_BACKEND_B1 === '1';
const BACKEND_B2_ENABLED = process.env.TONGPIN_ENABLE_BACKEND_B2 === '1';
const BACKEND_ONLY = process.env.TONGPIN_BACKEND_ONLY === '1';
const DIFY_MEMORY_KEY = String(process.env.DIFY_MEMORY_APP_API_KEY || '');
const DIFY_MEMORY_BASE = String(process.env.DIFY_MEMORY_API_BASE_URL || DIFY_BASE).replace(/\/$/, '');
const DIFY_MEMORY_TIMEOUT_MS = Math.max(30_000, Math.min(120_000, Number(process.env.DIFY_MEMORY_TIMEOUT_MS) || 60_000));
const DIFY_MATCH_KEY = String(process.env.DIFY_MATCH_APP_API_KEY || '');
const DIFY_MATCH_BASE = String(process.env.DIFY_MATCH_API_BASE_URL || DIFY_BASE).replace(/\/$/, '');
const DASHSCOPE_ASR_KEY = String(process.env.DASHSCOPE_API_KEY || '');
const DASHSCOPE_ASR_BASE = String(process.env.DASHSCOPE_ASR_API_BASE_URL || 'https://dashscope.aliyuncs.com/api/v1').replace(/\/$/, '');
const DASHSCOPE_ASR_MODEL = String(process.env.DASHSCOPE_ASR_MODEL || 'qwen-audio-3.1-asr-flash');
const V2_DATABASE_FILE = process.env.V2_DATABASE_PATH || join(DATA_DIR, 'sales-assist-v2.sqlite');
const LANGFUSE_BASE_URL = String(process.env.LANGFUSE_BASE_URL || '').replace(/\/$/, '');
const LANGFUSE_PUBLIC_KEY = String(process.env.LANGFUSE_PUBLIC_KEY || '');
const LANGFUSE_SECRET_KEY = String(process.env.LANGFUSE_SECRET_KEY || '');
const MAX_BODY = 24_000;
const WECHAT_REPLY_STYLE = `微信回复要求（必须遵守）：
你是在替一位熟悉客户情况的保险销售起草微信消息，不要像机器人、客服公告或产品说明书。
先顺着客户这一句话回应，再把和当前问题直接相关的事实说清楚；用 2—4 个短句，通常控制在 120 字以内，不列清单。
不要使用“在继续说明前”“根据您提供的信息”“建议您进一步了解”“综上所述”等机器化套话，也不要每次都以“您好”“收到”开头。
只有缺少的信息会影响当前回答时，结尾才自然问 1 个问题；客户已经说过的内容不要再问。
可以说“这个点确实要先弄清楚”“我先把这件事说清楚”等自然表达，但不得假装亲身经历，不得编造事实、承诺收益、催单或替客户作适合度结论。`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm'
};

const v2Store = openDatabase(V2_DATABASE_FILE);
const langfuseExporter = createLangfuseExporter({
  baseUrl: LANGFUSE_BASE_URL,
  publicKey: LANGFUSE_PUBLIC_KEY,
  secretKey: LANGFUSE_SECRET_KEY,
  environment: process.env.TONGPIN_ENVIRONMENT || 'local'
});
const observability = createObservabilityService({ store: v2Store, exporter: langfuseExporter });
const aiBudget = createAiBudgetService({ store: v2Store, limitCny: Number(process.env.AI_CUSTOMER_BUDGET_CNY || 10) });
const knowledgeSafety = createKnowledgeSafetyService({ store: v2Store });
let salesAssist = null;
try {
  ({ runSalesAssist: salesAssist } = await import('./ai/sales-assist.mjs'));
} catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND' || !String(error.message).includes('/ai/sales-assist.mjs')) throw error;
}

function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(JSON.stringify(body));
}

async function readJson(req, maxBytes = MAX_BODY) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > maxBytes) throw new Error('REQUEST_TOO_LARGE');
  }
  return JSON.parse(body || '{}');
}

function trackedDifyRunner(baseRunner, workflow) {
  if (!baseRunner) return null;
  return async payload => {
    const scope = usageScopeFromDifyInput(payload);
    if (scope.workspace_id && scope.customer_id) {
      if (workflow === 'B1_memory') aiBudget.assertNonessentialAvailable(scope.workspace_id, scope.customer_id);
      else aiBudget.assertAvailable(scope.workspace_id, scope.customer_id);
    }
    const run = () => baseRunner(payload);
    const result = scope.workspace_id && scope.trace_id
      ? await observability.observe({
        workspace_id: scope.workspace_id, trace_id: scope.trace_id, type: 'generation', name: `dify.${workflow}`,
        model: 'deepseek', input: { workflow, opportunity_id: scope.opportunity_id, case_id: scope.case_id }
      }, run)
      : await run();
    if (scope.workspace_id && scope.customer_id) aiBudget.record({
      ...scope, workflow, provider_run_id: result?.workflow_run_id || result?.data?.id || null,
      idempotency_key: `${workflow}:${scope.idempotency_key || result?.workflow_run_id || randomUUID()}`, payload: result
    });
    if (scope.workspace_id && scope.trace_id) {
      const row = v2Store.raw.prepare(`SELECT observation_id FROM ai_observations WHERE workspace_id=? AND trace_id=? AND name=?
        ORDER BY started_at DESC,rowid DESC LIMIT 1`).get(scope.workspace_id, scope.trace_id, `dify.${workflow}`);
      if (row) {
        const usage = difyUsage(result);
        v2Store.raw.prepare(`UPDATE ai_observations SET input_tokens=?,output_tokens=?,total_tokens=?,cost_cny=?,model=? WHERE workspace_id=? AND observation_id=?`)
          .run(usage.input_tokens, usage.output_tokens, usage.total_tokens, usage.estimated_cost_cny, 'deepseek', scope.workspace_id, row.observation_id);
      }
    }
    return result;
  };
}

const runDifyWorkflow = DEEPSEEK_KEY
  ? trackedDifyRunner(createDeepSeekRunner({ apiKey: DEEPSEEK_KEY, workflow: 'A_sales_draft' }), 'A_sales_draft')
  : DIFY_KEY
  ? trackedDifyRunner(createDifyRunner({ baseUrl: DIFY_BASE, apiKey: DIFY_KEY, timeoutMs: DIFY_SALES_TIMEOUT_MS }), 'A_sales_draft')
  : async () => { throw new Error('DIFY_NOT_CONFIGURED'); };
const transcribeMedia = DASHSCOPE_ASR_KEY
  ? createDashScopeTranscriber({ baseUrl: DASHSCOPE_ASR_BASE, apiKey: DASHSCOPE_ASR_KEY, model: DASHSCOPE_ASR_MODEL })
  : null;

let backendB1 = null;
if (BACKEND_B1_ENABLED) {
  const { createBackendB1 } = await import('./server/backend-b1.mjs');
  backendB1 = createBackendB1({
    store: v2Store, readJson, sendJson: json,
    runMemoryDify: DEEPSEEK_KEY ? trackedDifyRunner(createDeepSeekRunner({ apiKey: DEEPSEEK_KEY, workflow: 'B1_memory' }), 'B1_memory') : DIFY_MEMORY_KEY ? trackedDifyRunner(createDifyRunner({
      baseUrl: DIFY_MEMORY_BASE,
      apiKey: DIFY_MEMORY_KEY,
      timeoutMs: DIFY_MEMORY_TIMEOUT_MS
    }), 'B1_memory') : null
  });
}

let backendB2 = null;
if (BACKEND_B2_ENABLED) {
  const { createBackendB2 } = await import('./server/backend-b2.mjs');
  backendB2 = createBackendB2({
    store: v2Store, readJson, sendJson: json,
    runMatchDify: DEEPSEEK_KEY ? trackedDifyRunner(createDeepSeekRunner({ apiKey: DEEPSEEK_KEY, workflow: 'B2_product_match' }), 'B2_product_match') : DIFY_MATCH_KEY ? trackedDifyRunner(createDifyRunner({ baseUrl: DIFY_MATCH_BASE, apiKey: DIFY_MATCH_KEY }), 'B2_product_match') : null,
    allowSimulationProducts: process.env.TONGPIN_ENABLE_SIMULATION_KNOWLEDGE === '1'
  });
}

const conversationOrchestrator = salesAssist ? createConversationOrchestrator({
  runSalesAssist: salesAssist,
  ...(backendB1 ? {
    scheduleMemoryProposal: request => backendB1.generateMemoryProposal(request),
    findMemoryProposal: request => backendB1.findMemoryProposal(request)
  } : {}),
  ...(backendB2 ? {
    generateProductRecommendation: request => backendB2.recommendations.generate(request.workspaceId, request.opportunityId, {
      idempotency_key: request.idempotencyKey,
      latest_message_id: request.latestMessageId,
      expected_revision: request.expectedRevision,
      expected_context_versions: request.contextVersions,
      trace_id: request.traceId, session_id: request.sessionId,
      case_id: request.caseId, eval_run_id: request.evalRunId
    })
  } : {}),
  onBackgroundError(error, request) {
    console.error(`后台记忆提取失败，下一轮可重试：${request.opportunityId}/${request.messageId} ${error?.code || error?.name || 'ERROR'}`);
  }
}) : null;

const automaticSimulationJobs = new Map();

async function localV2Request(path, workspaceId, options = {}) {
  const response = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    ...options,
    headers: {
      accept: 'application/json',
      'x-workspace-id': workspaceId,
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.headers || {})
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `HTTP ${response.status}`);
    error.code = payload?.error?.code || `HTTP_${response.status}`;
    throw error;
  }
  return payload;
}

async function processAutomaticSimulationReply(request) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const contextPayload = await localV2Request(`/api/v2/opportunities/${encodeURIComponent(request.opportunityId)}/context`, request.workspaceId);
    const context = contextPayload.data;
    if (context.latest_message_id !== request.messageId) return { status: 'superseded' };
    try {
      const generated = await localV2Request(`/api/v2/opportunities/${encodeURIComponent(request.opportunityId)}/drafts`, request.workspaceId, {
        method: 'POST', body: { latest_message_id: request.messageId, expected_revision: context.context_versions.opportunity_revision }
      });
      const draft = generated.data;
      if (draft.status === 'draft_ready' && draft.review_required === false && draft.next_action === 'auto_send_safe_intake') {
        await localV2Request(`/api/v2/drafts/${encodeURIComponent(draft.draft_id)}/confirm`, request.workspaceId, {
          method: 'POST', body: {
            expected_revision: draft.revision,
            final_text: draft.draft,
            delivery_mode: 'simulation',
            editor_id: 'automatic-safe-intake',
            editor_role: 'sales',
            idempotency_key: `automatic-safe-intake:${request.messageId}`
          }
        });
        return { status: 'sent', draft_id: draft.draft_id };
      }
      return { status: draft.status === 'draft_ready' ? 'sales_review_required' : draft.status, draft_id: draft.draft_id };
    } catch (error) {
      if (!['STALE_CONTEXT', 'REVISION_CONFLICT'].includes(error.code) || attempt === 1) throw error;
    }
  }
  return { status: 'stale' };
}

function scheduleAutomaticSimulationReply(request) {
  if (request.workspaceId === COPILOT_WORKSPACE) return { status: 'sales_confirmation_required' };
  if (request.environment !== 'simulation' || request.source !== 'manual') return { status: 'not_scheduled' };
  const key = `${request.workspaceId}:${request.opportunityId}:${request.messageId}`;
  if (automaticSimulationJobs.has(key)) return { status: 'running' };
  const job = processAutomaticSimulationReply(request)
    .catch(error => {
      if (!['STALE_CONTEXT', 'REVISION_CONFLICT', 'MARKETING_OPT_OUT', 'HUMAN_HANDOFF_ACTIVE'].includes(error.code)) {
        console.error(`模拟对话自动处理失败：${request.opportunityId}/${request.messageId} ${error.code || error.name || 'ERROR'}`);
      }
      return { status: 'failed', code: error.code || 'ERROR' };
    })
    .finally(() => automaticSimulationJobs.delete(key));
  automaticSimulationJobs.set(key, job);
  return { status: 'scheduled' };
}

const routeCopilot = createCopilotApi({ store: v2Store, readJson, sendJson: json, observability, knowledgeSafety,
  validateDraft: backendB2 ? row => backendB2.validateDraft(row) : null });

const routeV2 = createV2Api({
  store: v2Store,
  salesAssist,
  conversationOrchestrator,
  aiBudget,
  knowledgeSafety,
  observability,
  onCustomerMessage: scheduleAutomaticSimulationReply,
  ...(backendB1 ? {
    onOpportunityPurchased: ({ workspaceId, opportunityId, purchasedAt }) => backendB1.salesOps.captureChampionCandidates(workspaceId, opportunityId, { purchased_at: purchasedAt })
  } : {}),
  readJson,
  sendJson: json,
  aiConfigured: Boolean(DEEPSEEK_KEY || DIFY_KEY),
  transcribeMedia,
  mediaTranscriptionConfigured: Boolean(transcribeMedia),
  ...(backendB2 ? {
    prepareSalesContext: context => backendB2.prepareSalesContext(context),
    validateSalesContext: context => backendB2.validateSalesContext(context),
    validateDraft: row => backendB2.validateDraft(row)
  } : {}),
  aiDependencies: {
    runDify: runDifyWorkflow,
    retrieveKnowledge: async (request, dependencies) => {
      const traceId = request.trace_id || null;
      return traceId ? observability.observe({
        workspace_id: request.workspace_id || 'demo', trace_id: traceId, type: 'retriever', name: 'rag.retrieve',
        input: { query: request.query, product_scope: request.product_scope, limit: request.limit || 5 },
        metadata: { top_k: request.limit || 5, top_n: request.limit || 5 }
      }, () => retrieveKnowledge(request, dependencies)) : retrieveKnowledge(request, dependencies);
    },
    ...(backendB1 ? { retrieveExperiences: request => backendB1.retrieveExperiences(request) } : {}),
    now: () => new Date(),
    allowSimulationKnowledge: process.env.TONGPIN_ENABLE_SIMULATION_KNOWLEDGE === '1'
  }
});

const runEvaluationCase = createEvaluationGateway({ baseUrl: `http://127.0.0.1:${PORT}` });

function validWorkbenchState(value) {
  return Boolean(value && typeof value === 'object' && value.product && Array.isArray(value.customers) && Array.isArray(value.tasks) && Array.isArray(value.learning));
}

async function readWorkbenchState(res) {
  try {
    const state = JSON.parse(await readFile(STATE_FILE, 'utf8'));
    if (!validWorkbenchState(state)) return json(res, 500, { status: 'error', reason: '保存的数据结构无效。' });
    return json(res, 200, { status: 'ok', state });
  } catch (error) {
    if (error.code === 'ENOENT') return json(res, 404, { status: 'empty' });
    return json(res, 500, { status: 'error', reason: '无法读取本地数据。' });
  }
}

async function writeWorkbenchState(req, res) {
  try {
    const state = await readJson(req, 1_000_000);
    if (!validWorkbenchState(state)) return json(res, 400, { status: 'error', reason: '保存的数据结构无效。' });
    await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
    const temp = `${STATE_FILE}.tmp`;
    await writeFile(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(temp, STATE_FILE);
    return json(res, 200, { status: 'saved', updated_at: new Date().toISOString() });
  } catch (error) {
    const status = error.message === 'REQUEST_TOO_LARGE' ? 413 : 400;
    return json(res, status, { status: 'error', reason: '无法保存本地数据。' });
  }
}

async function readEvaluationFile(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

async function readEvaluationCases(res) {
  try {
    const payload = await readEvaluationFile(EVALUATION_CASES_FILE, null);
    if (!payload || payload.schema_version !== 'sales-evaluation.v1' || !Array.isArray(payload.cases)) {
      return json(res, 500, { error: { code: 'EVALUATION_CASES_INVALID', message: '评测集数据无效。' } });
    }
    return json(res, 200, payload);
  } catch {
    return json(res, 500, { error: { code: 'EVALUATION_CASES_UNAVAILABLE', message: '无法读取评测集。' } });
  }
}

async function readEvaluationResults(res) {
  try {
    const results = await readEvaluationFile(EVALUATION_RESULTS_FILE, []);
    return json(res, 200, { schema_version: 'sales-evaluation-results.v1', results: Array.isArray(results) ? results : [] });
  } catch {
    return json(res, 500, { error: { code: 'EVALUATION_RESULTS_UNAVAILABLE', message: '无法读取评测结果。' } });
  }
}

async function writeEvaluationResult(req, res) {
  try {
    const input = await readJson(req, 500_000);
    const caseId = text(input.case_id, 8);
    const verdict = text(input.verdict, 30);
    if (!/^[A-H]\d{2}$/.test(caseId)) return json(res, 400, { error: { code: 'INVALID_CASE_ID', message: '评测案例编号无效。' } });
    if (!['passed', 'failed', 'needs_review'].includes(verdict)) return json(res, 400, { error: { code: 'INVALID_VERDICT', message: '请选择通过、不通过或待复核。' } });
    const cases = await readEvaluationFile(EVALUATION_CASES_FILE, null);
    if (!cases?.cases?.some(item => item.id === caseId)) return json(res, 404, { error: { code: 'CASE_NOT_FOUND', message: '评测案例不存在。' } });
    const existing = await readEvaluationFile(EVALUATION_RESULTS_FILE, []);
    const record = {
      result_id: `eval_${randomUUID()}`,
      case_id: caseId,
      verdict,
      notes: text(input.notes, 4000),
      run_id: text(input.run_id, 160) || null,
      opportunity_id: text(input.opportunity_id, 160) || null,
      actual: input.actual && typeof input.actual === 'object' ? input.actual : null,
      created_at: new Date().toISOString()
    };
    const results = [...(Array.isArray(existing) ? existing : []), record].slice(-5000);
    await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
    const temp = `${EVALUATION_RESULTS_FILE}.tmp`;
    await writeFile(temp, JSON.stringify(results, null, 2), { mode: 0o600 });
    await rename(temp, EVALUATION_RESULTS_FILE);
    return json(res, 201, { data: record });
  } catch (error) {
    return json(res, error.message === 'REQUEST_TOO_LARGE' ? 413 : 400, { error: { code: 'EVALUATION_RESULT_INVALID', message: '评测结果无法保存。' } });
  }
}

function text(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

function groupedPageLines(page) {
  const observations = Array.isArray(page?.observations) ? page.observations : [];
  if (page?.method !== 'vision-ocr' || !observations.some(item => Number(item.width) > 0)) {
    return String(page?.text || '').split(/\r?\n/).map(value => ({ text: value.trim(), confidence: 1 })).filter(item => item.text);
  }
  const groups = [];
  for (const item of observations) {
    const midY = Number(item.y) + Number(item.height) / 2;
    let group = groups.find(candidate => Math.abs(candidate.midY - midY) <= Math.max(.012, Number(item.height) * .6));
    if (!group) {
      group = { midY, items: [] };
      groups.push(group);
    }
    group.items.push(item);
    group.midY = group.items.reduce((sum, entry) => sum + Number(entry.y) + Number(entry.height) / 2, 0) / group.items.length;
  }
  return groups.sort((a, b) => b.midY - a.midY).map(group => {
    const items = group.items.sort((a, b) => Number(a.x) - Number(b.x));
    return {
      text: items.map(item => String(item.text || '').trim()).filter(Boolean).join(' '),
      confidence: items.reduce((sum, item) => sum + Number(item.confidence || 0), 0) / Math.max(1, items.length)
    };
  }).filter(item => item.text);
}

function planCandidates(pages) {
  const candidates = [];
  for (const page of pages) {
    for (const line of groupedPageLines(page)) {
      const normalized = line.text.replace(/[￥¥]/g, '').replace(/，/g, ',');
      const matches = [...normalized.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)].filter(match => normalized.slice(match.index + match[0].length).trimStart()[0] !== '%');
      if (matches.length < 4) continue;
      const values = matches.map(match => Number(match[0].replace(/,/g, ''))).filter(Number.isFinite);
      const year = Math.trunc(values[0]);
      if (year < 1 || year > 200) continue;
      const mapped = {
        year,
        premium: Math.max(0, values[1] ?? 0),
        benefit: Math.max(0, values[2] ?? 0),
        cashValue: Math.max(0, values[3] ?? 0),
        deathBenefit: Math.max(0, values[4] ?? 0)
      };
      const exact = values.length === 5;
      const confidence = Math.max(0, Math.min(1, Number(line.confidence || 0) * (exact ? .96 : .58)));
      candidates.push({
        id: `page-${page.page}-row-${candidates.length + 1}`,
        page: Number(page.page) || 1,
        sourceText: text(line.text, 500),
        confidence,
        exactColumnCount: exact,
        numericValues: values.slice(0, 12),
        ...mapped
      });
    }
  }
  const deduped = [];
  for (const candidate of candidates.sort((a, b) => a.page - b.page || a.year - b.year || b.confidence - a.confidence)) {
    const existing = deduped.find(item => item.page === candidate.page && item.year === candidate.year);
    if (!existing) deduped.push(candidate);
  }
  return deduped.slice(0, 200);
}

async function extractPlanDocument(req, res) {
  let input;
  try {
    input = await readJson(req, 12_000_000);
  } catch (error) {
    return json(res, error.message === 'REQUEST_TOO_LARGE' ? 413 : 400, { status: 'error', reason: '文件请求过大或格式无效。' });
  }
  const filename = text(input.filename, 200);
  const extension = extname(filename).toLowerCase();
  const allowed = new Set(['.pdf', '.png', '.jpg', '.jpeg']);
  if (!allowed.has(extension)) return json(res, 400, { status: 'error', reason: '只支持 PDF、PNG、JPG 或 JPEG。' });
  let data;
  try {
    data = Buffer.from(String(input.data_base64 || ''), 'base64');
  } catch {
    return json(res, 400, { status: 'error', reason: '文件内容无效。' });
  }
  if (!data.length || data.length > 8_000_000) return json(res, 413, { status: 'error', reason: '文件需小于 8 MB。' });
  const validSignature = extension === '.pdf'
    ? data.subarray(0, 4).toString() === '%PDF'
    : extension === '.png'
      ? data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (!validSignature) return json(res, 400, { status: 'error', reason: '文件扩展名与实际内容不一致。' });

  const directory = await mkdtemp(join(tmpdir(), 'tongpin-plan-'));
  const inputPath = join(directory, `input${extension}`);
  try {
    await writeFile(inputPath, data, { mode: 0o600 });
    const { stdout } = await execFile('/usr/bin/swift', [DOCUMENT_EXTRACTOR, inputPath], {
      timeout: 120_000,
      maxBuffer: 12_000_000,
      encoding: 'utf8'
    });
    const extraction = JSON.parse(stdout);
    if (extraction.status !== 'ok') return json(res, 422, { status: 'error', reason: text(extraction.warning, 800) || '没有识别到文本。' });
    const pages = Array.isArray(extraction.pages) ? extraction.pages : [];
    const candidates = planCandidates(pages);
    const rawText = pages.map(page => `第 ${page.page} 页\n${page.text || ''}`).join('\n\n').slice(0, 200_000);
    return json(res, 200, {
      status: 'review_required',
      filename,
      mode: text(extraction.mode, 80),
      page_count: pages.length,
      candidates,
      raw_text: rawText,
      warning: text(extraction.warning, 800),
      privacy: '原文件已从临时目录删除；识别结果只有人工确认后才写入方案。'
    });
  } catch (error) {
    const reason = error.killed || error.signal === 'SIGTERM' ? '识别超时，请缩小文件或减少页数后重试。' : '本机未能完成文档识别。';
    return json(res, 500, { status: 'error', reason });
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

function normalizeStatus(route) {
  return ({
    PENDING_SALES_APPROVAL: 'draft_ready',
    HUMAN_REQUIRED: 'human_required',
    CALL_REQUESTED: 'human_required',
    VERIFY_SOURCE: 'verify_source',
    STALE_DRAFT: 'stale_product',
    SERVICE_ONLY: 'service_only',
    STOP_MARKETING: 'stop_marketing',
    DRAFT_REVIEW_REQUIRED: 'review_required',
    MISSING_MESSAGE: 'error'
  })[route] || 'error';
}

function normalizeOutputs(outputs = {}) {
  const blocked = Object.keys(outputs).some(key => key.startsWith('blocked_'));
  const take = name => outputs[blocked ? `blocked_${name}` : name];
  const route = text(take('route'), 80);
  return {
    status: normalizeStatus(route),
    route,
    reason: text(take('reason'), 800),
    draft: text(take('draft'), 4000),
    handoff_required: Boolean(take('handoff_required')),
    approval_required: take('approval_required') !== false,
    product: {
      version: text(take('product_version'), 120),
      source: text(take('product_source'), 500)
    }
  };
}

function unknown(value) {
  const normalized = text(value, 160);
  return !normalized || /未确认|待确认|待重新确认|不适用/.test(normalized);
}

function analyzeCustomer(input) {
  const message = text(input.customer_message, 3000);
  const profile = input.customer_profile && typeof input.customer_profile === 'object' ? input.customer_profile : {};
  const status = text(input.customer_status, 40);
  const suggestions = [];
  const addSuggestion = (field, label, value, evidence) => {
    if (!value || suggestions.some(item => item.field === field)) return;
    const current = text(profile[field], 160);
    if (!unknown(current) && current === value) return;
    suggestions.push({ field, label, value, evidence, requires_confirmation: true });
  };

  const ageMatch = message.match(/(?:孩子|本人|我|家人)?\s*(\d{1,2})\s*岁/);
  if (ageMatch && Number(ageMatch[1]) > 0 && Number(ageMatch[1]) < 100) addSuggestion('age', '年龄', `${ageMatch[1]} 岁`, `客户原话提到“${ageMatch[0].trim()}”`);
  const budgetMatch = message.match(/(?:每年|一年|年交|预算)\s*(\d+(?:\.\d+)?)\s*万/);
  if (budgetMatch) {
    addSuggestion('budget', '预算', `每年 ${budgetMatch[1]} 万元（客户自述）`, `客户原话提到“${budgetMatch[0].trim()}”`);
    addSuggestion('premium', '年交保费', String(Math.round(Number(budgetMatch[1]) * 10000)), `客户原话提到“${budgetMatch[0].trim()}”，仍需以计划书核对`);
  }
  if (/给.{0,8}孩子|孩子的|为.{0,8}孩子/.test(message)) addSuggestion('purpose', '给谁／用途', '为孩子做长期安排', '客户原话明确提到孩子');
  else if (/养老|退休/.test(message)) addSuggestion('purpose', '给谁／用途', '本人养老', '客户原话明确提到养老或退休');
  if (/中途.*用钱|临时.*用钱|流动性|灵活取|能不能取/.test(message)) addSuggestion('concern', '主要顾虑', '担心中途需要用钱', '客户原话出现资金使用或流动性顾虑');
  if (/(?:被保险人|孩子|本人).{0,4}(?:是|为)?\s*(男|男性)/.test(message)) addSuggestion('gender', '性别', '男', '客户原话明确提到被保险人为男性');
  if (/(?:被保险人|孩子|本人).{0,4}(?:是|为)?\s*(女|女性)/.test(message)) addSuggestion('gender', '性别', '女', '客户原话明确提到被保险人为女性');
  const planMatch = message.match(/计划\s*([一二12])/);
  if (planMatch) addSuggestion('plan', '保障计划', /[一1]/.test(planMatch[1]) ? '计划一' : '计划二', `客户原话提到“${planMatch[0]}”`);
  const paymentMatch = message.match(/(?:趸交|[35]\s*年(?:交|缴))/);
  if (paymentMatch) {
    const paymentTerm = /趸/.test(paymentMatch[0]) ? '趸交' : `${paymentMatch[0].match(/[35]/)[0]} 年交`;
    addSuggestion('paymentTerm', '交费期间', paymentTerm, `客户原话提到“${paymentMatch[0]}”`);
  }
  if (/年领/.test(message)) addSuggestion('receiveMode', '领取方式', '年领', '客户原话明确提到年领');
  else if (/月领/.test(message)) addSuggestion('receiveMode', '领取方式', '月领', '客户原话明确提到月领');

  const effective = { ...profile };
  for (const item of suggestions) if (unknown(effective[item.field])) effective[item.field] = item.value;
  const coreMissing = ['purpose', 'age', 'budget', 'concern'].filter(field => unknown(effective[field]));
  const planMissing = ['gender', 'plan', 'paymentTerm', 'premium', 'receiveMode', 'pensionAccount'].filter(field => unknown(effective[field]));
  const calculationIntent = /计划书|方案测算|测算|收益|回本|irr|现金价值|每年.*(?:领|拿)|能领多少/i.test(message);
  const missing = [...coreMissing, ...(calculationIntent ? planMissing : [])];
  const questions = {
    purpose: '这笔安排主要想给谁准备、解决什么问题？',
    age: /孩子/.test(`${message}${effective.purpose || ''}`) ? '方便先确认一下孩子现在多大吗？' : '方便先确认一下被保险人的年龄吗？',
    budget: '您大概计划每年投入多少预算？',
    concern: '在缴费、领取安排和中途使用资金之间，您最担心哪一点？',
    gender: '计划书还需要确认被保险人的性别，是男性还是女性？',
    plan: '您想先看计划一还是计划二？我会把差别一起标出来。',
    paymentTerm: '您想先按趸交、3 年交还是 5 年交测算？',
    premium: '这次计划书准备按多少年交保费测算？',
    receiveMode: '领取方式想先按年领还是月领看？',
    pensionAccount: '这次是否使用个人养老金资金账户交费？'
  };

  const signals = [];
  let score = 10;
  const addSignal = (label, points) => { signals.push({ label, points }); score += points; };
  if (/缴费|领取|条款|现金价值|适合|怎么买|怎么交/.test(message)) addSignal('提出具体产品问题', 15);
  if (!unknown(effective.purpose)) addSignal('用途较明确', 15);
  if (!unknown(effective.age)) addSignal('年龄信息已获得', 10);
  if (!unknown(effective.budget)) addSignal('预算信息已获得', 15);
  if (!unknown(effective.concern)) addSignal('主要顾虑已出现', 10);
  if (/打电话|回电|电话聊|给我打电话/.test(message)) addSignal('主动要求电话沟通', 25);
  if (/上次|之前聊过|再了解/.test(message)) addSignal('再次主动咨询', 15);
  if (/最近|尽快|这周|今天|马上/.test(message)) addSignal('出现明确时间信号', 10);

  const stop = status === '拒绝营销' || /不要再联系|不要再推荐|停止营销|别再推销/.test(message);
  const serviceRisk = /投诉|退款|退保|理赔纠纷|监管举报/.test(message);
  const purchased = status.startsWith('已购');
  const directFactQuestion = /(?:几年|多少年|10\s*年|20\s*年).{0,4}(?:交|缴)|怎么(?:交|缴费)|交费方式|缴费方式|祝贺金|祝福金|犹豫期|宽限期|保单贷款|现金价值|退保/.test(message) && !/适不适合|是否适合|推荐|怎么买/.test(message);
  if (stop || serviceRisk) score = 0;
  if (purchased) score = Math.min(score, 25);
  score = Math.max(0, Math.min(100, score));
  const level = score >= 70 ? '高优先跟进' : score >= 45 ? '继续了解' : '信息不足';

  let productStatus = 'information_required';
  let productConclusion = '信息不足，先补充必要信息，再决定是否进入方案说明。';
  if (stop || serviceRisk) {
    productStatus = 'no_recommendation';
    productConclusion = '停止产品推荐，交由人工处理当前诉求。';
  } else if (purchased) {
    productStatus = 'service_only';
    productConclusion = '已购客户进入保单服务，不重复推荐当前产品。';
  } else if (!coreMissing.includes('purpose') && !coreMissing.includes('age') && !coreMissing.includes('budget') && (!calculationIntent || planMissing.length === 0)) {
    productStatus = 'discussion_candidate';
    productConclusion = '可以进入单产品方案说明，但这不是适合度结论或购买建议。';
  }

  return {
    next_question: stop || serviceRisk || purchased || directFactQuestion ? '' : questions[missing[0]] || '',
    missing_fields: missing,
    profile_suggestions: suggestions,
    intent: {
      score,
      level,
      signals,
      explanation: '分数只表示销售跟进优先级，由显式对话信号计算，不代表客户购买资格、适当性或成交概率。'
    },
    product_assist: {
      status: productStatus,
      conclusion: productConclusion,
      product_name: text(input.product_name, 120),
      known_matches: [effective.purpose, effective.age, effective.gender, effective.budget, effective.plan, effective.paymentTerm, effective.premium, effective.receiveMode, effective.pensionAccount].filter(value => !unknown(value)),
      unresolved: [...new Set([...coreMissing, ...planMissing])].map(field => ({ purpose: '用途', age: '年龄', gender: '性别', budget: '预算', concern: '主要顾虑', plan: '保障计划', paymentTerm: '交费期间', premium: '年交／趸交保费', receiveMode: '领取方式', pensionAccount: '是否使用个人养老金资金账户' })[field]),
      guardrail: '仅依据当前有效且已核验的资料；不判断适合购买，不承诺收益、承保或理赔。'
    }
  };
}

async function runDify(req, res) {
  const requestId = `req_${randomUUID()}`;
  if (!DIFY_KEY) {
    return json(res, 503, { request_id: requestId, status: 'error', reason: '本地后端尚未配置 Dify 应用密钥。' });
  }

  let input;
  try {
    input = await readJson(req);
  } catch (error) {
    return json(res, error.message === 'REQUEST_TOO_LARGE' ? 413 : 400, { request_id: requestId, status: 'error', reason: '请求格式无效。' });
  }

  const inputs = {
    customer_message: text(input.customer_message, 3000),
    customer_status: text(input.customer_status, 40) || '未购',
    known_context: text(input.known_context, 2000),
    product_name: text(input.product_name, 120) || '太保蛮好的人生年金保险（互联网）',
    product_version: text(input.product_version, 120),
    draft_product_version: text(input.draft_product_version, 120),
    product_rule: text(input.product_rule, 6000),
    source_verified: text(input.source_verified, 40),
    product_source: text(input.product_source, 500)
  };
  const analysis = analyzeCustomer(input);
  inputs.known_context = text(`${inputs.known_context}\n${WECHAT_REPLY_STYLE}${analysis.next_question ? `\n本轮确有一个必要缺项，可在回答后自然问一句：“${analysis.next_question}”` : '\n本轮没有影响当前回答的必要缺项，不要为了流程强行追问。'}`, 4000);

  if (!inputs.customer_message) {
    return json(res, 400, { request_id: requestId, status: 'error', reason: '客户消息不能为空。' });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(`${DIFY_BASE}/workflows/run`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${DIFY_KEY}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ inputs, response_mode: 'blocking', user: `tongpin-demo-${text(input.customer_id, 80) || 'visitor'}` }),
      signal: controller.signal
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.data?.status === 'failed') {
      const reason = payload?.message || payload?.data?.error || `Dify 返回 ${response.status}`;
      return json(res, 502, { request_id: requestId, status: 'error', reason: text(reason, 800) });
    }
    const result = normalizeOutputs(payload?.data?.outputs || {});
    if (result.handoff_required) analysis.next_question = '';
    return json(res, 200, {
      request_id: requestId,
      ...result,
      product: { name: inputs.product_name, ...result.product },
      trace: {
        provider: 'dify-local',
        workflow_run_id: text(payload?.workflow_run_id || payload?.data?.id, 160),
        created_at: new Date().toISOString()
      },
      analysis
    });
  } catch (error) {
    const reason = error.name === 'AbortError' ? 'Dify 响应超时，请稍后重试或转人工。' : '无法连接本地 Dify，请确认 Dify 正在运行。';
    return json(res, 502, { request_id: requestId, status: 'error', reason });
  } finally {
    clearTimeout(timer);
  }
}

async function serveStatic(req, res) {
  const requested = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);
  const relative = requested === '/' ? 'index.html' : requested.replace(/^\/+/, '');
  const safe = normalize(relative).replace(/^(\.\.(\/|\\|$))+/, '');
  const file = join(PUBLIC_DIR, safe);
  if (!file.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'forbidden' });
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'self'; media-src 'self' blob:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'"
    });
    res.end(data);
  } catch (error) {
    if (error.code === 'ENOENT') return json(res, 404, { error: 'not_found' });
    return json(res, 500, { error: 'server_error' });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  if (backendB2 && await backendB2.route(req, res, url)) return;
  if (backendB1 && await backendB1.route(req, res, url)) return;
  if (await routeCopilot(req, res, url)) return;
  if (url.pathname.startsWith('/api/v2/')) return routeV2(req, res, url);
  if (req.method === 'GET' && req.url === '/api/health') {
    return json(res, 200, {
      ok: true,
      mode: 'local',
      dify_configured: Boolean(DIFY_KEY),
      deepseek_configured: Boolean(DEEPSEEK_KEY),
      text_ai_provider: DEEPSEEK_KEY ? 'deepseek' : DIFY_KEY ? 'dify' : 'unconfigured',
      dify_endpoint: DIFY_BASE,
      backend_b1_enabled: BACKEND_B1_ENABLED,
      backend_b2_enabled: BACKEND_B2_ENABLED,
      backend_only: BACKEND_ONLY,
      memory_workflow_configured: BACKEND_B1_ENABLED && Boolean(DEEPSEEK_KEY || DIFY_MEMORY_KEY),
      product_match_workflow_configured: BACKEND_B2_ENABLED && Boolean(DEEPSEEK_KEY || DIFY_MATCH_KEY),
      asr_configured: Boolean(transcribeMedia),
      asr_model: transcribeMedia ? DASHSCOPE_ASR_MODEL : null,
      observability_configured: true,
      langfuse_configured: Boolean(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY),
      v2_database: 'ready'
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/evaluation/cases') return readEvaluationCases(res);
  if (req.method === 'GET' && url.pathname === '/api/evaluation/results') return readEvaluationResults(res);
  if (req.method === 'POST' && url.pathname === '/api/evaluation/results') return writeEvaluationResult(req, res);
  if (req.method === 'POST' && url.pathname === '/api/evaluation/run-case') {
    try {
      return json(res, 200, await runEvaluationCase(await readJson(req)));
    } catch (error) {
      return json(res, error?.status || 500, {
        error: error?.code || 'EVALUATION_GATEWAY_ERROR',
        message: error?.message || '评测适配器执行失败。'
      });
    }
  }
  if (BACKEND_ONLY) return json(res, 404, { error: 'backend_only', message: '此端口仅提供后端接口；原工作台页面未修改。' });
  if (req.method === 'GET' && req.url === '/api/state') return readWorkbenchState(res);
  if (req.method === 'PUT' && req.url === '/api/state') return writeWorkbenchState(req, res);
  if (req.method === 'POST' && req.url === '/api/ai-draft') return runDify(req, res);
  if (req.method === 'POST' && req.url === '/api/plan-extract') return extractPlanDocument(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method_not_allowed' });
  return serveStatic(req, res);
});

server.once('close', () => backendB1?.close());

server.listen(PORT, '127.0.0.1', () => {
  console.log(`同频本地${BACKEND_ONLY ? '后端' : '工作台'}已启动：http://127.0.0.1:${server.address().port}`);
  console.log(DIFY_KEY ? 'Dify 应用密钥：已配置' : 'Dify 应用密钥：未配置，请创建 .env.local');
});
