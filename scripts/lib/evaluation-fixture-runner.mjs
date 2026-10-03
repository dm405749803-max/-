import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requiresEvaluationFixture, requiresEvaluationHumanReview } from './evaluation-outcomes.mjs';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function testPassed(transcript, caseId) {
  return new RegExp(`(?:✔|ok\\s+\\d+\\s+-)\\s*\\[${caseId}\\]`).test(transcript);
}

function fixtureEvidence(transcript) {
  const evidence = new Map();
  for (const match of transcript.matchAll(/FIXTURE_EVIDENCE\s+(\{[^\r\n]+\})/g)) {
    try {
      const value = JSON.parse(match[1]);
      if (value?.case_id) evidence.set(value.case_id, value);
    } catch {}
  }
  return evidence;
}

export async function runFixtureExecutor({
  executor,
  testFiles,
  outputFile,
  schemaVersion = 'sales-evaluation-fixtures.v2',
  datasetFile = 'evaluation/sales-v1.3-cases.json',
  backendRoot = process.env.BACKEND_ROOT || 'http://127.0.0.1:8833',
  syncBadcases = false,
  evalRunId = null,
  p0RegressionStatus = 'fixture_passed_p0_human_pending',
  workspace = 'eval_any_agent',
  caseIds = []
} = {}) {
  if (!executor) throw new TypeError('fixture executor is required');
  const files = Array.isArray(testFiles) ? testFiles : [testFiles].filter(Boolean);
  if (!files.length) throw new TypeError('fixture testFiles are required');

  const dataset = JSON.parse(await readFile(join(root, datasetFile), 'utf8'));
  const selectedCaseIds = new Set((Array.isArray(caseIds) ? caseIds : []).map(value => String(value).trim()).filter(Boolean));
  const cases = dataset.cases.filter(item =>
    requiresEvaluationFixture(item) && item.setup?.executor === executor
    && (!selectedCaseIds.size || selectedCaseIds.has(item.id)));
  if (!cases.length) throw new Error('没有找到符合筛选条件的评测夹具。');
  const pattern = [...selectedCaseIds].map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const run = spawnSync(process.execPath, [
    '--test', ...(pattern ? ['--test-name-pattern', `\\[(?:${pattern})\\]`] : []), ...files
  ], { cwd: root, encoding: 'utf8' });
  const transcript = `${run.stdout || ''}${run.stderr || ''}`;
  const evidence = fixtureEvidence(transcript);
  const results = cases.map(item => ({
    case_id: item.id,
    fixture_type: item.fixture_type,
    executor,
    setup: item.setup,
    check: item.expected,
    status: testPassed(transcript, item.id) ? 'passed' : 'failed',
    evidence: evidence.get(item.id) || null
  }));
  const report = {
    schema_version: schemaVersion,
    generated_at: new Date().toISOString(),
    executor,
    total: results.length,
    passed: results.filter(item => item.status === 'passed').length,
    failed: results.filter(item => item.status === 'failed').length,
    results
  };
  const output = join(root, outputFile);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);

  if (run.status !== 0 || report.failed > 0) {
    process.stderr.write(transcript);
    throw Object.assign(new Error(`${executor}夹具未全部通过：${report.passed}/${report.total}`), {
      code: 'EVALUATION_FIXTURE_FAILED', report, exitCode: run.status || 1
    });
  }

  if (!syncBadcases) return { report, output };
  if (!evalRunId) throw new Error('EVAL_RUN_ID is required when SYNC_BADCASES=1');

  const headers = { accept: 'application/json', 'content-type': 'application/json', 'x-workspace-id': workspace };
  try {
    const rootUrl = String(backendRoot).replace(/\/$/, '');
    const payload = await fetch(`${rootUrl}/api/v2/observability/badcases?eval_run_id=${encodeURIComponent(evalRunId)}`, { headers })
      .then(response => response.json());
    const existing = Array.isArray(payload.data) ? payload.data : [];
    for (const item of results) {
      const current = existing.find(row => row.eval_run_id === evalRunId && row.case_id === item.case_id);
      if (!current) continue;
      const definition = cases.find(row => row.id === item.case_id);
      const requiresHuman = requiresEvaluationHumanReview(definition);
      const humanAlreadyApproved = current.human_review_status === 'approved';
      const reviewStillRequired = requiresHuman && !humanAlreadyApproved;
      const fixtureEvidence = {
        case_id: item.case_id,
        schema_version: item.setup.schema_version,
        fixture_type: item.fixture_type,
        executor,
        observations: item.setup.observations,
        details: item.evidence,
        status: 'passed'
      };
      const response = await fetch(`${rootUrl}/api/v2/observability/badcases`, {
        method: 'POST', headers,
        body: JSON.stringify({
          badcase_id: current.badcase_id,
          case_id: current.case_id,
          eval_run_id: current.eval_run_id,
          trace_id: current.trace_id,
          status: reviewStillRequired ? 'needs_review' : 'closed',
          severity: current.severity,
          failed_dimensions: [],
          actual: { ...(current.actual || {}), fixture_execution: fixtureEvidence },
          expected: current.expected,
          root_cause_layer: reviewStillRequired ? 'human_judgment_pending' : 'passed',
          root_cause_note: reviewStillRequired
            ? `${item.fixture_type}夹具回归已通过，P0/完整旅程或评分表要求的人工复核尚未完成：${item.check}。`
            : humanAlreadyApproved
              ? `${item.fixture_type}夹具回归已通过，沿用既有人工复核通过结论：${item.check}。`
              : `${item.fixture_type}夹具回归已通过：${item.check}。`,
          fix_version: `${executor}-v2`,
          reset_human_review: current.human_review_status === 'rejected',
          regression_status: reviewStillRequired
            ? (definition?.priority === 'P0' ? p0RegressionStatus : 'fixture_passed_human_pending') : 'passed'
        })
      });
      if (!response.ok) throw new Error(`${item.case_id} 同步失败：HTTP ${response.status}`);
    }
  } catch (error) {
    console.warn(`夹具报告已生成，但归因中心同步失败：${error.message}`);
  }

  return { report, output };
}
