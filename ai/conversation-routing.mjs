import { isDirectHumanRequest, isMarketingOptOutRequest, isProductActionQuestion, isReturnGuaranteeRequest } from './customer-signals.mjs';

// Shared deterministic routing. Model output cannot choose a different workflow.
const HIGH_RISK = /(?:投诉|举报|纠纷|退保|理赔争议|理赔纠纷|隐瞒病史|带病投保|核保争议)/i;
const COMPLAINT = /(?:投诉|举报|监管举报)/;
const SERVICE = /(?:我已经买|已买|已投保|保全|变更受益人|续期|领取手续)/;
const CONTRACT_QUESTION = /(?:保单|合同|查资料|宽限期|保单贷款)/;
const MATCH = /(?:推荐|适合|怎么选|选哪款|买哪款|哪款|哪个更好|哪款更好|有什么区别|区别是什么|对比产品|比较产品)/;
const PLAN = /(?:方案|计划书|测算|报价)/;
const PRODUCT_FACT = /(?:产品|条款|怎么交|交费|缴费|趸交|(?:可以|能)?(?:选择|选)?(?:几|多少|\d+)\s*年交|计划一|计划二|保费|保额|领取|现金价值|收益|irr|回本|犹豫期|宽限期|保单|合同|中途(?:用钱|取钱|急用)|资金使用|减保|部分领取)/i;
const PUBLIC_KNOWLEDGE = /(?:公司统一|服务流程|查询流程|通用规则|合规|核保|承保|保证.*(?:通过|承保|理赔)|一定.*(?:通过|承保|理赔))/i;
// A customer asking where or how to look up a policy is asking for a company
// service route, not a fact about one product. Keep this separate from the
// broader PRODUCT_FACT expression so it can use globally approved service
// knowledge without inventing a product scope.
const PUBLIC_SERVICE_QUERY = /(?:保单|合同).{0,12}(?:在哪(?:里)?|哪里|怎么|如何|什么渠道).{0,8}(?:查|查询|查看)|(?:在哪(?:里)?|哪里|怎么|如何|什么渠道).{0,10}(?:查|查询|查看).{0,8}(?:保单|合同)/i;
const DEFERRED_BUDGET_DISCOVERY = /(?:预算.{0,8}(?:先不说|不想说|暂不说)|(?:先不说|不想说|暂不说).{0,8}预算)[\s\S]{0,80}(?:领取|什么时候开始领)/i;
const GENERIC_LIQUIDITY_CONCERN = /(?:对|担心|顾虑).{0,8}流动性|流动性.{0,8}(?:担心|顾虑)/i;
const NEW_NEED_AFTER_PURCHASE = /(?:已经|之前|已).{0,10}(?:买|投保).{0,16}(?:又|另外|现在).{0,12}(?:咨询|了解|准备|想).{0,12}(?:孩子|教育)/i;
const GENERIC_PRODUCT_OVERVIEW = /(?:你们|你家|公司)?(?:都)?(?:有|有哪些|有什么|介绍).{0,6}(?:哪些|什么)?产品|产品有哪些/i;

export function isExplicitMarketingOptOut(message) {
  return isMarketingOptOutRequest(message);
}

// Safety routes may send only a deterministic acknowledgement.  They never
// continue the sales conversation and complaint turns intentionally stay
// silent so the human owner can take over directly.
export function safetyAcknowledgement(route, message) {
  const value = String(message ?? '').trim().slice(0, 5000);
  if (route === 'human_required') {
    return !COMPLAINT.test(value) && !isReturnGuaranteeRequest(value) && isDirectHumanRequest(value)
      ? '好的，已通知人工专员接手。'
      : '';
  }
  if (route === 'stop_marketing') {
    return '';
  }
  return '';
}

export function classifyConversationTurn(context) {
  const message = String(context?.latest_message ?? '').trim().slice(0, 5000);
  const state = context?.contact_state || {};
  if (isExplicitMarketingOptOut(message)) return 'stop_marketing';
  if (state.human_handoff === true || HIGH_RISK.test(message) || isDirectHumanRequest(message) || isReturnGuaranteeRequest(message)) return 'human_required';
  if (NEW_NEED_AFTER_PURCHASE.test(message)) return 'intake';
  const explicitService = SERVICE.test(message) || Boolean(context?.product_scope?.policy_contract_version && CONTRACT_QUESTION.test(message));
  const service = state.purchased_for_opportunity === true || explicitService;
  if ((state.marketing_opt_out === true || isExplicitMarketingOptOut(message)) && !explicitService) return 'stop_marketing';
  if (service) return 'service';
  if (isProductActionQuestion(message)) return 'product_faq';
  if (PUBLIC_KNOWLEDGE.test(message) || PUBLIC_SERVICE_QUERY.test(message)) return 'public_faq';
  if (DEFERRED_BUDGET_DISCOVERY.test(message)) return 'intake';
  // A generic concern about liquidity is discovery feedback, even if the
  // customer also says they do not want to rush into a "方案".  It must be
  // acknowledged before any matching workflow starts.
  if (GENERIC_LIQUIDITY_CONCERN.test(message)) return 'intake';
  // A generic catalogue question is still discovery.  It may describe broad
  // planning directions, but it must not enter product FAQ or matching before
  // the customer has supplied a need.
  if (GENERIC_PRODUCT_OVERVIEW.test(message)) return 'intake';
  const requested = message.replace(/(?:朋友|别人)(?:介绍|推荐)/g, '').replace(/(?:暂时)?(?:不要|不用|不需要)推荐/g, '');
  if (MATCH.test(requested)) return 'product_match';
  // A factual question remains FAQ even when the customer mentions a plan or
  // proposal document. “这款产品的收益率是多少，现在没有正式计划书” asks
  // for evidence; it does not ask B2 to select a product.
  if (PRODUCT_FACT.test(message)) return 'product_faq';
  if (PLAN.test(message)) return context?.product_scope?.product_id ? 'product_faq' : 'product_match';
  return 'intake';
}

export function matchingProfileGaps(context) {
  const need = context?.need_profile || {};
  const persons = [...new Set(Array.isArray(need.person_ids) ? need.person_ids.filter(Boolean) : [])];
  const facts = (Array.isArray(context?.confirmed_facts) ? context.confirmed_facts : [])
    .filter(fact => fact?.status === 'confirmed' && (!fact.opportunity_id || fact.opportunity_id === context.opportunity_id));
  const numeric = (field, personId) => [...new Set(facts.filter(fact => fact.field === field
    && (fact.person_id || null) === personId && typeof fact.value === 'number' && Number.isFinite(fact.value)).map(fact => fact.value))];
  const age = persons.length === 1 ? numeric('age', persons[0]) : [];
  const horizon = numeric('funds_usage_years', null);
  return [
    persons.length !== 1 && 'insured_person',
    !String(need.purpose || '').trim() && 'purpose',
    (age.length !== 1 || !Number.isInteger(age[0]) || age[0] < 0 || age[0] > 120) && 'insured_age',
    (typeof need.budget_amount !== 'number' || !Number.isFinite(need.budget_amount) || need.budget_amount < 0) && 'budget_amount',
    need.budget_currency !== 'CNY' && 'budget_currency',
    (horizon.length !== 1 || !Number.isInteger(horizon[0]) || horizon[0] < 0 || horizon[0] > 100) && 'funds_usage_years'
  ].filter(Boolean);
}
