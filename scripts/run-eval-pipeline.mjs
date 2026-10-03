import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

const [csvPath, datasetName = `Eval ${new Date().toISOString()}`] = process.argv.slice(2);
if (!csvPath) {
  throw new Error('Usage: node scripts/run-eval-pipeline.mjs <dataset.csv> [dataset-name]');
}

const evalRoot = process.env.EVAL_ROOT || 'http://127.0.0.1:3000';
const username = process.env.EVAL_USERNAME || 'admin';
const password = process.env.EVAL_PASSWORD;
const profileId = process.env.EVAL_PROFILE_ID || 'cmumqc3j200sfo90zlep9im79';
const evaluatorId = process.env.EVAL_EVALUATOR_ID || 'insurance-quality-v2-20260929';
const concurrency = Math.max(1, Math.min(20, Number(process.env.EVAL_CONCURRENCY) || 4));
if (!password) throw new Error('EVAL_PASSWORD is required');

const login = await fetch(`${evalRoot}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username, password })
});
if (!login.ok) throw new Error(`Eval login failed: HTTP ${login.status}`);
const cookie = login.headers.get('set-cookie')?.split(';')[0];
if (!cookie) throw new Error('Eval login did not return a session cookie');

async function request(path, options = {}) {
  const response = await fetch(`${evalRoot}${path}`, {
    ...options,
    headers: { cookie, ...(options.headers || {}) }
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    throw new Error(`${options.method || 'GET'} ${path} failed: HTTP ${response.status} ${payload?.message || ''}`.trim());
  }
  return payload.data;
}

async function waitFor(path, terminal = new Set(['completed', 'stopped', 'failed'])) {
  const startedAt = Date.now();
  let readFailures = 0;
  while (true) {
    let task;
    try { task = await request(path); readFailures = 0; }
    catch (error) {
      if (++readFailures > 3) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000));
      continue;
    }
    if (terminal.has(task.status)) {
      return { ...task, elapsed_ms: Date.now() - startedAt };
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

const bytes = await readFile(csvPath);
const form = new FormData();
form.set('name', datasetName);
form.set('file', new Blob([bytes], { type: 'text/csv' }), basename(csvPath));
const dataset = await request('/api/datasets/upload', { method: 'POST', body: form });

const execution = await request('/api/tasks', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    datasetId: dataset.id,
    profileId,
    concurrency,
    timeoutMs: 120000,
    retryCount: 2,
    conversationIdMode: 'per_row',
    conversationIdEvery: 1
  })
});
const executionDone = await waitFor(`/api/tasks/${encodeURIComponent(execution.id)}`);
if (executionDone.status !== 'completed' || executionDone.failedRows > 0) {
  console.log(JSON.stringify({ dataset, execution: executionDone }, null, 2));
  process.exitCode = 1;
} else {
  const createdEvaluations = await request('/api/evaluation-tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sourceTaskId: execution.id, evaluatorIds: [evaluatorId], notifyDingTalk: false })
  });
  const evaluation = createdEvaluations[0];
  const evaluationDone = await waitFor(`/api/evaluation-tasks/${encodeURIComponent(evaluation.id)}`);
  console.log(JSON.stringify({
    dataset: { id: dataset.id, name: dataset.name, rowCount: dataset.rowCount },
    execution: {
      id: executionDone.id,
      status: executionDone.status,
      totalRows: executionDone.totalRows,
      successRows: executionDone.successRows,
      failedRows: executionDone.failedRows,
      elapsed_ms: executionDone.elapsed_ms
    },
    evaluation: {
      id: evaluationDone.id,
      status: evaluationDone.status,
      totalRows: evaluationDone.totalRows,
      completedRows: evaluationDone.completedRows,
      failedRows: evaluationDone.failedRows,
      skippedRows: evaluationDone.skippedRows,
      elapsed_ms: evaluationDone.elapsed_ms
    }
  }, null, 2));
}
