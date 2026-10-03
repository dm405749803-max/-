import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const payload = JSON.parse(await readFile(new URL('../../evaluation/sales-v1-cases.json', import.meta.url), 'utf8'));

test('sales V1 evaluation dataset contains 100 unique natural-language cases', () => {
  assert.equal(payload.schema_version, 'sales-evaluation.v1');
  assert.equal(payload.total, 100);
  assert.equal(payload.cases.length, 100);
  assert.equal(new Set(payload.cases.map(item => item.id)).size, 100);
  assert.deepEqual(Object.fromEntries(Object.entries(Object.groupBy(payload.cases, item => item.group_code)).map(([key, values]) => [key, values.length])), {
    A: 10, B: 15, C: 10, D: 15, E: 15, F: 10, G: 5, H: 20
  });
});

test('every evaluation case remains readable by business reviewers', () => {
  for (const item of payload.cases) {
    assert.match(item.id, /^[A-H]\d{2}$/);
    assert.ok(item.scenario.length > 3, item.id);
    assert.ok(item.expected.length > 3, item.id);
    assert.ok((item.failure_condition || item.success_condition).length > 3, item.id);
    assert.ok(item.suggested_input.length > 0, item.id);
    assert.equal(item.requires_human_judgment, true);
  }
});

test('product-specific RAG cases carry the expected simulation scope', () => {
  const byId = Object.fromEntries(payload.cases.map(item => [item.id, item]));
  assert.equal(byId.E01.product_id, 'practice-savings-endowment');
  assert.equal(byId.E01.product_version, 'practice-2026-09-v2');
  assert.equal(byId.E05.product_id, 'practice-education-annuity');
});
