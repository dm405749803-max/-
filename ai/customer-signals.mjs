const MARKETING_OPT_OUT = /(?:不要|别)再(?:(?:给我)?发(?:消息|信息|了)?|联系|推荐|推销)|停止营销/;
const HUMAN_REQUEST_NEGATION = /(?:不用|不需要|无需|暂时不用|先不用).{0,6}(?:人工|客服|专员)/;
const DIRECT_HUMAN_REQUEST = /(?:找|转|转接|安排|请|麻烦|希望|需要|要求|想要).{0,10}(?:人工|人工客服|人工专员)(?:.{0,8}(?:联系|回复|处理|接手|沟通))?|(?:人工客服|人工专员|人工).{0,8}(?:联系|回复|处理|接手|沟通|服务)/;
const PAYMENT_DURATION_QUESTION = /(?:交|缴)(?:费)?[^\n，。；;]{0,8}(?:几年|多少年|多久)|(?:几年|多少年|多久)[^\n，。；;]{0,8}(?:交|缴)(?:费)?/;
const BENEFIT_ACTION_QUESTION = /(?:以后|将来|到时)?[^\n，。；;]{0,8}(?:怎么领|如何领|领取|领钱|什么时候领|领多少)/;

function input(value) {
  return String(value ?? '').trim().slice(0, 5000);
}

export function isMarketingOptOutRequest(value) {
  return MARKETING_OPT_OUT.test(input(value));
}

export function isDirectHumanRequest(value) {
  const body = input(value);
  return !HUMAN_REQUEST_NEGATION.test(body) && DIRECT_HUMAN_REQUEST.test(body);
}

export function isReturnGuaranteeRequest(value) {
  return input(value).split(/[，,。；;！？!?\n]/).some(clause => {
    if (/(?:不用|不必|不需要|不要|不能|不可以).{0,5}(?:保证|承诺)|(?:不要求|不需要).{0,8}(?:收益保证|收益承诺)/.test(clause)) return false;
    return /(?:保证|承诺).{0,10}(?:收益|回本|赚钱|盈利)|(?:收益|回本).{0,8}(?:保证|承诺|保底)|保本保(?:息|收益)|稳赚|零风险/.test(clause);
  });
}

export function acquisitionChannel(value) {
  const body = input(value);
  if (/(?:不是|并非|没看).{0,8}(?:视频|直播)/.test(body)) return null;
  if (/(?:我|通过|从).{0,16}(?:视频|直播).{0,12}(?:过来|来的|找到|加|联系)|(?:看|刷)到.{0,12}(?:视频|直播).{0,12}(?:加|过来|联系)/.test(body)) {
    return /直播/.test(body) ? 'livestream' : 'video';
  }
  if (/(?:朋友|同事|家人).{0,8}(?:介绍|推荐).{0,8}(?:来|加|联系|找到)/.test(body)) return 'referral';
  return null;
}

export function productActionSignals(value) {
  const body = input(value);
  return {
    asks_payment_duration: PAYMENT_DURATION_QUESTION.test(body),
    asks_benefit_action: BENEFIT_ACTION_QUESTION.test(body)
  };
}

export function isProductActionQuestion(value) {
  const signals = productActionSignals(value);
  return signals.asks_payment_duration && signals.asks_benefit_action;
}

export const __test = {
  MARKETING_OPT_OUT, HUMAN_REQUEST_NEGATION, DIRECT_HUMAN_REQUEST,
  PAYMENT_DURATION_QUESTION, BENEFIT_ACTION_QUESTION
};
