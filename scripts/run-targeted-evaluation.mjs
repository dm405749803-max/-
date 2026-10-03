import { readFile } from 'node:fs/promises';
import { createEvaluationGateway } from '../server/evaluation-gateway.mjs';

const ids = process.argv.slice(2);
if (!ids.length) throw new Error('Usage: node scripts/run-targeted-evaluation.mjs <case-id> [...]');

const dataset = JSON.parse(await readFile(new URL('../evaluation/sales-v1.3-cases.json', import.meta.url), 'utf8'));
const byId = new Map(dataset.cases.map(item => [item.id, item]));
const gateway = createEvaluationGateway({ baseUrl: process.env.BACKEND_ROOT || 'http://127.0.0.1:8833' });
const evalRunId = process.env.EVAL_RUN_ID || `targeted-${new Date().toISOString().replace(/\W/g, '').slice(0, 14)}`;

const results = [];
for (const id of ids) {
  const item = byId.get(id);
  if (!item) throw new Error(`Unknown case: ${id}`);
  const result = await gateway({
    case_id: item.id,
    customer_input: item.suggested_input,
    product_id: item.product_id,
    product_version: item.product_version,
    execution_support: item.execution_support,
    fixture_type: item.fixture_type,
    setup: item.setup,
    setup_instructions: item.setup_instructions,
    eval_run_id: evalRunId
  });
  results.push({
    case_id: id,
    actual_response: result.actual_response,
    draft_status: result.draft_status,
    route: result.route,
    blocking_gate: result.blocking_gate,
    next_action: result.next_action,
    business_events: result.business_events,
    risk_flags: result.risk_flags,
    citations: result.citations.map(item => ({ document_id: item.document_id, version: item.version, location: item.location })),
    b1_facts: (result.modules?.b1?.proposal_details || []).flatMap(item => item.facts || []),
    task_count: result.tasks.length,
    tasks: result.tasks.map(task => ({ title: task.title, owner: task.owner, status: task.status, due_at: task.due_at })),
    contact_state: result.customer_state?.contact_state || null,
    processing_status: result.customer_state?.processing_status || null,
    risky_promise_detected: result.checks.risky_promise_detected,
    evaluation_fixture: result.evaluation_fixture
  });
}

console.log(JSON.stringify({ eval_run_id: evalRunId, results }, null, 2));
