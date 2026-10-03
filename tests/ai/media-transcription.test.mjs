import test from 'node:test';
import assert from 'node:assert/strict';
import { createDashScopeTranscriber, MediaTranscriptionError } from '../../server/media-transcription.mjs';

test('Qwen Audio adapter sends video as inline media and returns review-required text', async () => {
  const calls = [];
  const transcribe = createDashScopeTranscriber({
    apiKey: 'secret-test-key',
    baseUrl: 'https://example.test/api/v1',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => ({ output: { text: '我妈妈58岁，想帮她看养老。' }, usage: { duration: 8 }, request_id: 'asr-run-1' }) };
    }
  });
  const result = await transcribe({ filename: '客户视频.mp4', mime_type: 'video/mp4', data_base64: Buffer.from('short-media').toString('base64'), duration_seconds: 8 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.test/api/v1/services/aigc/multimodal-generation/generation');
  assert.equal(calls[0].options.headers.authorization, 'Bearer secret-test-key');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, 'qwen-audio-3.1-asr-flash');
  assert.equal(body.parameters.format, 'mp4');
  assert.match(body.input.messages[0].content[0].input_audio.data, /^data:video\/mp4;base64,/);
  assert.equal(result.status, 'review_required');
  assert.equal(result.transcript, '我妈妈58岁，想帮她看养老。');
  assert.equal(result.media_kind, 'video');
  assert.equal(result.needs_human_review, true);
  assert.ok(result.review_hints.some(item => item.includes('金额')));
  assert.doesNotMatch(JSON.stringify(result), /secret-test-key/);
});

test('media limits and formats are rejected before an upstream request', async () => {
  let calls = 0;
  const transcribe = createDashScopeTranscriber({ apiKey: 'test', fetchImpl: async () => { calls += 1; return { ok: true, json: async () => ({}) }; } });
  const sample = Buffer.from('sample').toString('base64');
  await assert.rejects(() => transcribe({ filename: 'record.exe', mime_type: 'application/octet-stream', data_base64: sample }), error => error instanceof MediaTranscriptionError && error.code === 'UNSUPPORTED_MEDIA_TYPE');
  await assert.rejects(() => transcribe({ filename: 'record.mp3', mime_type: 'audio/mpeg', data_base64: sample, duration_seconds: 301 }), error => error.code === 'MEDIA_DURATION_UNSUPPORTED');
  await assert.rejects(() => transcribe({ filename: 'record.mp3', mime_type: 'audio/mpeg', data_base64: Buffer.alloc(7_000_001).toString('base64') }), error => error.code === 'MEDIA_TOO_LARGE');
  assert.equal(calls, 0);
});

test('upstream errors are sanitized and never expose the API key', async () => {
  const transcribe = createDashScopeTranscriber({ apiKey: 'do-not-leak', fetchImpl: async () => ({ ok: false, json: async () => ({ message: 'bad request do-not-leak' }) }) });
  await assert.rejects(() => transcribe({ filename: 'record.wav', mime_type: 'audio/wav', data_base64: Buffer.from('sample').toString('base64') }), error => {
    assert.equal(error.code, 'ASR_UPSTREAM_ERROR');
    assert.doesNotMatch(error.message, /do-not-leak/);
    return true;
  });
});
