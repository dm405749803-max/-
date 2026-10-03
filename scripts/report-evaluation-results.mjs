import { readFile } from 'node:fs/promises';
import {
  classifyEvaluationOutcome,
  fixtureExecutionOutcome,
  requiresEvaluationHumanReview,
  summarizeEvaluationOutcomes
} from './lib/evaluation-outcomes.mjs';

const [executionTaskId, evaluationTaskId, ...fixtureReportPaths] = process.argv.slice(2);
if (!executionTaskId || !evaluationTaskId) {
  throw new Error('Usage: node scripts/report-evaluation-results.mjs <execution-task-id> <evaluation-task-id> [fixture-result.json ...]');
}

const evalRoot = process.env.EVAL_ROOT || 'http://127.0.0.1:3000';
const username = process.env.EVAL_USERNAME || 'admin';
const password = process.env.EVAL_PASSWORD;
if (!password) throw new Error('EVAL_PASSWORD is required');

const dataset = JSON.parse(await readFile(new URL('../evaluation/sales-v1.3-cases.json', import.meta.url), 'utf8'));
const casesById = new Map(dataset.cases.map(item => [item.id, item]));
const fixtureEvidenceByCase = new Map();
for (const path of fixtureReportPaths) {
  const fixtureReport = JSON.parse(await readFile(path, 'utf8'));
  for (const result of fixtureReport.results || []) {
    if (!result?.case_id || !['passed', 'failed'].includes(result.status)) continue;
    fixtureEvidenceByCase.set(result.case_id, {
      case_id: result.case_id,
      status: result.status,
      report_path: path,
      report_schema: fixtureReport.schema_version || null,
      generated_at: fixtureReport.generated_at || null,
      details: result.evidence || null
    });
  }
}

const login = await fetch(`${evalRoot}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username, password })
});
if (!login.ok) throw new Error(`Eval login failed: HTTP ${login.status}`);
const cookie = login.headers.get('set-cookie')?.split(';')[0];
if (!cookie) throw new Error('Eval login did not return a session cookie');

async function get(path) {
  const response = await fetch(`${evalRoot}${path}`, { headers: { cookie } });
  const payload = await response.json();
  if (!response.ok || !payload?.ok) throw new Error(`Could not read ${path}`);
  return payload.data;
}

const [execution, evaluation] = await Promise.all([
  get(`/api/tasks/${encodeURIComponent(executionTaskId)}/results?pageSize=100`),
  get(`/api/evaluation-tasks/${encodeURIComponent(evaluationTaskId)}/results?pageSize=100`)
]);

const executionByCase = new Map(execution.rows.map(row => [row.inputData?.case_id, row]));
const evaluationByCase = new Map(evaluation.rows.map(row => [row.sourceInput?.case_id, row]));
const caseIds = [...new Set([...executionByCase.keys(), ...evaluationByCase.keys(), ...fixtureEvidenceByCase.keys()].filter(Boolean))];

function groupSummary(rows) {
  const result = {};
  for (const row of rows) {
    result[row.group] ||= { total: 0, decisions: {} };
    result[row.group].total += 1;
    result[row.group].decisions[row.decision] = (result[row.group].decisions[row.decision] || 0) + 1;
  }
  return result;
}

const rows = caseIds.map(caseId => {
  const evaluationRow = evaluationByCase.get(caseId);
  const definition = casesById.get(caseId);
  const executionRow = executionByCase.get(caseId);
  const result = executionRow?.outputs?.result || {};
  const fixtureEvidence = fixtureEvidenceByCase.get(caseId) || null;
  const fixture = fixtureExecutionOutcome(definition, executionRow, fixtureEvidence);
  return {
    case_id: caseId,
    group: definition?.group_code || caseId?.[0] || '?',
    priority: definition?.priority || 'P1',
    human_review_required: requiresEvaluationHumanReview(definition),
    execution_succeeded: executionRow ? executionRow.status === 'success' : null,
    evidence_kind: executionRow ? 'conversation_execution' : 'fixture_only',
    ai_evaluation_completed: evaluationRow?.status === 'success',
    ai_passed: evaluationRow?.status === 'success' && evaluationRow?.passed === true,
    fixture_status: fixture.status,
    decision: classifyEvaluationOutcome({ definition, executionRow, evaluationRow, fixtureEvidence }),
    score: evaluationRow?.score == null ? null : Number(evaluationRow.score),
    draft_status: result.draft_status || null,
    route: result.route || null,
    response: result.actual_response || '',
    reason: evaluationRow?.reason || ''
  };
});

const summary = summarizeEvaluationOutcomes(rows);
const completedAiRows = rows.filter(row => row.ai_evaluation_completed);
const rawAiAverage = completedAiRows.length
  ? completedAiRows.reduce((total, row) => total + row.score, 0) / completedAiRows.length
  : null;

const report = {
  execution_task_id: executionTaskId,
  evaluation_task_id: evaluationTaskId,
  total: rows.length,
  execution: summary.execution,
  ai_evaluation: {
    ...summary.ai_evaluation,
    raw_average_score: rawAiAverage == null ? null : Math.round(rawAiAverage * 100) / 100,
    note: '原始AI均分只表示语义评分，不等于执行成功率、夹具通过率或Badcase闭环率。'
  },
  fixture: {
    ...summary.fixture,
    evidence_reports: fixtureReportPaths,
    note: '只有显式传入的本轮夹具报告才能证明夹具已执行；单轮AI评分不能代替夹具。'
  },
  automated_decision: summary.decision,
  by_group: groupSummary(rows),
  cases: rows,
  metric_note: '执行成功、AI通过、P0/完整旅程待人工、夹具执行与Badcase闭环为独立口径，本报告不再生成混合的“调整后通过率”。'
};

console.log(JSON.stringify(report, null, 2));
