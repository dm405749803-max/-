import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../../dify/', import.meta.url);
const workflows = new Map();
function runCode(file, id, args) {
  if (!workflows.has(file)) workflows.set(file, JSON.parse(execFileSync('ruby', ['-rjson', '-ryaml', '-e',
    'puts JSON.generate(YAML.load_file(ARGV[0]))', fileURLToPath(new URL(file, root))], { encoding: 'utf8' })));
  const code = workflows.get(file).workflow.graph.nodes.find(node => node.id === id).data.code;
  const output = execFileSync('python3', ['-c', 'import json,sys; p=json.load(sys.stdin); scope={}; exec(p["code"],scope); print(json.dumps(scope["main"](**p["args"])))'],
    { input: JSON.stringify({ code, args }), encoding: 'utf8' });
  return JSON.parse(output);
}
const a = 'tongpin-sales-assist-a-batch.yml';
const b1 = 'tongpin-memory-proposal-b1.yml';
const b2 = 'tongpin-product-match-b2.yml';

test('A knowledge retrieval keeps the six-library local embedding and rerank contract', () => {
  if (!workflows.has(a)) workflows.set(a, JSON.parse(execFileSync('ruby', ['-rjson', '-ryaml', '-e',
    'puts JSON.generate(YAML.load_file(ARGV[0]))', fileURLToPath(new URL(a, root))], { encoding: 'utf8' })));
  const node = workflows.get(a).workflow.graph.nodes.find(item => item.id === 'knowledge-retrieval');
  assert.equal(node.data.retrieval_mode, 'multiple');
  assert.equal(node.data.dataset_ids.length, 6);
  assert.equal(node.data.multiple_retrieval_config.top_k, 5);
  assert.equal(node.data.multiple_retrieval_config.reranking_enable, true);
  assert.equal(node.data.multiple_retrieval_config.reranking_mode, 'reranking_model');
  assert.deepEqual(node.data.multiple_retrieval_config.reranking_model, {
    reranking_provider_name: 'langgenius/ollama/ollama',
    reranking_model_name: 'BAAI/bge-reranker-v2-m3'
  });
});

test('A executable preflight admits fixture evidence only in simulation and exact version', () => {
  const fixture = JSON.parse(readFileSync(new URL('api-verification-fixture.json', root), 'utf8'));
  const args = fixture.cases[0].request.inputs;
  assert.equal(runCode(a, 'preflight', args).route, 'READY');
  assert.equal(runCode(a, 'preflight', fixture.cases[1].request.inputs).route, 'BLOCKED');
  const context = JSON.parse(args.context_json);
  context.environment = 'real';
  assert.equal(JSON.parse(runCode(a, 'preflight', { ...args, context_json: JSON.stringify(context) }).result_json).status, 'needs_source');
});

test('A executable gates stop risk and model route overrides before generation', () => {
  const fixture = JSON.parse(readFileSync(new URL('api-verification-fixture.json', root), 'utf8'));
  const args = fixture.cases[0].request.inputs;
  assert.equal(JSON.parse(runCode(a, 'preflight', { ...args, latest_message: '找人工处理' }).result_json).status, 'human_required');
  const context = { ...JSON.parse(args.context_json), conversation_route: 'product_match' };
  assert.equal(runCode(a, 'preflight', { ...args, context_json: JSON.stringify(context) }).route, 'BLOCKED');
  const result = JSON.parse(runCode(a, 'postcheck', { model_text: JSON.stringify({ draft: '说明', citation_ids: ['allowed', 'forged'] }), allowed_citations_json: '["allowed"]' }).result_json);
  assert.equal(result.status, 'invalid_output');
  assert.equal(result.draft, '');
});

test('B1 executable input validation cannot mistake malformed or wrong-turn data for no new facts', () => {
  const bad = runCode(b1, 'preflight', { schema_version: 'wrong', context_json: '{}' });
  assert.equal(JSON.parse(bad.result_json).status, 'invalid_context');
  const fixture = JSON.parse(readFileSync(new URL('memory-input-output-fixture.json', root), 'utf8'));
  const args = fixture.cases[0].request.inputs;
  assert.equal(runCode(b1, 'preflight', args).route, 'READY');
  const context = JSON.parse(args.context_json);
  context.latest_message_id = 'different-message';
  const output = JSON.parse(runCode(b1, 'preflight', { ...args, context_json: JSON.stringify(context) }).result_json);
  assert.equal(output.status, 'invalid_context');
  assert.ok(output.missing_evidence.includes('latest_customer_evidence_missing'));
  const preflight = runCode(b1, 'preflight', args);
  const misleading = JSON.parse(runCode(b1, 'postcheck', {
    safe_context_json: preflight.safe_context_json,
    allowed_message_ids_json: preflight.allowed_message_ids_json,
    allowed_person_ids_json: preflight.allowed_person_ids_json,
    opportunity_id: preflight.opportunity_id,
    model_text: JSON.stringify({ status: 'insufficient_evidence', facts: [{ field: 'age', value: 99 }] })
  }).result_json);
  assert.equal(misleading.status, 'invalid_output');
});

test('B2 executable postcheck rejects verdict/product/payment mutations instead of stripping them', () => {
  const allowed = { c1: { product_id: 'p1', product_version: 'v1', status: 'eligible_for_discussion', years: [3], citation_ids: ['doc#rules'], case_ids: [] } };
  const candidate = { candidate_id: 'c1', explanation: '已确认条件符合该版本规则。', citation_ids: ['doc#rules'], case_ids: [] };
  for (const mutation of [{ product_id: 'p2' }, { product_version: 'v2' }, { status: 'not_matched' }, { allowed_payment_years: [5] }]) {
    const result = JSON.parse(runCode(b2, 'postcheck', { allowed_json: JSON.stringify(allowed), model_text: JSON.stringify({ status: 'ready', candidates: [{ ...candidate, ...mutation }] }) }).result_json);
    assert.equal(result.status, 'invalid_output');
    assert.deepEqual(result.candidates, []);
  }
  const valid = JSON.parse(runCode(b2, 'postcheck', { allowed_json: JSON.stringify(allowed), model_text: JSON.stringify({ status: 'ready', candidates: [candidate] }) }).result_json);
  assert.equal(valid.status, 'ready');
});
