import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyEvaluationOutcome,
  fixtureExecutionOutcome,
  requiresEvaluationFixture,
  requiresEvaluationHumanReview,
  summarizeEvaluationOutcomes
} from '../../scripts/lib/evaluation-outcomes.mjs';

const dataset = JSON.parse(await readFile(new URL('../../evaluation/sales-v1.3-cases.json', import.meta.url), 'utf8'));
const byId = new Map(dataset.cases.map(item => [item.id, item]));

test('every fixture_required case is recognized regardless of mode', () => {
  const fixtureCases = dataset.cases.filter(requiresEvaluationFixture);
  assert.ok(fixtureCases.length >= 21);
  assert.equal(fixtureCases.length, dataset.cases.filter(item => item.execution_support === 'fixture_required').length);
  for (const id of ['B15', 'D04', 'F08', 'F09', 'H01']) {
    assert.equal(requiresEvaluationFixture(byId.get(id)), true, id);
  }
  assert.equal(byId.get('B15').mode, 'single_or_contextual');
  assert.equal(byId.get('H01').mode, 'journey');
});

test('AI pass cannot close a fixture case without explicit fixture evidence', () => {
  const definition = byId.get('D04');
  const executionRow = { status: 'success', inputData: { case_id: 'D04' }, outputs: { result: {} } };
  const evaluationRow = { status: 'success', passed: true, score: 100 };
  assert.equal(fixtureExecutionOutcome(definition, executionRow).status, 'not_executed');
  assert.equal(classifyEvaluationOutcome({ definition, executionRow, evaluationRow }), 'fixture_not_executed');
});

test('gateway preparation is not accepted as deterministic fixture evidence', () => {
  const definition = byId.get('B15');
  const executionRow = {
    status: 'success',
    inputData: { case_id: 'B15' },
    outputs: { result: { evaluation_fixture: { case_id: 'B15', status: 'prepared' } } }
  };
  assert.equal(fixtureExecutionOutcome(definition, executionRow).status, 'not_executed');
});

test('explicit matching fixture evidence is accepted and P0 still waits for human review', () => {
  const nonP0 = byId.get('D04');
  const p0 = byId.get('B15');
  const executionRow = { status: 'success', outputs: { result: {} } };
  const evaluationRow = { status: 'success', passed: false, score: 20 };
  assert.equal(classifyEvaluationOutcome({
    definition: nonP0,
    executionRow,
    evaluationRow,
    fixtureEvidence: { case_id: 'D04', status: 'passed' }
  }), 'passed');
  assert.equal(classifyEvaluationOutcome({
    definition: p0,
    executionRow,
    evaluationRow,
    fixtureEvidence: { case_id: 'B15', status: 'passed' }
  }), 'p0_human_pending');
  assert.equal(fixtureExecutionOutcome(nonP0, executionRow, { case_id: 'other', status: 'passed' }).status, 'not_executed');
});

test('ordinary execution, AI judgment and P0 review remain separate decisions', () => {
  const p1 = byId.get('A05');
  const p0 = byId.get('A04');
  const success = { status: 'success', outputs: { result: {} } };
  assert.equal(classifyEvaluationOutcome({ definition: p1, executionRow: { status: 'failed' }, evaluationRow: { status: 'success', passed: true } }), 'execution_failed');
  assert.equal(classifyEvaluationOutcome({ definition: p1, executionRow: success, evaluationRow: { status: 'success', passed: false } }), 'ai_failed');
  assert.equal(classifyEvaluationOutcome({ definition: p1, executionRow: success, evaluationRow: { status: 'success', passed: true } }), 'passed');
  assert.equal(classifyEvaluationOutcome({ definition: p0, executionRow: success, evaluationRow: { status: 'success', passed: true } }), 'p0_human_pending');
});

test('journey and explicit rubric review gates stay pending after AI or fixture success', () => {
  const success = { status: 'success', outputs: { result: {} } };
  const ai = { status: 'success', passed: true };
  for (const definition of [
    { id: 'custom-journey', priority: 'P1', mode: 'journey' },
    { id: 'custom-review', priority: 'P1', rubric: { judgment: { human_review_required: true } } }
  ]) {
    assert.equal(requiresEvaluationHumanReview(definition), true);
    assert.equal(classifyEvaluationOutcome({ definition, executionRow: success, evaluationRow: ai }), 'human_review_pending');
    assert.equal(classifyEvaluationOutcome({
      definition: { ...definition, execution_support: 'fixture_required' },
      executionRow: success, evaluationRow: ai,
      fixtureEvidence: { case_id: definition.id, status: 'passed' }
    }), 'human_review_pending');
    assert.equal(classifyEvaluationOutcome({ definition, executionRow: success, evaluationRow: { ...ai, passed: false } }), 'ai_failed');
  }
});

test('review summaries count P0 separately from other required human reviews', () => {
  const summary = summarizeEvaluationOutcomes([
    { execution_succeeded: true, ai_evaluation_completed: true, ai_passed: true, fixture_status: 'not_required', decision: 'human_review_pending' }
  ]);
  assert.equal(summary.decision.human_review_pending, 1);
  assert.equal(summary.decision.p0_human_pending, 0);
  assert.equal(summary.decision.passed, 0);
});

test('summary exposes independent counters instead of a blended adjusted pass rate', () => {
  const summary = summarizeEvaluationOutcomes([
    { execution_succeeded: true, ai_evaluation_completed: true, ai_passed: true, fixture_status: 'not_required', decision: 'passed' },
    { execution_succeeded: true, ai_evaluation_completed: true, ai_passed: true, fixture_status: 'not_executed', decision: 'fixture_not_executed' },
    { execution_succeeded: true, ai_evaluation_completed: true, ai_passed: true, fixture_status: 'passed', decision: 'p0_human_pending' },
    { execution_succeeded: false, ai_evaluation_completed: false, ai_passed: false, fixture_status: 'not_required', decision: 'execution_failed' }
  ]);
  assert.deepEqual(summary.execution, { succeeded: 3, failed: 1, not_executed: 0 });
  assert.deepEqual(summary.fixture, { required: 2, executed: 1, passed: 1, failed: 0, not_executed: 1 });
  assert.equal(summary.ai_evaluation.passed, 3);
  assert.equal(summary.decision.passed, 1);
  assert.equal(summary.decision.p0_human_pending, 1);
  assert.equal(summary.decision.fixture_not_executed, 1);
  assert.equal(Object.hasOwn(summary, 'adjusted_pass_rate'), false);
});

test('fixture-only evidence has no invented conversation execution or AI pass', () => {
  const definition = byId.get('B15');
  const fixtureEvidence = { case_id: 'B15', status: 'passed' };
  assert.equal(classifyEvaluationOutcome({ definition, fixtureEvidence }), 'p0_human_pending');
  const summary = summarizeEvaluationOutcomes([{ execution_succeeded: null, ai_evaluation_completed: false,
    ai_passed: false, fixture_status: 'passed', decision: 'p0_human_pending' }]);
  assert.deepEqual(summary.execution, { succeeded: 0, failed: 0, not_executed: 1 });
  assert.equal(summary.ai_evaluation.passed, 0);
  assert.equal(summary.fixture.passed, 1);
});

test('report script contains no static fixture case whitelist', async () => {
  const source = await readFile(new URL('../../scripts/report-evaluation-results.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /fixtureValidated|new Set\(\[\s*['"]B15/);
  assert.match(source, /fixtureReportPaths/);
});

test('fixture runners are evidence-only by default and cannot target a historical run implicitly', async () => {
  const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  for (const name of ['run-state-fixtures.mjs', 'run-b2-fixtures.mjs', 'run-rag-fixtures.mjs']) {
    const source = await readFile(new URL(`../../scripts/${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /eval-task-cm[a-z0-9]+/);
    assert.match(source, /process\.env\.SYNC_BADCASES === '1'/);
    assert.match(source, /EVAL_RUN_ID is required when SYNC_BADCASES=1/);
    assert.match(source, /fixture_passed_p0_human_pending/);
    const run = spawnSync(process.execPath, [`scripts/${name}`], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, SYNC_BADCASES: '1', EVAL_RUN_ID: '' }
    });
    assert.notEqual(run.status, 0, name);
    assert.match(`${run.stdout}${run.stderr}`, /EVAL_RUN_ID is required/);
  }
});
