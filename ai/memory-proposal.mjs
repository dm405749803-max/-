import { isDirectHumanRequest, isMarketingOptOutRequest, isProductActionQuestion } from './customer-signals.mjs';

const SCHEMA_VERSION = 'memory-proposal.v1';
const INPUT_SCHEMA_VERSION = 'sales-assist.v1';
const ENVIRONMENTS = new Set(['real', 'simulation']);
const SALES_MEMORY_STATES = new Set(['manually_confirmed_sent', 'provider_confirmed_sent', 'simulated_sent']);
const NON_CONFIRMING = /(?:不想|不要|还没|没有决定|没决定|只是(?:比较|看看)|先看看|再看看|不确定|还不确定|可能|也许|暂时不|并非|不是)/i;
const DIRECT_CONSTRAINT_FIELD = /^(?:contact_preference|marketing_opt_out|liquidity_constraint)$/;
// Uncertainty about a choice must not erase independent profile facts from the
// same message. For example, in “58岁，预算2万，先看看方案” only the
// commitment is tentative; age and budget are still explicit facts.
const COMMITMENT_FIELD = /(?:^|_)(?:payment_term|product_choice|product_selection|selected_product|purchase_commitment|purchase_decision|decision_timing|purchase_timing|confirmed_plan|chosen_plan)(?:_|$)/;
const FIELD_NAME = /^[a-z][a-z0-9_]{0,63}$/;

function text(value, max = 4000) {
  return String(value ?? '').trim().slice(0, max);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function emptySummary() {
  return { text: '', through_message_id: null, evidence_message_ids: [], open_objections: [], promises: [] };
}

function emptyIntent() {
  return { level: 'unknown', score: 0, signals: [], reason: '证据不足，暂不判定意向', recommended_action: 'continue_discovery', evidence_message_ids: [] };
}

// Intent is operational state, not free-form copy. Keep a deterministic floor
// for explicit customer signals so a model cannot turn “今天决定” into low intent,
// or continue discovery after the customer asks for a human or opts out.
export function deterministicIntent(messages) {
  const customer = messages.filter(message => message.role === 'customer');
  const latest = customer.at(-1);
  if (!latest) return null;
  const body = latest.text;
  const build = (level, score, reason, recommendedAction, type, weight = score, preserveCurrent = false) => ({
    level,
    score,
    reason,
    recommended_action: recommendedAction,
    preserve_current: preserveCurrent,
    evidence_message_ids: [latest.message_id],
    signals: [{ type, weight, evidence_message_ids: [latest.message_id] }]
  });
  if (isMarketingOptOutRequest(body)) {
    return build('low', 0, 'marketing_opt_out', 'stop_marketing', 'marketing_opt_out', -100);
  }
  if (isDirectHumanRequest(body)) {
    return build('unknown', 0, 'requested_human_contact', 'human_close', 'requested_human_contact', 0, true);
  }
  if (/(?:如果)?今天决定.{0,16}(?:手续|办理|怎么办)|(?:手续|办理).{0,12}今天/.test(body)) {
    return build('high', 90, 'immediate_purchase_action', 'human_close', 'decision_timing', 45);
  }
  const asksForPlan = /(?:具体)?(?:计划书|方案|测算|报价)/.test(body);
  const suppliesAge = /(?:今年|现在|大概|差不多)?\s*\d{1,3}\s*岁/.test(body);
  const suppliesBudget = /(?:预算|保费|每年|一年|每月|一个月)[^\n，。；;]{0,12}\d+(?:\.\d+)?\s*(?:万|千|元)|\d+(?:\.\d+)?\s*(?:万|千|元)[^\n，。；;]{0,8}(?:每年|一年|预算|保费)/.test(body);
  if (asksForPlan && suppliesAge && suppliesBudget) {
    return build('high', 85, 'plan_requested_with_profile', 'human_close', 'plan_request', 40);
  }
  if (/(?:家里)?暂时不考虑(?:了)?|先不考虑/.test(body)) {
    return build('low', 10, 'interest_paused', 'follow_up', 'interest_paused', -35);
  }
  if (/(?:明年|下半年|过几个月).{0,10}(?:再)?考虑/.test(body)) {
    return build('medium', 50, 'future_follow_up_timing', 'follow_up', 'future_timing', 20);
  }
  if (/(?:跟|和).{0,4}(?:家人|爱人|配偶|老婆|老公|妻子|丈夫).{0,6}(?:商量|讨论).{0,16}(?:过段时间|以后|之后|再)(?:联系|说|聊)?/.test(body)) {
    return build('medium', 55, 'joint_decision_pending', 'follow_up', 'joint_decision_pending', -10);
  }
  if (isProductActionQuestion(body)) {
    return build('medium', 65, 'product_action_questions', 'human_close', 'product_detail_interest', 30);
  }
  if (/(?:给|帮)(?:我)?(?:妈妈|母亲).{0,12}养老/.test(body) && /(?:不愿|不想|先不).{0,8}(?:说|透露)?预算/.test(body)) {
    return build('medium', 45, 'need_known_budget_deferred', 'continue_discovery', 'need_known', 20);
  }
  if (/^(?:随便|先)?看看[!！。]?$/i.test(body)) {
    return build('low', 10, 'browsing_only', 'continue_discovery', 'browsing_only', 5);
  }
  return null;
}

function baseResult(context, overrides = {}) {
  return {
    schema_version: SCHEMA_VERSION,
    status: 'error',
    facts: [],
    summary: emptySummary(),
    intent: emptyIntent(),
    context_versions: context?.context_versions && typeof context.context_versions === 'object'
      ? { ...context.context_versions }
      : {},
    review_required: true,
    risk_flags: [],
    missing_evidence: [],
    trace: { provider: '', workflow_run_id: null },
    ...overrides
  };
}

function contextProblem(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return 'context_not_object';
  if (context.schema_version !== INPUT_SCHEMA_VERSION) return 'unsupported_context_schema';
  for (const field of ['workspace_id', 'customer_id', 'opportunity_id', 'latest_message_id']) {
    if (!text(context[field], 160)) return `missing_${field}`;
  }
  if (!ENVIRONMENTS.has(context.environment)) return 'invalid_environment';
  if (!Array.isArray(context.recent_messages)) return 'recent_messages_not_array';
  if (!context.context_versions || typeof context.context_versions !== 'object') return 'missing_context_versions';
  if (text(context.context_versions.latest_message_id, 160) !== text(context.latest_message_id, 160)) return 'latest_customer_message_changed';
  return null;
}

function eligibleMessages(context) {
  const result = [];
  const seen = new Set();
  for (const item of context.recent_messages) {
    if (!item || typeof item !== 'object') continue;
    const messageId = text(item.message_id, 160);
    const body = text(item.text, 6000);
    if (!messageId || !body || seen.has(messageId)) continue;
    if (item.environment !== undefined && item.environment !== context.environment) continue;
    if (item.opportunity_id !== undefined && item.opportunity_id !== context.opportunity_id) continue;
    if (item.customer_id !== undefined && item.customer_id !== context.customer_id) continue;
    if (item.workspace_id !== undefined && item.workspace_id !== context.workspace_id) continue;
    const customer = item.role === 'customer' && item.status === 'received';
    const sales = item.role === 'sales'
      && SALES_MEMORY_STATES.has(item.status)
      && (item.status !== 'simulated_sent' || context.environment === 'simulation');
    if (!customer && !sales) continue;
    seen.add(messageId);
    result.push({
      message_id: messageId,
      role: item.role,
      text: body,
      status: item.status,
      source: text(item.source, 120) || null,
      occurred_at: text(item.occurred_at, 120) || null
    });
  }
  return result;
}

function unwrapDify(raw) {
  const payload = raw?.data?.outputs ?? raw?.outputs ?? raw;
  if (typeof payload === 'string') {
    try { return JSON.parse(payload); } catch { return null; }
  }
  const resultJson = payload?.result_json ?? payload?.proposal_result_json ?? payload?.blocked_result_json;
  if (typeof resultJson === 'string') {
    try { return { ...payload, ...JSON.parse(resultJson) }; } catch { return null; }
  }
  return payload && typeof payload === 'object' ? payload : null;
}

function primitiveValue(value) {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean';
}

function stringList(value, maxItems = 20, maxLength = 500) {
  if (!Array.isArray(value)) return [];
  return unique(value.map(item => text(item, maxLength))).slice(0, maxItems);
}

function evidenceCheck(ids, evidence, order, throughIndex = Number.POSITIVE_INFINITY) {
  if (!Array.isArray(ids) || !ids.length) return { error: 'evidence_required' };
  const normalized = unique(ids.map(id => text(id, 160)));
  if (!normalized.length || normalized.length !== ids.length) return { error: 'evidence_invalid' };
  const messages = [];
  for (const id of normalized) {
    const message = evidence.get(id);
    if (!message) return { error: 'evidence_out_of_scope' };
    if ((order.get(id) ?? Number.POSITIVE_INFINITY) > throughIndex) return { error: 'evidence_after_summary_boundary' };
    messages.push(message);
  }
  if (!messages.some(message => message.role === 'customer')) return { error: 'customer_evidence_required' };
  return { ids: normalized, messages };
}

function moneyAmount(value, unit) {
  const chinese = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const number = Object.hasOwn(chinese, String(value)) ? chinese[String(value)] : Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.round(number * (unit === '万' ? 10_000 : unit === '千' ? 1_000 : 1));
}

// Dify may phrase the same profile data with different field names. This
// deterministic layer adds a small canonical contract used by B2 and by the
// human profile-review card. It only reads explicit customer text and always
// keeps the supporting message id.
function canonicalProfileFacts(messages, context) {
  const facts = new Map();
  let activeRelationship = null;
  let previousBudget = null;
  const previousAgeByRelationship = new Map();
  const conflictingAgeRelationships = new Set();
  const relationshipEvidence = new Map();
  const relationshipOrder = [];
  const normalizedRelationship = value => ({
    self: 'self', '本人': 'self', mother: 'mother', '妈妈': 'mother', '母亲': 'mother',
    father: 'father', '爸爸': 'father', '父亲': 'father', child: 'child', '孩子': 'child',
    son: 'son', '儿子': 'son', daughter: 'daughter', '女儿': 'daughter', spouse: 'spouse', '配偶': 'spouse'
  })[String(value || '').trim()] || null;
  const personIdFor = relationship => {
    const person = (Array.isArray(context.persons) ? context.persons : []).find(item =>
      normalizedRelationship(item?.relationship ?? item?.relationship_to_customer) === relationship);
    return person?.person_id ? text(person.person_id, 160) : null;
  };
  const put = (field, value, messageId, personId = null) => facts.set(`${field}\u0000${personId || ''}`, {
    field, value, person_id: personId, opportunity_id: context.opportunity_id,
    evidence_message_ids: [messageId], status: 'proposed'
  });
  for (const message of messages) {
    if (message.role !== 'customer') continue;
    const body = message.text;
    let explicitRelationship = null;
    if (/(?:给|帮)(?:我)?(?:妈妈|母亲)|主要是给(?:我)?(?:妈妈|母亲)|我(?:妈妈|母亲|妈)(?:今年)?/.test(body)) explicitRelationship = 'mother';
    else if (/(?:给|帮)(?:我)?(?:爸爸|父亲)|主要是给(?:我)?(?:爸爸|父亲)|我(?:爸爸|父亲|爸)(?:今年)?/.test(body)) explicitRelationship = 'father';
    else if (/(?:给|帮)(?:我)?(?:孩子|小孩|儿子|女儿)|我(?:孩子|小孩|儿子|女儿)(?:今年)?/.test(body)) explicitRelationship = /女儿/.test(body) ? 'daughter' : /儿子/.test(body) ? 'son' : 'child';
    else if (/(?:给|帮)自己|主要是给自己|我本人/.test(body)) explicitRelationship = 'self';
    if (explicitRelationship) {
      activeRelationship = explicitRelationship;
      if (!relationshipEvidence.has(activeRelationship)) relationshipOrder.push(activeRelationship);
      relationshipEvidence.set(activeRelationship, unique([
        ...(relationshipEvidence.get(activeRelationship) || []), message.message_id
      ]));
    }
    if (activeRelationship) put('insured_person_relationship', activeRelationship, message.message_id, personIdFor(activeRelationship));

    const age = body.match(/(?:今年|其实|她|他|妈妈|母亲|爸爸|父亲|孩子|小孩|儿子|女儿)?\s*(\d{1,3})\s*岁/);
    if (age && activeRelationship && Number(age[1]) <= 120) {
      const value = Number(age[1]);
      const prior = previousAgeByRelationship.get(activeRelationship);
      if (prior && prior.value !== value) {
        conflictingAgeRelationships.add(activeRelationship);
        facts.set(`insured_person_age_conflict\u0000${personIdFor(activeRelationship) || ''}`, {
          field: 'insured_person_age_conflict',
          value: [prior.value, value].sort((left, right) => left - right).join('|'),
          person_id: personIdFor(activeRelationship),
          opportunity_id: context.opportunity_id,
          evidence_message_ids: [prior.message_id, message.message_id],
          status: 'proposed'
        });
      }
      previousAgeByRelationship.set(activeRelationship, { value, message_id: message.message_id });
      if (!conflictingAgeRelationships.has(activeRelationship)) {
        put('insured_person_age', value, message.message_id, personIdFor(activeRelationship));
      } else {
        facts.delete(`insured_person_age\u0000${personIdFor(activeRelationship) || ''}`);
      }
    }

    if (/(?:已经|之前|已).{0,10}(?:买|投保).{0,16}(?:又|另外|现在).{0,12}(?:咨询|了解|准备|想).{0,12}(?:孩子|教育)/.test(body)) put('purpose_code', 'education', message.message_id);
    else if (/养老/.test(body)) put('purpose_code', 'retirement', message.message_id);
    else if (/教育金|大学费用|教育准备/.test(body)) put('purpose_code', 'education', message.message_id);
    else if (/长期储备|长期储蓄|储蓄/.test(body)) put('purpose_code', 'savings', message.message_id);

    const budget = body.match(/每年(?:预算)?(?:大概|约|差不多)?\s*(\d+(?:\.\d+)?)\s*(万|千)?(?:元)?\s*(?:(?:到|至|[-~—])\s*(\d+(?:\.\d+)?)\s*(万|千)?(?:元)?)?/);
    let currentBudget = null;
    if (budget) {
      const minimum = moneyAmount(budget[1], budget[2] || budget[4]);
      const maximum = budget[3] ? moneyAmount(budget[3], budget[4] || budget[2]) : minimum;
      if (minimum !== null) {
        currentBudget = minimum;
        put('annual_budget_amount', minimum, message.message_id);
      }
      if (maximum !== null && maximum !== minimum) put('annual_budget_max', maximum, message.message_id);
    }
    if (!budget && /每年.{0,10}(?:投入|预算|保费)/.test(body)) {
      const approximateBudget = body.match(/(\d+(?:\.\d+)?|[一二两三四五六七八九十])\s*(万|千)?(?:元)?\s*(?:左右|上下|大概|差不多)/);
      const amount = approximateBudget ? moneyAmount(approximateBudget[1], approximateBudget[2]) : null;
      if (amount !== null) {
        currentBudget = amount;
        put('annual_budget_amount', amount, message.message_id);
      }
    }
    if (!budget) {
      const constrainedBudget = body.match(/(?:只能|可以).{0,8}(?:先)?考虑\s*(\d+(?:\.\d+)?|[一二两三四五六七八九十])\s*(万|千)?(?:元)?/);
      const amount = constrainedBudget ? moneyAmount(constrainedBudget[1], constrainedBudget[2]) : null;
      if (amount !== null) {
        currentBudget = amount;
        put('annual_budget_amount', amount, message.message_id);
      }
    }
    if (currentBudget !== null) {
      if (previousBudget && previousBudget.value !== currentBudget) {
        facts.set('previous_annual_budget_amount', {
          field: 'previous_annual_budget_amount', value: previousBudget.value,
          person_id: null, opportunity_id: context.opportunity_id,
          evidence_message_ids: [previousBudget.message_id, message.message_id], status: 'proposed'
        });
        if (message.occurred_at) put('annual_budget_changed_at', message.occurred_at, message.message_id);
      }
      previousBudget = { value: currentBudget, message_id: message.message_id };
    }

    const mentionedAges = [...body.matchAll(/(\d{1,3})\s*岁/g)].map(match => Number(match[1])).filter(age => age <= 120);
    const distinctAges = [...new Set(mentionedAges)];
    if (distinctAges.length > 1 && /(?:一处|另一处|冲突|不一致|说法不同)/.test(body)) {
      if (activeRelationship) conflictingAgeRelationships.add(activeRelationship);
      put('insured_person_age_conflict', distinctAges.sort((a, b) => a - b).join('|'), message.message_id,
        activeRelationship ? personIdFor(activeRelationship) : null);
      if (activeRelationship) facts.delete(`insured_person_age\u0000${personIdFor(activeRelationship) || ''}`);
    }

    if (/我有(?:一|个|一个)?(?:儿子|女儿|孩子|小孩)/.test(body) && !/(?:给|帮).{0,4}(?:儿子|女儿|孩子|小孩)/.test(body)) {
      put('mentioned_family_relationship', /女儿/.test(body) ? 'daughter' : /儿子/.test(body) ? 'son' : 'child', message.message_id);
    }
    if (/(?:先|需要|要|得)?.{0,4}(?:跟|和).{0,3}(?:家人|爱人|配偶|老婆|老公|妻子|丈夫).{0,4}(?:商量|讨论)/.test(body)) {
      put('decision_participant', /(?:家人)/.test(body) ? 'family' : 'spouse', message.message_id);
    }
    if (/健康.{0,12}(?:以后|后面|真要买时|暂时不|先不).{0,8}(?:再聊|再说|不聊)?/.test(body)) {
      put('health_discussion_preference', 'defer', message.message_id);
    }
    if (/(?:先放着|以后再说|暂时不考虑|先不考虑)/.test(body)) {
      put('need_status', 'unclear_deferred', message.message_id);
      // Keep the customer's broad direction without turning it into a
      // confirmed retirement/education need.  This lets sales resume from a
      // useful observation later without inventing a concrete purpose now.
      if (/(?:放着|储备|存着)/.test(body)) {
        put('planning_direction_observation', 'long_term_savings_candidate', message.message_id);
      }
    }

    if (/(?:家里|家庭).{0,6}收入.{0,6}(?:还行|可以|不错|过得去)/.test(body)) {
      // Qualitative wording is deliberately stored as qualitative.  Never
      // infer an annual amount or a high-net-worth label from this phrase.
      put('household_income_observation', 'qualitatively_adequate_unquantified', message.message_id);
    }

    if (/(?:还是老问题|仍然|还是).{0,20}(?:担心|顾虑).{0,10}(?:中途用钱|流动性)/.test(body)) {
      put('liquidity_constraint', 'unresolved_midterm_access_concern', message.message_id);
      put('liquidity_objection_status', 'unresolved', message.message_id);
    }

    if (/(?:不想|不愿).{0,8}(?:长期)?锁住|(?:(?:三|三五|3|3\s*[至到~-]\s*5)年内?).{0,10}(?:可能)?(?:会)?(?:要)?用(?:钱|到)/.test(body)) {
      put('liquidity_constraint', 'may_need_within_3_years', message.message_id);
    }

    const horizon = body.match(/(\d{1,3})\s*年(?:内|后)(?:可能)?(?:会)?(?:不?用|需要用|用到)/);
    if (horizon) put('funds_usage_years', Number(horizon[1]), message.message_id);
  }

  // A correction from one insured person to another is not a replacement of
  // the person's identity. Keep each explicitly mentioned person and age as a
  // separate, reviewable candidate. The review service resolves these
  // relationship-scoped candidates to stable person_ids before activation.
  if (relationshipOrder.length > 1) {
    for (const relationship of relationshipOrder) {
      const relationshipIds = relationshipEvidence.get(relationship) || [];
      const relationshipMessageId = relationshipIds.at(-1);
      if (!relationshipMessageId) continue;
      put(`person_relationship_${relationship}`, relationship, relationshipMessageId);
      const age = previousAgeByRelationship.get(relationship);
      if (age && !conflictingAgeRelationships.has(relationship)) {
        put(`person_age_${relationship}`, age.value, age.message_id);
      }
    }
  }
  return [...facts.values()];
}

function validateOutput(output, context, messages) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return { error: 'dify_output_not_object' };
  const evidence = new Map(messages.map(message => [message.message_id, message]));
  const order = new Map(messages.map((message, index) => [message.message_id, index]));
  const rawIntent = output.intent && typeof output.intent === 'object' && !Array.isArray(output.intent)
    ? output.intent
    : {};
  const level = ['unknown', 'low', 'medium', 'high'].includes(rawIntent.level) ? rawIntent.level : 'unknown';
  const score = Number.isFinite(Number(rawIntent.score)) ? Math.max(0, Math.min(100, Math.round(Number(rawIntent.score)))) : 0;
  const action = ['continue_discovery', 'follow_up', 'human_close', 'stop_marketing'].includes(rawIntent.recommended_action)
    ? rawIntent.recommended_action
    : 'continue_discovery';
  const intentEvidence = Array.isArray(rawIntent.evidence_message_ids) && rawIntent.evidence_message_ids.length
    ? evidenceCheck(rawIntent.evidence_message_ids, evidence, order)
    : { ids: [] };
  const intent = intentEvidence.error ? emptyIntent() : {
    level,
    score,
    signals: Array.isArray(rawIntent.signals) ? rawIntent.signals.slice(0, 12).map(item => ({
      type: text(item?.type, 80),
      weight: Number.isFinite(Number(item?.weight)) ? Math.max(-100, Math.min(100, Math.round(Number(item.weight)))) : 0,
      evidence_message_ids: Array.isArray(item?.evidence_message_ids)
        ? unique(item.evidence_message_ids.map(id => text(id, 160))).filter(id => evidence.has(id))
        : []
    })).filter(item => item.type) : [],
    reason: text(rawIntent.reason, 500) || '暂无明确购买行动信号',
    recommended_action: action,
    preserve_current: rawIntent.preserve_current === true,
    evidence_message_ids: intentEvidence.ids
  };
  if (output.status === 'insufficient_evidence'
      && (!Array.isArray(output.facts) || output.facts.length === 0)
      && !text(output.summary?.text, 5000)) {
    return { insufficient: true, missing_evidence: stringList(output.missing_evidence, 20, 160), intent };
  }
  if (output.status !== undefined && output.status !== 'proposed') return { error: 'dify_status_not_proposed', intent };
  const personIds = new Set((Array.isArray(context.persons) ? context.persons : [])
    .map(person => text(person?.person_id, 160)).filter(Boolean));
  const currentPersonIds = new Set((Array.isArray(context.person_ids) ? context.person_ids : [])
    .map(personId => text(personId, 160)).filter(Boolean));
  const rawFacts = Array.isArray(output.facts) ? output.facts : [];
  if (rawFacts.length > 20) return { error: 'too_many_facts' };
  const facts = [];
  for (const item of rawFacts) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { error: 'fact_not_object' };
    const field = text(item.field, 64);
    if (!FIELD_NAME.test(field)) return { error: 'fact_field_invalid' };
    if (!primitiveValue(item.value)) return { error: 'fact_value_invalid' };
    const personId = item.person_id == null ? null : text(item.person_id, 160);
    if (personId && (!personIds.has(personId) || !currentPersonIds.has(personId))) return { error: 'fact_person_out_of_scope' };
    if (text(item.opportunity_id, 160) !== text(context.opportunity_id, 160)) return { error: 'fact_opportunity_out_of_scope' };
    const checked = evidenceCheck(item.evidence_message_ids, evidence, order);
    if (checked.error) return { error: `fact_${checked.error}` };
    if (COMMITMENT_FIELD.test(field) && !DIRECT_CONSTRAINT_FIELD.test(field)
        && checked.messages.every(message => message.role !== 'customer' || NON_CONFIRMING.test(message.text))) {
      return { error: 'fact_evidence_not_confirming' };
    }
    facts.push({
      field,
      value: typeof item.value === 'string' ? text(item.value, 1000) : item.value,
      person_id: personId,
      opportunity_id: context.opportunity_id,
      evidence_message_ids: checked.ids,
      status: 'proposed'
    });
  }
  for (const fact of canonicalProfileFacts(messages, context)) {
    const duplicate = facts.findIndex(item => item.field === fact.field && item.person_id === fact.person_id);
    if (duplicate >= 0) facts[duplicate] = fact;
    else if (facts.length < 20) facts.push(fact);
  }
  // A conflict marker and a fixed age are mutually exclusive. Provider output
  // sometimes proposes both; retain the uncertainty and remove only the age
  // candidates in the same person scope (or unscoped ages when no person is
  // known), instead of silently choosing the provider's last value.
  const ageConflicts = facts.filter(item => item.field === 'insured_person_age_conflict');
  for (let index = facts.length - 1; index >= 0; index -= 1) {
    const fact = facts[index];
    if (fact.field === 'insured_person_age_conflict' || /^person_age_/.test(fact.field)) continue;
    if (!/(?:^|_)(?:age|insured_person_age|daughter_age|son_age|child_age|parent_age|spouse_age)(?:_|$)/.test(fact.field)) continue;
    if (ageConflicts.some(conflict => (conflict.person_id || null) === (fact.person_id || null))) facts.splice(index, 1);
  }
  // The provider may emit several aliases for the same business concept. Once
  // a deterministic canonical field exists, keep one field only so the review
  // card and downstream B2 never see duplicate/contradictory profile slots.
  const canonicalFields = new Set(facts.map(item => item.field));
  const redundantAliases = new Map([
    ['annual_budget', 'annual_budget_amount'], ['budget', 'annual_budget_amount'], ['budget_amount', 'annual_budget_amount'],
    ['product_interest', 'purpose_code'], ['interest_area', 'purpose_code'], ['interest_topic', 'purpose_code'], ['topic_interest', 'purpose_code'],
    ['relationship', 'insured_person_relationship'], ['insured_person', 'insured_person_relationship']
  ]);
  for (let index = facts.length - 1; index >= 0; index -= 1) {
    const canonicalField = redundantAliases.get(facts[index].field);
    if (canonicalField && canonicalFields.has(canonicalField)) facts.splice(index, 1);
  }

  const rawSummary = output.summary && typeof output.summary === 'object' && !Array.isArray(output.summary)
    ? output.summary
    : {};
  const summaryText = text(rawSummary.text, 5000);
  let summary = emptySummary();
  if (summaryText) {
    const throughMessageId = text(rawSummary.through_message_id, 160);
    const throughIndex = order.get(throughMessageId);
    if (throughIndex === undefined) return { error: 'summary_boundary_out_of_scope' };
    const checked = evidenceCheck(rawSummary.evidence_message_ids, evidence, order, throughIndex);
    if (checked.error) return { error: `summary_${checked.error}` };
    summary = {
      text: summaryText,
      through_message_id: throughMessageId,
      evidence_message_ids: checked.ids,
      open_objections: stringList(rawSummary.open_objections, 20, 300),
      promises: stringList(rawSummary.promises, 20, 300)
    };
  } else if (rawSummary.through_message_id || (Array.isArray(rawSummary.evidence_message_ids) && rawSummary.evidence_message_ids.length)) {
    return { error: 'summary_text_required' };
  }

  if (!summary.text) {
    if (!facts.length) return { insufficient: true };
    return { error: 'summary_required_for_proposal' };
  }
  if (intentEvidence.error) return { error: `intent_${intentEvidence.error}` };
  return { facts, summary, intent };
}

export async function proposeMemory(context, dependencies = {}) {
  const problem = contextProblem(context);
  if (problem) {
    return baseResult(context, {
      status: problem === 'latest_customer_message_changed' ? 'stale_context' : 'invalid_context',
      missing_evidence: [problem],
      risk_flags: problem === 'latest_customer_message_changed' ? ['context_changed'] : []
    });
  }
  const messages = eligibleMessages(context);
  if (!messages.length || !messages.some(message => message.role === 'customer')) {
    return baseResult(context, { status: 'invalid_context', missing_evidence: ['no_eligible_customer_evidence'] });
  }
  if (!messages.some(message => message.message_id === context.latest_message_id && message.role === 'customer')) {
    return baseResult(context, { status: 'invalid_context', missing_evidence: ['latest_customer_evidence_missing'] });
  }
  if (typeof dependencies.runDify !== 'function') {
    return baseResult(context, {
      status: 'unavailable',
      missing_evidence: ['dify_memory_not_configured'],
      trace: { provider: 'unconfigured', workflow_run_id: null }
    });
  }

  let raw;
  try {
    raw = await dependencies.runDify({
      inputs: {
        schema_version: SCHEMA_VERSION,
        context_json: JSON.stringify({
          workspace_id: context.workspace_id,
          trace_id: context.trace_id || null,
          session_id: context.session_id || null,
          evaluation: context.evaluation || null,
          customer_id: context.customer_id,
          opportunity_id: context.opportunity_id,
          latest_message_id: context.latest_message_id,
          environment: context.environment,
          persons: Array.isArray(context.persons) ? context.persons : [],
          person_ids: Array.isArray(context.person_ids) ? context.person_ids : [],
          confirmed_facts: Array.isArray(context.confirmed_facts) ? context.confirmed_facts.filter(fact => fact?.status === 'confirmed'
            && (!fact.opportunity_id || fact.opportunity_id === context.opportunity_id)) : [],
          long_term_summary: context.long_term_summary || emptySummary(),
          product_scope: context.product_scope || {},
          context_window: context.context_window || null,
          context_versions: context.context_versions,
          messages
        })
      },
      user: `workspace:${text(context.workspace_id, 160)}:customer:${text(context.customer_id, 160)}`
    });
  } catch (error) {
    return baseResult(context, {
      status: 'error',
      missing_evidence: [error?.code || 'dify_memory_call_failed'],
      trace: { provider: 'dify-memory', workflow_run_id: null }
    });
  }

  const output = unwrapDify(raw);
  const intentFloor = deterministicIntent(messages);
  let recoveredFromMalformedOutput = false;
  let checked;
  if (!output) {
    const canonical = canonicalProfileFacts(messages, context);
    const customerEvidence = messages.filter(message => message.role === 'customer');
    if ((canonical.length || intentFloor) && customerEvidence.length) {
      const last = customerEvidence.at(-1);
      checked = validateOutput({
        status: 'proposed',
        facts: [],
        summary: {
          text: customerEvidence.map(message => message.text).join('；').slice(0, 5000),
          through_message_id: last.message_id,
          evidence_message_ids: customerEvidence.map(message => message.message_id),
          open_objections: [],
          promises: []
        },
        intent: intentFloor || emptyIntent()
      }, context, messages);
      recoveredFromMalformedOutput = !checked.error;
    } else checked = { error: 'dify_output_not_object' };
  } else checked = validateOutput(output, context, messages);
  // Explicit deterministic intent may recover a provider that admits it has
  // insufficient evidence. It must not hide a structurally invalid or
  // contradictory provider payload unless we also have canonical facts that
  // can safely replace that payload.
  if (checked.insufficient || (checked.error && canonicalProfileFacts(messages, context).length)) {
    const canonical = canonicalProfileFacts(messages, context);
    const customerEvidence = messages.filter(message => message.role === 'customer');
    if ((canonical.length || intentFloor) && customerEvidence.length) {
      const last = customerEvidence.at(-1);
      const recovered = validateOutput({
        status: 'proposed',
        facts: canonical,
        summary: {
          text: customerEvidence.map(message => message.text).join('；').slice(0, 5000),
          through_message_id: last.message_id,
          evidence_message_ids: customerEvidence.map(message => message.message_id),
          open_objections: [],
          promises: []
        },
        intent: intentFloor || emptyIntent()
      }, context, messages);
      if (!recovered.error) {
        checked = recovered;
        recoveredFromMalformedOutput = true;
      }
    }
  }
  if (!checked.error && !checked.insufficient && intentFloor) checked.intent = intentFloor;
  const workflowRunId = text(raw?.workflow_run_id || raw?.data?.id || raw?.id || output?.workflow_run_id, 200) || null;
  const trace = {
    provider: text(output?.provider, 120) || 'dify-memory-deepseek',
    workflow_run_id: workflowRunId
  };
  if (!checked.error && !checked.insufficient && checked.facts?.some(fact => fact.field === 'decision_participant' && ['spouse', 'family'].includes(fact.value))) {
    const evidenceIds = unique(checked.facts.filter(fact => fact.field === 'decision_participant').flatMap(fact => fact.evidence_message_ids || []));
    checked.intent = {
      ...checked.intent,
      level: checked.intent?.level === 'high' ? 'high' : 'low',
      reason: 'joint_decision_pending',
      recommended_action: 'follow_up',
      evidence_message_ids: evidenceIds,
      signals: [...(checked.intent?.signals || []), { type: 'joint_decision_pending', weight: -10, evidence_message_ids: evidenceIds }]
    };
  }
  if (checked.error) {
    return baseResult(context, {
      status: 'invalid_output',
      missing_evidence: [checked.error],
      risk_flags: ['invalid_dify_memory_output'],
      intent: checked.intent || emptyIntent(),
      trace
    });
  }
  if (checked.insufficient) {
    return baseResult(context, {
      status: 'insufficient_evidence',
      missing_evidence: checked.missing_evidence?.length ? checked.missing_evidence : ['no_memory_proposal'],
      intent: checked.intent || emptyIntent(),
      trace
    });
  }
  return baseResult(context, {
    status: 'proposed',
    facts: checked.facts,
    summary: checked.summary,
    intent: checked.intent,
    risk_flags: recoveredFromMalformedOutput ? ['dify_memory_output_recovered'] : [],
    trace: recoveredFromMalformedOutput ? { ...trace, provider: 'deterministic-profile-fallback' } : trace
  });
}

export const __test = {
  contextProblem,
  eligibleMessages,
  unwrapDify,
  validateOutput,
  evidenceCheck,
  canonicalProfileFacts,
  deterministicIntent
};
