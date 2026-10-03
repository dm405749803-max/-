const SETUP_TYPE_RULES = [
  ['historical_memory', /历史购买需求|同一客户此前.*孩子教育|长期记忆/],
  ['cross_period_context', /跨月摘要|未解决顾虑|旧产品版本/],
  ['confirmed_profile', /先确认.*(?:人物|年龄|用途|预算)|已确认的人物|画像确认|画像卡确认/],
  ['profile_change_approval', /人物.*(?:切换|确认)|新旧冲突候选|销售画像确认/],
  ['deterministic_candidate_rules', /确定性规则.*候选|候选.*确定性排除|全部被确定性规则排除|多个候选|多个合格候选/],
  ['multiple_need_boundaries', /两条不同用途的购买需求|匹配边界不会合并/],
  ['profile_conflict', /冲突年龄证据|旧年龄.*冲突/],
  ['recommendation_review', /已生成的B2推荐.*驳回/],
  ['historical_case_reference', /历史成交案例/],
  ['recommendation_invalidation', /已生成的B2推荐和对应草稿|改变匹配的画像证据/],
  ['draft_editor_state', /AI(?:原)?草稿|人工终稿|编辑状态|销售修改|清空编辑框/],
  ['product_catalog_state', /产品目录|两产品|匹配候选/],
  ['knowledge_scope', /公共与产品FAQ|范围差异|同范围冲突/],
  ['document_lifecycle', /生命周期为已下架|已下架的产品文档/],
  ['low_relevance_retrieval', /低相关的文本|低相关检索/],
  ['liquidity_recheck', /流动性约束|重新运行B2/],
  ['conversation_deferral', /两次.*回避|停止追问/],
  ['intent_followup', /意向变化|回访待办|与家人商量/],
  ['human_handoff', /人工接管|投诉/],
  ['media_review', /媒体转写|ASR|OCR|语音转写/],
  ['purchased_state', /预置已购状态/],
  ['version_alignment', /产品目录、规则和RAG|切换.*版本|旧产品版本/],
  ['ai_budget_threshold', /AI成本|70%|100%阈值/],
  ['dependency_outage', /关闭Dify|恢复后.*降级/],
  ['experience_review', /销冠|经验池|成交.*候选经验/],
  ['evidence_conflict', /文字、OCR和ASR|三种证据|冲突确认/],
  ['purchase_service_transition', /成交.*已购服务|保单查询.*服务链路/]
];

const BUILTIN_SETUP_TYPES = new Set(['profile_change_approval']);

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function explicitSetup(input) {
  const value = input?.fixture_setup ?? input?.setup_types ?? input?.setup_type;
  if (Array.isArray(value)) return {
    types: value.map(item => typeof item === 'string' ? item : item?.type),
    parameters: Object.fromEntries(value.filter(item => item && typeof item === 'object' && item.type)
      .map(item => [item.type, item.parameters || {}]))
  };
  if (value && typeof value === 'object') return {
    types: Object.entries(value).filter(([, enabled]) => enabled).map(([type]) => type),
    parameters: Object.fromEntries(Object.entries(value).filter(([, parameters]) => parameters && typeof parameters === 'object'))
  };
  return { types: value ? [String(value)] : [], parameters: {} };
}

function inferPurpose(text) {
  const value = String(text || '');
  if (/(孩子|女儿|儿子).*(教育|大学)|(教育|大学).*(孩子|女儿|儿子)/s.test(value)) return '孩子教育';
  if (/养老/.test(value)) return '养老';
  return null;
}

export function resolveEvaluationFixturePlan(input = {}) {
  const executionSupport = String(input.execution_support || 'single_turn_executable').trim() || 'single_turn_executable';
  const setupInstructions = String(input.setup_instructions || '').trim();
  const setup = input.setup && typeof input.setup === 'object' ? input.setup : null;
  const fixtureType = String(input.fixture_type || setup?.fixture_type || '').trim() || null;
  // The explicit fixture contract is authoritative. Keyword inference remains a
  // backwards-compatible subtype hint for old datasets and detailed journey steps.
  const inferred = SETUP_TYPE_RULES.filter(([, pattern]) => pattern.test(setupInstructions)).map(([type]) => type);
  const explicit = explicitSetup(input);
  const correctionText = `${input.customer_input || input.question || ''}`;
  const conversationalApproval = /(?:刚才说错|改一下|其实这次).*(?:妈妈|爸爸|孩子|本人)/s.test(correctionText)
    ? ['profile_change_approval'] : [];
  const setupTypes = unique([fixtureType, ...explicit.types, ...inferred, ...conversationalApproval]);
  const fixtureRequired = executionSupport === 'fixture_required';
  const setupParameters = setup?.parameters || setup?.payload || explicit.parameters;
  const declarativeResources = Array.isArray(setupParameters?.resources) ? setupParameters.resources : [];
  const gatewaySupported = declarativeResources.length > 0 || setupTypes.includes('profile_change_approval');
  return {
    execution_support: executionSupport,
    fixture_required: fixtureRequired,
    fixture_type: fixtureType,
    setup_instructions: setupInstructions,
    setup: setup ? {
      schema_version: setup.schema_version || null,
      executor: setup.executor || null,
      preconditions: Array.isArray(setup.preconditions) ? setup.preconditions : [],
      actions: Array.isArray(setup.actions) ? setup.actions : [],
      observations: Array.isArray(setup.observations) ? setup.observations : []
    } : null,
    setup_types: setupTypes,
    setup_parameters: setupParameters,
    declarative_resources: declarativeResources,
    unsupported_setup_types: fixtureRequired && !gatewaySupported
      ? (setupTypes.length ? setupTypes : ['untyped_fixture'])
      : [],
    needs_profile_change_approval: setupTypes.includes('profile_change_approval'),
    opportunity_defaults: { purpose: inferPurpose(input.customer_input || input.question || '') }
  };
}

export function createEvaluationFixtureOrchestrator({ request } = {}) {
  if (typeof request !== 'function') throw new TypeError('evaluation fixture orchestrator requires request');

  return function createFixtureRun(input = {}, context = {}) {
    const plan = resolveEvaluationFixturePlan(input);
    const events = [];
    const headers = context.headers || {};
    const resources = new Map();

    async function createOpportunity(customerId, body) {
      return request(`/api/v2/customers/${encodeURIComponent(customerId)}/opportunities`, {
        method: 'POST', headers, body
      });
    }

    async function afterCustomerCreated({ customerId, opportunityId, runId, suffix }) {
      for (const [index, resource] of plan.declarative_resources.entries()) {
        const key = String(resource?.key || `resource-${index}`).replace(/[^a-zA-Z0-9_-]/g, '-');
        const payload = resource?.payload && typeof resource.payload === 'object' ? resource.payload : {};
        if (resource.type === 'opportunity') {
          const fixtureOpportunityId = `${opportunityId}-fixture-${key}`;
          const created = await createOpportunity(customerId, { ...payload, opportunity_id: fixtureOpportunityId });
          resources.set(resource.key, { type: 'opportunity', id: fixtureOpportunityId, data: created.data });
          events.push({ stage: 'after_customer_created', type: 'resource:opportunity', key: resource.key, status: 'applied', opportunity_id: fixtureOpportunityId });
          continue;
        }
        if (resource.type === 'message') {
          const parent = resources.get(resource.parent_ref);
          if (parent?.type !== 'opportunity') throw new Error(`fixture message parent not found: ${resource.parent_ref}`);
          const saved = await request(`/api/v2/opportunities/${encodeURIComponent(parent.id)}/messages`, {
            method: 'POST', headers,
            body: { ...payload, idempotency_key: `${runId}:${suffix}:fixture:${key}` }
          });
          resources.set(resource.key, { type: 'message', id: saved.data.message_id, data: saved.data });
          events.push({ stage: 'after_customer_created', type: 'resource:message', key: resource.key, status: 'applied', message_id: saved.data.message_id });
          continue;
        }
        if (resource.type === 'summary') {
          const parent = resources.get(resource.parent_ref);
          if (parent?.type !== 'opportunity') throw new Error(`fixture summary parent not found: ${resource.parent_ref}`);
          const through = resources.get(resource.references?.through_message);
          const evidence = (resource.references?.evidence_messages || []).map(ref => resources.get(ref)?.id).filter(Boolean);
          const saved = await request(`/api/v2/opportunities/${encodeURIComponent(parent.id)}/summaries`, {
            method: 'POST', headers,
            body: {
              ...payload,
              expected_revision: Number(payload.expected_revision || 1),
              idempotency_key: `${runId}:${suffix}:fixture:${key}`,
              through_message_id: through?.id || null,
              evidence_message_ids: evidence
            }
          });
          resources.set(resource.key, { type: 'summary', id: saved.data?.summary_id || key, data: saved.data });
          events.push({ stage: 'after_customer_created', type: 'resource:summary', key: resource.key, status: 'applied' });
          continue;
        }
        events.push({ stage: 'after_customer_created', type: `resource:${resource.type || 'unknown'}`, key: resource.key, status: 'unsupported' });
      }
      if (plan.fixture_required && plan.declarative_resources.length === 0) {
        events.push({ stage: 'after_customer_created', type: plan.fixture_type || 'untyped_fixture', status: 'not_executed' });
      }
    }

    async function afterMemory({ memoryPayload, runId, suffix }) {
      if (!plan.needs_profile_change_approval) return memoryPayload;
      const candidate = (Array.isArray(memoryPayload?.data) ? memoryPayload.data : []).find(item => {
        if (item?.status !== 'pending' || item?.review_mode !== 'solution_profile_card') return false;
        return (Array.isArray(item.facts) ? item.facts : []).some(fact => fact.field === 'insured_person_relationship');
      });
      if (!candidate) {
        events.push({ stage: 'after_memory', type: 'profile_change_approval', status: 'not_applicable' });
        return memoryPayload;
      }
      const approved = await request(`/api/v2/memory-review/proposals/${encodeURIComponent(candidate.proposal_id)}/approve`, {
        method: 'POST', headers,
        body: {
          expected_revision: candidate.revision,
          idempotency_key: `${runId}:${suffix}:fixture:profile-change-approval`,
          reviewer: 'Eval-Any-Agent human fixture',
          reason: '评测夹具：人工确认客户明确提出的当前被保人变更。'
        }
      });
      events.push({
        stage: 'after_memory', type: 'profile_change_approval', status: approved.data?.status || 'approved',
        proposal_id: candidate.proposal_id, reviewer: 'human_fixture'
      });
      return request(`/api/v2/memory-review/proposals?opportunity_id=${encodeURIComponent(context.opportunityId)}`, { headers });
    }

    function report() {
      const executableTypes = new Set(events.map(event => event.type));
      const failed = events.some(event => ['unsupported', 'failed'].includes(event.status));
      const notExecuted = events.some(event => event.status === 'not_executed');
      // Gateway execution only prepares the declared preconditions. It must
      // never masquerade as the independent deterministic fixture verdict
      // consumed by evaluation-outcomes.mjs.
      const status = plan.fixture_required
        ? (failed ? 'failed' : notExecuted || events.length === 0 ? 'not_executed' : 'prepared')
        : (events.length ? 'applied' : 'not_required');
      return { case_id: input.case_id || null, ...plan, status, executed_setup_types: [...executableTypes], events: [...events] };
    }

    return { plan, afterCustomerCreated, afterMemory, report };
  };
}

export const __test = { SETUP_TYPE_RULES, BUILTIN_SETUP_TYPES, inferPurpose };
