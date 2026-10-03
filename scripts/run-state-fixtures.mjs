import { runFixtureExecutor } from './lib/evaluation-fixture-runner.mjs';

const syncBadcases = process.env.SYNC_BADCASES === '1';
if (syncBadcases && !process.env.EVAL_RUN_ID) throw new Error('EVAL_RUN_ID is required when SYNC_BADCASES=1');
const p0RegressionStatus = 'fixture_passed_p0_human_pending';
const caseIds = String(process.env.EVAL_CASE_IDS || '').split(',').map(value => value.trim()).filter(Boolean);

try {
  const { report, output } = await runFixtureExecutor({
    executor: 'state_fixture',
    testFiles: ['tests/evaluation/state-fixtures.test.mjs'],
    outputFile: 'evaluation/state-fixture-results.json',
    schemaVersion: 'sales-state-fixtures.v2',
    syncBadcases,
    evalRunId: process.env.EVAL_RUN_ID || null,
    p0RegressionStatus,
    caseIds
  });
  console.log(JSON.stringify({ report: output, total: report.total, passed: report.passed, failed: report.failed }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exit(error.exitCode || 1);
}
