import { ApiError, assertApi } from './errors.mjs';
import { buildContext } from './context.mjs';
import { classifyConversationTurn, isExplicitMarketingOptOut } from '../ai/conversation-routing.mjs';
import { isDirectHumanRequest, isReturnGuaranteeRequest } from '../ai/customer-signals.mjs';
import { createTraceId } from './observability.mjs';

const WORKSPACE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export function createV2Api({ store, salesAssist = null, conversationOrchestrator = null, readJson, sendJson, aiDependencies = {}, aiConfigured = Boolean(salesAssist), aiBudget = null, knowledgeSafety = null, observability = null, onOpportunityPurchased = null, onCustomerMessage = null, prepareSalesContext = null, validateSalesContext = null, validateDraft = null, transcribeMedia = null, mediaTranscriptionConfigured = Boolean(transcribeMedia) }) {
  const ok = (res, data, traceId, status = 200) => sendJson(res, status, { data, trace_id: traceId });
  const personDto = person => {
    const attributes = person.attributes || {};
    return {
      age: attributes.age ?? null, gender: attributes.gender ?? null,
      person_id: person.person_id, customer_id: person.customer_id, name: person.name, relationship: person.relationship,
      attributes, revision: person.revision
    };
  };
  const opportunityDto = (opportunity, customer) => ({
    opportunity_id: opportunity.opportunity_id, customer_id: opportunity.customer_id,
    person_id: opportunity.person_ids?.[0] || null, person_ids: opportunity.person_ids || [],
    purpose: opportunity.purpose, budget: opportunity.budget_amount, budget_amount: opportunity.budget_amount,
    budget_currency: opportunity.budget_currency, stage: opportunity.stage, status: opportunity.status,
    sales_stage: opportunity.sales_stage || 'new_contact', intent_level: opportunity.intent_level || 'unknown',
    intent_score: Number(opportunity.intent_score) || 0, intent_reason: opportunity.intent_reason || null,
    processing_status: opportunity.processing_status || 'normal', intent_updated_at: opportunity.intent_updated_at || null,
    purchased: Boolean(opportunity.purchased), product_id: opportunity.product_id, product_version: opportunity.product_version,
    policy_contract_version: opportunity.policy_contract_version, environment: opportunity.environment,
    revision: opportunity.revision, profile_version: customer?.profile_version ?? null,
    contact_state: {
      marketing_opt_out: Boolean(customer?.marketing_opt_out),
      human_handoff: Boolean(customer?.human_handoff || opportunity.human_handoff),
      purchased_for_opportunity: Boolean(opportunity.purchased)
    },
    handoff_owner: opportunity.handoff_owner || customer?.handoff_owner || null,
    updated_at: opportunity.updated_at
  });
  const customerSummaryDto = customer => ({
    customer_id: customer.customer_id, name: customer.name, revision: customer.revision,
    profile_version: customer.profile_version,
    contact_preferences: { ...(customer.contact_preferences || {}), marketing_opt_out: Boolean(customer.marketing_opt_out) },
    marketing_opt_out: Boolean(customer.marketing_opt_out), human_handoff: Boolean(customer.human_handoff),
    handoff_owner: customer.handoff_owner, updated_at: customer.updated_at,
    wechat_joined_on: customer.wechat_joined_on ?? null,
    wechat_joined_source: customer.wechat_joined_source ?? 'unknown',
    wechat_joined_label: customer.wechat_joined_label ?? null
  });
  const customerDetailDto = customer => ({
    ...customerSummaryDto(customer),
    persons: (customer.persons || []).map(personDto),
    opportunities: (customer.opportunities || []).map(opportunity => opportunityDto(opportunity, customer)),
    facts: customer.facts || [],
    business_events: customer.business_events || []
  });
  const messageDto = message => ({
    message_id: message.message_id, opportunity_id: message.opportunity_id, role: message.role, text: message.text,
    status: message.status, source: message.source, environment: message.environment, occurred_at: message.occurred_at,
    created_at: message.created_at, trace_id: message.trace_id || null, session_id: message.session_id || null
  });
  const taskDto = task => ({
    task_id: task.task_id, customer_id: task.customer_id, opportunity_id: task.opportunity_id,
    title: task.title || task.reason, reason: task.reason, owner: task.owner, due_at: task.due_at,
    status: task.status, result: task.result, revision: task.revision, overdue: Boolean(task.overdue),
    created_at: task.created_at, updated_at: task.updated_at
  });
  const draftDto = row => {
    const ai = row.ai_result || {};
    return {
      draft_id: row.draft_id, opportunity_id: row.opportunity_id, revision: row.revision,
      draft: row.content, status: row.status, context_versions: { ...(row.context_versions || {}), ...(ai.context_versions || {}) },
      citations: ai.citations || [], proposed_fact_changes: ai.proposed_fact_changes || [],
      experience_suggestions: Array.isArray(ai.experience_suggestions) ? ai.experience_suggestions : [],
      reason: ai.reason ?? null,
      next_question: ai.next_question ?? null, next_action: ai.next_action ?? null,
      risk_flags: ai.risk_flags || [], missing_evidence: ai.missing_evidence || [],
      review_required: ai.review_required !== false, trace: ai.trace || { provider: '', workflow_run_id: null },
      orchestration: ai.orchestration || null,
      stale: Boolean(row.stale), stale_reason: row.stale_reason || null,
      final_text: row.final_text || null, delivery_mode: row.delivery_mode || null,
      created_at: row.created_at, updated_at: row.updated_at
    };
  };
  const workspace = req => {
    const value = String(req.headers['x-workspace-id'] || 'demo');
    assertApi(WORKSPACE_RE.test(value), 400, 'INVALID_WORKSPACE_ID', 'workspace_id 格式无效。');
    return value;
  };
  const body = async (req, maxBytes = 1_000_000) => {
    try { return await readJson(req, maxBytes); }
    catch (error) { throw new ApiError(error.message === 'REQUEST_TOO_LARGE' ? 413 : 400, 'INVALID_JSON', '请求 JSON 无效或过大。'); }
  };
  const emit = (workspaceId, eventName, input = {}) => observability?.recordEvent?.(workspaceId, {
    event_name: eventName,
    ...input
  });

  return async function routeV2(req, res, url = new URL(req.url, 'http://127.0.0.1')) {
    if (!url.pathname.startsWith('/api/v2/')) return false;
    let traceId = createTraceId(req.headers['x-trace-id']);
    const caseId = String(req.headers['x-eval-case-id'] || '').trim().slice(0, 80) || null;
    const evalRunId = String(req.headers['x-eval-run-id'] || '').trim().slice(0, 160) || null;
    try {
      const ws = workspace(req);
      let match;
      if (url.pathname === '/api/v2/observability/events' && req.method === 'GET') {
        assertApi(observability?.listEvents, 503, 'OBSERVABILITY_NOT_CONFIGURED', '链路观测尚未配置。');
        return ok(res, observability.listEvents(ws, Object.fromEntries(url.searchParams)), traceId), true;
      }
      if (url.pathname === '/api/v2/observability/events' && req.method === 'POST') {
        assertApi(observability?.recordEvent, 503, 'OBSERVABILITY_NOT_CONFIGURED', '链路观测尚未配置。');
        return ok(res, observability.recordEvent(ws, await body(req)), traceId, 201), true;
      }
      if (url.pathname === '/api/v2/observability/metrics' && req.method === 'GET') {
        assertApi(observability?.dashboard, 503, 'OBSERVABILITY_NOT_CONFIGURED', '指标看板尚未配置。');
        return ok(res, observability.dashboard(ws, Object.fromEntries(url.searchParams)), traceId), true;
      }
      if (url.pathname === '/api/v2/observability/evaluations' && req.method === 'POST') {
        assertApi(observability?.upsertBadcase, 503, 'OBSERVABILITY_NOT_CONFIGURED', '评测闭环尚未配置。');
        const input = await body(req);
        assertApi(input.case_id && input.eval_run_id, 400, 'EVALUATION_ID_REQUIRED', '评测结果缺少 case_id 或 eval_run_id。');
        const failed = input.passed !== true || input.hard_failure === true || input.required_outcomes_met === false;
        const needsReview = !failed && input.human_review_required === true;
        emit(ws,'evaluation_judged',{
          category:'quality',trace_id:input.trace_id,actor:input.evaluator || 'evaluation',numeric_value:input.score,
          idempotency_key:`evaluation:${input.eval_run_id}:${input.case_id}`,
          payload:{ case_id:input.case_id,eval_run_id:input.eval_run_id,score:input.score,passed:!failed,hard_failure:Boolean(input.hard_failure),high_risk:Boolean(input.high_risk),high_risk_miss:Boolean(input.high_risk_miss),failed_dimensions:input.failed_dimensions||[] }
        });
        const value = observability.upsertBadcase(ws,{
          case_id:input.case_id,eval_run_id:input.eval_run_id,trace_id:input.trace_id||null,
          status:failed?'open':needsReview?'needs_review':'closed',severity:input.severity||'P1',
          failed_dimensions:input.failed_dimensions||[],actual:input.actual||{ score:input.score,evaluation:input },
          expected:input.expected||null,root_cause_layer:failed?(input.root_cause_layer||'ai_judgment'):needsReview?'human_judgment_pending':'passed',
          root_cause_note:input.reason||null,regression_status:failed?'failed_ai_judgment':needsReview?'ai_passed_human_pending':'passed'
        });
        return ok(res,value,traceId,201), true;
      }
      if (url.pathname === '/api/v2/observability/traces' && req.method === 'GET') {
        assertApi(observability, 503, 'OBSERVABILITY_NOT_CONFIGURED', '链路观测尚未配置。');
        return ok(res, observability.listTraces(ws, Object.fromEntries(url.searchParams)), traceId), true;
      }
      if (url.pathname === '/api/v2/observability/badcases' && req.method === 'GET') {
        assertApi(observability, 503, 'OBSERVABILITY_NOT_CONFIGURED', '链路观测尚未配置。');
        return ok(res, observability.listBadcases(ws, Object.fromEntries(url.searchParams)), traceId), true;
      }
      if (url.pathname === '/api/v2/observability/badcases' && req.method === 'POST') {
        assertApi(observability, 503, 'OBSERVABILITY_NOT_CONFIGURED', '链路观测尚未配置。');
        return ok(res, observability.upsertBadcase(ws, await body(req)), traceId, 201), true;
      }
      if ((match = url.pathname.match(/^\/api\/v2\/observability\/badcases\/([^/]+)\/review$/)) && req.method === 'POST') {
        assertApi(observability, 503, 'OBSERVABILITY_NOT_CONFIGURED', '链路观测尚未配置。');
        const value = observability.reviewBadcase(ws, decodeURIComponent(match[1]), await body(req));
        assertApi(value, 404, 'BADCASE_NOT_FOUND', '评测案例不存在。');
        return ok(res, value, traceId), true;
      }
      if ((match = url.pathname.match(/^\/api\/v2\/observability\/traces\/([0-9a-f]{32})$/)) && req.method === 'GET') {
        assertApi(observability, 503, 'OBSERVABILITY_NOT_CONFIGURED', '链路观测尚未配置。');
        const value = observability.getTrace(ws, match[1]);
        assertApi(value, 404, 'TRACE_NOT_FOUND', '运行链路不存在。');
        return ok(res, value, traceId), true;
      }
      if (url.pathname === '/api/v2/customers' && req.method === 'GET') return ok(res, store.listCustomers(ws, Object.fromEntries([...url.searchParams].filter(([key]) => ['joined_on', 'joined_from', 'joined_to'].includes(key)))).map(customerSummaryDto), traceId), true;
      if (url.pathname === '/api/v2/customers' && req.method === 'POST') {
        const created = store.createCustomer(ws, await body(req));
        emit(ws,'customer_created',{
          trace_id:traceId,customer_id:created.customer_id,actor:'sales',environment:'real',
          idempotency_key:`customer:${created.customer_id}:created`,payload:{ source_channel:created.wechat_joined_source||'unknown',wechat_joined_on:created.wechat_joined_on||null }
        });
        return ok(res,customerSummaryDto(created),traceId,201), true;
      }
      if ((match = url.pathname.match(/^\/api\/v2\/customers\/([^/]+)\/join-date-audit$/)) && req.method === 'GET') return ok(res, store.listCustomerDateAudit(ws, decodeURIComponent(match[1])), traceId), true;
      if ((match = url.pathname.match(/^\/api\/v2\/customers\/([^/]+)$/)) && req.method === 'GET') return ok(res, customerDetailDto(store.getCustomer(ws, decodeURIComponent(match[1]))), traceId), true;
      if (match && req.method === 'PATCH') { const input = await body(req); return ok(res, customerDetailDto(store.patchCustomer(ws, decodeURIComponent(match[1]), input.expected_revision, input.changes)), traceId), true; }
      if ((match = url.pathname.match(/^\/api\/v2\/customers\/([^/]+)\/ai-budget$/)) && req.method === 'GET') {
        assertApi(aiBudget, 503, 'AI_BUDGET_NOT_CONFIGURED', 'AI 成本计量尚未配置。');
        return ok(res, aiBudget.status(ws, decodeURIComponent(match[1])), traceId), true;
      }
      if (url.pathname === '/api/v2/knowledge-safety/status' && req.method === 'GET') {
        assertApi(knowledgeSafety, 503, 'KNOWLEDGE_SAFETY_NOT_CONFIGURED', '知识版本安全锁尚未配置。');
        return ok(res, knowledgeSafety.status(ws), traceId), true;
      }
      if (url.pathname === '/api/v2/knowledge-safety/releases' && req.method === 'GET') {
        assertApi(knowledgeSafety, 503, 'KNOWLEDGE_SAFETY_NOT_CONFIGURED', '知识版本安全锁尚未配置。');
        return ok(res, knowledgeSafety.listReleases(ws), traceId), true;
      }
      if (url.pathname === '/api/v2/knowledge-safety/releases' && req.method === 'POST') {
        assertApi(knowledgeSafety, 503, 'KNOWLEDGE_SAFETY_NOT_CONFIGURED', '知识版本安全锁尚未配置。');
        return ok(res, knowledgeSafety.upsertRelease(ws, await body(req)), traceId, 201), true;
      }
      if (url.pathname === '/api/v2/knowledge-safety/lock' && req.method === 'POST') {
        assertApi(knowledgeSafety, 503, 'KNOWLEDGE_SAFETY_NOT_CONFIGURED', '知识版本安全锁尚未配置。');
        return ok(res, knowledgeSafety.setManualLock(ws, await body(req)), traceId), true;
      }
      if ((match = url.pathname.match(/^\/api\/v2\/customers\/([^/]+)\/persons$/)) && req.method === 'POST') return ok(res, personDto(store.addPerson(ws, decodeURIComponent(match[1]), await body(req))), traceId, 201), true;
      if ((match = url.pathname.match(/^\/api\/v2\/customers\/([^/]+)\/opportunities$/)) && req.method === 'POST') {
        const customerId = decodeURIComponent(match[1]);
        return ok(res, opportunityDto(store.addOpportunity(ws, customerId, await body(req)), store.getCustomer(ws, customerId)), traceId, 201), true;
      }
      if ((match = url.pathname.match(/^\/api\/v2\/opportunities\/([^/]+)$/)) && req.method === 'PATCH') {
        const opportunityId = decodeURIComponent(match[1]);
        const before = store._helpers.ensureOpportunity(ws, opportunityId);
        const input = await body(req); const updated = store.patchOpportunity(ws, opportunityId, input.expected_revision, input.changes);
        const eventBase = { trace_id:traceId,customer_id:updated.customer_id,opportunity_id:opportunityId,actor:input.actor||'sales',environment:updated.environment };
        if (before.sales_stage !== updated.sales_stage) emit(ws,'sales_stage_changed',{ ...eventBase,
          idempotency_key:`opportunity:${opportunityId}:stage:${updated.revision}`,payload:{ status_before:before.sales_stage,status_after:updated.sales_stage,reason:input.reason||null }
        });
        if (Boolean(before.human_handoff) !== Boolean(updated.human_handoff)) emit(ws,'human_handoff_changed',{ ...eventBase,
          idempotency_key:`opportunity:${opportunityId}:handoff:${updated.revision}`,payload:{ status_before:Boolean(before.human_handoff),status_after:Boolean(updated.human_handoff),owner:updated.handoff_owner||null,reason:input.reason||null }
        });
        if (!before.purchased && updated.purchased && typeof onOpportunityPurchased === 'function') {
          await onOpportunityPurchased({ workspaceId: ws, opportunityId, purchasedAt: updated.updated_at });
        }
        if (!before.purchased && updated.purchased) emit(ws,'purchase_marked',{ ...eventBase,
          product_version:updated.product_version,idempotency_key:`opportunity:${opportunityId}:purchased`,payload:{ product_id:updated.product_id||null,confirmed_by_role:input.actor||'sales',purchased_at:updated.updated_at }
        });
        return ok(res, opportunityDto(updated, store.getCustomer(ws, updated.customer_id)), traceId), true;
      }
      if ((match = url.pathname.match(/^\/api\/v2\/opportunities\/([^/]+)\/messages$/)) && req.method === 'GET') return ok(res, store.listMessages(ws, decodeURIComponent(match[1])).map(messageDto), traceId), true;
      if (match && req.method === 'POST') {
        const oid = decodeURIComponent(match[1]); const input = await body(req);
        const opportunity = store._helpers.ensureOpportunity(ws, oid);
        const session = observability?.getSession(ws, oid, opportunity.customer_id, opportunity.environment) || { session_id: `session_${oid}` };
        const provisionalMessageId = input.message_id || null;
        observability?.startTrace({
          workspace_id: ws, trace_id: traceId, session_id: session.session_id, customer_id: opportunity.customer_id,
          opportunity_id: oid, message_id: provisionalMessageId, case_id: caseId, eval_run_id: evalRunId,
          name: 'customer-message', input: { role: input.role, text: input.text, source: input.source || 'manual' },
          metadata: { environment: opportunity.environment }
        });
        const ingest = observability?.startObservation({ workspace_id: ws, trace_id: traceId, type: 'span', name: 'message.ingest', input: { role: input.role, source: input.source || 'manual' } });
        const result = store.addMessage(ws, oid, { ...input, trace_id: traceId, session_id: session.session_id });
        if (!result.idempotent_replay && result.message.role === 'customer') emit(ws,'message_received',{
          trace_id:traceId,session_id:session.session_id,customer_id:opportunity.customer_id,opportunity_id:oid,
          message_id:result.message.message_id,actor:'customer',environment:result.message.environment,
          idempotency_key:`message:${result.message.message_id}:received`,payload:{ source:result.message.source,text_length:String(result.message.text||'').length }
        });
        observability?.finishObservation(ws, ingest?.observation_id, { output: { message_id: result.message.message_id, idempotent_replay: result.idempotent_replay } });
        observability?.startTrace({ workspace_id: ws, trace_id: traceId, session_id: session.session_id, customer_id: opportunity.customer_id,
          opportunity_id: oid, message_id: result.message.message_id, case_id: caseId, eval_run_id: evalRunId,
          name: 'customer-message', input: { role: input.role, text: input.text, source: input.source || 'manual' }, metadata: { environment: opportunity.environment } });
        const backgroundAnalysis = !result.idempotent_replay && result.message.role === 'customer' && conversationOrchestrator
          ? conversationOrchestrator.scheduleBackgroundMemory({ workspaceId: ws, opportunityId: oid, messageId: result.message.message_id,
            traceId, sessionId: session.session_id, caseId, evalRunId })
          : { status: result.idempotent_replay ? 'idempotent_replay' : 'not_scheduled' };
        const scheduleObservation = observability?.startObservation({ workspace_id: ws, trace_id: traceId, type: 'event', name: 'b1.memory.scheduled', input: { message_id: result.message.message_id } });
        observability?.finishObservation(ws, scheduleObservation?.observation_id, { output: backgroundAnalysis });
        const automaticReply = !result.idempotent_replay && result.message.role === 'customer' && typeof onCustomerMessage === 'function'
          ? onCustomerMessage({ workspaceId: ws, opportunityId: oid, customerId: opportunity.customer_id,
            messageId: result.message.message_id, source: result.message.source, environment: result.message.environment,
            traceId, sessionId: session.session_id })
          : { status: result.idempotent_replay ? 'idempotent_replay' : 'not_scheduled' };
        return ok(res, { ...messageDto(result.message), idempotent_replay: result.idempotent_replay,
          background_analysis: backgroundAnalysis, automatic_reply: automaticReply }, traceId, 201), true;
      }
      if ((match = url.pathname.match(/^\/api\/v2\/opportunities\/([^/]+)\/intent-events$/)) && req.method === 'GET') {
        return ok(res, store.listOpportunityIntentEvents(ws, decodeURIComponent(match[1])), traceId), true;
      }
      if ((match = url.pathname.match(/^\/api\/v2\/opportunities\/([^/]+)\/media-transcriptions$/)) && req.method === 'POST') {
        assertApi(mediaTranscriptionConfigured && typeof transcribeMedia === 'function', 503, 'ASR_NOT_CONFIGURED', '语音识别尚未配置；可以先直接试听并手工录入文字。');
        const oid = decodeURIComponent(match[1]);
        store._helpers.ensureOpportunity(ws, oid);
        const input = await body(req, 12_000_000);
        try {
          return ok(res, await transcribeMedia(input), traceId, 201), true;
        } catch (error) {
          if (error?.name === 'MediaTranscriptionError') throw new ApiError(error.status || 400, error.code || 'ASR_ERROR', error.message);
          throw error;
        }
      }
      if ((match = url.pathname.match(/^\/api\/v2\/opportunities\/([^/]+)\/context$/)) && req.method === 'GET') return ok(res, buildContext(store, ws, decodeURIComponent(match[1])), traceId), true;
      if ((match = url.pathname.match(/^\/api\/v2\/opportunities\/([^/]+)\/summaries$/)) && req.method === 'POST') {
        const result = store.addSummary(ws, decodeURIComponent(match[1]), await body(req));
        return ok(res, { ...result.summary, idempotent_replay: result.idempotent_replay }, traceId, 201), true;
      }
      if ((match = url.pathname.match(/^\/api\/v2\/opportunities\/([^/]+)\/drafts\/latest$/)) && req.method === 'GET') {
        const draft = store.getLatestDraft(ws, decodeURIComponent(match[1]), url.searchParams.get('latest_message_id') || null);
        return ok(res, draft ? draftDto(draft) : null, traceId), true;
      }
      if ((match = url.pathname.match(/^\/api\/v2\/opportunities\/([^/]+)\/drafts$/)) && req.method === 'POST') {
        assertApi(salesAssist, 503, 'AI_MODULE_NOT_CONNECTED', '新销售辅助模块尚未接通；未使用模板冒充 AI。');
        const oid = decodeURIComponent(match[1]); const input = await body(req);
        const baseContext = buildContext(store, ws, oid, { caseId, evalRunId });
        traceId = baseContext.trace_id || traceId;
        const opportunity = store._helpers.ensureOpportunity(ws, oid);
        const session = observability?.getSession(ws, oid, baseContext.customer_id, opportunity.environment) || { session_id: baseContext.session_id || `session_${oid}` };
        const storedTrace = observability?.getTrace(ws, traceId);
        const traceContext = { ...baseContext, trace_id: traceId, session_id: baseContext.session_id || session.session_id,
          evaluation: {
            case_id: caseId || storedTrace?.case_id || baseContext.evaluation?.case_id || null,
            eval_run_id: evalRunId || storedTrace?.eval_run_id || baseContext.evaluation?.eval_run_id || null
          } };
        observability?.startTrace({ workspace_id: ws, trace_id: traceId, session_id: traceContext.session_id, customer_id: baseContext.customer_id,
          opportunity_id: oid, message_id: baseContext.latest_message_id, case_id: traceContext.evaluation.case_id,
          eval_run_id: traceContext.evaluation.eval_run_id, name: 'customer-message', input: { text: baseContext.latest_message },
          metadata: { environment: baseContext.environment } });
        if (aiBudget) aiBudget.assertAvailable(ws, baseContext.customer_id);
        if (knowledgeSafety) knowledgeSafety.assertAiAllowed(ws);
        const context = prepareSalesContext ? prepareSalesContext(traceContext) : traceContext;
        const turnRoute = classifyConversationTurn(context);
        const routeObservation = observability?.startObservation({ workspace_id: ws, trace_id: traceId, type: 'span', name: 'route.decide', input: { latest_message: context.latest_message } });
        observability?.finishObservation(ws, routeObservation?.observation_id, { output: { route: turnRoute } });
        emit(ws,'route_decided',{
          trace_id:traceId,session_id:traceContext.session_id,customer_id:baseContext.customer_id,opportunity_id:oid,
          message_id:baseContext.latest_message_id,actor:'system',environment:baseContext.environment,workflow:'conversation_orchestrator',
          idempotency_key:`route:${traceId}`,payload:{ route:turnRoute,gate_status:'evaluated' }
        });
        const currentTurnOptsOut = turnRoute === 'stop_marketing' && isExplicitMarketingOptOut(context.latest_message);
        assertApi(!context.contact_state.marketing_opt_out || ['service', 'human_required'].includes(turnRoute) || currentTurnOptsOut, 409, 'MARKETING_OPT_OUT', '客户已拒收营销，仅可处理明确合同服务请求。');
        assertApi(!context.contact_state.human_handoff || turnRoute === 'human_required' || currentTurnOptsOut, 409, 'HUMAN_HANDOFF_ACTIVE', '当前由人工接手，不生成助手草稿。');
        assertApi(input.latest_message_id === context.latest_message_id, 409, 'STALE_CONTEXT', '已有更新的消息。', { latest_message_id: context.latest_message_id });
        assertApi(Number(input.expected_revision) === context.context_versions.opportunity_revision, 409, 'REVISION_CONFLICT', '需求版本已变更。', { current_revision: context.context_versions.opportunity_revision });
        assertApi(aiConfigured || ['intake', 'human_required', 'stop_marketing'].includes(turnRoute), 503, 'AI_NOT_CONFIGURED', '销售辅助工作流尚未配置；产品与服务内容不能由模板代替。');
        const workflowStartedAt = Date.now();
        const eventContext = { trace_id:traceId,session_id:traceContext.session_id,customer_id:baseContext.customer_id,
          opportunity_id:oid,message_id:baseContext.latest_message_id,actor:'system',environment:baseContext.environment,
          workflow:'conversation_orchestrator' };
        emit(ws,'workflow_started',{ ...eventContext,idempotency_key:`workflow:${traceId}:started`,payload:{ route:turnRoute,attempt:1 } });
        let generated;
        try {
          generated = observability
            ? await observability.observe({ workspace_id: ws, trace_id: traceId, type: 'span', name: 'orchestrator.main_reply', input: { route: turnRoute } }, () => conversationOrchestrator
              ? conversationOrchestrator.runMainReply(context, { ...aiDependencies, observability })
              : salesAssist(context, { ...aiDependencies, observability }))
            : conversationOrchestrator
              ? await conversationOrchestrator.runMainReply(context, aiDependencies)
              : await salesAssist(context, aiDependencies);
        } catch (error) {
          emit(ws,'workflow_failed',{ ...eventContext,duration_ms:Date.now()-workflowStartedAt,
            idempotency_key:`workflow:${traceId}:failed`,payload:{ route:turnRoute,error_code:error?.code||error?.name||'ERROR',retryable:Boolean(error?.retryable),attempt:1 }
          });
          throw error;
        }
        const result = generated && { ...generated, interaction_type: turnRoute === 'service' ? 'contract_service' : 'new_consultation' };
        assertApi(result && result.schema_version === 'sales-assist.v1' && typeof result.status === 'string', 502, 'INVALID_AI_RESULT', 'AI 返回结构无效。');
        if (validateSalesContext) validateSalesContext(context);
        const savedResult = context.confirmed_product_match ? { ...result, product_match_reference: {
          recommendation_id: context.confirmed_product_match.recommendation_id,
          catalog_fingerprint: context.confirmed_product_match.catalog_fingerprint
        } } : result;
        const saved = draftDto(store.saveDraft(ws, oid, input.latest_message_id, input.expected_revision, savedResult, context));
        const workflowDuration = Date.now()-workflowStartedAt;
        emit(ws,'workflow_completed',{ ...eventContext,duration_ms:workflowDuration,
          idempotency_key:`workflow:${traceId}:completed`,payload:{ route:turnRoute,result_id:saved.draft_id,status:saved.status,attempt:1 }
        });
        emit(ws,'draft_generated',{ ...eventContext,duration_ms:workflowDuration,
          idempotency_key:`draft:${saved.draft_id}:generated`,payload:{ draft_id:saved.draft_id,status:saved.status,provider:saved.trace?.provider||null,model_version:saved.trace?.model_version||null,prompt_version:saved.trace?.prompt_version||null }
        });
        const operationalTask = (() => {
          if (isReturnGuaranteeRequest(context.latest_message) || result.next_action === 'sales_review_guarantee_scope'
            || (result.status === 'needs_source' && /(?:保证|收益)/.test(context.latest_message || ''))) return {
            title: '核对收益保证依据',
            reason: '客户要求收益保证；须由销售依据合同或正式计划书核对，AI不得承诺。'
          };
          if (['sales_review_missing_formal_plan', 'sales_review_missing_formal_amount'].includes(result.next_action)) return {
            title: '核对正式计划书与金额依据',
            reason: '当前正式计划书或金额依据不足；请销售补齐对应产品、版本和客户条件的资料后回复。',
            owner: 'sales'
          };
          if (result.next_action === 'human_review_claim_coverage') return {
            title: '人工核对理赔问题',
            reason: '客户询问疾病是否一定理赔；须结合合同、案件事实和正式审核结果人工处理。'
          };
          if (result.next_action === 'review_insured_person_switch') return {
            title: '确认切换被保人',
            reason: '客户将当前需求从本人改为妈妈；须确认人物切换并隔离两人资料后才能进入产品匹配。'
          };
          if (result.next_action === 'confirm_product_identity_before_comparison') return {
            title: '核对疑似产品名称',
            reason: '客户提到的产品名与当前目录不一致；请销售依据保单或计划书确认产品全称，确认前不得引用其他产品条款比较。'
          };
          if (result.status === 'human_required' || result.next_action === 'route_to_human_owner') {
            if (isDirectHumanRequest(context.latest_message)) return {
              title: '尽快联系客户（人工接管）',
              reason: 'requested_human_contact',
              owner: 'sales',
              idempotency_key: `intent-task:${oid}:${context.latest_message_id}`
            };
            return {
              title: '高风险服务人工接管',
              reason: '高风险服务请求已触发安全门禁；AI停止对客，由人工核验合同和当前数据。'
            };
          }
          return null;
        })();
        if (operationalTask) {
          store.createTask(ws, {
            customer_id: opportunity.customer_id,
            opportunity_id: oid,
            due_at: new Date().toISOString(),
            owner: 'unassigned',
            status: 'open',
            idempotency_key: operationalTask.idempotency_key
              || `ai-action:${oid}:${context.latest_message_id}:${result.next_action || result.status}`,
            ...operationalTask
          });
          if (result.status === 'human_required') {
            const current = store._helpers.ensureOpportunity(ws, oid);
            if (!current.human_handoff) {
              const handed = store.patchOpportunity(ws, oid, current.revision, { human_handoff: true, handoff_owner: 'unassigned' });
              emit(ws,'human_handoff_changed',{ ...eventContext,
                idempotency_key:`opportunity:${oid}:handoff:${handed.revision}`,payload:{ status_before:false,status_after:true,reason:operationalTask.reason,task_created:true }
              });
            }
          }
        }
        observability?.finishTrace(ws, traceId, { status: saved.orchestration?.blocking_gate ? 'blocked' : 'success', output: {
          draft_id: saved.draft_id, status: saved.status, blocking_gate: saved.orchestration?.blocking_gate || null,
          citations: saved.citations?.length || 0
        } });
        return ok(res, saved, traceId, 201), true;
      }
      if ((match = url.pathname.match(/^\/api\/v2\/drafts\/([^/]+)\/confirm$/)) && req.method === 'POST') {
        const did = decodeURIComponent(match[1]); const input = await body(req);
        const draft = store.getDraft(ws, did);
        const opportunity = store._helpers.ensureOpportunity(ws, draft.opportunity_id);
        if (aiBudget) aiBudget.assertAvailable(ws, opportunity.customer_id);
        if (knowledgeSafety) knowledgeSafety.assertAiAllowed(ws);
        if (validateDraft) validateDraft(draft);
        const result = store.confirmDraft(ws, did, input);
        const message = store.listMessages(ws,draft.opportunity_id).find(item=>item.message_id===draft.latest_message_id);
        const sourceTraceId = message?.trace_id||traceId;
        if (!result.idempotent_replay) emit(ws,'draft_confirmed_sent',{
          trace_id:sourceTraceId,session_id:message?.session_id||null,customer_id:opportunity.customer_id,opportunity_id:draft.opportunity_id,
          message_id:draft.latest_message_id,actor:input.editor_role||'sales',environment:opportunity.environment,
          idempotency_key:`draft:${did}:confirmed:${input.confirmation_key||result.draft.confirmation_key||'once'}`,
          payload:{ draft_id:did,delivery_mode:input.delivery_mode||result.draft.delivery_mode||null,ai_draft_length:String(draft.content||'').length,final_length:String(input.final_text||draft.content||'').length }
        });
        return ok(res, { ...draftDto(result.draft), idempotent_replay: result.idempotent_replay }, traceId), true;
      }
      if ((match = url.pathname.match(/^\/api\/v2\/opportunities\/([^/]+)\/plans$/)) && req.method === 'GET') return ok(res, store.getPlans(ws, decodeURIComponent(match[1])), traceId), true;
      if (match && req.method === 'POST') return ok(res, store.savePlan(ws, decodeURIComponent(match[1]), await body(req)), traceId, 201), true;
      if (url.pathname === '/api/v2/tasks' && req.method === 'GET') return ok(res, store.listTasks(ws, { status: url.searchParams.get('status') || undefined }).map(taskDto), traceId), true;
      if (url.pathname === '/api/v2/tasks' && req.method === 'POST') { const result = store.createTask(ws, await body(req)); return ok(res, { ...taskDto(result.task), idempotent_replay: result.idempotent_replay }, traceId, 201), true; }
      if ((match = url.pathname.match(/^\/api\/v2\/tasks\/([^/]+)$/)) && req.method === 'PATCH') { const input = await body(req); return ok(res, taskDto(store.patchTask(ws, decodeURIComponent(match[1]), input.expected_revision, input.changes)), traceId), true; }
      throw new ApiError(404, 'NOT_FOUND', '接口不存在。');
    } catch (error) {
      const known = error instanceof ApiError;
      try {
        const ws = workspace(req);
        observability?.finishTrace(ws, traceId, { status: 'error', error_code: known ? error.code : 'INTERNAL_ERROR', output: { failed: true } });
        const status = known ? error.status : 500;
        if (observability?.upsertBadcase && status >= 500 && /\/drafts(?:\/|$)|\/media-transcriptions(?:\/|$)/.test(url.pathname)) {
          const runtimeRunId = evalRunId || `runtime-${new Date().toISOString().slice(0,10)}`;
          const runtimeCaseId = caseId || `runtime-${traceId.slice(0,12)}`;
          observability.upsertBadcase(ws,{
            case_id:runtimeCaseId,eval_run_id:runtimeRunId,trace_id:traceId,status:'open',severity:'P0',
            failed_dimensions:['workflow'],actual:{ error_code:known?error.code:'INTERNAL_ERROR',status,message:known?error.message:'服务器无法完成请求。',request_path:url.pathname },
            expected:{ behavior:'销售工作流应完成并返回可核验结果。' },root_cause_layer:'workflow',
            root_cause_note:`运行时工作流失败：${known?error.code:'INTERNAL_ERROR'}`,regression_status:'not_run'
          });
        }
      } catch {}
      if (!known) console.error(`[${traceId}] v2 request failed: ${error.name}: ${error.message}`);
      sendJson(res, known ? error.status : 500, {
        error: { code: known ? error.code : 'INTERNAL_ERROR', message: known ? error.message : '服务器无法完成请求。', details: known ? error.details : null },
        trace_id: traceId
      });
      return true;
    }
  };
}
