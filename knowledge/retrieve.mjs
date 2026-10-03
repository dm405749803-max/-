import { readFile } from 'node:fs/promises';
import { generalizedProductBundles, isGeneralizedProductScope, isApprovedGeneralizedChunk } from './generalized-products.mjs';

const SAMPLE_URL = new URL('./sample-documents.json', import.meta.url);
const SIMULATION_URL = new URL('./simulation-documents.json', import.meta.url);
const SIMULATION_FIXTURE = Object.freeze({
  document_id: 'fixture-terms-v1',
  version: 'fixture-v1',
  product_id: 'fixture-product',
  product_version: 'fixture-v1',
  scope: 'new_consultation',
  location: '交费期测试段落',
  publisher: '同频 A 批次隔离演练',
  source_label: 'A批次隔离演练文档'
});
const GLOBAL_SIMULATION = Object.freeze({
  product_id: 'GLOBAL',
  product_version: 'global-2026-09-v1',
  publisher: '同频产品方案演练'
});

const TOPIC_PATTERNS = new Map([
  ['payment_term', /(?:交费|缴费|趸交|\d+\s*年交|几年)/i],
  ['plan_calculation', /(?:计划书|测算|方案|能领多少|保额|保费|irr|回本|收益)/i],
  ['cash_value', /(?:现金价值|退保|中途.*用钱)/i],
  ['policy_loan', /(?:保单贷款|贷款|自动垫交)/i],
  ['benefit', /(?:祝贺金|祝福金|满期|身故|领取)/i],
  ['surrender', /(?:退保|解除合同)/i],
  ['complaint', /(?:投诉|举报|纠纷)/i],
  ['education', /(?:教育|上学|留学|大学)/i],
  ['retirement', /(?:养老|退休)/i],
  ['contract_service', /(?:保单|合同|已买|查资料|保全|变更)/i]
]);

function asText(value, max = 10_000) {
  return String(value ?? '').trim().slice(0, max);
}

function compact(value) {
  return asText(value).toLowerCase().replace(/[\s　，。；：！？,.;:!?()[\]{}《》“”'"`~_—-]+/g, '');
}

function dateValue(value) {
  if (!value) return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) ? time : null;
}

function detectedTopics(query) {
  const result = [];
  for (const [topic, pattern] of TOPIC_PATTERNS) if (pattern.test(query)) result.push(topic);
  return result;
}

function documentScopeReason(document, request, nowTime) {
  if (!document || typeof document !== 'object') return 'invalid_document';
  if (document.index_status !== 'ready') return `index_${document.index_status || 'unknown'}`;
  if (!Array.isArray(document.scopes) || !document.scopes.includes(request.interaction_type)) return 'scope_mismatch';

  const productId = asText(request.product_scope?.product_id, 160);
  const isGlobal = document.knowledge_type === 'global'
    && document.product_id === GLOBAL_SIMULATION.product_id
    && document.product_version === GLOBAL_SIMULATION.product_version;
  if (productId && document.product_id && document.product_id !== productId) return 'product_mismatch';

  if (request.interaction_type === 'contract_service') {
    const contractVersion = asText(request.product_scope?.policy_contract_version, 160);
    if (!contractVersion) return 'missing_contract_version';
    const versions = Array.isArray(document.policy_contract_versions) ? document.policy_contract_versions : [];
    if (!versions.includes(contractVersion) && document.product_version !== contractVersion) return 'contract_version_mismatch';
    if (!['active', 'archived_serviceable'].includes(document.lifecycle_status)) return 'not_serviceable';
  } else {
    const productVersion = asText(request.product_scope?.product_version, 160);
    if (!isGlobal && !productVersion) return 'missing_product_version';
    if (!isGlobal && document.product_version && document.product_version !== productVersion) return 'product_version_mismatch';
    if (document.lifecycle_status !== 'active') return 'not_active';
    const starts = dateValue(document.valid_from);
    const ends = dateValue(document.valid_to);
    if (starts !== null && starts > nowTime) return 'not_yet_effective';
    if (ends !== null && ends < nowTime) return 'expired';
  }
  return null;
}

function chunkScore(query, topics, document, chunk) {
  const normalizedQuery = compact(query);
  let score = 0;
  const reasons = [];
  for (const keyword of Array.isArray(chunk.keywords) ? chunk.keywords : []) {
    const normalizedKeyword = compact(keyword);
    if (normalizedKeyword && normalizedQuery.includes(normalizedKeyword)) {
      const points = Math.min(8, Math.max(3, normalizedKeyword.length));
      score += points;
      reasons.push(`keyword:${keyword}`);
    }
  }
  for (const topic of topics) {
    if (Array.isArray(document.topics) && document.topics.includes(topic)) {
      score += 4;
      reasons.push(`topic:${topic}`);
    }
  }
  return { score, reasons };
}

function citationFor(document, chunk) {
  return {
    document_id: document.document_id,
    version: document.version,
    location: chunk.location,
    excerpt: asText(chunk.text, 280),
    title: document.title,
    source_url: document.source?.url || null,
    verification_status: document.verification_status,
    customer_use: document.customer_use
  };
}

export async function loadSampleKnowledge() {
  const parsed = JSON.parse(await readFile(SAMPLE_URL, 'utf8'));
  if (!Array.isArray(parsed)) throw new TypeError('knowledge sample must be an array');
  return parsed;
}

export async function loadSimulationKnowledge() {
  const parsed = JSON.parse(await readFile(SIMULATION_URL, 'utf8'));
  if (!Array.isArray(parsed)) throw new TypeError('simulation knowledge fixture must be an array');
  return [...parsed, ...generalizedProductBundles().map(item => item.document)];
}

function simulationMode(request, dependencies, interactionType) {
  return dependencies.allowSimulationKnowledge === true
    && request.environment === 'simulation'
    && interactionType === SIMULATION_FIXTURE.scope
    && ((asText(request.product_scope?.product_id, 160) === SIMULATION_FIXTURE.product_id
      && asText(request.product_scope?.product_version, 160) === SIMULATION_FIXTURE.product_version)
      || isGeneralizedProductScope(request.product_scope)
      || request.knowledge_scope === 'global');
}

function approvedSimulationChunk(document, chunk, enabled) {
  if (enabled && document.knowledge_type === 'global') {
    return document.product_id === GLOBAL_SIMULATION.product_id
      && document.product_version === GLOBAL_SIMULATION.product_version
      && document.source?.publisher === GLOBAL_SIMULATION.publisher
      && document.scopes?.length === 1 && document.scopes[0] === SIMULATION_FIXTURE.scope
      && document.lifecycle_status === 'active' && document.index_status === 'ready'
      && document.verification_status === 'business_verified'
      && document.customer_use === 'approved_for_simulation'
      && typeof chunk?.location === 'string' && chunk.location.length > 0;
  }
  if (enabled && isApprovedGeneralizedChunk(document, chunk)) {
    return document.scopes?.length === 1 && document.scopes[0] === SIMULATION_FIXTURE.scope
      && document.lifecycle_status === 'active' && document.index_status === 'ready'
      && document.verification_status === 'business_verified'
      && document.customer_use === 'approved_for_simulation';
  }
  return enabled
    && document.document_id === SIMULATION_FIXTURE.document_id
    && document.version === SIMULATION_FIXTURE.version
    && document.product_id === SIMULATION_FIXTURE.product_id
    && document.product_version === SIMULATION_FIXTURE.product_version
    && Array.isArray(document.scopes)
    && document.scopes.length === 1
    && document.scopes[0] === SIMULATION_FIXTURE.scope
    && document.lifecycle_status === 'active'
    && document.index_status === 'ready'
    && document.verification_status === 'business_verified'
    && document.customer_use === 'approved_for_simulation'
    && document.source?.publisher === SIMULATION_FIXTURE.publisher
    && document.source?.label === SIMULATION_FIXTURE.source_label
    && document.source?.url === null
    && chunk.location === SIMULATION_FIXTURE.location;
}

/**
 * Deterministic scope/version/evidence gate. Semantic retrieval can be supplied
 * upstream, but its candidates must still pass this gate before reaching Dify.
 */
export async function retrieveKnowledge(request = {}, dependencies = {}) {
  const query = asText(request.query, 5000);
  const interactionType = request.interaction_type === 'contract_service' ? 'contract_service' : 'new_consultation';
  const nowInput = typeof dependencies.now === 'function' ? dependencies.now() : (request.as_of || new Date());
  const now = nowInput instanceof Date ? nowInput : new Date(nowInput);
  const nowTime = Number.isFinite(now.getTime()) ? now.getTime() : Date.now();
  const simulationEnabled = simulationMode(request, dependencies, interactionType);
  const baseDocuments = Array.isArray(dependencies.documents) ? dependencies.documents : await loadSampleKnowledge();
  const simulationDocuments = simulationEnabled ? await loadSimulationKnowledge() : [];
  const documents = [...baseDocuments, ...simulationDocuments];
  const topics = detectedTopics(query);
  const rejected = [];
  const reviewCandidates = [];
  const eligible = [];
  // Product and version have already passed strict scope checks above. One exact
  // short Chinese business keyword (for example “交费”) is therefore sufficient.
  const minimumScore = Number.isFinite(request.minimum_score) ? Number(request.minimum_score) : 3;

  for (const document of documents) {
    const scopeReason = documentScopeReason(document, { ...request, interaction_type: interactionType }, nowTime);
    if (scopeReason) {
      rejected.push({ document_id: document?.document_id || null, reason: scopeReason });
      continue;
    }
    for (const chunk of Array.isArray(document.chunks) ? document.chunks : []) {
      const relevance = chunkScore(query, topics, document, chunk);
      if (relevance.score < minimumScore) {
        rejected.push({ document_id: document.document_id, location: chunk.location, reason: 'low_relevance', score: relevance.score });
        continue;
      }
      const candidate = {
        document_id: document.document_id,
        version: document.version,
        knowledge_type: document.knowledge_type,
        product_id: document.product_id ?? null,
        product_version: document.product_version ?? null,
        policy_contract_version: interactionType === 'contract_service'
          ? asText(request.product_scope?.policy_contract_version, 160) || null
          : null,
        scope: interactionType,
        lifecycle_status: document.lifecycle_status,
        index_status: document.index_status,
        verification_status: document.verification_status,
        customer_use: document.customer_use,
        location: chunk.location,
        claim_key: asText(chunk.claim_key || chunk.faq_key, 160) || null,
        text: asText(chunk.text, 2000),
        source: document.source,
        score: relevance.score,
        match_reasons: relevance.reasons,
        citation: citationFor(document, chunk)
      };
      const customerApproved = document.verification_status === 'business_verified'
        && (document.customer_use === 'approved' || approvedSimulationChunk(document, chunk, simulationEnabled));
      if (customerApproved) eligible.push(candidate);
      else {
        reviewCandidates.push(candidate);
        rejected.push({ document_id: document.document_id, location: chunk.location, reason: 'business_review_required', score: relevance.score });
      }
    }
  }

  eligible.sort((a, b) => b.score - a.score || a.document_id.localeCompare(b.document_id));
  reviewCandidates.sort((a, b) => b.score - a.score || a.document_id.localeCompare(b.document_id));
  const productId = asText(request.product_scope?.product_id, 160);
  const knowledgeScope = request.knowledge_scope === 'global' ? 'global' : 'product';
  const unkeyed = eligible.filter(item => !item.claim_key);
  const groups = new Map();
  for (const item of eligible.filter(candidate => candidate.claim_key)) {
    const values = groups.get(item.claim_key) || [];
    values.push(item);
    groups.set(item.claim_key, values);
  }
  const selected = [...unkeyed];
  const conflicts = [];
  for (const [claimKey, values] of groups) {
    const preferred = knowledgeScope === 'global'
      ? values.filter(item => item.knowledge_type === 'global')
      : values.filter(item => productId && item.product_id === productId);
    const applicable = preferred.length ? preferred : values;
    for (const item of values) {
      if (!applicable.includes(item)) rejected.push({ document_id: item.document_id, location: item.location, reason: 'shadowed_by_specific_scope', claim_key: claimKey });
    }
    const variants = new Set(applicable.map(item => compact(item.text)));
    if (variants.size > 1) {
      conflicts.push({ claim_key: claimKey, document_ids: applicable.map(item => item.document_id), locations: applicable.map(item => item.location) });
      for (const item of applicable) rejected.push({ document_id: item.document_id, location: item.location, reason: 'evidence_conflict', claim_key: claimKey });
      continue;
    }
    selected.push(...applicable);
  }
  selected.sort((a, b) => b.score - a.score || a.document_id.localeCompare(b.document_id));
  const limited = conflicts.length ? [] : selected.slice(0, Math.max(1, Math.min(8, Number(request.limit) || 5)));
  return {
    query,
    interaction_type: interactionType,
    detected_topics: topics,
    documents: limited,
    citations: limited.map(item => item.citation),
    review_candidates: reviewCandidates.slice(0, 5),
    conflicts,
    rejected,
    evidence_status: conflicts.length ? 'conflict' : limited.length ? 'ready' : reviewCandidates.length ? 'review_required' : 'not_found'
  };
}

export const __test = { compact, detectedTopics, documentScopeReason, chunkScore, simulationMode, approvedSimulationChunk };
