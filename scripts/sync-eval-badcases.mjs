import { readFile } from 'node:fs/promises';
import { fixtureExecutionOutcome, requiresEvaluationFixture, requiresEvaluationHumanReview } from './lib/evaluation-outcomes.mjs';

const [taskId, evaluationTaskId = '', ...fixtureReportPaths] = process.argv.slice(2);
if (!taskId) {
  throw new Error(
    'Usage: node scripts/sync-eval-badcases.mjs <task-id> [evaluation-task-id] [fixture-result.json ...]'
  );
}

const evalRoot = process.env.EVAL_ROOT || 'http://127.0.0.1:3000';
const backendRoot = process.env.BACKEND_ROOT || 'http://127.0.0.1:8833';
const username = process.env.EVAL_USERNAME || 'admin';
const password = process.env.EVAL_PASSWORD;
if (!password) throw new Error('EVAL_PASSWORD is required');

const datasetSource = process.env.EVAL_DATASET_PATH
  ? process.env.EVAL_DATASET_PATH
  : new URL('../evaluation/sales-v1.3-cases.json', import.meta.url);
const dataset = JSON.parse(await readFile(datasetSource, 'utf8'));
const cases = new Map(dataset.cases.map(item => [item.id, item]));
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
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username, password })
});
if (!login.ok) throw new Error(`Eval login failed: HTTP ${login.status}`);
const cookie = login.headers.get('set-cookie')?.split(';')[0];
if (!cookie) throw new Error('Eval login did not return a session cookie');

const resultResponse = await fetch(`${evalRoot}/api/tasks/${encodeURIComponent(taskId)}/results?pageSize=100`, { headers: { cookie } });
const resultPayload = await resultResponse.json();
if (!resultResponse.ok || !resultPayload?.ok) throw new Error('Could not read Eval task results');
const rows = resultPayload.data.rows;
// Include fixture evidence without inventing conversation executions or AI scores.
const executedCaseIds = new Set(rows.map(row => row.inputData?.case_id));
for (const caseId of fixtureEvidenceByCase.keys()) {
  if (!executedCaseIds.has(caseId) && requiresEvaluationFixture(cases.get(caseId))) {
    rows.push({ status: 'not_executed', inputData: { case_id: caseId }, evidence_kind: 'fixture_only' });
  }
}
const runId = process.env.EVAL_RUN_ID || `eval-task-${taskId}`;

const aiByCase = new Map();
if (evaluationTaskId) {
  const evaluationResponse = await fetch(`${evalRoot}/api/evaluation-tasks/${encodeURIComponent(evaluationTaskId)}/results?pageSize=100`, { headers: { cookie } });
  const evaluationPayload = await evaluationResponse.json();
  if (!evaluationResponse.ok || !evaluationPayload?.ok) throw new Error('Could not read AI evaluation results');
  for (const row of evaluationPayload.data.rows) {
    const caseId = row.sourceInput?.case_id;
    if (caseId) aiByCase.set(caseId, row);
  }
}

async function traceFor(result) {
  if (!result?.trace_id) return null;
  const response = await fetch(`${backendRoot}/api/v2/observability/traces/${encodeURIComponent(result.trace_id)}`, {
    headers: { 'x-workspace-id': 'eval_any_agent' }
  });
  const payload = await response.json().catch(() => null);
  return response.ok ? payload?.data : null;
}

function b1Outcome(trace) {
  const observation = trace?.observations?.find(item => item.name === 'dify.B1_memory');
  if (!observation) return { provider: 'not_observed', business: 'not_observed' };
  if (observation.status === 'error') return { provider: observation.error_code || 'error', business: observation.error_code || 'error' };
  const raw = observation.output?.data?.outputs?.proposal_result_json;
  try { return { provider: observation.status, business: JSON.parse(raw).status || 'missing_status' }; }
  catch { return { provider: observation.status, business: 'invalid_json' }; }
}

function objectiveAssessment(row, item, result, trace, aiEvaluation, fixtureEvidence) {
  const issues = [];
  const failedDimensions = [];
  let layer = 'human_judgment_pending';
  const fixtureRequired = requiresEvaluationFixture(item);
  const requiresHuman = requiresEvaluationHumanReview(item);
  const humanLabel = item?.priority === 'P0' ? 'P0' : '完整旅程或评分表指定案例';
  const fixture = fixtureExecutionOutcome(item, row, fixtureEvidence);

  if (row.status !== 'success' && row.evidence_kind !== 'fixture_only') {
    issues.push(`批量执行失败：${row.errorType || row.status}`);
    failedDimensions.push('执行可用性'); layer = 'evaluation_transport';
  }
  const b1 = b1Outcome(trace);
  if (!fixtureRequired) {
    const expectedSafeBlock = ['HUMAN_HANDOFF_ACTIVE', 'MARKETING_OPT_OUT'].includes(result?.business_error?.code);
    if (result?.business_error && !expectedSafeBlock) {
      issues.push(`后端业务错误：${result.business_error.code || 'unknown'}`);
      failedDimensions.push('后端执行'); layer = 'backend_runtime';
    }
    if (['unavailable', 'invalid_output', 'ERROR'].includes(result?.draft_status)) {
      issues.push(`草稿状态不可用：${result.draft_status}`);
      failedDimensions.push('AI输出'); layer = 'ai_workflow';
    }
    if (result?.checks?.risky_promise_detected) {
      issues.push('检测到高风险承诺'); failedDimensions.push('安全合规'); layer = 'safety_gate';
    }
    if (Number(result?.checks?.question_count) > 1) {
      issues.push('单轮追问超过一个'); failedDimensions.push('对话体验'); layer = 'reply_policy';
    }

    const acceptedB1Result = result?.modules?.b1?.status === 'success';
    if (!expectedSafeBlock && !acceptedB1Result && ['invalid_output', 'invalid_json', 'DIFY_TIMEOUT', 'DIFY_UPSTREAM_ERROR', 'DIFY_INSUFFICIENT_BALANCE'].includes(b1.business)) {
      issues.push(`B1异常：${b1.business}`); failedDimensions.push('客户画像与记忆'); layer = 'b1_memory';
    }

    const sourceRequirement = `${item?.expected || ''} ${item?.success_condition || ''}`;
    const permitsSalesToProvideSource = /或请销售(?:发送|提供)/.test(sourceRequirement);
    const expectsCitation = item?.group_code === 'E'
      && /(?:引用|来源|知识库|RAG|条款|FAQ)/i.test(sourceRequirement)
      && !permitsSalesToProvideSource;
    if (expectsCitation && result?.draft_status === 'draft_ready' && !result?.citations?.length) {
      issues.push('应有依据的回复没有引用'); failedDimensions.push('RAG证据'); layer = 'rag_retrieval';
    }
  }

  if (fixture.status === 'not_executed') {
    issues.push(`该案例需要专用状态夹具，本轮未执行：${item.setup_instructions}`);
    failedDimensions.push('评测夹具');
    layer = 'evaluation_fixture';
  } else if (fixture.status === 'failed') {
    issues.push('该案例的专用状态夹具执行失败');
    failedDimensions.push('评测夹具');
    layer = 'evaluation_fixture';
  }

  let status = issues.length ? 'open' : 'needs_review';
  let regressionStatus = fixture.status === 'not_executed'
    ? 'fixture_not_executed'
    : fixture.status === 'failed'
      ? 'fixture_failed'
      : issues.length ? 'failed_objective_checks' : 'objective_checks_passed_human_pending';
  let note = issues.join('；') || '客观自动检查已通过，仍需AI表达评分及P0人工复核。';

  if (!issues.length && fixtureRequired && fixture.status === 'passed') {
    if (requiresHuman) {
      status = 'needs_review'; regressionStatus = item?.priority === 'P0' ? 'fixture_passed_p0_human_pending' : 'fixture_passed_human_pending'; layer = 'human_judgment_pending';
      note = `状态夹具已独立执行并通过，${humanLabel}仍需人工复核。`;
    } else {
      status = 'closed'; regressionStatus = 'passed'; layer = 'passed';
      note = '状态夹具已独立执行并通过。';
    }
  } else if (!issues.length && aiEvaluation?.status === 'success') {
    if (aiEvaluation.passed !== true) {
      status = 'open'; regressionStatus = 'failed_ai_judgment'; layer = 'ai_judgment';
      failedDimensions.push('AI语义评分');
      note = `AI评分 ${Number(aiEvaluation.score ?? 0).toFixed(1)}/100：${aiEvaluation.reason || '未达到通过标准'}`;
    } else if (requiresHuman) {
      status = 'needs_review'; regressionStatus = item?.priority === 'P0' ? 'ai_passed_p0_human_pending' : 'ai_passed_human_pending'; layer = 'human_judgment_pending';
      note = `客观检查与AI评分已通过（${Number(aiEvaluation.score ?? 0).toFixed(1)}/100），${humanLabel}仍需人工复核。`;
    } else {
      status = 'closed'; regressionStatus = 'passed'; layer = 'passed';
      note = `客观检查与AI评分已通过（${Number(aiEvaluation.score ?? 0).toFixed(1)}/100）。`;
    }
  }

  return {
    issues,
    failedDimensions: [...new Set(failedDimensions)],
    layer,
    b1,
    status,
    regressionStatus,
    note,
    fixtureStatus: fixture.status
  };
}

let open = 0; let pending = 0; let closed = 0;
const metrics = {
  execution: { succeeded: 0, failed: 0, not_executed: 0 },
  ai_evaluation: { passed: 0, failed: 0, not_evaluated: 0 },
  fixture: { required: 0, executed: 0, passed: 0, failed: 0, not_executed: 0 },
  p0_human_pending: 0,
  human_review_pending: 0
};
for (let offset = 0; offset < rows.length; offset += 10) {
  const batch = rows.slice(offset, offset + 10);
  await Promise.all(batch.map(async row => {
    const result = row.outputs?.result || {};
    const item = cases.get(row.inputData?.case_id);
    const trace = await traceFor(result);
    const aiEvaluation = aiByCase.get(item?.id || row.inputData?.case_id);
    const fixtureEvidence = fixtureEvidenceByCase.get(item?.id || row.inputData?.case_id) || null;
    const assessment = objectiveAssessment(row, item, result, trace, aiEvaluation, fixtureEvidence);
    if (row.evidence_kind === 'fixture_only') metrics.execution.not_executed += 1;
    else if (row.status === 'success') metrics.execution.succeeded += 1;
    else metrics.execution.failed += 1;
    if (aiEvaluation?.status !== 'success') metrics.ai_evaluation.not_evaluated += 1;
    else if (aiEvaluation.passed === true) metrics.ai_evaluation.passed += 1;
    else metrics.ai_evaluation.failed += 1;
    if (requiresEvaluationFixture(item)) {
      metrics.fixture.required += 1;
      if (assessment.fixtureStatus === 'not_executed') metrics.fixture.not_executed += 1;
      else {
        metrics.fixture.executed += 1;
        if (assessment.fixtureStatus === 'failed') metrics.fixture.failed += 1;
        else metrics.fixture.passed += 1;
      }
    }
    if (['ai_passed_p0_human_pending', 'fixture_passed_p0_human_pending'].includes(assessment.regressionStatus)) {
      metrics.p0_human_pending += 1;
    }
    if (['ai_passed_human_pending', 'fixture_passed_human_pending'].includes(assessment.regressionStatus)) {
      metrics.human_review_pending += 1;
    }
    if (assessment.status === 'open') open += 1;
    else if (assessment.status === 'closed') closed += 1;
    else pending += 1;
    const response = await fetch(`${backendRoot}/api/v2/observability/badcases`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-workspace-id': 'eval_any_agent' },
      body: JSON.stringify({
        case_id: item?.id || row.inputData?.case_id || `row-${row.rowIndex}`,
        eval_run_id: runId,
        trace_id: result.trace_id || null,
        status: assessment.status,
        severity: item?.priority || 'P1',
        failed_dimensions: assessment.failedDimensions,
        actual: {
          evidence_kind: row.evidence_kind || 'conversation_execution',
          business_events: result.business_events || [],
          tasks: result.tasks || [],
          customer_state: result.customer_state || null,
          input: result.customer_input || row.inputData?.customer_input || '',
          latest_customer_message: result.latest_customer_message || '',
          response: result.actual_response || '', draft_status: result.draft_status || row.status,
          route: result.route || null, citations: result.citations || [], checks: result.checks || {},
          modules: result.modules || {}, b1: assessment.b1,
          evaluation_fixture: {
            required: requiresEvaluationFixture(item),
            status: assessment.fixtureStatus,
            evidence: fixtureEvidence
          },
          ai_evaluation: aiEvaluation ? {
            evaluation_task_id: evaluationTaskId,
            score: aiEvaluation.score,
            passed: aiEvaluation.passed,
            reason: aiEvaluation.reason,
            status: aiEvaluation.status
          } : null
        },
        expected: {
          behavior: item?.expected || row.inputData?.expected_behavior || '',
          hard_failure: item?.rubric?.hard_failure || row.inputData?.hard_failure || '',
          pass_score: item?.rubric?.pass_score || row.inputData?.pass_score || 85,
          ai_pass_threshold: 85
        },
        root_cause_layer: assessment.layer,
        root_cause_note: assessment.note,
        fix_version: evaluationTaskId ? 'ai-evaluated-baseline-v1' : 'post-recharge-regression-v1',
        regression_status: assessment.regressionStatus
      })
    });
    if (!response.ok) throw new Error(`Badcase sync failed for ${item?.id}: HTTP ${response.status}`);
  }));
}

console.log(JSON.stringify({
  task_id: taskId,
  evaluation_task_id: evaluationTaskId || null,
  eval_run_id: runId,
  total: rows.length,
  badcase_status: { open, needs_review: pending, closed },
  metrics,
  note: '执行成功、AI通过、P0/完整旅程待人工与Badcase闭环是不同口径，不可互换。'
}, null, 2));
