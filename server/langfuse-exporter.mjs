import { createHash } from 'node:crypto';

const json = value => JSON.stringify(value ?? null);
const parse = (value, fallback = null) => { try { return value == null ? fallback : JSON.parse(value); } catch { return fallback; } };
const attr = (key, value) => ({ key, value: typeof value === 'boolean' ? { boolValue: value } : { stringValue: String(value) } });
const arrayAttr = (key, values) => ({ key, value: { arrayValue: { values: values.map(value => ({ stringValue: String(value) })) } } });
const nanos = value => String(BigInt(Date.parse(value || new Date().toISOString())) * 1_000_000n);
const rootSpanId = traceId => createHash('sha256').update(`tongpin-root:${traceId}`).digest('hex').slice(0, 16);

function observationType(type) {
  if (type === 'generation') return 'generation';
  if (type === 'retriever') return 'retriever';
  return 'span';
}

function resourceSpans(spans, publicKey, environment) {
  return [{
    resource: { attributes: [attr('service.name', 'tongpin-sales-backend'), attr('deployment.environment', environment)] },
    scopeSpans: [{
      scope: {
        name: 'tongpin-observability',
        version: '1.0.0',
        attributes: [attr('public_key', publicKey)]
      },
      spans
    }]
  }];
}

function traceSpan(trace) {
  const metadata = trace.metadata || parse(trace.metadata_json, {}) || {};
  const tags = [trace.case_id ? 'evaluation' : 'conversation', trace.status || 'unknown'];
  if (metadata.quality_state) tags.push(String(metadata.quality_state));
  if (metadata.badcase_id && metadata.quality_state !== 'passed') tags.push('badcase');
  if (metadata.severity) tags.push(String(metadata.severity));
  const attributes = [
    attr('langfuse.observation.type', 'span'),
    attr('langfuse.trace.name', trace.name || 'customer-message'),
    attr('langfuse.observation.input', json(trace.input ?? parse(trace.input_json))),
    attr('langfuse.observation.output', json(trace.output ?? parse(trace.output_json))),
    attr('langfuse.trace.input', json(trace.input ?? parse(trace.input_json))),
    attr('langfuse.trace.output', json(trace.output ?? parse(trace.output_json))),
    arrayAttr('langfuse.trace.tags', [...new Set(tags)]),
    attr('langfuse.trace.public', false)
  ];
  if (trace.session_id) attributes.push(attr('langfuse.session.id', trace.session_id));
  if (trace.customer_id) attributes.push(attr('langfuse.user.id', trace.customer_id));
  for (const [key, value] of Object.entries({ ...metadata, case_id: trace.case_id, eval_run_id: trace.eval_run_id, opportunity_id: trace.opportunity_id })) {
    if (value != null && value !== '') attributes.push(attr(`langfuse.trace.metadata.${key}`, json(value)));
  }
  return {
    traceId: trace.trace_id,
    spanId: rootSpanId(trace.trace_id),
    name: trace.name || 'customer-message',
    kind: 1,
    startTimeUnixNano: nanos(trace.started_at),
    endTimeUnixNano: nanos(trace.ended_at || new Date().toISOString()),
    attributes,
    status: { code: trace.status === 'error' ? 2 : 1, message: trace.error_code || '' }
  };
}

function childSpan(trace, observation) {
  const metadata = observation.metadata || parse(observation.metadata_json, {}) || {};
  const usage = {
    input_tokens: observation.input_tokens ?? undefined,
    output_tokens: observation.output_tokens ?? undefined,
    total_tokens: observation.total_tokens ?? undefined
  };
  const attributes = [
    attr('langfuse.observation.type', observationType(observation.type)),
    attr('langfuse.observation.input', json(observation.input ?? parse(observation.input_json))),
    attr('langfuse.observation.output', json(observation.output ?? parse(observation.output_json))),
    attr('langfuse.observation.usage_details', json(Object.fromEntries(Object.entries(usage).filter(([, value]) => value != null))))
  ];
  if (observation.model) attributes.push(attr('langfuse.observation.model.name', observation.model));
  if (observation.error_code) attributes.push(attr('langfuse.observation.status_message', observation.error_code));
  for (const [key, value] of Object.entries({ ...metadata, estimated_cost_cny: observation.cost_cny })) {
    if (value != null && value !== '') attributes.push(attr(`langfuse.observation.metadata.${key}`, json(value)));
  }
  return {
    traceId: trace.trace_id,
    spanId: observation.observation_id,
    parentSpanId: observation.parent_observation_id || rootSpanId(trace.trace_id),
    name: observation.name,
    kind: 1,
    startTimeUnixNano: nanos(observation.started_at),
    endTimeUnixNano: nanos(observation.ended_at || new Date().toISOString()),
    attributes,
    status: { code: observation.status === 'error' ? 2 : 1, message: observation.error_code || '' }
  };
}

export function createLangfuseExporter({ baseUrl, publicKey, secretKey, environment = 'local', fetchImpl = fetch, onError = console.warn } = {}) {
  const configured = Boolean(baseUrl && publicKey && secretKey);
  const endpoint = `${String(baseUrl || '').replace(/\/$/, '')}/api/public/otel/v1/traces`;

  async function send(spans) {
    if (!configured || !spans.length) return { skipped: true };
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}`,
        'content-type': 'application/json',
        'x-langfuse-ingestion-version': '4',
        'x-langfuse-sdk-name': 'tongpin-observability',
        'x-langfuse-sdk-version': '1.0.0'
      },
      body: JSON.stringify({ resourceSpans: resourceSpans(spans, publicKey, environment) })
    });
    if (!response.ok) throw new Error(`LANGFUSE_EXPORT_${response.status}`);
    return { exported: spans.length };
  }

  const safeSend = spans => send(spans).catch(error => {
    onError?.(`Langfuse 导出失败：${error.message}`);
    return { error: error.message };
  });

  return {
    configured,
    endpoint,
    exportTrace: trace => trace ? safeSend([traceSpan(trace)]) : Promise.resolve({ skipped: true }),
    exportObservation: (trace, observation) => trace && observation
      ? safeSend([childSpan(trace, observation)])
      : Promise.resolve({ skipped: true })
  };
}

export const __test = { rootSpanId, traceSpan, childSpan, resourceSpans, nanos };
