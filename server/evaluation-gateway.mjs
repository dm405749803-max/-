import { randomUUID } from 'node:crypto';
import { createEvaluationFixtureOrchestrator } from './evaluation-fixtures.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function parseTurns(value) {
  const text = String(value || '').trim();
  if (!text) return [];
  const lines = text.split(/\n+/).map(line => line.trim()).filter(Boolean);
  const hasRoles = lines.some(line => /^(?:客户|销售)[：:]/.test(line));
  if (!hasRoles) return [{ role: 'customer', text }];
  return lines.map(line => {
    const sales = /^销售[：:]/.test(line);
    return {
      role: sales ? 'sales' : 'customer',
      text: line.replace(/^(?:客户|销售)[：:]\s*/, '')
    };
  }).filter(turn => turn.text);
}

function safePart(value, fallback) {
  const cleaned = String(value || '').replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 32);
  return cleaned || fallback;
}

function countQuestions(text) {
  return (String(text || '').match(/[？?]/g) || []).length;
}

function evaluationMemoryDetails(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 5).map(item => ({
    status: item?.status || null,
    review_mode: item?.review_mode || null,
    facts: (Array.isArray(item?.facts) ? item.facts : []).slice(0, 20).map(fact => ({
      field: fact?.field || null,
      value: fact?.value ?? null,
      person_id: fact?.person_id || null,
      evidence_message_ids: Array.isArray(fact?.evidence_message_ids) ? fact.evidence_message_ids.slice(0, 10) : [],
      review_tier: fact?.review_tier || null
    })),
    summary: item?.summary && typeof item.summary === 'object' ? {
      text: item.summary.text || '',
      evidence_message_ids: Array.isArray(item.summary.evidence_message_ids) ? item.summary.evidence_message_ids.slice(0, 10) : [],
      through_message_id: item.summary.through_message_id || null
    } : null,
    intent: item?.intent && typeof item.intent === 'object' ? {
      level: item.intent.level || 'unknown',
      score: Number.isFinite(Number(item.intent.score)) ? Number(item.intent.score) : 0,
      reason: item.intent.reason || '',
      recommended_action: item.intent.recommended_action || null,
      signals: Array.isArray(item.intent.signals) ? item.intent.signals.slice(0, 10) : []
    } : null
  }));
}

function currentMemoryProposals(items) {
  return (Array.isArray(items) ? items : []).filter(item => !['expired', 'rejected'].includes(item?.status));
}

function evaluationRecommendationDetails(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 5).map(item => {
    const result = item?.result && typeof item.result === 'object' ? item.result : {};
    return {
      recommendation_id: item?.recommendation_id || null,
      status: result.status || item?.status || null,
      blocking_gate: result.blocking_gate || null,
      reason: result.reason || null,
      missing_fields: Array.isArray(result.missing_fields) ? result.missing_fields.slice(0, 20) : [],
      candidates: (Array.isArray(result.candidates) ? result.candidates : []).slice(0, 10).map(candidate => ({
        product_id: candidate?.product_id || null,
        product_version: candidate?.product_version || null,
        eligibility: candidate?.eligibility || candidate?.status || null,
        reasons: Array.isArray(candidate?.reasons) ? candidate.reasons.slice(0, 10) : []
      }))
    };
  });
}

export function createEvaluationGateway({
  baseUrl,
  fetchImpl = fetch,
  sleep = wait,
  workspaceId = 'eval_any_agent',
  b1WaitMs = 30_000,
  b1PollMs = 500
} = {}) {
  const root = String(baseUrl || '').replace(/\/$/, '');
  if (!root) throw new TypeError('evaluation gateway requires baseUrl');

  async function request(path, { method = 'GET', body, headers = {} } = {}) {
    const response = await fetchImpl(`${root}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        'x-workspace-id': workspaceId,
        ...headers,
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(payload?.error?.message || payload?.message || `HTTP ${response.status}`);
      error.code = payload?.error?.code || `HTTP_${response.status}`;
      error.status = response.status;
      error.traceId = payload?.trace_id || null;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  async function waitForB1(traceId, headers) {
    if (!traceId) return { data: null };
    const attempts = Math.max(1, Math.ceil(Math.max(0, Number(b1WaitMs) || 0) / Math.max(100, Number(b1PollMs) || 500)));
    let payload = { data: null };
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      payload = await request(`/api/v2/observability/traces/${traceId}`, { headers }).catch(() => ({ data: null }));
      const observation = payload.data?.observations?.find(item => item.name === 'dify.B1_memory');
      if (observation && observation.status !== 'running') return payload;
      if (attempt < attempts - 1) await sleep(Math.max(100, Number(b1PollMs) || 500));
    }
    return payload;
  }

  const createFixtureRun = createEvaluationFixtureOrchestrator({ request });

  return async function runCase(input = {}) {
    const caseId = String(input.case_id || '').trim().slice(0, 80);
    const customerInput = String(input.customer_input || input.question || '').trim();
    if (!caseId) throw Object.assign(new Error('case_id不能为空。'), { code: 'CASE_ID_REQUIRED', status: 400 });
    if (!customerInput) throw Object.assign(new Error('customer_input不能为空。'), { code: 'CUSTOMER_INPUT_REQUIRED', status: 400 });

    const runId = String(input.eval_run_id || `baseline-${new Date().toISOString().slice(0, 10)}`).slice(0, 160);
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const casePart = safePart(caseId.toLowerCase(), 'case');
    const customerId = `eval-${casePart}-${suffix}`;
    const opportunityId = `eval-opp-${casePart}-${suffix}`;
    const evaluationHeaders = { 'x-eval-case-id': caseId, 'x-eval-run-id': runId };
    const today = new Date().toISOString().slice(0, 10);

    await request('/api/v2/customers', {
      method: 'POST', headers: evaluationHeaders,
      body: {
        customer_id: customerId,
        name: `Eval ${caseId}`,
        wechat_joined_on: today,
        wechat_joined_source: 'manual',
        wechat_joined_actor: 'Eval-Any-Agent'
      }
    });
    const fixtureRun = createFixtureRun(input, {
      headers: evaluationHeaders, customerId, opportunityId, runId, suffix
    });
    await fixtureRun.afterCustomerCreated({ customerId, opportunityId, runId, suffix });
    await request(`/api/v2/customers/${encodeURIComponent(customerId)}/opportunities`, {
      method: 'POST', headers: evaluationHeaders,
      body: {
        opportunity_id: opportunityId,
        purpose: input.purpose || fixtureRun.plan.opportunity_defaults.purpose || null,
        stage: 'evaluation',
        status: 'open',
        environment: 'simulation',
        product_id: input.product_id && input.product_id !== 'null' ? input.product_id : null,
        product_version: input.product_version && input.product_version !== 'null' ? input.product_version : null
      }
    });

    const turns = parseTurns(customerInput);
    let latestCustomerMessage = null;
    let traceId = null;
    let sessionId = null;
    for (let index = 0; index < turns.length; index += 1) {
      const turn = turns[index];
      const saved = await request(`/api/v2/opportunities/${encodeURIComponent(opportunityId)}/messages`, {
        method: 'POST', headers: evaluationHeaders,
        body: {
          idempotency_key: `${runId}:${caseId}:${suffix}:message:${index}`,
          role: turn.role,
          text: turn.text,
          status: turn.role === 'customer' ? 'received' : 'manually_confirmed_sent',
          source: 'simulation',
          environment: 'simulation'
        }
      });
      if (turn.role === 'customer') {
        latestCustomerMessage = saved.data;
        traceId = saved.trace_id || traceId;
        sessionId = saved.data?.session_id || sessionId;
        // Let B1 persist intent and workflow state before a later turn or the
        // main reply reads context. This is part of the real conversation
        // contract, not an artificial delay for the evaluator.
        await waitForB1(traceId, evaluationHeaders);
      }
    }
    if (!latestCustomerMessage) {
      throw Object.assign(new Error('案例至少需要一条客户消息。'), { code: 'CUSTOMER_MESSAGE_REQUIRED', status: 400 });
    }

    const context = await request(`/api/v2/opportunities/${encodeURIComponent(opportunityId)}/context`, { headers: evaluationHeaders });
    let draft = null;
    let businessError = null;
    try {
      const generated = await request(`/api/v2/opportunities/${encodeURIComponent(opportunityId)}/drafts`, {
        method: 'POST', headers: { ...evaluationHeaders, ...(traceId ? { 'x-trace-id': traceId } : {}) },
        body: {
          latest_message_id: context.data.latest_message_id,
          expected_revision: context.data.context_versions.opportunity_revision
        }
      });
      draft = generated.data;
      traceId = generated.trace_id || traceId;
    } catch (error) {
      businessError = { code: error.code || 'ERROR', message: error.message, status: error.status || 500 };
      traceId = error.traceId || traceId;
    }

    // B1 is asynchronous. Poll its trace to a terminal state instead of sampling too early
    // and incorrectly reporting a slow successful run as "running".
    const tracePayload = await waitForB1(traceId, evaluationHeaders);
    let memoryPayload = await request(`/api/v2/memory-review/proposals?opportunity_id=${encodeURIComponent(opportunityId)}`, { headers: evaluationHeaders }).catch(() => ({ data: [] }));
    memoryPayload = await fixtureRun.afterMemory({ memoryPayload, runId, suffix });
    const fixtureReport = fixtureRun.report();
    const evaluationHumanActions = fixtureReport.events
      .filter(event => event.type === 'profile_change_approval' && event.proposal_id)
      .map(event => ({ action: 'approve_insured_person_switch', ...event }));
    const [recommendationPayload, customerPayload, taskPayload] = await Promise.all([
      request(`/api/v2/product-match/opportunities/${encodeURIComponent(opportunityId)}/recommendations`, { headers: evaluationHeaders }).catch(() => ({ data: [] })),
      request(`/api/v2/customers/${encodeURIComponent(customerId)}`, { headers: evaluationHeaders }).catch(() => ({ data: null })),
      request('/api/v2/tasks?status=open', { headers: evaluationHeaders }).catch(() => ({ data: [] }))
    ]);

    const observations = Array.isArray(tracePayload.data?.observations) ? tracePayload.data.observations : [];
    // Keep expired/rejected proposals in the backend audit history, but do not
    // feed obsolete values to the evaluator as if they were current memory.
    const memory = currentMemoryProposals(memoryPayload.data);
    const recommendations = Array.isArray(recommendationPayload.data) ? recommendationPayload.data : [];
    const customer = customerPayload.data && typeof customerPayload.data === 'object' ? customerPayload.data : null;
    const evaluatedOpportunity = customer?.opportunities?.find(item => item.opportunity_id === opportunityId) || null;
    const tasks = (Array.isArray(taskPayload.data) ? taskPayload.data : []).filter(item => item.opportunity_id === opportunityId);
    const silentGate = ['HUMAN_HANDOFF_ACTIVE', 'MARKETING_OPT_OUT'].includes(businessError?.code);
    const actualResponse = draft?.draft || (silentGate ? '' : businessError?.message) || draft?.reason || draft?.next_question || '';
    const riskyPattern = /保证收益|稳赚|一定能赔|肯定通过核保|随时取都不会亏/;

    return {
      schema_version: 'sales-evaluation-run.v1',
      case_id: caseId,
      eval_run_id: runId,
      customer_input: customerInput,
      latest_customer_message: latestCustomerMessage?.text || turns.filter(turn => turn.role === 'customer').at(-1)?.text || '',
      actual_response: actualResponse,
      draft_status: draft?.status || businessError?.code || 'unknown',
      route: tracePayload.data?.metadata?.route || draft?.orchestration?.route || null,
      review_required: draft?.review_required ?? null,
      blocking_gate: draft?.orchestration?.blocking_gate || null,
      citations: draft?.citations || [],
      risk_flags: draft?.risk_flags || [],
      business_error: businessError,
      customer_state: evaluatedOpportunity ? {
        person_ids: evaluatedOpportunity.person_ids || [],
        purpose: evaluatedOpportunity.purpose || null,
        sales_stage: evaluatedOpportunity.sales_stage,
        intent_level: evaluatedOpportunity.intent_level,
        intent_score: evaluatedOpportunity.intent_score,
        intent_reason: evaluatedOpportunity.intent_reason,
        processing_status: evaluatedOpportunity.processing_status,
        purchased: evaluatedOpportunity.purchased,
        contact_state: evaluatedOpportunity.contact_state
      } : null,
      business_events: (customer?.business_events || [])
        .filter(item => item.opportunity_id === opportunityId)
        .map(({ event_id, event_type, payload, evidence_message_ids, occurred_at }) => ({
          event_id, event_type, payload, evidence_message_ids, occurred_at
        })),
      current_people: (customer?.persons || [])
        .filter(item => (evaluatedOpportunity?.person_ids || []).includes(item.person_id))
        .map(item => ({
          person_id: item.person_id,
          relationship: item.relationship,
          age: item.age ?? (customer?.facts || []).find(fact => fact.field === 'age'
            && fact.person_id === item.person_id && fact.status === 'confirmed')?.value ?? null
        })),
      evaluation_human_actions: evaluationHumanActions,
      evaluation_fixture: fixtureReport,
      related_opportunities: (customer?.opportunities || []).map(item => ({
        opportunity_id: item.opportunity_id,
        purpose: item.purpose,
        sales_stage: item.sales_stage,
        processing_status: item.processing_status,
        purchased: item.purchased
      })),
      tasks: tasks.slice(0, 10).map(item => ({
        task_id: item.task_id,
        title: item.title,
        reason: item.reason,
        owner: item.owner,
        due_at: item.due_at,
        status: item.status
      })),
      checks: {
        question_count: countQuestions(actualResponse),
        risky_promise_detected: riskyPattern.test(actualResponse),
        has_product_citation: Boolean(draft?.citations?.length),
        backend_returned_status: Boolean(draft?.status || businessError?.code)
      },
      modules: {
        b1: {
          proposals: memory.length,
          status: observations.find(item => item.name === 'dify.B1_memory')?.status || (memory.length ? 'completed' : 'not_observed'),
          proposal_details: evaluationMemoryDetails(memory)
        },
        b2: {
          recommendations: recommendations.length,
          status: observations.find(item => item.name === 'dify.B2_product_match')?.status || (recommendations.length ? 'completed' : 'not_observed'),
          recommendation_details: evaluationRecommendationDetails(recommendations)
        },
        rag: { status: observations.find(item => item.name === 'rag.retrieve')?.status || 'not_observed' },
        a: { status: observations.find(item => item.name === 'dify.A_sales_draft')?.status || draft?.status || 'not_observed' }
      },
      trace_id: traceId,
      session_id: sessionId || tracePayload.data?.session_id || null,
      customer_id: customerId,
      opportunity_id: opportunityId
    };
  };
}

export const __test = { parseTurns, safePart, countQuestions, evaluationMemoryDetails, currentMemoryProposals, evaluationRecommendationDetails };
