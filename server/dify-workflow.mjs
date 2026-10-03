const DEFAULT_TIMEOUT_MS = 30_000;

export class DifyWorkflowError extends Error {
  constructor(code, message, status = null) {
    super(message);
    this.name = 'DifyWorkflowError';
    this.code = code;
    this.status = status;
  }
}

function text(value, max = 1000) {
  return String(value ?? '').trim().slice(0, max);
}

export function createDifyWorkflowRunner(options = {}) {
  const baseUrl = text(options.baseUrl).replace(/\/+$/, '');
  const apiKey = text(options.apiKey, 2000);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = Math.max(100, Math.min(120_000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS));
  if (!baseUrl) throw new TypeError('Dify baseUrl is required');
  if (!apiKey) throw new TypeError('Dify apiKey is required');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
  let insufficientBalanceUntil = 0;

  const upstreamFailure = (body, status) => {
    const detail = String(body?.data?.error || body?.message || '');
    if (/insufficient balance|status code 402|余额不足/i.test(detail)) {
      insufficientBalanceUntil = Date.now() + 5 * 60_000;
      return new DifyWorkflowError('DIFY_INSUFFICIENT_BALANCE', '模型服务余额不足，AI调用已暂时停止。', 402);
    }
    return new DifyWorkflowError('DIFY_UPSTREAM_ERROR', `Dify workflow failed with status ${status}`, status);
  };

  return async function runDify(payload = {}) {
    if (!payload.inputs || typeof payload.inputs !== 'object' || Array.isArray(payload.inputs)) throw new TypeError('Dify inputs are required');
    if (Date.now() < insufficientBalanceUntil) {
      throw new DifyWorkflowError('DIFY_INSUFFICIENT_BALANCE', '模型服务余额不足，AI调用已暂时停止。', 402);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}/workflows/run`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          inputs: payload.inputs,
          response_mode: 'blocking',
          user: text(payload.user, 255) || 'tongpin-sales-assist-v2'
        }),
        signal: controller.signal
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || body?.data?.status === 'failed') throw upstreamFailure(body, response.status);
      if (!body || typeof body !== 'object') throw new DifyWorkflowError('DIFY_INVALID_RESPONSE', 'Dify workflow returned an invalid response', response.status);
      return body;
    } catch (error) {
      if (error instanceof DifyWorkflowError) throw error;
      if (error?.name === 'AbortError') throw new DifyWorkflowError('DIFY_TIMEOUT', 'Dify workflow timed out');
      throw new DifyWorkflowError('DIFY_UNREACHABLE', 'Dify workflow is unavailable');
    } finally {
      clearTimeout(timer);
    }
  };
}
