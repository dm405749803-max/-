import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeepSeekRunner } from '../../server/deepseek-client.mjs';
const response = { id: 'test-run', choices: [{ finish_reason: 'stop', message: { content: '{"status":"proposed","facts":[]}', reasoning_content: 'private-reasoning' } }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } };
for (const workflow of ['A_sales_draft', 'B1_memory', 'B2_product_match']) {
  test(`${workflow}: request and established result contract`, async () => {
    let request;
    const client = { chat: { completions: { create: async body => { request = body; return response; } } } };
    const result = await createDeepSeekRunner({ client, workflow })({ inputs: { context_json: '{}' } });
    assert.equal(request.model, 'deepseek-flash');
    assert.deepEqual(request.thinking, { type: 'enabled' });
    assert.equal(request.reasoning_effort, 'high');
    assert.equal(request.stream, false);
    assert.equal(result.data.total_tokens, 20);
    assert.equal(JSON.parse(result.data.outputs.result_json).status, 'proposed');
    assert.ok(!JSON.stringify(result).includes('private-reasoning'));
  });
}
test('does not leak upstream credential-bearing error messages', async () => {
  const client = { chat: { completions: { create: async () => { throw { status: 401, message: 'secret-test-key' }; } } } };
  await assert.rejects(createDeepSeekRunner({ client })({ inputs: {} }), { message: 'DEEPSEEK_AUTH_FAILED' });
});
for (const [label, value] of [['malformed JSON', { ...response, choices: [{ finish_reason: 'stop', message: { content: 'not json' } }] }], ['truncated result', { ...response, choices: [{ finish_reason: 'length', message: { content: '{}' } }] }]]) {
  test(`rejects ${label}`, async () => {
    const client = { chat: { completions: { create: async () => value } } };
    await assert.rejects(createDeepSeekRunner({ client })({ inputs: {} }));
  });
}
test('rejects unknown workflow and oversized input', async () => {
  assert.throws(() => createDeepSeekRunner({ workflow: 'arbitrary' }));
  const client = { chat: { completions: { create: async () => { throw new Error('must not call'); } } } };
  await assert.rejects(createDeepSeekRunner({ client })({ inputs: { text: 'x'.repeat(120001) } }), /AI_INPUT_TOO_LARGE/);
});
