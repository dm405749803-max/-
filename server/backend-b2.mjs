import { createProductMatchService } from './product-match/index.mjs';
import { createRecommendationService } from './recommendations.mjs';
import { createProductMatchApi } from './product-match-api.mjs';
import { runProductMatch } from '../ai/product-match.mjs';
import { buildContext } from './context.mjs';
import { assertApi } from './errors.mjs';

export function createBackendB2({store, readJson, sendJson, runMatchDify = null, allowSimulationProducts = false, now = () => new Date()}) {
  const products = createProductMatchService({ store, now, allowSimulationProducts });
  const recommendations = createRecommendationService({
    store, now,
    evaluate: context => products.evaluate(context),
    putCase: (workspaceId, input) => products.putCase(workspaceId, input),
    generate: (context, rules) => runProductMatch(context, {
      evaluateCandidates: () => rules,
      retrieveCases: (current, candidate) => products.retrieveCases(current, candidate),
      runDify: runMatchDify, now
    })
  });
  const currentMatch = context => recommendations.getConfirmed(context);
  const ensureMatch = (context, expected) => {
    const actual = currentMatch(context);
    assertApi(actual && actual.recommendation_id === expected.recommendation_id
      && actual.catalog_fingerprint === expected.catalog_fingerprint,
    409, 'PRODUCT_MATCH_STALE', '已确认的产品建议发生变化，请重新生成并确认。');
  };
  return {
    products, recommendations,
    route: createProductMatchApi({ products, recommendations, readJson, sendJson }),
    prepareSalesContext(context) {
      const confirmed = currentMatch(context);
      return confirmed ? { ...context, confirmed_product_match: confirmed } : context;
    },
    validateSalesContext(context) {
      if (context.confirmed_product_match) ensureMatch(context, context.confirmed_product_match);
    },
    validateDraft(row) {
      // A replay after a successful confirmation performs no new sending or state change.
      if (['simulated_sent', 'manually_confirmed_sent', 'provider_confirmed_sent'].includes(row.status)) return;
      const reference = row.ai_result?.product_match_reference;
      if (reference) ensureMatch(buildContext(store, row.workspace_id, row.opportunity_id), reference);
    }
  };
}
