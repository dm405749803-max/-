import test from 'node:test';
import assert from 'node:assert/strict';
import { proposeMemory } from '../../ai/memory-proposal.mjs';

test('B1 preserves the provider failure category instead of pretending the schema is invalid', async () => {
  const result = await proposeMemory({
    schema_version: 'sales-assist.v1', workspace_id: 'w1', customer_id: 'c1', opportunity_id: 'o1',
    latest_message_id: 'm1', environment: 'simulation', persons: [], person_ids: [], confirmed_facts: [],
    recent_messages: [{ message_id: 'm1', role: 'customer', text: '你好', status: 'received', environment: 'simulation' }],
    context_versions: { latest_message_id: 'm1' }
  }, { runDify: async () => { const error = new Error('sanitized'); error.code = 'DIFY_INSUFFICIENT_BALANCE'; throw error; } });
  assert.equal(result.status, 'error');
  assert.deepEqual(result.missing_evidence, ['DIFY_INSUFFICIENT_BALANCE']);
});
