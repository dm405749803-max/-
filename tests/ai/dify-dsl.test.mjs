import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const DSL_URL = new URL('../../dify/tongpin-sales-assist-a-batch.yml', import.meta.url);
const API_FIXTURE_URL = new URL('../../dify/api-verification-fixture.json', import.meta.url);
const OLD_EXAMPLE_URL = new URL('../../dify/input-output-example.json', import.meta.url);
const API_VERIFIER_URL = new URL('../../dify/verify-api-fixture.mjs', import.meta.url);
const SIMULATION_DOCS_URL = new URL('../../knowledge/simulation-documents.json', import.meta.url);
const SIMULATION_SOURCE_URL = new URL('../../knowledge/dify-fixture-business-approved.md', import.meta.url);
const MEMORY_DSL_URL = new URL('../../dify/tongpin-memory-proposal-b1.yml', import.meta.url);
const MEMORY_FIXTURE_URL = new URL('../../dify/memory-input-output-fixture.json', import.meta.url);
const MATCH_DSL_URL = new URL('../../dify/tongpin-product-match-b2.yml', import.meta.url);
const MATCH_FIXTURE_URL = new URL('../../dify/product-match-input-output-fixture.json', import.meta.url);

test('Dify DSL parses as YAML and contains the isolated evidence-gated graph', async () => {
  const summary = execFileSync('ruby', [
    '-e',
    "require 'yaml'; d=YAML.load_file(ARGV[0]); puts [d.dig('app','mode'),d.dig('workflow','graph','nodes').length,d.dig('workflow','graph','edges').length].join(',')",
    fileURLToPath(DSL_URL)
  ], { encoding: 'utf8' }).trim();
  assert.equal(summary, 'workflow,8,7');

  const source = await readFile(DSL_URL, 'utf8');
  assert.match(source, /知心大姐姐/);
  assert.match(source, /一次只问一个最必要的问题/);
  for (const value of [
    'knowledge-retrieval',
    '935ccc8a-1f55-4364-bf45-a160ed4e615c',
    '6c7fa6ba-1dfc-4e58-8286-5d93541a8260',
    '3f06bf95-8043-46a2-9102-dbbf0c50107b',
    '8ea849ca-b8d0-45f5-b2b2-b00ffc4e4e35',
    'f91eeb3b-00f0-48a9-87d5-a21f1da14641',
    '2223c28f-3506-44f4-a37b-c15d97c5a09d',
    'knowledge_json',
    'allowed_citations_json',
    'no_prefiltered_evidence',
    'scope_or_version_filter_empty',
    'business_verified',
    'approved_for_simulation',
    'deepseek-flash',
    "r'<think>.*?</think>'",
    'blocked_result_json',
    'draft_result_json',
    'result_json'
  ]) {
    assert.ok(source.includes(value), `missing ${value}`);
  }
  assert.equal(source.includes('d1272570-9c2c-44d7-aa7b-63638ed47abe'), false);
  assert.equal(/api[_-]?key|Bearer\s+[A-Za-z0-9]/i.test(source), false);
});

test('real API fixture covers positive and wrong-version branches without credentials', async () => {
  const fixture = JSON.parse(await readFile(API_FIXTURE_URL, 'utf8'));
  const oldExample = JSON.parse(await readFile(OLD_EXAMPLE_URL, 'utf8'));
  const verifier = await readFile(API_VERIFIER_URL, 'utf8');
  assert.deepEqual(fixture.cases.map(item => item.expected.output_key), [
    'draft_result_json',
    'blocked_result_json'
  ]);
  for (const item of fixture.cases) {
    const [evidence] = JSON.parse(item.request.inputs.knowledge_json);
    for (const field of [
      'product_id', 'product_version', 'policy_contract_version', 'scope',
      'lifecycle_status', 'index_status', 'verification_status', 'customer_use'
    ]) assert.ok(Object.hasOwn(evidence, field), `${item.id} missing ${field}`);
  }
  assert.equal(oldExample.deprecated, true);
  assert.equal(oldExample.superseded_by, 'dify/api-verification-fixture.json');
  assert.equal(verifier.includes('DIFY_APP_API_KEY'), true);
  assert.equal(/app-[A-Za-z0-9_-]{20,}/.test(verifier), false);
});

test('simulation knowledge fragment exactly matches the isolated Dify source document', async () => {
  const [document] = JSON.parse(await readFile(SIMULATION_DOCS_URL, 'utf8'));
  const source = await readFile(SIMULATION_SOURCE_URL, 'utf8');
  assert.equal(document.document_id, 'fixture-terms-v1');
  assert.equal(document.product_id, 'fixture-product');
  assert.equal(document.product_version, 'fixture-v1');
  assert.equal(document.customer_use, 'approved_for_simulation');
  assert.equal(document.chunks[0].location, '交费期测试段落');
  assert.ok(source.includes(document.chunks[0].text));
});

test('memory proposal DSL is an independent validated workflow with no embedded credentials', async () => {
  const summary = execFileSync('ruby', [
    '-e',
    "require 'yaml'; d=YAML.load_file(ARGV[0]); puts [d.dig('app','mode'),d.dig('workflow','graph','nodes').length,d.dig('workflow','graph','edges').length].join(',')",
    fileURLToPath(MEMORY_DSL_URL)
  ], { encoding: 'utf8' }).trim();
  assert.equal(summary, 'workflow,7,6');

  const source = await readFile(MEMORY_DSL_URL, 'utf8');
  for (const value of [
    'memory-proposal.v1',
    'deepseek-flash',
    'untrusted_context_json',
    'allowed_message_ids_json',
    'allowed_person_ids_json',
    'len(raw_facts) > 20',
    'summary_required_for_proposal',
    'fact_evidence_not_confirming',
    'INTENT_SIGNALS',
    "'level': level",
    "'recommended_action': action",
    'blocked_result_json',
    'proposal_result_json'
  ]) assert.ok(source.includes(value), `missing ${value}`);
  assert.equal(source.includes('knowledge-retrieval'), false);
  assert.equal(source.includes('79f29333-2e70-4248-9b08-ef5584dafa27'), false);
  assert.equal(/app-[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9]/i.test(source), false);
});

test('memory fixture covers a proposed path and an insufficient-evidence path', async () => {
  const fixture = JSON.parse(await readFile(MEMORY_FIXTURE_URL, 'utf8'));
  assert.equal(fixture.contains_credentials, false);
  assert.deepEqual(fixture.cases.map(item => item.expected.output_key), [
    'proposal_result_json',
    'blocked_result_json'
  ]);
  const positiveContext = JSON.parse(fixture.cases[0].request.inputs.context_json);
  assert.deepEqual(positiveContext.person_ids, ['person-self']);
  assert.equal(positiveContext.messages.length, 1);
  assert.equal(fixture.cases[0].expected.summary_required, true);
});

test('product match DSL is an independent candidate and reference-gated workflow', async () => {
  const summary = execFileSync('ruby', [
    '-e',
    "require 'yaml'; d=YAML.load_file(ARGV[0]); puts [d.dig('app','mode'),d.dig('workflow','graph','nodes').length,d.dig('workflow','graph','edges').length].join(',')",
    fileURLToPath(MATCH_DSL_URL)
  ], { encoding: 'utf8' }).trim();
  assert.equal(summary, 'workflow,7,6');
  const source = await readFile(MATCH_DSL_URL, 'utf8');
  for (const value of [
    'product-match.v1',
    'deepseek-flash',
    'untrusted_verified_rules',
    'allowed_json',
    'dify_candidate_out_of_scope',
    'dify_citation_out_of_scope',
    'dify_case_out_of_scope',
    'dify_payment_year_out_of_scope',
    'blocked_result_json',
    'match_result_json'
  ]) assert.ok(source.includes(value), `missing ${value}`);
  assert.equal(source.includes('knowledge-retrieval'), false);
  assert.equal(source.includes('dataset_ids'), false);
  assert.equal(/app-[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9]/i.test(source), false);
});

test('product match fixture contains only minimal profile values and covers both routes', async () => {
  const fixture = JSON.parse(await readFile(MATCH_FIXTURE_URL, 'utf8'));
  assert.equal(fixture.contains_credentials, false);
  assert.deepEqual(fixture.cases.map(item => item.expected.output_key), ['match_result_json', 'blocked_result_json']);
  const context = JSON.parse(fixture.cases[0].request.inputs.context_json);
  const rules = JSON.parse(fixture.cases[0].request.inputs.rules_json);
  assert.equal(Object.hasOwn(context, 'customer_id'), false);
  assert.equal(Object.hasOwn(context, 'person_ids'), false);
  assert.equal(Object.hasOwn(context, 'context_versions'), false);
  assert.deepEqual(rules[0].reasons[0], {
    code: 'age_budget_ok',
    message: '已确认年龄与预算通过演练规则',
    citation_ids: ['fixture-rules#age-budget']
  });
});
