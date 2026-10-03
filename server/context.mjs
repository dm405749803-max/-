import { selectContextMessages } from './memory-policy.mjs';

const parse = (value, fallback) => {
  try { return value == null ? fallback : JSON.parse(value); } catch { return fallback; }
};

function recentConversation(messages, options = {}) { return selectContextMessages(messages, options).messages; }

export function buildContext(store, workspaceId, opportunityId, options = {}) {
  const { one, all, ensureOpportunity } = store._helpers;
  const opportunity = ensureOpportunity(workspaceId, opportunityId);
  const customer = one('SELECT * FROM customers WHERE workspace_id=? AND customer_id=?', workspaceId, opportunity.customer_id);
  const messages = all('SELECT * FROM messages WHERE workspace_id=? AND opportunity_id=? ORDER BY occurred_at,created_at,rowid', workspaceId, opportunityId);
  const selection = selectContextMessages(messages, { ...options, environment: opportunity.environment });
  const latest = selection.latestCustomer;
  const persons = all('SELECT * FROM persons WHERE workspace_id=? AND customer_id=? ORDER BY created_at', workspaceId, opportunity.customer_id).map(row => ({
    person_id: row.person_id, name: row.name, relationship: row.relationship, attributes: parse(row.attributes, {}), revision: row.revision
  }));
  const facts = all("SELECT * FROM facts WHERE workspace_id=? AND customer_id=? AND status='confirmed' AND (opportunity_id IS NULL OR opportunity_id=?) ORDER BY recorded_at", workspaceId, opportunity.customer_id, opportunityId).map(row => ({
    fact_id: row.fact_id, field: row.field, value: parse(row.value, null), person_id: row.person_id,
    opportunity_id: row.opportunity_id, evidence_message_ids: parse(row.evidence_message_ids, []), status: row.status, recorded_at: row.recorded_at
  }));
  const summary = one("SELECT * FROM summaries WHERE workspace_id=? AND opportunity_id=? AND status='confirmed' ORDER BY created_at DESC,rowid DESC LIMIT 1", workspaceId, opportunityId);
  const relatedOpportunities = all(`SELECT * FROM opportunities
    WHERE workspace_id=? AND customer_id=? AND opportunity_id<>?
    ORDER BY updated_at DESC LIMIT 10`, workspaceId, opportunity.customer_id, opportunityId).map(row => {
    const relatedSummary = one("SELECT * FROM summaries WHERE workspace_id=? AND opportunity_id=? AND status='confirmed' ORDER BY created_at DESC,rowid DESC LIMIT 1", workspaceId, row.opportunity_id);
    return {
      opportunity_id: row.opportunity_id,
      purpose: row.purpose,
      sales_stage: row.sales_stage || 'new_contact',
      processing_status: row.processing_status || 'normal',
      purchased: Boolean(row.purchased),
      summary: relatedSummary?.text || '',
      updated_at: row.updated_at
    };
  });
  const plan = one("SELECT * FROM plans WHERE workspace_id=? AND opportunity_id=? AND confirmation_status='confirmed' AND stale=0 ORDER BY plan_version DESC,created_at DESC LIMIT 1", workspaceId, opportunityId);
  return {
    schema_version: 'sales-assist.v1',
    workspace_id: workspaceId,
    customer_id: opportunity.customer_id,
    opportunity_id: opportunityId,
    environment: opportunity.environment,
    person_ids: parse(opportunity.person_ids, []),
    latest_message_id: latest.message_id,
    latest_message: latest.text,
    trace_id: latest.trace_id || options.traceId || null,
    session_id: latest.session_id || options.sessionId || null,
    evaluation: {
      case_id: options.caseId || null,
      eval_run_id: options.evalRunId || null
    },
    contact_state: {
      marketing_opt_out: Boolean(customer.marketing_opt_out),
      human_handoff: Boolean(customer.human_handoff || opportunity.human_handoff),
      purchased_for_opportunity: Boolean(opportunity.purchased)
    },
    customer_state: {
      sales_stage: opportunity.sales_stage || 'new_contact',
      intent_level: opportunity.intent_level || 'unknown',
      intent_score: Number(opportunity.intent_score) || 0,
      intent_reason: opportunity.intent_reason || null,
      processing_status: opportunity.processing_status || 'normal',
      intent_updated_at: opportunity.intent_updated_at || null
    },
    persons,
    need_profile: {
      purpose: opportunity.purpose,
      budget_amount: opportunity.budget_amount,
      budget_currency: opportunity.budget_currency,
      person_ids: parse(opportunity.person_ids, []),
      provenance: 'opportunity_record'
    },
    confirmed_facts: facts,
    recent_messages: selection.messages,
    related_history_messages: selection.relatedHistory,
    related_opportunities: relatedOpportunities,
    context_window: selection.window,
    long_term_summary: summary ? {
      text: summary.text, through_message_id: summary.through_message_id,
      evidence_message_ids: parse(summary.evidence_message_ids, [])
    } : { text: '', through_message_id: null, evidence_message_ids: [] },
    open_objections: summary ? parse(summary.open_objections, []) : [],
    promises: summary ? parse(summary.promises, []) : [],
    product_scope: {
      product_id: opportunity.product_id || '', product_version: opportunity.product_version || '',
      policy_contract_version: opportunity.policy_contract_version, as_of: options.asOf || new Date().toISOString()
    },
    verified_plan: plan ? {
      plan_id: plan.plan_id, plan_version: plan.plan_version, condition_snapshot: parse(plan.condition_snapshot, {}),
      annual_data: parse(plan.annual_data, []), sources: parse(plan.sources, [])
    } : null,
    context_versions: {
      customer_revision: customer.revision, opportunity_revision: opportunity.revision,
      profile_version: customer.profile_version, latest_message_id: latest.message_id,
      latest_conversation_message_id: selection.latestConversation.message_id
    }
  };
}

export { recentConversation };
