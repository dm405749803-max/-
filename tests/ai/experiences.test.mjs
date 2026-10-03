import test from 'node:test';
import assert from 'node:assert/strict';
import { createApprovedExperienceRetriever } from '../../knowledge/experiences.mjs';

function item(overrides = {}) {
  return {
    experience_id: 'experience-1',
    source_review_id: 'review-1',
    approval_status: 'approved',
    version: '1',
    workspace_id: 'workspace-1',
    environment: 'real',
    product_id: 'product-1',
    product_version: 'v1',
    content: '客户问交费期时，先确认是否已经有偏好。',
    topics: ['交费'],
    keywords: ['几年交'],
    follow_up_suggestion: '您更倾向一次交清，还是分几年安排？',
    private_notes: '不应进入结果',
    ...overrides
  };
}

function request(overrides = {}) {
  return {
    workspace_id: 'workspace-1',
    environment: 'real',
    product_scope: { product_id: 'product-1', product_version: 'v1' },
    query: '这款可以选几年交费？',
    interaction_type: 'new_consultation',
    ...overrides
  };
}

test('adapter calls SalesOps with the fixed signature and returns only canonical approved fields', async () => {
  let called;
  const retrieve = createApprovedExperienceRetriever({
    listApprovedExperiences: async (...args) => { called = args; return [item()]; }
  });
  const result = await retrieve(request());
  assert.deepEqual(called, ['workspace-1', { environment: 'real', product_id: 'product-1', product_version: 'v1' }]);
  assert.equal(result.status, 'ready');
  assert.equal(result.experiences[0].experience_id, 'experience-1');
  assert.equal(Object.hasOwn(result.experiences[0], 'private_notes'), false);
});

test('approval, tenant, environment, product version and relevance are all rechecked', async () => {
  const retrieve = createApprovedExperienceRetriever({
    listApprovedExperiences: async () => [
      item({ experience_id: 'pending', approval_status: 'pending' }),
      item({ experience_id: 'other-workspace', workspace_id: 'other' }),
      item({ experience_id: 'simulation', environment: 'simulation' }),
      item({ experience_id: 'other-version', product_version: 'v2' }),
      item({ experience_id: 'irrelevant', content: '投诉转人工。', topics: ['投诉'], keywords: ['投诉'] }),
      item()
    ]
  });
  const result = await retrieve(request());
  assert.deepEqual(result.experiences.map(value => value.experience_id), ['experience-1']);
  assert.deepEqual(new Set(result.rejected.map(value => value.reason)), new Set([
    'not_approved', 'workspace_mismatch', 'environment_mismatch', 'product_version_mismatch', 'low_relevance'
  ]));
});

test('invalid requests do not call storage', async () => {
  let calls = 0;
  const retrieve = createApprovedExperienceRetriever({ listApprovedExperiences: async () => { calls += 1; return []; } });
  const result = await retrieve(request({ environment: undefined }));
  assert.equal(result.status, 'invalid_request');
  assert.equal(calls, 0);
});
