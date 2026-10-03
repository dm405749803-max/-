const taskId = process.argv[2];
if (!taskId) throw new Error('Usage: node scripts/analyze-eval-task.mjs <task-id>');

const evalRoot = process.env.EVAL_ROOT || 'http://127.0.0.1:3000';
const backendRoot = process.env.BACKEND_ROOT || 'http://127.0.0.1:8833';
const username = process.env.EVAL_USERNAME || 'admin';
const password = process.env.EVAL_PASSWORD;
if (!password) throw new Error('EVAL_PASSWORD is required');

const login = await fetch(`${evalRoot}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username, password })
});
if (!login.ok) throw new Error(`Eval login failed: HTTP ${login.status}`);
const cookie = login.headers.get('set-cookie')?.split(';')[0];
if (!cookie) throw new Error('Eval login did not return a session cookie');

const resultResponse = await fetch(`${evalRoot}/api/tasks/${encodeURIComponent(taskId)}/results?pageSize=100`, {
  headers: { cookie }
});
const resultPayload = await resultResponse.json();
if (!resultResponse.ok || !resultPayload?.ok) throw new Error('Could not read Eval task results');
const rows = resultPayload.data.rows;

async function loadTrace(row) {
  const traceId = row.outputs?.result?.trace_id || row.outputs?.trace_id;
  if (!traceId) return { row, trace: null };
  const response = await fetch(`${backendRoot}/api/v2/observability/traces/${encodeURIComponent(traceId)}`, {
    headers: { 'x-workspace-id': 'eval_any_agent' }
  });
  const payload = await response.json().catch(() => null);
  return { row, trace: response.ok ? payload?.data : null };
}

const traced = [];
for (let offset = 0; offset < rows.length; offset += 10) {
  traced.push(...await Promise.all(rows.slice(offset, offset + 10).map(loadTrace)));
}

function counts(values) {
  return Object.fromEntries([...values.reduce((map, value) => {
    const key = value == null || value === '' ? 'null' : String(value);
    map.set(key, (map.get(key) || 0) + 1);
    return map;
  }, new Map())].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

const latencies = rows.map(row => row.latencyMs).filter(Number.isFinite);
const finalB1 = traced.map(({ trace }) => trace?.observations?.find(item => item.name === 'dify.B1_memory')).filter(Boolean);
const rag = traced.map(({ trace }) => trace?.observations?.find(item => item.name === 'rag.retrieve')?.status || 'not_observed');
const results = rows.map(row => row.outputs?.result || {});
const ragCases = traced.filter(({ row }) => /RAG|知识/.test(row.inputData?.group || ''));

function b1BusinessStatus(observation) {
  if (observation.status === 'error') return observation.error_code || 'error';
  const raw = observation.output?.data?.outputs?.proposal_result_json;
  if (typeof raw !== 'string') return 'missing_output';
  try { return JSON.parse(raw).status || 'missing_status'; } catch { return 'invalid_json'; }
}

function b1BusinessOutput(observation) {
  if (observation.status === 'error') return { status: observation.error_code || 'error', missing_evidence: [] };
  const raw = observation.output?.data?.outputs?.proposal_result_json;
  if (typeof raw !== 'string') return { status: 'missing_output', missing_evidence: [] };
  try { return JSON.parse(raw); } catch { return { status: 'invalid_json', missing_evidence: [] }; }
}

const report = {
  task_id: taskId,
  transport: {
    total: rows.length,
    success: rows.filter(row => row.status === 'success').length,
    failed: rows.filter(row => row.status === 'failed').length
  },
  identity: {
    unique_trace_ids: new Set(results.map(item => item.trace_id).filter(Boolean)).size,
    unique_session_ids: new Set(results.map(item => item.session_id).filter(Boolean)).size
  },
  latency_ms: {
    average: latencies.length ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length) : null,
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    max: latencies.length ? Math.max(...latencies) : null
  },
  routes: counts(results.map(item => item.route)),
  draft_statuses: counts(results.map(item => item.draft_status)),
  b1: {
    observed: finalB1.length,
    statuses: counts(finalB1.map(item => item.status)),
    business_statuses: counts(finalB1.map(b1BusinessStatus)),
    error_codes: counts(finalB1.filter(item => item.status === 'error').map(item => item.error_code)),
    total_tokens: finalB1.reduce((sum, item) => sum + (Number(item.total_tokens) || 0), 0),
    total_cost_cny: Number(finalB1.reduce((sum, item) => sum + (Number(item.cost_cny) || 0), 0).toFixed(6)),
    average_duration_ms: finalB1.length
      ? Math.round(finalB1.reduce((sum, item) => sum + (Number(item.duration_ms) || 0), 0) / finalB1.length)
      : null,
    issues: traced.flatMap(({ row, trace }) => {
      const observation = trace?.observations?.find(item => item.name === 'dify.B1_memory');
      if (!observation) return [];
      const output = b1BusinessOutput(observation);
      if (!['invalid_output', 'DIFY_TIMEOUT'].includes(output.status)) return [];
      return [{
        case_id: row.inputData?.case_id,
        group: row.inputData?.group,
        status: output.status,
        proposed_fields: Array.isArray(output.facts) ? output.facts.map(item => item?.field).filter(Boolean) : [],
        missing_evidence: output.missing_evidence || [],
        trace_id: trace.trace_id
      }];
    })
  },
  rag: {
    statuses: counts(rag),
    cases: ragCases.length,
    cases_with_citations: ragCases.filter(({ row }) => row.outputs?.result?.citations?.length).length,
    no_citation_case_ids: ragCases.filter(({ row }) => !row.outputs?.result?.citations?.length).map(({ row }) => row.inputData?.case_id)
  },
  safety: {
    risky_promises: results.filter(item => item.checks?.risky_promise_detected).length,
    more_than_one_question: results.filter(item => Number(item.checks?.question_count) > 1).length
  },
  dataset_debt: {
    journey_summaries: rows.filter(row => row.inputData?.mode === 'journey' && !/^(?:客户|销售)[：:]/m.test(row.inputData?.customer_input || '')).length,
    fixture_required: rows.filter(row => row.inputData?.execution_support === 'fixture_required').length
  }
};

console.log(JSON.stringify(report, null, 2));
