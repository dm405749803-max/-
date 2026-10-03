import { createHash } from 'node:crypto';
import { classifyConversationTurn, matchingProfileGaps, safetyAcknowledgement } from '../ai/conversation-routing.mjs';
export { classifyConversationTurn } from '../ai/conversation-routing.mjs';

const unique = values => [...new Set(values.filter(Boolean))];
const NON_MATCH_FIELDS = new Set(['preferred_contact_time', 'contact_time', 'communication_preference']);
const SAFE_MEMORY = new Set(['approved', 'rejected', 'ignored', 'observed', 'no_changes']);
const MATCH_STATES = new Set(['ready', 'needs_information', 'needs_source', 'not_matched', 'human_required', 'unavailable', 'invalid_output']);

function backgroundKey(workspaceId, opportunityId, messageId) {
  return [workspaceId, opportunityId, messageId].join('\u0000');
}

async function withTimeout(promise, timeoutMs, fallback = { status: 'running' }, { unref = false } = {}) {
  if (!promise) return null;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return fallback;
  let timer;
  try {
    return await Promise.race([promise, new Promise(resolve => {
      timer = setTimeout(() => resolve(fallback), timeoutMs);
      if (unref) timer.unref?.();
    })]);
  } finally { clearTimeout(timer); }
}

function normalizeMemory(value, context) {
  if (!value || typeof value !== 'object') return { status: 'failed', code: 'INVALID_BACKGROUND_MEMORY_RESULT' };
  const status = value.status === 'insufficient_evidence' ? 'no_changes' : value.status;
  const allowed = new Set([...SAFE_MEMORY, 'pending', 'running', 'expired', 'stale_context', 'not_configured', 'not_started', 'failed', 'unavailable', 'invalid_output', 'error']);
  if (!allowed.has(status)) return { status: 'failed', code: 'INVALID_BACKGROUND_MEMORY_RESULT' };
  if (context && value.context_versions?.latest_message_id && value.context_versions.latest_message_id !== context.latest_message_id) {
    return { status: 'stale_context', code: 'BACKGROUND_MEMORY_MESSAGE_CHANGED' };
  }
  const state = { status, proposal_id: value.proposal_id || null, revision: value.revision || null };
  if (status === 'pending') {
    // Summary-only and known communication preferences cannot alter the matching
    // profile. Unknown fields fail closed if future rules start consuming them.
    state.affects_product_match = !Array.isArray(value.facts) || value.facts.some(fact => {
      if (fact?.review_tier === 'observation') return false;
      if (['solution_impact','sensitive','conflict'].includes(fact?.review_tier)) return true;
      if (!fact || NON_MATCH_FIELDS.has(fact.field)) return !fact;
      return !(context?.confirmed_facts || []).some(known => known.status === 'confirmed'
        && known.field === fact.field && (known.person_id || null) === (fact.person_id || null)
        && (!known.opportunity_id || known.opportunity_id === context.opportunity_id)
        && JSON.stringify(known.value) === JSON.stringify(fact.value));
    });
  }
  return state;
}

function failedMemory(error) {
  // Do not expose arbitrary upstream error messages or provider codes.
  if (error?.code === 'MEMORY_PROPOSAL_INSUFFICIENT_EVIDENCE') return { status: 'no_changes' };
  if (error?.code === 'MEMORY_MODEL_NOT_CONFIGURED') return { status: 'not_configured' };
  if (['MEMORY_PROPOSAL_STALE', 'MEMORY_PROPOSAL_EXPIRED', 'STALE_CONTEXT'].includes(error?.code)) return { status: 'stale_context' };
  return { status: 'failed', code: 'BACKGROUND_MEMORY_FAILED' };
}

function gateForResult(result) {
  if (result.status === 'stale_context' || result.next_action === 'repair_context_envelope') return 'input_data';
  if (result.risk_flags?.includes('invalid_dify_output') || ['needs_source', 'invalid_output'].includes(result.status)) return 'evidence';
  if (['human_required', 'stop_marketing'].includes(result.status)) return 'safety_business';
  if (['error', 'unavailable'].includes(result.status)) return 'dependency';
  if (result.status === 'draft_ready' && result.review_required !== false) return 'human_decision';
  return null;
}

function orchestration(result, route, backgroundMemory) {
  const gate = gateForResult(result);
  return { ...result, orchestration: {
    schema_version: 'conversation-orchestration.v1', route,
    reply_path: ['human_required', 'stop_marketing'].includes(route) ? 'human'
      : route === 'intake' ? 'safe_intake' : route === 'product_match' ? 'product_match_then_draft' : 'rag_draft',
    background_memory: backgroundMemory, product_match: null,
    blocking_gate: gate, blocking_reason: gate ? result.next_action || result.status : null
  } };
}

function blocked(result, status, action, reason, gate) {
  return { ...result, status, draft: '', citations: [], next_question: null, next_action: action, review_required: true,
    missing_evidence: unique([...(result.missing_evidence || []), reason]),
    orchestration: { ...result.orchestration, blocking_gate: gate, blocking_reason: reason } };
}

export function createConversationOrchestrator({
  runSalesAssist, scheduleMemoryProposal = null, findMemoryProposal = null,
  generateProductRecommendation = null, onBackgroundError = () => {},
  memoryWaitMs = 30_000, backgroundTimeoutMs = 120_000, mainReplyTimeoutMs = 120_000, productMatchTimeoutMs = 120_000
}) {
  if (typeof runSalesAssist !== 'function') throw new TypeError('runSalesAssist is required');
  const jobs = new Map();
  const requestFor = context => ({ workspaceId: context.workspace_id, opportunityId: context.opportunity_id, messageId: context.latest_message_id,
    traceId: context.trace_id || null, sessionId: context.session_id || null,
    caseId: context.evaluation?.case_id || null, evalRunId: context.evaluation?.eval_run_id || null });
  const keyFor = context => backgroundKey(context.workspace_id, context.opportunity_id, context.latest_message_id);

  function scheduleBackgroundMemory({ workspaceId, opportunityId, messageId, traceId = null, sessionId = null, caseId = null, evalRunId = null }) {
    if (typeof scheduleMemoryProposal !== 'function') return { status: 'not_configured' };
    if (!workspaceId || !opportunityId || !messageId) return { status: 'not_started' };
    const key = backgroundKey(workspaceId, opportunityId, messageId);
    if (!jobs.has(key)) {
      const entry = { state: { status: 'running' }, value: null, promise: null };
      jobs.set(key, entry);
      const work = Promise.resolve().then(() => scheduleMemoryProposal({
        workspaceId, opportunityId, messageId, idempotencyKey: 'background-memory:' + messageId,
        traceId, sessionId, caseId, evalRunId
      })).then(value => {
        entry.value = value;
        return normalizeMemory(value);
      }).catch(error => {
        try { onBackgroundError(error, { workspaceId, opportunityId, messageId }); } catch {}
        return failedMemory(error);
      });
      entry.promise = withTimeout(work, backgroundTimeoutMs,
        { status: 'failed', code: 'BACKGROUND_MEMORY_TIMEOUT' }, { unref: true }).then(state => (entry.state = state));
      const cleanup = setTimeout(() => { if (jobs.get(key) === entry) jobs.delete(key); }, 30 * 60 * 1000);
      cleanup.unref?.();
    }
    return { status: 'scheduled', generation_key: 'background-memory:' + messageId };
  }

  function snapshot(context) {
    const job = jobs.get(keyFor(context));
    return job?.state || { status: typeof scheduleMemoryProposal === 'function' || typeof findMemoryProposal === 'function' ? 'not_started' : 'not_configured' };
  }

  async function memoryState(context) {
    const job = jobs.get(keyFor(context));
    if (job?.state.status === 'running') await withTimeout(job.promise, memoryWaitMs);
    if (typeof findMemoryProposal === 'function') {
      try {
        const stored = await withTimeout(Promise.resolve().then(() => findMemoryProposal({
          ...requestFor(context), generationKey: 'background-memory:' + context.latest_message_id
        })), memoryWaitMs, { status: 'failed', code: 'BACKGROUND_MEMORY_LOOKUP_TIMEOUT' });
        if (stored) return normalizeMemory(stored, context);
      } catch { return { status: 'failed', code: 'BACKGROUND_MEMORY_LOOKUP_FAILED' }; }
    }
    return job?.value && job.state.status !== 'failed' ? normalizeMemory(job.value, context) : snapshot(context);
  }

  async function runMainReply(context, dependencies = {}) {
    const route = classifyConversationTurn(context);
    if (!context?.workspace_id || !context?.opportunity_id || !context?.latest_message_id
      || (context.context_versions?.latest_message_id && context.context_versions.latest_message_id !== context.latest_message_id)) {
      return blocked(orchestration({ schema_version: 'sales-assist.v1', missing_evidence: [] }, route, { status: 'not_started' }),
        'stale_context', 'rebuild_context_from_latest_message', 'invalid_or_stale_context', 'input_data');
    }
    // Ingestion starts B1; an explicit draft request can recover scheduling after
    // a restart. Persistent proposal generation remains idempotent.
    if (!jobs.has(keyFor(context))) scheduleBackgroundMemory(requestFor(context));
    let result;
    try {
      result = await withTimeout(Promise.resolve().then(() => runSalesAssist(context, dependencies)), mainReplyTimeoutMs,
        { schema_version: 'sales-assist.v1', status: 'unavailable', draft: '', next_action: 'retry_main_reply', missing_evidence: ['main_reply_timeout'], review_required: true });
    } catch {
      result = { schema_version: 'sales-assist.v1', status: 'unavailable', draft: '', next_action: 'retry_main_reply', missing_evidence: ['main_reply_failed'], review_required: true };
    }
    if (!result || result.schema_version !== 'sales-assist.v1' || typeof result.status !== 'string') {
      result = { schema_version: 'sales-assist.v1', status: 'invalid_output', draft: '', next_action: 'review_invalid_ai_output', missing_evidence: ['invalid_main_reply'], review_required: true };
    }
    // Never await a B1 job or proposal lookup on the ordinary reply path.
    let combined = orchestration(result, route, snapshot(context));
    if (['human_required', 'stop_marketing'].includes(route)) {
      const safetyBlocked = blocked(combined, route, route === 'stop_marketing' ? 'stop_marketing_contact' : 'route_to_human_owner', route, 'safety_business');
      return { ...safetyBlocked, draft: context.contact_state?.marketing_opt_out ? '' : safetyAcknowledgement(route, context.latest_message) };
    }
    if (route !== 'intake' && combined.review_required === false) {
      combined = { ...combined, review_required: true,
        orchestration: { ...combined.orchestration, blocking_gate: 'human_decision', blocking_reason: 'sales_review_required' } };
    }
    if (result.next_action !== 'run_product_match') return combined;
    if (route !== 'product_match' || result.status !== 'needs_information') {
      return blocked(combined, 'invalid_output', 'review_invalid_ai_output', 'product_match_route_mismatch', 'evidence');
    }

    const backgroundMemory = await memoryState(context);
    combined = orchestration(result, route, backgroundMemory);
    if (backgroundMemory.status === 'pending' && backgroundMemory.affects_product_match !== false) {
      return blocked(combined, 'needs_information', 'review_memory_before_product_match', 'memory_review_required', 'memory');
    }
    if (backgroundMemory.status === 'running') {
      return blocked(combined, 'needs_information', 'wait_for_background_memory', 'background_memory_running', 'memory');
    }
    if (['expired', 'stale_context'].includes(backgroundMemory.status)) {
      return blocked(combined, 'stale_context', 'regenerate_background_memory', 'background_memory_stale', 'input_data');
    }
    if (!SAFE_MEMORY.has(backgroundMemory.status) && !(backgroundMemory.status === 'pending' && backgroundMemory.affects_product_match === false)) {
      return blocked(combined, 'unavailable', 'retry_background_memory', 'background_memory_' + backgroundMemory.status, 'dependency');
    }
    const gaps = matchingProfileGaps(context);
    if (gaps.length) {
      combined.missing_evidence = unique([...(combined.missing_evidence || []), ...gaps]);
      return blocked(combined, 'needs_information', 'collect_product_match_information', 'confirmed_profile_incomplete', 'input_data');
    }
    if (typeof generateProductRecommendation !== 'function') {
      return blocked(combined, 'unavailable', 'configure_product_match', 'product_match_not_configured', 'dependency');
    }

    let recommendation;
    try {
      const versionKey = createHash('sha256').update(JSON.stringify(context.context_versions || {})).digest('hex').slice(0, 20);
      recommendation = await withTimeout(Promise.resolve().then(() => generateProductRecommendation({
        workspaceId: context.workspace_id, opportunityId: context.opportunity_id,
        latestMessageId: context.latest_message_id, expectedRevision: context.context_versions.opportunity_revision,
        contextVersions: { ...context.context_versions },
        traceId: context.trace_id || null, sessionId: context.session_id || null,
        caseId: context.evaluation?.case_id || null, evalRunId: context.evaluation?.eval_run_id || null,
        idempotencyKey: 'orchestrated-product-match:' + context.latest_message_id + ':' + versionKey
      })), productMatchTimeoutMs, { result: { status: 'unavailable', missing_fields: ['product_match_timeout'] } });
    } catch (error) {
      const stale = ['STALE_CONTEXT', 'REVISION_CONFLICT', 'RECOMMENDATION_STALE'].includes(error?.code);
      return blocked(combined, stale ? 'stale_context' : 'unavailable', stale ? 'rebuild_context_from_latest_message' : 'retry_product_match',
        stale ? 'product_match_context_changed' : 'product_match_failed', stale ? 'input_data' : 'dependency');
    }
    if (recommendation?.stale) return blocked(combined, 'stale_context', 'rebuild_context_from_latest_message', 'product_match_context_changed', 'input_data');
    const status = recommendation?.result?.status;
    const matchStatus = MATCH_STATES.has(status) ? status : 'invalid_output';
    const outcomes = {
      ready: ['needs_information', 'review_product_match', 'product_match_acceptance_required', 'human_decision'],
      needs_information: ['needs_information', 'collect_product_match_information', 'product_match_information_required', 'input_data'],
      needs_source: ['needs_source', 'verify_product_source', 'product_match_source_required', 'evidence'],
      not_matched: ['needs_information', 'review_no_product_match', 'no_eligible_product', 'human_decision'],
      human_required: ['human_required', 'route_to_human_owner', 'product_match_human_required', 'safety_business'],
      unavailable: ['unavailable', 'retry_product_match', 'product_match_unavailable', 'dependency'],
      invalid_output: ['invalid_output', 'review_invalid_product_match', 'invalid_product_match_output', 'evidence']
    };
    combined.missing_evidence = unique([...(combined.missing_evidence || []), ...(recommendation?.result?.missing_fields || [])]);
    combined.orchestration.product_match = { status: matchStatus, recommendation_id: recommendation?.recommendation_id || null, review_required: true };
    return blocked(combined, ...outcomes[matchStatus]);
  }

  return { scheduleBackgroundMemory, runMainReply, classifyConversationTurn, _jobs: jobs };
}

export const __test = { backgroundKey, withTimeout, normalizeMemory, matchingProfileGaps };
