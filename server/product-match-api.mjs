import { randomUUID } from 'node:crypto';
import { ApiError, assertApi } from './errors.mjs';

export function createProductMatchApi({ products, recommendations, readJson, sendJson }) {
  return async (req, res, url) => {
    if (!url.pathname.startsWith('/api/v2/product-match/')) return false;
    const traceId = `trace_${randomUUID()}`;
    const ok = (data, status = 200) => sendJson(res, status, { data, trace_id: traceId });
    try {
      const ws = String(req.headers['x-workspace-id'] || 'demo');
      assertApi(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(ws), 400, 'INVALID_WORKSPACE_ID', 'workspace_id 格式无效。');
      const body = async () => {
        try { const value = await readJson(req, 500_000); assertApi(value && typeof value === 'object' && !Array.isArray(value), 400, 'INVALID_JSON', '请输入 JSON 对象。'); return value; }
        catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(400, 'INVALID_JSON', 'JSON 无效或请求过大。'); }
      };
      const filters = Object.fromEntries(url.searchParams);
      let match;
      if (url.pathname === '/api/v2/product-match/products' && req.method === 'GET') ok(products.listProducts(ws, filters));
      else if (url.pathname === '/api/v2/product-match/products' && req.method === 'POST') ok(products.putProduct(ws, await body()), 201);
      else if (url.pathname === '/api/v2/product-match/cases' && req.method === 'GET') ok(products.listCases(ws, filters));
      else if (url.pathname === '/api/v2/product-match/recommendations' && req.method === 'GET') ok(recommendations.listAll(ws, filters));
      else if ((match = url.pathname.match(/^\/api\/v2\/product-match\/opportunities\/([^/]+)\/recommendations$/)) && req.method === 'GET') ok(recommendations.list(ws, decodeURIComponent(match[1])));
      else if (match && req.method === 'POST') ok(await recommendations.generate(ws, decodeURIComponent(match[1]), await body()), 201);
      else if ((match = url.pathname.match(/^\/api\/v2\/product-match\/recommendations\/([^/]+)$/)) && req.method === 'GET') ok(recommendations.get(ws, decodeURIComponent(match[1])));
      else if ((match = url.pathname.match(/^\/api\/v2\/product-match\/recommendations\/([^/]+)\/(accept|reject)$/)) && req.method === 'POST') ok(recommendations.decide(ws, decodeURIComponent(match[1]), match[2], await body()));
      else if ((match = url.pathname.match(/^\/api\/v2\/product-match\/recommendations\/([^/]+)\/outcome$/)) && req.method === 'POST') ok(recommendations.recordOutcome(ws, decodeURIComponent(match[1]), await body()), 201);
      else throw new ApiError(404, 'NOT_FOUND', '接口不存在。');
    } catch (error) {
      const known = error instanceof ApiError;
      sendJson(res, known ? error.status : 500, { error: {
        code: known ? error.code : 'INTERNAL_ERROR', message: known ? error.message : '匹配服务暂时不可用。', details: known ? error.details : null
      }, trace_id: traceId });
    }
    return true;
  };
}
