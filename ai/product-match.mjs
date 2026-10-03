const SCHEMA_VERSION = 'product-match.v1';
const INPUT_SCHEMA_VERSION = 'sales-assist.v1';
const RULES_SCHEMA_VERSION = 'product-match-rules.v1';
const ENVIRONMENTS = new Set(['real', 'simulation']);
const RULE_STATUSES = new Set(['eligible_for_discussion', 'not_matched', 'needs_information']);
const EVALUATION_STATUSES = new Set(['evaluated', 'needs_source', 'human_required']);
const OVERCLAIM = /(?:保证[^，。；;]{0,12}(?:收益|回本|理赔|承保)|保本保收益|稳赚|零风险|一定适合|最适合|百分之百|100%)/i;

function text(value, max = 4000) {
  return String(value ?? '').trim().slice(0, max);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function stringList(value, maxItems = 30, maxLength = 500) {
  if (!Array.isArray(value)) return [];
  return unique(value.map(item => text(item, maxLength))).slice(0, maxItems);
}

function safeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function baseResult(context, overrides = {}) {
  return {
    schema_version: SCHEMA_VERSION,
    status: 'invalid_output',
    candidates: [],
    catalog_fingerprint: null,
    context_versions: safeObject(context?.context_versions),
    profile_snapshot: {},
    missing_fields: [],
    risk_flags: [],
    review_required: true,
    trace: { provider: '', workflow_run_id: null },
    ...overrides
  };
}

function contextProblem(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return 'context_not_object';
  if (context.schema_version !== INPUT_SCHEMA_VERSION) return 'unsupported_context_schema';
  for (const field of ['workspace_id', 'customer_id', 'opportunity_id']) {
    if (!text(context[field], 160)) return `missing_${field}`;
  }
  if (!ENVIRONMENTS.has(context.environment)) return 'invalid_environment';
  if (!context.context_versions || typeof context.context_versions !== 'object' || Array.isArray(context.context_versions)) return 'missing_context_versions';
  const expectedLatest = text(context.context_versions.latest_message_id, 160);
  const latest = text(context.latest_message_id, 160);
  if (expectedLatest && latest && expectedLatest !== latest) return 'latest_message_changed';
  return null;
}

function citationId(citation) {
  if (typeof citation === 'string') return text(citation, 320);
  if (!citation || typeof citation !== 'object' || Array.isArray(citation)) return '';
  const explicit = text(citation.citation_id, 320);
  if (explicit) return explicit;
  const documentId = text(citation.document_id || citation.source_id, 160);
  const location = text(citation.location || citation.section, 160);
  return documentId && location ? `${documentId}#${location}` : documentId;
}

function paymentYears(value) {
  if (!Array.isArray(value)) return [];
  return unique(value.map(Number).filter(item => Number.isInteger(item) && item > 0 && item <= 100)).sort((a, b) => a - b);
}

function normalizeReasons(value, allowedCitations) {
  if (!Array.isArray(value)) return { reasons: [] };
  const reasons = [];
  for (const item of value.slice(0, 20)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { error: 'rule_reason_not_object' };
    const code = text(item.code, 120);
    const message = text(item.message, 500);
    const citationIds = unique((Array.isArray(item.citation_ids) ? item.citation_ids : []).map(value => text(value, 320)));
    if (!code || !message) return { error: 'rule_reason_invalid' };
    if (citationIds.some(id => !allowedCitations.has(id))) return { error: 'rule_reason_citation_out_of_scope' };
    reasons.push({ code, message, citation_ids: citationIds });
  }
  return { reasons };
}

function normalizeRules(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'rules_result_not_object' };
  if (raw.schema_version !== RULES_SCHEMA_VERSION) return { error: 'rules_schema_invalid' };
  if (!EVALUATION_STATUSES.has(raw.status)) return { error: 'rules_status_invalid' };
  const fingerprint = text(raw.catalog_fingerprint, 200);
  if (!fingerprint) return { error: 'catalog_fingerprint_missing' };
  const rawCandidates = Array.isArray(raw.candidates) ? raw.candidates : [];
  if (rawCandidates.length > 20) return { error: 'too_many_rule_candidates' };
  const seen = new Set();
  const candidates = [];
  for (const item of rawCandidates) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { error: 'rule_candidate_not_object' };
    const candidateId = text(item.candidate_id, 160);
    const productId = text(item.product_id, 160);
    const productVersion = text(item.product_version, 160);
    if (!candidateId || seen.has(candidateId)) return { error: 'rule_candidate_id_invalid' };
    if (!productId || !productVersion) return { error: 'rule_product_scope_missing' };
    if (!RULE_STATUSES.has(item.status)) return { error: 'rule_candidate_status_invalid' };
    const citations = Array.isArray(item.citations) ? item.citations.slice(0, 20) : [];
    if (item.status !== 'needs_information' && !citations.length) return { error: 'rule_candidate_citations_missing' };
    const allowedCitations = new Set(citations.map(citationId).filter(Boolean));
    const reasons = normalizeReasons(item.reasons, allowedCitations);
    if (reasons.error) return { error: reasons.error };
    seen.add(candidateId);
    candidates.push({
      candidate_id: candidateId,
      product_id: productId,
      product_version: productVersion,
      status: item.status,
      reasons: reasons.reasons,
      missing_fields: stringList(item.missing_fields, 20, 160),
      questions: stringList(item.questions, 10, 500),
      citations,
      allowed_payment_years: paymentYears(item.allowed_payment_years),
      case_references: [],
      explanation: null,
      explanation_citation_ids: [],
      explanation_case_ids: []
    });
  }
  return {
    schema_version: RULES_SCHEMA_VERSION,
    status: raw.status,
    catalog_fingerprint: fingerprint,
    profile_snapshot: safeObject(raw.profile_snapshot),
    candidates,
    missing_fields: stringList(raw.missing_fields, 30, 160),
    risk_flags: stringList(raw.risk_flags, 30, 160)
  };
}

function normalizeCases(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { status: 'invalid', cases: [], rejected: [] };
  const cases = [];
  const seen = new Set();
  for (const item of Array.isArray(raw.cases) ? raw.cases : []) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const caseId = text(item.case_id, 160);
    if (!caseId || seen.has(caseId)) continue;
    const outcome = text(item.outcome, 80);
    const sourceKind = text(item.source_kind, 80);
    if (!outcome || !sourceKind) continue;
    seen.add(caseId);
    cases.push({
      case_id: caseId,
      outcome,
      similarities: stringList(item.similarities, 20, 300),
      differences: stringList(item.differences, 20, 300),
      reason: text(item.reason, 600) || null,
      source_kind: sourceKind
    });
  }
  return {
    status: text(raw.status, 80) || (cases.length ? 'ready' : 'not_found'),
    cases: cases.slice(0, 10),
    rejected: Array.isArray(raw.rejected) ? raw.rejected.slice(0, 50) : []
  };
}

function deterministicStatus(candidates) {
  if (candidates.some(item => item.status === 'eligible_for_discussion')) return 'ready';
  if (candidates.some(item => item.status === 'needs_information')) return 'needs_information';
  return 'not_matched';
}

function unwrapDify(raw) {
  const payload = raw?.data?.outputs ?? raw?.outputs ?? raw;
  if (typeof payload === 'string') {
    try { return JSON.parse(payload); } catch { return null; }
  }
  const resultJson = payload?.match_result_json ?? payload?.result_json ?? payload?.blocked_result_json;
  if (typeof resultJson === 'string') {
    try { return { ...payload, ...JSON.parse(resultJson) }; } catch { return null; }
  }
  return payload && typeof payload === 'object' ? payload : null;
}

function validateModel(output, candidates) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return { error: 'dify_output_not_object' };
  if (output.status !== 'ready') return { error: 'dify_status_invalid' };
  if (!Array.isArray(output.candidates) || output.candidates.length !== candidates.length) return { error: 'dify_candidate_set_invalid' };
  const rulesById = new Map(candidates.map(item => [item.candidate_id, item]));
  const seen = new Set();
  const explanations = new Map();
  for (const item of output.candidates) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { error: 'dify_candidate_not_object' };
    const candidateId = text(item.candidate_id, 160);
    const rule = rulesById.get(candidateId);
    if (!rule || seen.has(candidateId)) return { error: 'dify_candidate_out_of_scope' };
    if (item.product_id !== undefined && text(item.product_id, 160) !== rule.product_id) return { error: 'dify_product_changed' };
    if (item.product_version !== undefined && text(item.product_version, 160) !== rule.product_version) return { error: 'dify_product_version_changed' };
    if (item.status !== undefined && item.status !== rule.status) return { error: 'dify_rule_status_changed' };
    if (item.allowed_payment_years !== undefined && JSON.stringify(item.allowed_payment_years) !== JSON.stringify(rule.allowed_payment_years)) return { error: 'dify_payment_years_changed' };
    const explanation = text(item.explanation, 1200);
    if (!explanation) return { error: 'dify_explanation_missing' };
    if (OVERCLAIM.test(explanation)) return { error: 'dify_explanation_overclaim' };

    const allowedCitations = new Set(rule.citations.map(citationId).filter(Boolean));
    const citationIds = unique((Array.isArray(item.citation_ids) ? item.citation_ids : []).map(value => text(value, 320)));
    if (allowedCitations.size && !citationIds.length) return { error: 'dify_citation_missing' };
    if (citationIds.some(id => !allowedCitations.has(id))) return { error: 'dify_citation_out_of_scope' };

    const allowedCases = new Set(rule.case_references.map(reference => reference.case_id));
    const caseIds = unique((Array.isArray(item.case_ids) ? item.case_ids : []).map(value => text(value, 160)));
    if (caseIds.some(id => !allowedCases.has(id))) return { error: 'dify_case_out_of_scope' };

    const mentionedYears = [...explanation.matchAll(/(\d{1,3})\s*年交/g)].map(match => Number(match[1]));
    if (mentionedYears.some(year => !rule.allowed_payment_years.includes(year))) return { error: 'dify_payment_year_out_of_scope' };
    seen.add(candidateId);
    explanations.set(candidateId, { explanation, citation_ids: citationIds, case_ids: caseIds });
  }
  return { explanations, provider: text(output.provider, 120) || 'dify-product-match-deepseek' };
}

function safeDifyContext(context, rules) {
  const need = safeObject(context.need_profile);
  const profile = safeObject(rules.profile_snapshot);
  const value = (source, key) => {
    const item = source[key];
    return typeof item === 'string' || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item)) ? item : null;
  };
  return {
    environment: context.environment,
    need_profile: {
      purpose: value(need, 'purpose'),
      budget_amount: value(need, 'budget_amount'),
      budget_currency: value(need, 'budget_currency'),
      fund_use_years: value(need, 'fund_use_years'),
      time_horizon_years: value(need, 'time_horizon_years')
    },
    profile_snapshot: {
      purpose: value(profile, 'purpose'),
      budget_amount: value(profile, 'budget_amount'),
      budget_currency: value(profile, 'budget_currency'),
      insured_age: value(profile, 'insured_age') ?? value(profile, 'age'),
      selected_payment_years: value(profile, 'selected_payment_years'),
      fund_use_years: value(profile, 'fund_use_years'),
      funds_usage_years: value(profile, 'funds_usage_years'),
      requested_payment_years: value(profile, 'requested_payment_years'),
      time_horizon_years: value(profile, 'time_horizon_years')
    }
  };
}

function citationForDify(citation) {
  const source = safeObject(citation);
  return {
    citation_id: citationId(citation),
    label: text(source.label || source.title, 200) || null,
    section: text(source.section || source.location, 200) || null,
    excerpt: text(source.excerpt, 600) || null
  };
}

function rulesForDify(candidates) {
  return candidates.map(item => ({
    candidate_id: item.candidate_id,
    product_id: item.product_id,
    product_version: item.product_version,
    status: item.status,
    reasons: item.reasons,
    missing_fields: item.missing_fields,
    questions: item.questions,
    allowed_payment_years: item.allowed_payment_years,
    citations: item.citations.map(citationForDify)
  }));
}

function casesForDify(candidates) {
  return candidates.map(item => ({ candidate_id: item.candidate_id, cases: item.case_references }));
}

function candidatesForExplanation(candidates) {
  return candidates.filter(item => item.status !== 'not_matched');
}

function deterministicExplanation(candidate) {
  const messages = unique(candidate.reasons.map(item => text(item.message, 500))).slice(0, 3);
  return {
    explanation: messages.join('；') || '已由确定性产品规则判定为不匹配，不进入本轮方案建议。',
    citation_ids: unique(candidate.reasons.flatMap(item => item.citation_ids)).slice(0, 20),
    case_ids: []
  };
}

export async function runProductMatch(context, dependencies = {}) {
  const problem = contextProblem(context);
  if (problem) {
    return baseResult(context, {
      status: problem === 'latest_message_changed' ? 'human_required' : 'invalid_output',
      missing_fields: [problem],
      risk_flags: problem === 'latest_message_changed' ? ['context_changed'] : ['invalid_context'],
      trace: { provider: 'input-gate', workflow_run_id: null }
    });
  }
  if (context.contact_state?.marketing_opt_out === true
      || context.contact_state?.human_handoff === true
      || context.contact_state?.purchased_for_opportunity === true) {
    const reason = context.contact_state.human_handoff
      ? 'human_handoff_active'
      : context.contact_state.marketing_opt_out
        ? 'marketing_opt_out'
        : 'opportunity_already_purchased';
    return baseResult(context, {
      status: 'human_required',
      risk_flags: [reason],
      trace: { provider: 'policy-gate', workflow_run_id: null }
    });
  }
  if (typeof dependencies.evaluateCandidates !== 'function') {
    return baseResult(context, {
      status: 'unavailable',
      missing_fields: ['product_match_rules_not_configured'],
      trace: { provider: 'unconfigured', workflow_run_id: null }
    });
  }

  let evaluatedRaw;
  try {
    evaluatedRaw = await dependencies.evaluateCandidates(context);
  } catch {
    return baseResult(context, {
      status: 'unavailable',
      missing_fields: ['product_match_rules_failed'],
      trace: { provider: 'rules-only', workflow_run_id: null }
    });
  }
  const rules = normalizeRules(evaluatedRaw);
  if (rules.error) {
    return baseResult(context, {
      status: 'invalid_output',
      missing_fields: [rules.error],
      risk_flags: ['invalid_rules_output'],
      trace: { provider: 'rules-only', workflow_run_id: null }
    });
  }
  const common = {
    candidates: rules.candidates,
    catalog_fingerprint: rules.catalog_fingerprint,
    profile_snapshot: rules.profile_snapshot,
    missing_fields: rules.missing_fields,
    risk_flags: rules.risk_flags
  };
  if (rules.status === 'needs_source' || rules.status === 'human_required') {
    return baseResult(context, {
      ...common,
      status: rules.status,
      trace: { provider: 'rules-only', workflow_run_id: null }
    });
  }

  const caseRiskFlags = [];
  if (typeof dependencies.retrieveCases === 'function') {
    for (const candidate of rules.candidates) {
      if (candidate.status !== 'eligible_for_discussion') continue;
      try {
        const result = normalizeCases(await dependencies.retrieveCases(context, candidate));
        if (result.status === 'invalid') caseRiskFlags.push(`case_retrieval_invalid:${candidate.candidate_id}`);
        candidate.case_references = result.cases;
      } catch {
        caseRiskFlags.push(`case_retrieval_failed:${candidate.candidate_id}`);
      }
    }
  }
  common.risk_flags = unique([...common.risk_flags, ...caseRiskFlags]);
  const rulesStatus = deterministicStatus(rules.candidates);
  if (!rules.candidates.length) {
    return baseResult(context, { ...common, status: 'not_matched', trace: { provider: 'rules-only', workflow_run_id: null } });
  }
  const explanationCandidates = candidatesForExplanation(rules.candidates);
  if (!explanationCandidates.length) {
    return baseResult(context, {
      ...common,
      status: rulesStatus,
      candidates: rules.candidates.map(candidate => {
        const explanation = deterministicExplanation(candidate);
        return {
          ...candidate,
          explanation: explanation.explanation,
          explanation_citation_ids: explanation.citation_ids,
          explanation_case_ids: []
        };
      }),
      trace: { provider: 'verified-rules', workflow_run_id: null }
    });
  }
  if (typeof dependencies.runDify !== 'function') {
    return baseResult(context, {
      ...common,
      status: 'unavailable',
      missing_fields: unique([...common.missing_fields, 'dify_product_match_not_configured']),
      trace: { provider: 'rules-only', workflow_run_id: null }
    });
  }

  let raw;
  try {
    raw = await dependencies.runDify({
      observability: {
        workspace_id: context.workspace_id,
        customer_id: context.customer_id,
        opportunity_id: context.opportunity_id,
        latest_message_id: context.latest_message_id || null,
        trace_id: context.trace_id || null,
        session_id: context.session_id || null,
        case_id: context.evaluation?.case_id || null,
        eval_run_id: context.evaluation?.eval_run_id || null
      },
      inputs: {
        schema_version: SCHEMA_VERSION,
        context_json: JSON.stringify(safeDifyContext(context, rules)),
        rules_json: JSON.stringify(rulesForDify(explanationCandidates)),
        cases_json: JSON.stringify(casesForDify(explanationCandidates))
      },
      user: `workspace:${text(context.workspace_id, 160)}:opportunity:${text(context.opportunity_id, 160)}`
    });
  } catch {
    return baseResult(context, {
      ...common,
      status: 'unavailable',
      missing_fields: unique([...common.missing_fields, 'dify_product_match_failed']),
      trace: { provider: 'rules-only', workflow_run_id: null }
    });
  }

  const output = unwrapDify(raw);
  const checked = validateModel(output, explanationCandidates);
  const workflowRunId = text(raw?.workflow_run_id || raw?.data?.id || raw?.id || output?.workflow_run_id, 200) || null;
  if (checked.error) {
    return baseResult(context, {
      ...common,
      status: 'invalid_output',
      missing_fields: unique([...common.missing_fields, checked.error]),
      risk_flags: unique([...common.risk_flags, 'invalid_dify_product_match_output']),
      trace: { provider: text(output?.provider, 120) || 'dify-product-match', workflow_run_id: workflowRunId }
    });
  }
  const candidates = rules.candidates.map(candidate => {
    const explanation = checked.explanations.get(candidate.candidate_id) || deterministicExplanation(candidate);
    return {
      ...candidate,
      explanation: explanation.explanation,
      explanation_citation_ids: explanation.citation_ids,
      explanation_case_ids: explanation.case_ids
    };
  });
  return baseResult(context, {
    ...common,
    status: rulesStatus,
    candidates,
    trace: { provider: checked.provider, workflow_run_id: workflowRunId }
  });
}

export const __test = {
  contextProblem,
  citationId,
  normalizeRules,
  normalizeReasons,
  normalizeCases,
  deterministicStatus,
  unwrapDify,
  validateModel,
  safeDifyContext,
  citationForDify,
  rulesForDify,
  casesForDify,
  candidatesForExplanation,
  deterministicExplanation
};
