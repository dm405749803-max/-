const APPROVED = 'approved';
const ENVIRONMENTS = new Set(['real', 'simulation']);

function text(value, max = 4000) {
  return String(value ?? '').trim().slice(0, max);
}

function compact(value) {
  return text(value, 8000).toLowerCase().replace(/[\s　，。；：！？,.;:!?()[\]{}《》“”'"`~_—-]+/g, '');
}

function stringList(value, maxItems = 20, maxLength = 200) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => text(item, maxLength)).filter(Boolean))].slice(0, maxItems);
}

function scopeReason(item, request) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return 'invalid_experience';
  if (!text(item.experience_id, 160)) return 'missing_experience_id';
  if (!text(item.source_review_id, 160)) return 'missing_source_review_id';
  if (item.approval_status !== APPROVED) return 'not_approved';
  if (!text(item.version, 160)) return 'missing_version';
  if (item.workspace_id !== undefined && text(item.workspace_id, 160) !== text(request.workspace_id, 160)) return 'workspace_mismatch';
  if (item.environment !== request.environment) return 'environment_mismatch';

  const productId = text(request.product_scope?.product_id, 160);
  const productVersion = text(request.product_scope?.product_version, 160);
  if (!productId || !productVersion) return 'missing_product_scope';
  if (text(item.product_id, 160) !== productId) return 'product_mismatch';
  if (text(item.product_version, 160) !== productVersion) return 'product_version_mismatch';
  if (!text(item.content, 3000)) return 'missing_content';
  return null;
}

function relevance(item, query) {
  const normalizedQuery = compact(query);
  const terms = [...stringList(item.topics), ...stringList(item.keywords)];
  let score = 0;
  const reasons = [];
  for (const term of terms) {
    const normalizedTerm = compact(term);
    if (normalizedTerm.length >= 2 && normalizedQuery.includes(normalizedTerm)) {
      score += Math.min(8, Math.max(3, normalizedTerm.length));
      reasons.push(`term:${term}`);
    }
  }
  const content = compact(item.content);
  for (let index = 0; index + 1 < normalizedQuery.length; index += 1) {
    const pair = normalizedQuery.slice(index, index + 2);
    if (content.includes(pair)) score += 1;
  }
  return { score, reasons };
}

function normalize(item, score, reasons) {
  return {
    experience_id: text(item.experience_id, 160),
    source_review_id: text(item.source_review_id, 160),
    approval_status: APPROVED,
    version: text(item.version, 160),
    environment: item.environment,
    product_id: text(item.product_id, 160),
    product_version: text(item.product_version, 160),
    content: text(item.content, 3000),
    topics: stringList(item.topics),
    keywords: stringList(item.keywords),
    follow_up_suggestion: text(item.follow_up_suggestion, 500) || null,
    score,
    match_reasons: reasons
  };
}

/**
 * Builds the optional runSalesAssist retrieveExperiences dependency.
 *
 * listApprovedExperiences is called as:
 *   listApprovedExperiences(workspaceId, { environment, product_id, product_version })
 * and must return an array, or { experiences: [] }, using the canonical fields
 * validated above. This adapter rechecks approval, tenant/environment/product
 * scope and relevance; unrecognized fields never leave the adapter.
 */
export function createApprovedExperienceRetriever({ listApprovedExperiences } = {}) {
  if (typeof listApprovedExperiences !== 'function') throw new TypeError('listApprovedExperiences is required');
  return async function retrieveExperiences(request = {}) {
    const workspaceId = text(request.workspace_id, 160);
    const query = text(request.query, 5000);
    const interactionType = request.interaction_type === 'contract_service' ? 'contract_service' : 'new_consultation';
    const environment = request.environment;
    const productId = text(request.product_scope?.product_id, 160);
    const productVersion = text(request.product_scope?.product_version, 160);
    if (!workspaceId || !query || !ENVIRONMENTS.has(environment) || !productId || !productVersion) {
      return { status: 'invalid_request', interaction_type: interactionType, experiences: [], rejected: [] };
    }

    const raw = await listApprovedExperiences(workspaceId, {
      environment,
      product_id: productId,
      product_version: productVersion
    });
    const items = Array.isArray(raw) ? raw : Array.isArray(raw?.experiences) ? raw.experiences : [];
    const eligible = [];
    const rejected = [];
    const minimumScore = Number.isFinite(request.minimum_score) ? Math.max(1, Number(request.minimum_score)) : 3;
    for (const item of items) {
      const reason = scopeReason(item, { ...request, workspace_id: workspaceId, environment });
      if (reason) {
        rejected.push({ experience_id: text(item?.experience_id, 160) || null, reason });
        continue;
      }
      const match = relevance(item, query);
      if (match.score < minimumScore) {
        rejected.push({ experience_id: text(item.experience_id, 160), reason: 'low_relevance', score: match.score });
        continue;
      }
      eligible.push(normalize(item, match.score, match.reasons));
    }
    eligible.sort((a, b) => b.score - a.score || a.experience_id.localeCompare(b.experience_id));
    const limit = Math.max(1, Math.min(5, Number(request.limit) || 3));
    const experiences = eligible.slice(0, limit);
    return {
      status: experiences.length ? 'ready' : 'not_found',
      interaction_type: interactionType,
      experiences,
      rejected
    };
  };
}

export const __test = { compact, scopeReason, relevance };
