import { readFile } from 'node:fs/promises';

const FIXTURE_URL = new URL('./api-verification-fixture.json', import.meta.url);

function requireEnvironment(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function matchesExpected(actual, expected) {
  const tokensMatch = expected.token_rule === 'equals_zero'
    ? actual.total_tokens === 0
    : Number(actual.total_tokens) > 0;
  return actual.http_status === expected.http_status
    && actual.workflow_status === expected.workflow_status
    && actual.output_key === expected.output_key
    && actual.result_status === expected.result_status
    && actual.next_action === expected.next_action
    && JSON.stringify(actual.citation_ids) === JSON.stringify(expected.citation_ids)
    && tokensMatch;
}

const baseUrl = requireEnvironment('DIFY_API_BASE_URL').replace(/\/+$/, '');
const apiKey = requireEnvironment('DIFY_APP_API_KEY');
const fixture = JSON.parse(await readFile(FIXTURE_URL, 'utf8'));
let failed = false;

for (const testCase of fixture.cases) {
  const response = await fetch(`${baseUrl}${fixture.endpoint_path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(testCase.request)
  });
  const body = await response.json().catch(() => ({}));
  const outputs = body?.data?.outputs || {};
  const outputKey = Object.keys(outputs).find(name => name.endsWith('_result_json')) || null;
  let result = {};
  if (outputKey && typeof outputs[outputKey] === 'string') {
    try { result = JSON.parse(outputs[outputKey]); } catch {}
  }
  const actual = {
    id: testCase.id,
    http_status: response.status,
    workflow_status: body?.data?.status || null,
    workflow_run_id: body?.workflow_run_id || body?.data?.id || null,
    output_key: outputKey,
    result_status: result.status || null,
    citation_ids: Array.isArray(result.citation_ids) ? result.citation_ids : [],
    next_action: result.next_action || null,
    total_tokens: body?.data?.total_tokens ?? null
  };
  actual.passed = matchesExpected(actual, testCase.expected);
  if (!actual.passed) failed = true;
  console.log(JSON.stringify(actual));
}

if (failed) process.exitCode = 1;
