import { readFile } from 'node:fs/promises';
import { requiresEvaluationFixture, requiresEvaluationHumanReview } from './lib/evaluation-outcomes.mjs';

const [baseTaskId, ...pairs] = process.argv.slice(2);
if (!baseTaskId || !pairs.length || pairs.some(pair => !pair.includes(':'))) {
  throw new Error('Usage: node scripts/apply-targeted-regressions.mjs <base-task-id> <execution-task-id:evaluation-task-id> [...]');
}

const evalRoot = process.env.EVAL_ROOT || 'http://127.0.0.1:3000';
const backendRoot = process.env.BACKEND_ROOT || 'http://127.0.0.1:8833';
const username = process.env.EVAL_USERNAME || 'admin';
const password = process.env.EVAL_PASSWORD;
if (!password) throw new Error('EVAL_PASSWORD is required');

const dataset = JSON.parse(await readFile(new URL('../evaluation/sales-v1.3-cases.json', import.meta.url), 'utf8'));
const definitions = new Map(dataset.cases.map(item => [item.id, item]));
const baseRunId = `eval-task-${baseTaskId}`;
const headers = { accept: 'application/json', 'content-type': 'application/json', 'x-workspace-id': 'eval_any_agent' };

const login = await fetch(`${evalRoot}/api/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username, password })
});
if (!login.ok) throw new Error(`Eval login failed: HTTP ${login.status}`);
const cookie = login.headers.get('set-cookie')?.split(';')[0];
if (!cookie) throw new Error('Eval login did not return a session cookie');

async function evalGet(path) {
  const response = await fetch(`${evalRoot}${path}`, { headers: { cookie } });
  const payload = await response.json();
  if (!response.ok || !payload?.ok) throw new Error(`Could not read ${path}`);
  return payload.data;
}

const currentPayload = await fetch(`${backendRoot}/api/v2/observability/badcases?eval_run_id=${encodeURIComponent(baseRunId)}`, { headers }).then(response => response.json());
const currentByCase = new Map((currentPayload.data || []).map(item => [item.case_id, item]));
const applied = new Map();
const skipped = new Map();

for (const pair of pairs) {
  const [executionTaskId, evaluationTaskId] = pair.split(':');
  const [execution, evaluation] = await Promise.all([
    evalGet(`/api/tasks/${encodeURIComponent(executionTaskId)}/results?pageSize=100`),
    evalGet(`/api/evaluation-tasks/${encodeURIComponent(evaluationTaskId)}/results?pageSize=100`)
  ]);
  const executionByCase = new Map(execution.rows.map(row => [row.inputData?.case_id, row]));

  for (const score of evaluation.rows) {
    const caseId = score.sourceInput?.case_id;
    if (!caseId || score.status !== 'success' || score.passed !== true) continue;
    const current = currentByCase.get(caseId);
    const definition = definitions.get(caseId);
    const result = executionByCase.get(caseId)?.outputs?.result || {};
    if (!current || !definition) continue;
    if (requiresEvaluationFixture(definition)) {
      skipped.set(caseId, {
        case_id: caseId,
        reason: 'fixture_required',
        note: '定向AI评分不能替代状态夹具执行，请使用专用夹具回归脚本。'
      });
      continue;
    }
    const requiresHuman = requiresEvaluationHumanReview(definition);
    const response = await fetch(`${backendRoot}/api/v2/observability/badcases`, {
      method: 'POST', headers,
      body: JSON.stringify({
        badcase_id: current.badcase_id,
        case_id: caseId,
        eval_run_id: baseRunId,
        trace_id: result.trace_id || current.trace_id,
        status: requiresHuman ? 'needs_review' : 'closed',
        severity: definition.priority,
        failed_dimensions: [],
        actual: {
          response: result.actual_response || '',
          draft_status: result.draft_status || null,
          route: result.route || null,
          citations: result.citations || [],
          checks: result.checks || {},
          modules: result.modules || {},
          targeted_regression: { execution_task_id: executionTaskId, evaluation_task_id: evaluationTaskId },
          ai_evaluation: { score: score.score, passed: true, reason: score.reason, status: score.status }
        },
        expected: current.expected,
        root_cause_layer: requiresHuman ? 'human_judgment_pending' : 'passed',
        root_cause_note: requiresHuman
          ? `定向修复回归已通过AI独立评分（${Number(score.score).toFixed(1)}/100），P0/完整旅程或评分表要求的人工复核尚未完成。`
          : `定向修复回归已通过AI独立评分（${Number(score.score).toFixed(1)}/100）。`,
        fix_version: 'targeted-regression-2026-09-30',
        regression_status: requiresHuman
          ? (definition.priority === 'P0' ? 'ai_passed_p0_human_pending' : 'ai_passed_human_pending') : 'passed'
      })
    });
    if (!response.ok) throw new Error(`${caseId} targeted regression sync failed: HTTP ${response.status}`);
    applied.set(caseId, { case_id: caseId, score: Number(score.score), status: requiresHuman ? 'needs_review' : 'closed' });
  }
}

console.log(JSON.stringify({ base_run_id: baseRunId, applied: [...applied.values()], skipped: [...skipped.values()] }, null, 2));
