import assert from 'node:assert/strict';
import { generalizedProductBundles } from '../knowledge/generalized-products.mjs';

// Explicit local catalog update, never automatic seeding of a production environment.
const base = process.env.WORKBENCH_BASE_URL || 'http://127.0.0.1:8832';
const workspaceId = process.env.WORKSPACE_ID || 'demo';
const health = await (await fetch(`${base}/api/health`)).json();
assert.ok(health.ok && health.backend_b2_enabled && health.mode === 'local', 'B2 local backend required.');
const next = generalizedProductBundles();
const nextIds = new Set(next.map(item => item.catalog.product_id));
const catalogResponse = await fetch(`${base}/api/v2/product-match/products?environment=simulation`, {
  headers: { 'x-workspace-id': workspaceId }, signal: AbortSignal.timeout(10000)
});
const active = (await catalogResponse.json()).data?.items || [];
for (const previous of active.filter(item => nextIds.has(item.product_id)
  && !next.some(nextItem => nextItem.catalog.product_id === item.product_id
    && nextItem.catalog.product_version === item.product_version))) {
  const response = await fetch(`${base}/api/v2/product-match/products`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId },
    body: JSON.stringify({ ...previous, catalog_status: 'inactive', expected_revision: previous.revision,
      idempotency_key: `retire-${previous.product_id}-${previous.product_version}` }),
    signal: AbortSignal.timeout(10000)
  });
  const result = await response.json();
  assert.equal(response.status, 201, JSON.stringify(result.error));
}
for (const { catalog } of next) {
  const response = await fetch(`${base}/api/v2/product-match/products`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId },
    body: JSON.stringify(catalog), signal: AbortSignal.timeout(10000)
  });
  const result = await response.json();
  assert.equal(response.status, 201, JSON.stringify(result.error));
  console.log(JSON.stringify({ workspace_id: workspaceId, product_id: catalog.product_id, name: catalog.name, environment: 'simulation', replay: Boolean(result.data?.idempotent_replay) }));
}
