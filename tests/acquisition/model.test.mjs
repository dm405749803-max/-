import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeepSeekRunner } from '../../services/acquisition/model.mjs';

test('DeepSeek 适配器将密钥留在请求头，要求 JSON，并保留服务返回的用量', async () => {
  let request;
  const runner = createDeepSeekRunner({ apiKey: 'fixture-key-not-real', fetchImpl: async (url, options) => {
    request = { url, ...options }; return Response.json({ model: 'deepseek-flash', choices: [{ finish_reason: 'stop', message: { content: '{"summary":"test"}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  } });
  const result = await runner.run({ system: '返回 JSON', payload: { text: '文案' } });
  assert.equal(request.url, 'https://api.deepseek.com/chat/completions'); assert.equal(request.headers.authorization, 'Bearer fixture-key-not-real');
  assert.equal(JSON.parse(request.body).response_format.type, 'json_object'); assert.doesNotMatch(request.body, /fixture-key/);
  assert.equal(JSON.parse(request.body).thinking.type, 'disabled');
  assert.equal(result.usage.prompt_tokens, 10);
});
test('未配置、鉴权错误、输出截断和无效 JSON 均不会返回成功产物', async () => {
  await assert.rejects(createDeepSeekRunner().run({ system: '', payload: {} }), { code: 'MODEL_NOT_CONFIGURED' });
  const run = body => createDeepSeekRunner({ apiKey: 'test', fetchImpl: async () => Response.json(body) }).run({ system: '', payload: {} });
  await assert.rejects(run({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }), { code: 'MODEL_OUTPUT_INCOMPLETE' });
  await assert.rejects(run({ choices: [{ finish_reason: 'stop', message: { content: 'not JSON' } }] }), { code: 'MODEL_INVALID_JSON' });
  const bad = createDeepSeekRunner({ apiKey: 'test', fetchImpl: async () => Response.json({ secret: 'not surfaced' }, { status: 401 }) });
  await assert.rejects(bad.run({ system: '', payload: {} }), { code: 'MODEL_AUTH_FAILED' });
});
