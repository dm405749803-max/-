const PASSED_FIXTURE_STATUSES = new Set(['passed', 'success', 'completed']);
const FAILED_FIXTURE_STATUSES = new Set(['failed', 'error']);

export function requiresEvaluationFixture(definition) {
  return definition?.execution_support === 'fixture_required';
}

export function requiresEvaluationHumanReview(definition) {
  return definition?.priority === 'P0'
    || definition?.mode === 'journey'
    || definition?.rubric?.judgment?.human_review_required === true;
}

function passedOutcome(definition) {
  if (definition?.priority === 'P0') return 'p0_human_pending';
  return requiresEvaluationHumanReview(definition) ? 'human_review_pending' : 'passed';
}

function normalizeFixtureEvidence(evidence, caseId) {
  if (!evidence || typeof evidence !== 'object') return null;
  if (evidence.case_id && caseId && evidence.case_id !== caseId) return null;
  const status = String(evidence.status || '').toLowerCase();
  if (PASSED_FIXTURE_STATUSES.has(status)) return { status: 'passed', evidence };
  if (FAILED_FIXTURE_STATUSES.has(status)) return { status: 'failed', evidence };
  return null;
}

export function fixtureExecutionOutcome(definition, executionRow = {}, externalEvidence = null) {
  if (!requiresEvaluationFixture(definition)) return { status: 'not_required', evidence: null };
  const result = executionRow?.outputs?.result || {};
  const caseId = definition?.id || executionRow?.inputData?.case_id;
  const candidates = [
    externalEvidence,
    result.fixture_execution,
    result.evaluation_fixture,
    executionRow.fixture_execution,
    executionRow?.outputs?.fixture_execution
  ];
  for (const candidate of candidates) {
    const normalized = normalizeFixtureEvidence(candidate, caseId);
    if (normalized) return normalized;
  }
  return { status: 'not_executed', evidence: null };
}

export function classifyEvaluationOutcome({ definition, executionRow, evaluationRow, fixtureEvidence = null }) {
  const executionSucceeded = executionRow?.status === 'success';
  const evaluationCompleted = evaluationRow?.status === 'success';
  const aiPassed = evaluationCompleted && evaluationRow?.passed === true;
  const fixture = fixtureExecutionOutcome(definition, executionRow, fixtureEvidence);

  if (requiresEvaluationFixture(definition)) {
    if (fixture.status === 'not_executed') return 'fixture_not_executed';
    if (fixture.status === 'failed') return 'fixture_failed';
    return passedOutcome(definition);
  }
  if (!executionSucceeded) return 'execution_failed';
  if (!evaluationCompleted) return 'ai_not_evaluated';
  if (!aiPassed) return 'ai_failed';
  return passedOutcome(definition);
}

export function summarizeEvaluationOutcomes(rows) {
  const summary = {
    total: rows.length,
    execution: { succeeded: 0, failed: 0, not_executed: 0 },
    ai_evaluation: { completed: 0, passed: 0, failed: 0, not_evaluated: 0 },
    fixture: { required: 0, executed: 0, passed: 0, failed: 0, not_executed: 0 },
    decision: {
      passed: 0,
      p0_human_pending: 0,
      human_review_pending: 0,
      fixture_not_executed: 0,
      fixture_failed: 0,
      execution_failed: 0,
      ai_failed: 0,
      ai_not_evaluated: 0
    }
  };
  for (const row of rows) {
    if (row.execution_succeeded == null) summary.execution.not_executed += 1;
    else if (row.execution_succeeded) summary.execution.succeeded += 1;
    else summary.execution.failed += 1;
    if (row.ai_evaluation_completed) {
      summary.ai_evaluation.completed += 1;
      if (row.ai_passed) summary.ai_evaluation.passed += 1;
      else summary.ai_evaluation.failed += 1;
    } else summary.ai_evaluation.not_evaluated += 1;
    if (row.fixture_status !== 'not_required') {
      summary.fixture.required += 1;
      if (row.fixture_status === 'not_executed') summary.fixture.not_executed += 1;
      else {
        summary.fixture.executed += 1;
        if (row.fixture_status === 'passed') summary.fixture.passed += 1;
        else summary.fixture.failed += 1;
      }
    }
    summary.decision[row.decision] += 1;
  }
  return summary;
}
