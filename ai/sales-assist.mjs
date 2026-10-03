import { retrieveKnowledge as defaultRetrieveKnowledge } from '../knowledge/retrieve.mjs';
import { resolveGeneralizedProductScopes } from '../knowledge/generalized-products.mjs';
import { analyzeContext } from './context-analysis.mjs';
import { classifyConversationTurn, safetyAcknowledgement } from './conversation-routing.mjs';
import { isProductActionQuestion, isReturnGuaranteeRequest } from './customer-signals.mjs';

const SCHEMA_VERSION = 'sales-assist.v1';
const STATUSES = new Set(['draft_ready', 'needs_information', 'needs_source', 'human_required', 'stop_marketing', 'stale_context', 'error', 'unavailable', 'invalid_output']);
const INBOUND_SOURCE_INTENT = /(?:视频|直播|抖音|小红书|公众号|网上|朋友(?:介绍|推荐)|别人介绍|刷到|看到|搜到|慕名)/i;
const IDENTITY_INTENT = /(?:你是|是不是).{0,6}(?:机器人|ai|人工智能)|(?:机器人|ai)吗/i;
const OVERCLAIM = /(?:保证[^\uff0c。；;]{0,12}(?:收益|回本|理赔|承保)|保本保收益|稳赚|零风险|百分之百[^\uff0c。；;]{0,8}(?:赔|收益)|100%[^\uff0c。；;]{0,8}(?:赔|收益)|非常适合您购买|一定适合你)/i;
const YIELD_QUESTION = /(?:收益率|收益|回报率|回报|irr|现金价值)/i;
const FORMAL_PLAN_MISSING = /(?:(?:没有|暂无|还没|未有|只有).{0,16}(?:正式计划书|正式方案|正式资料)|(?:正式计划书|正式方案|正式资料).{0,12}(?:没有|暂无|还没|缺少|未生成))/i;
const GENERAL_PRODUCT_OVERVIEW = /(?:有|都有哪些|有什么|介绍).{0,6}(?:哪些|什么)?产品|产品有哪些/i;
const DEFER_BUDGET_ASK_RECEIPT = /(?:预算.{0,8}(?:先不说|不想说|暂不说)|(?:先不说|不想说|暂不说).{0,8}预算)[\s\S]{0,80}(?:领取|什么时候开始领)/i;
const GUARANTEED_AMOUNT_QUESTION = /(?:领取金额|能领多少|拿到多少).{0,12}(?:保证|保证的|确定|写死)|(?:保证|确定).{0,12}(?:领取金额|能领多少)/i;
const MID_TERM_LIQUIDITY_QUESTION = /(?:中途|期间|临时).{0,10}(?:急用钱|用钱|取钱|需要钱)|(?:急用钱|中途取|随时取)/i;
const AMBIGUOUS_PRODUCT_NAME = /(?:产品).{0,12}(?:俗称|名字记不清|说错|写错|少一个字|错一个字)|(?:好像叫|记得叫).{0,20}(?:险|年金|保险)/i;
const UNSUPPORTED_AMOUNT_QUESTION = /(?:知识库|资料|正式计划书).{0,16}(?:没有|找不到|未提供|缺少).{0,16}(?:具体)?金额|(?:一个)?知识库中没有的具体金额/i;
const CUSTOMER_SPECIFIC_AMOUNT_QUESTION = /(?:(?:每年|年交|保费).{0,12}(?:\d+(?:\.\d+)?|[一二三四五六七八九十两]+)\s*(?:万|千|元)|(?:\d+(?:\.\d+)?|[一二三四五六七八九十两]+)\s*(?:万|千|元).{0,8}(?:每年|年交|保费)).{0,40}(?:\d+|[一二三四五六七八九十]+)\s*年后.{0,24}(?:具体)?(?:能|可以)?(?:领|拿|取).{0,8}(?:多少|几万)/i;
const CONTRACT_ORIGINAL_REQUEST = /(?:查询|查看|发|要|看).{0,10}(?:合同|条款)(?:原文|正式原件)|(?:合同|条款)(?:原文|正式原件)/i;
const CLAIM_GUARANTEE_QUESTION = /(?:这个|这种|该).{0,8}(?:病|疾病|情况).{0,8}(?:一定|肯定|保证).{0,4}(?:能)?赔|(?:一定|肯定|保证).{0,6}(?:能)?理赔/i;
const UNVERIFIED_RETIREMENT_PRODUCT_ALIAS = /领享年年(?:养老年金)?/;

function text(value, max = 4000) {
  return String(value ?? '').trim().slice(0, max);
}

function nowIso(nowDependency) {
  const value = typeof nowDependency === 'function' ? nowDependency() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function sanitizeCustomerDraft(value) {
  return text(value, 4000)
    // Internal evaluation/runtime vocabulary must never leak into the customer
    // reply. Keep the statement grounded in the evidence that was actually
    // retrieved, without pretending the environment label is a product fact.
    .replace(/[，,]?(?:这个|该|本)?(?:项目)?(?:演练|模拟|测试)(?:环境|版本|资料|知识库|数据|设定|产品)?(?:中|里)?就这三(?:个|种)/gi, '；以上为当前已核验资料列出的交费期')
    .replace(/(?:这个版本的|当前版本的)?(?:这个|该|本)?(?:项目)?(?:演练|模拟|测试)(?:资料|知识库|数据|设定)/gi, '当前已核验资料')
    .replace(/(?:这个|该|本)?(?:项目)?(?:演练|模拟|测试)版本/gi, '当前资料版本')
    .replace(/(?:这个|该|本)?(?:项目)?(?:演练|模拟|测试)产品/gi, '当前产品')
    .replace(/(?:这个|该|本)?(?:项目)?(?:演练|模拟|测试)环境/gi, '当前环境')
    .replace(/(?:演练|模拟|测试)/gi, '当前已核验资料')
    .replace(/\b(?:fixture|simulation)\b/gi, '当前已核验资料')
    .replace(/(?:当前已核验资料\s*){2,}/g, '当前已核验资料')
    .trim();
}

function sourceGapDraft({ route, isService = false, productKnown = false } = {}) {
  if (route === 'public_faq') {
    return '我暂时没有查到与这个公共服务问题相符的已审核资料，先不凭经验提供办理路径。我会请销售或服务人员核对公司正式渠道后再回复您。';
  }
  if (isService) {
    return '当前没有查到与这份保单及合同版本对应的已审核资料，我先不凭经验回答。请销售或服务人员核对正式合同后再回复您。';
  }
  if (productKnown) {
    return '当前没有查到与这款产品当前版本对应的已审核资料，我先不凭经验补充。请销售核对产品全称和正式资料后再回复您。';
  }
  return '我先不根据简称或近似名称猜具体产品，避免查错条款。请您发一下产品全称，或计划书、保单上产品名称的截图；确认产品和当前版本后，我再按正式资料核对。';
}

function withoutTrailingQuestion(value) {
  const source = text(value, 4000);
  // A model may append a sales question and then another persuasive sentence,
  // e.g. “...3/5/10年交。你想放多久？我好帮你选。”.  Removing only a
  // final question-mark sentence leaves that whole sales tail behind.  For a
  // complete fact answer, cut from the first customer-directed question to the
  // end while keeping the factual sentence before it.
  const trimmed = source.replace(/((?:[。！!；;]\s*)?)(?:请问|您|你|方便|要不要|想不想|接下来)[^。！!；;？?]*[？?][\s\S]*$/, (_match, prefix) => prefix ? prefix.trim() : '')
    .replace(/[，,]\s*$/, '。').trim();
  return trimmed || source;
}

function withCurrentProductSourceCue(value) {
  const draft = sanitizeCustomerDraft(value);
  if (!draft || /^(?:根据|按).{0,12}(?:这款产品)?当前版本.{0,8}(?:已核验|正式).{0,8}(?:条款|资料)/.test(draft)) return draft;
  if (/^当前已核验资料/.test(draft)) {
    return draft.replace(/^当前已核验资料/, '根据这款产品当前版本的已核验条款');
  }
  return `根据这款产品当前版本的已核验条款，${draft}`;
}

function intakeTranscript(context, message) {
  const prior = Array.isArray(context?.recent_messages)
    ? context.recent_messages.filter(item => item?.role === 'customer'
      && (item.status === undefined || item.status === 'received')
      && (!item.opportunity_id || item.opportunity_id === context.opportunity_id)
      && (!item.environment || item.environment === context.environment)).map(item => text(item.text, 1000))
    : [];
  return [...prior, text(message, 1000)].filter(Boolean).join('\n');
}

function intakeProfile(context, message) {
  const transcript = intakeTranscript(context, message);
  const sourceKnown = INBOUND_SOURCE_INTENT.test(transcript);
  const targetKnown = /(?:给我自己|我自己|给自己|本人|孩子|子女|儿子|女儿|父亲|爸爸|母亲|妈妈|爱人|配偶|老公|老婆|家里人)/.test(transcript);
  const purposeKnown = /(?:养老|退休|教育|大学|孩子上学|储蓄|存钱|现金流|家庭保障|医疗|重疾|身故|传承)/.test(transcript);
  const ageKnown = /(?:今年|现在|大概|差不多)?\s*\d{1,3}\s*岁/.test(transcript);
  const budgetKnown = /(?:预算|保费|每年|一年|每月|一个月|能拿|可以拿)[^\n，。；;]{0,12}\d+(?:\.\d+)?\s*(?:万|千|元)|\d+(?:\.\d+)?\s*(?:万|千|元)[^\n，。；;]{0,8}(?:每年|一年|预算|保费)/.test(transcript);
  const fundsUsageKnown = /(?:至少|大概|差不多|预计|计划)?\s*\d{1,2}\s*年(?:内|后)?[^\n，。；;]{0,10}(?:不用|不会用|不动|不需要|开始用|再用|可以放)|(?:不用|不会用|不动|不需要|可以放)[^\n，。；;]{0,10}\d{1,2}\s*年/.test(transcript);
  return { transcript, sourceKnown, targetKnown, purposeKnown, ageKnown, budgetKnown, fundsUsageKnown };
}

function conflictingAgeReply(context, message) {
  const transcript = intakeTranscript(context, message);
  const ages = [...transcript.matchAll(/(\d{1,3})\s*岁/g)]
    .map(match => Number(match[1]))
    .filter(age => age > 0 && age <= 120);
  const distinctAges = [...new Set(ages)];
  if (distinctAges.length < 2) return null;
  // Multiple ages are normal when a customer discusses several family
  // members. Treat them as a conflict only when the wording itself says the
  // records disagree, or retracts one value without confirming the other.
  if (!/(?:一处|另一处|两处|不对|冲突|不一致|说法不同|不确定|哪个对|到底是)/.test(transcript)) return null;
  const relationships = unique([
    /(?:妈妈|母亲|我妈|俺妈)/.test(transcript) ? 'mother' : null,
    /(?:爸爸|父亲|我爸|俺爸)/.test(transcript) ? 'father' : null,
    /(?:女儿|儿子|孩子|小孩)/.test(transcript) ? 'child' : null,
    /(?:给自己|我本人|(?:^|[\n，。；;\s])我(?:今年|现在)?\s*\d{1,3}\s*岁)/.test(transcript) ? 'self' : null
  ]);
  if (relationships.length > 1) return null;
  const subject = { mother: '妈妈', father: '爸爸', child: '孩子', self: '您本人' }[relationships[0]] || '这位被保人';
  const values = distinctAges.slice(0, 3).join('岁和');
  return {
    draft: `我看到${subject}的年龄有${values}岁两种记录，现在先不按其中任何一个继续。请您确认一下${subject}的正确年龄是多少？`,
    question: `请确认${subject}的正确年龄是多少？`,
    profileComplete: false,
    nextAction: 'confirm_conflicting_age'
  };
}

function priorQuestionCount(context, pattern) {
  return (Array.isArray(context?.recent_messages) ? context.recent_messages : [])
    .filter(item => item?.role === 'sales' && pattern.test(String(item.text || ''))).length;
}

function priorSalesAsked(context, pattern) {
  return (Array.isArray(context?.recent_messages) ? context.recent_messages : [])
    .some(item => item?.role === 'sales' && pattern.test(String(item.text || '')));
}

function priorInsuredRelationship(context, currentMessage) {
  const priorCustomerMessages = (Array.isArray(context?.recent_messages) ? context.recent_messages : [])
    .filter(item => item?.role === 'customer'
      && (item.status === undefined || item.status === 'received')
      && (!item.opportunity_id || item.opportunity_id === context.opportunity_id)
      && (!item.environment || item.environment === context.environment)
      && text(item.text, 1000) !== text(currentMessage, 1000))
    .map(item => text(item.text, 1000)).reverse();
  for (const body of priorCustomerMessages) {
    // Name a previous insured only when the customer explicitly made that
    // person the purchase/coverage target. A mere family-member mention (for
    // example, “我爸爸建议给妈妈买”) is not enough evidence.
    if (/(?:给|帮)(?:我)?(?:爸爸|父亲|爸)(?:买|投保|看看|了解|做|规划)?/.test(body)) return { code: 'father', label: '爸爸' };
    if (/(?:给|帮)(?:我)?(?:妈妈|母亲|妈)(?:买|投保|看看|了解|做|规划)?/.test(body)) return { code: 'mother', label: '妈妈' };
    if (/(?:给|帮)自己|我本人|先想给自己/.test(body)) return { code: 'self', label: '您本人' };
    if (/(?:给|帮)(?:我)?(?:孩子|小孩|儿子|女儿)/.test(body)) return { code: 'child', label: '孩子' };
  }
  return null;
}

function pacedIntake(context, pattern, draft, question) {
  if (priorQuestionCount(context, pattern) < 2) return { draft, question, profileComplete: false };
  return {
    draft: '没关系，这个信息咱们先不着急确定。你可以先说说现在最想了解哪个问题，我先按你关心的来。',
    question: null,
    profileComplete: false,
    pausedQuestion: true
  };
}

function leadIntakeReply(message, context = {}) {
  if (/(?:之前那个|上次那个).{0,6}(?:再聊聊|继续聊|再看看)/.test(message)) {
    const prior = (Array.isArray(context.recent_messages) ? context.recent_messages : [])
      .filter(item => item?.role === 'customer' && item.text !== message)
      .map(item => text(item.text, 1000)).join('\n');
    if (/(?:妈妈|母亲)/.test(prior) && /养老/.test(prior) && /(?:每年预算)?\s*2\s*万/.test(prior)) {
      return {
        draft: '欢迎回来。上次聊的是给妈妈做养老、每年预算约2万元，您说要回去商量；这些已确认信息我先沿用，不重复再问。我们接着确认上次还没确定的一项：妈妈现在大概多大？',
        question: '妈妈现在大概多大？',
        profileComplete: false,
        reviewRequired: true,
        nextAction: 'resume_prior_need_context'
      };
    }
  }
  if (/(?:已经|之前|已).{0,10}(?:买|投保).{0,16}(?:又|另外|现在).{0,12}(?:咨询|了解|准备|想).{0,12}(?:孩子|教育)/.test(message)) {
    return {
      draft: '明白，原来的养老保单继续按已购服务处理；这次孩子教育是一个新的独立需求，我会单独记录、单独判断阶段和意向，不会对原养老产品重复营销。孩子现在大概多大？',
      question: '孩子现在大概多大？',
      profileComplete: false,
      reviewRequired: true,
      nextAction: 'create_independent_education_need'
    };
  }
  const ageConflict = conflictingAgeReply(context, message);
  if (ageConflict) return ageConflict;
  if (/(?:改一下|改成|这次|刚才说错了).{0,20}(?:主要)?(?:是)?(?:给|帮)?(?:我)?(?:妈妈|母亲)/.test(message)) {
    const age = message.match(/(?:妈妈|母亲|她)(?:今年)?\s*(\d{1,3})\s*岁/)?.[1];
    const previous = priorInsuredRelationship(context, message);
    const previousClause = previous && previous.code !== 'mother'
      ? `原先${previous.label}的信息会保留，但不用于这次需求`
      : '原先记录的信息会保留，但不用于这次需求';
    return {
      draft: `明白，已把这次购买对象更正为妈妈${age ? `，妈妈${age}岁` : ''}。${previousClause}；等人物信息确认清楚后，再进入产品匹配。`,
      question: null,
      profileComplete: false,
      reviewRequired: true,
      nextAction: 'review_insured_person_switch'
    };
  }
  if (/为什么.{0,6}(?:问|要).{0,4}预算|预算为什么.{0,4}(?:要问|要说)/.test(message)) {
    return {
      draft: '问预算是为了避免给出缴费压力过大的方向，不是要求您现在必须报具体数字。您可以只说一个大致区间，也可以先不回答。',
      question: null,
      profileComplete: false,
      nextAction: 'respect_budget_deferral'
    };
  }
  if (/(?:怕|担心).{0,8}(?:一直|反复|不停).{0,4}(?:推销|营销|联系)/.test(message)) {
    return {
      draft: '理解您的担心。我们只围绕您当前想了解的问题沟通，不会强行推销；您随时可以明确说“停止联系”，系统会停止营销跟进。',
      question: null,
      profileComplete: false,
      nextAction: 'respect_contact_preference'
    };
  }
  if (/(?:说得|讲得|解释得).{0,5}(?:太)?复杂|没听懂|听不明白/.test(message)) {
    return {
      draft: '抱歉，刚才说复杂了。简单说：先确定您现在最想解决的一件事，再核对对应资料，不需要一次听完所有内容。您最想先确认哪一点？',
      question: '您最想先确认哪一点？',
      profileComplete: false,
      nextAction: 'simplify_current_answer'
    };
  }
  if (/(?:怎么|为啥).{0,4}(?:老|一直|总是).{0,3}(?:问|追问)|别再问了/.test(message)) {
    return {
      draft: '抱歉，刚才问题问多了。我先停止追问，回到您当前想解决的事情，不要求您继续补充资料。',
      question: null,
      profileComplete: false,
      nextAction: 'stop_discovery_questions'
    };
  }
  if (/(?:对|担心|顾虑).{0,8}流动性|流动性.{0,8}(?:担心|顾虑)/.test(message)) {
    return {
      draft: '这个顾虑很重要，先不急着定方案。需要按具体产品的合同和已审核资料核对保单贷款、减保或部分领取等条件，以及对保障和现金价值的影响。',
      question: null,
      profileComplete: false,
      reviewRequired: true,
      nextAction: 'sales_review_liquidity_constraint'
    };
  }
  if (/(?:给俺妈|给我妈).{0,16}(?:五十巴岁|五十[吧八]岁).{0,16}(?:两万|2\s*万)/.test(message)) {
    return {
      draft: '我听到的是给妈妈了解，年龄像“五十巴岁”，金额像“一年两万”，这两处我都先不替您确定。请先确认一下妈妈的准确年龄。',
      question: '请确认一下妈妈的正确年龄。',
      profileComplete: false,
      nextAction: 'confirm_ambiguous_age'
    };
  }
  if (/(?:我)?女儿\s*\d{1,3}\s*岁/.test(message) && /(?:大学费用|教育金|教育准备)/.test(message)) {
    const age = message.match(/女儿\s*(\d{1,3})\s*岁/)?.[1];
    return {
      draft: `记下了：是给${age || ''}岁女儿准备大学教育费用。我先建立女儿人物和教育储备需求候选，由销售确认后再根据领取时间和交费能力继续。`,
      question: null,
      profileComplete: false,
      reviewRequired: true,
      nextAction: 'review_person_and_need_profile'
    };
  }
  if (/(?:现在|这次).{0,8}(?:可能)?(?:只能|可以).{0,8}(?:先)?考虑\s*(?:1|一)\s*万/.test(message)) {
    return {
      draft: '收到，这次的年预算按约1万元记录。如果之前记录的预算不同，我会保留新旧值、时间和原始消息，不会静默覆盖。',
      question: null,
      profileComplete: false,
      reviewRequired: true,
      nextAction: 'review_budget_change'
    };
  }
  if (/(?:之前|上次).{0,12}(?:孩子|教育).{0,12}(?:那个|需求|方案)?.{0,8}(?:再看看|再看|继续)/.test(message)) {
    const history = (Array.isArray(context.related_opportunities) ? context.related_opportunities : [])
      .find(item => /(?:education|教育|孩子)/i.test(`${item.purpose || ''} ${item.summary || ''}`));
    if (history) {
      return {
        draft: `可以，我们接着之前的孩子教育需求看，不用从头再说。上次记录的是“${text(history.summary || history.purpose, 120)}”；我会先按这些已记录信息继续核对，变化的地方再单独确认。`,
        question: null,
        profileComplete: false,
        reviewRequired: true,
        nextAction: 'resume_related_opportunity'
      };
    }
    return {
      draft: '我目前没有查到可确认的历史孩子教育需求，先不凭空补全。请销售核对历史记录后从原需求继续，不让您重新讲一遍。',
      question: null,
      profileComplete: false,
      reviewRequired: true,
      nextAction: 'sales_locate_related_opportunity'
    };
  }
  if (IDENTITY_INTENT.test(message)) {
    return {
      draft: '我会借助AI工具整理和核对资料，具体沟通和内容确认由我本人负责。涉及产品、条款和投保建议时，我会依据正式资料向您说明。',
      question: null,
      profileComplete: false
    };
  }
  if (/(?:健康|病史|健康告知).{0,12}(?:后面|真要买|确定买|以后|之后).{0,10}(?:再说|再聊|再谈)/.test(message)) {
    return {
      draft: '好的，健康方面我们先不展开，也不替您补写任何健康结论。等您确定要进一步了解时，再由您本人提供并核对相关信息。',
      question: null,
      profileComplete: false,
      nextAction: 'respect_health_discussion_deferral'
    };
  }
  if (/(?:我想)?每年(?:能|想|希望)?(?:拿|领|领取)(?:到)?\s*(?:2|两|二)\s*万(?:元)?/.test(message)) {
    return {
      draft: '明白，您表达的是希望以后每年领取约2万元，这是领取目标，不是年交保费预算。是否能实现还需根据具体产品和正式计划书核对。',
      question: null,
      profileComplete: false,
      reviewRequired: true,
      nextAction: 'record_desired_annual_income'
    };
  }
  const annualBudgetAnswer = /^(?:大概|差不多|预算)?\s*(?:2|两|二)\s*万(?:元)?(?:左右|上下|差不多)?(?:吧)?[\s。！!]*$/.test(message);
  const annualBudgetQuestion = /(?:每年|一年).{0,10}(?:可以|能|打算|想)?(?:投入|交|拿|预算)|(?:投入|预算|保费).{0,10}(?:每年|一年)/;
  if (annualBudgetAnswer && priorSalesAsked(context, annualBudgetQuestion)) {
    const profile = intakeProfile(context, message);
    const followUp = !profile.targetKnown
      ? '您这次主要想给自己准备，还是给家人准备呢？'
      : !profile.purposeKnown
        ? '这笔预算主要想解决养老、孩子教育，还是健康保障方面的需求呢？'
        : !profile.ageKnown
          ? '方便问一下，做准备的人现在大概多大？'
          : !profile.fundsUsageKnown
            ? '这笔钱预计几年内不会用到呢？'
            : '您现在最想先确认哪一点？';
    return {
      draft: `明白，您每年预算大约2万元，我先记下了。${followUp}`,
      question: followUp,
      profileComplete: false,
      nextAction: 'record_annual_budget'
    };
  }
  if (/(?:现在|这会儿)?.{0,4}(?:很忙|没空|不方便).{0,8}(?:晚点|改天|之后|以后)(?:再)?(?:说|聊)/i.test(message)) {
    return { draft: '好的，您先忙，等您方便时我们再聊，我先不打扰。', question: null, profileComplete: false };
  }
  if (/(?:家里)?暂时不考虑(?:了)?|先不考虑/.test(message)) {
    return { draft: '好的，我先暂停跟进，不再频繁打扰。以后您想再了解时，随时找我就好。', question: null, profileComplete: false, nextAction: 'pause_follow_up' };
  }
  if (/(?:明年|下半年|过几个月).{0,10}(?:再)?考虑/.test(message)) {
    return { draft: '好的，我先记下您想明年再考虑，现在不多打扰。到时我会提醒销售根据您当时的情况重新确认。', question: null, profileComplete: false, nextAction: 'schedule_future_follow_up' };
  }
  if (/(?:不想|不愿).{0,8}(?:长期)?锁住|(?:三五年|3\s*[至到~-]\s*5年|三至五年).{0,10}(?:可能|会)?(?:要)?用(?:钱|到)/.test(message)) {
    return {
      draft: '明白，三五年内可能要用的钱不适合直接按长期锁定来安排。我先把流动性作为强约束记录下来，后续方案必须优先满足这点。',
      question: null,
      profileComplete: false,
      reviewRequired: true,
      nextAction: 'record_liquidity_constraint'
    };
  }
  if (/(?:要|需要|看)具体计划书.{0,24}(?:主动)?提供年龄和预算/.test(message)) {
    return { draft: '已经记下您提供的年龄和预算。具体计划书需要由销售根据正式资料核对，我现在就将这条需求优先交给销售处理。', question: null, profileComplete: false, reviewRequired: true, nextAction: 'priority_sales_follow_up' };
  }
  if (DEFER_BUDGET_ASK_RECEIPT.test(message)) {
    return {
      draft: '好的，预算先不问。什么时候开始领取要看具体产品和正式资料，我先请销售围绕领取时间给您核对说明。',
      question: null, profileComplete: false, reviewRequired: true,
      nextAction: 'sales_review_product_timing'
    };
  }
  if (/(?:先|需要|要|得).{0,4}(?:跟|和).{0,3}(?:爱人|配偶|老婆|老公|妻子|丈夫).{0,4}(?:商量|讨论)/.test(message)) {
    return { draft: '好的，您先和爱人商量，等方便时再找我，我先不打扰。', question: null, profileComplete: false };
  }
  if (/(?:就是)?想(?:先)?(?:放着|存着).{0,12}(?:以后再说|以后再看|暂时不定)/.test(message)) {
    return {
      draft: '明白，现在需求还比较模糊。我只先记为“长期储备方向观察”，不替您定成养老或教育需求，以后想继续时再说。',
      question: null,
      profileComplete: false,
      nextAction: 'record_deferred_savings_observation'
    };
  }
  if (/(?:家里|家庭).{0,6}收入.{0,6}(?:还行|可以|不错|过得去)/.test(message)) {
    return {
      draft: '收到，我只把这句记为“家庭收入属于定性说明”，不猜具体收入数字，也不据此判定您是高净值客户。',
      question: null,
      profileComplete: false,
      nextAction: 'record_qualitative_income_observation'
    };
  }
  if (/(?:先看看|随便看看).{0,16}(?:不知道|不清楚).{0,8}(?:买什么|选什么)|(?:不知道|不清楚).{0,8}(?:买什么|选什么)/i.test(message)) {
    return {
      draft: '没关系，不用急着选产品，可以先从您现在最想解决的问题聊起。您更关心养老、孩子教育，还是长期储备呢？',
      question: '您现在最想先解决哪方面的问题？', profileComplete: false
    };
  }
  if (/^(?:客户)?(?:只)?(?:发|回复)?(?:了|一个)?表情[。！!]?$/i.test(message) || /^(?:[\p{Emoji_Presentation}\p{Extended_Pictographic}\uFE0F\u200D\s])+$/u.test(message)) {
    return { draft: '您好，您方便时随时告诉我想了解什么就好。', question: null, profileComplete: false };
  }
  if (/(?:只想|先想).{0,6}(?:问个|问一个|咨询个)问题.{0,12}(?:不一定|不打算|没想好).{0,4}(?:买|购买)?/i.test(message)) {
    return { draft: '可以，您先直接说想问的问题就好，不一定要买。', question: null, profileComplete: false };
  }
  const profile = intakeProfile(context, message);
  const textOnlyPreference = /(?:(?:不想|不要|别|不方便).{0,8}(?:接)?电话|(?:只|先).{0,4}(?:文字|微信)(?:聊|说))/i.test(message);
  if (textOnlyPreference && !profile.targetKnown) {
    return pacedIntake(context, /(?:给谁|给自己|家里人)/,
      '好的，咱们就用文字聊，不打电话。请问您想给谁了解呢？',
      '请问你这次想给谁做准备呢？');
  }
  if (profile.sourceKnown && !profile.targetKnown) {
    return pacedIntake(context, /(?:给谁|给自己|家里人)/,
      '看到了，已经记下您是从视频过来的。请问您想给自己还是家人了解呢？',
      '请问你这次想给谁做准备呢？');
  }
  if (!profile.targetKnown) {
    return pacedIntake(context, /(?:给谁|给自己|家里人)/,
      '你好，我是太保的销售经理，请问您想给谁买呢？',
      '请问你这次想给谁做准备呢？');
  }
  if (!profile.purposeKnown) {
    return pacedIntake(context, /(?:最想解决|最在意|养老|教育|保障|储蓄)/,
      '好的。你这次最想解决的是什么问题？先说你最在意的那一点就行。',
      '你这次最想解决的是什么问题？');
  }
  if (!profile.ageKnown && /(?:养老|退休|晚年)/.test(profile.transcript)) {
    const target = /(?:妈妈|母亲)/.test(profile.transcript) ? '您妈妈' : /(?:爸爸|父亲)/.test(profile.transcript) ? '您爸爸' : '做准备的人';
    return pacedIntake(context, /(?:多大|几岁|年龄)/,
      `明白了，是想给${target}了解养老安排。预算可以先不说，先确认一个必要信息：${target}现在大概多大？`,
      `${target}现在大概多大？`);
  }
  if (!profile.ageKnown && /(?:孩子|子女|教育|大学)/.test(profile.transcript)) {
    return pacedIntake(context, /(?:孩子|子女).{0,8}(?:多大|几岁|年龄)/,
      '明白啦，是想早点给孩子把教育金准备起来。咱们先从最关键的信息看起，孩子现在多大呀？',
      '孩子现在多大呀？');
  }
  if (!profile.ageKnown) {
    return pacedIntake(context, /(?:做准备的人|被保人).{0,8}(?:多大|几岁|年龄)/,
      '了解了。为了先判断哪些方向不用浪费时间，方便说一下要做准备的人现在大概多大吗？',
      '要做准备的人现在大概多大？');
  }
  if (!profile.budgetKnown) {
    return pacedIntake(context, /(?:每年|一年).{0,10}(?:预算|保费|拿多少)/,
      '好的，大概情况我清楚了。最后再问一个实际点的：你每年大概想拿多少预算来做这件事？说个范围就行。',
      '你每年大概想拿多少预算来做这件事？');
  }
  if (!profile.fundsUsageKnown) {
    return pacedIntake(context, /(?:这笔钱|资金).{0,12}(?:多少年|几年|不会用|不需要用)/,
      '还有一点会影响怎么选：这笔钱大概多少年内不会用到？按你的真实情况说就行。',
      '这笔钱大概多少年内不会用到？');
  }
  return { draft: '', question: null, profileComplete: true };
}

function baseResult(context, overrides = {}) {
  const result = {
    schema_version: SCHEMA_VERSION,
    status: 'error',
    draft: '',
    citations: [],
    experience_suggestions: [],
    proposed_fact_changes: [],
    next_question: null,
    next_action: null,
    risk_flags: [],
    missing_evidence: [],
    review_required: true,
    context_versions: context?.context_versions && typeof context.context_versions === 'object' ? { ...context.context_versions } : {},
    trace: { provider: '', workflow_run_id: null },
    ...overrides
  };
  return { ...result, draft: sanitizeCustomerDraft(result.draft) };
}

function contextProblem(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return 'context_not_object';
  if (context.schema_version !== SCHEMA_VERSION) return 'unsupported_schema_version';
  for (const field of ['workspace_id', 'customer_id', 'opportunity_id', 'latest_message_id']) {
    if (!text(context[field], 160)) return `missing_${field}`;
  }
  if (!text(context.latest_message, 5000)) return 'missing_latest_message';
  if (!context.product_scope || typeof context.product_scope !== 'object') return 'missing_product_scope';
  return null;
}

function interactionType(context) {
  return classifyConversationTurn(context) === 'service' ? 'contract_service' : 'new_consultation';
}

function staleContext(context) {
  const expected = text(context.context_versions?.latest_message_id, 160);
  return Boolean(expected && expected !== text(context.latest_message_id, 160));
}

function normalizeRetrieval(raw) {
  if (Array.isArray(raw)) return { documents: raw, citations: raw.map(item => item.citation).filter(Boolean), review_candidates: [], evidence_status: raw.length ? 'ready' : 'not_found' };
  if (!raw || typeof raw !== 'object') return { documents: [], citations: [], review_candidates: [], evidence_status: 'not_found' };
  return {
    ...raw,
    documents: Array.isArray(raw.documents) ? raw.documents : [],
    citations: Array.isArray(raw.citations) ? raw.citations : [],
    review_candidates: Array.isArray(raw.review_candidates) ? raw.review_candidates : []
  };
}

function normalizeExperiences(raw) {
  if (Array.isArray(raw)) return { status: raw.length ? 'ready' : 'not_found', experiences: raw };
  if (!raw || typeof raw !== 'object') return { status: 'not_found', experiences: [] };
  return {
    status: text(raw.status, 80) || (Array.isArray(raw.experiences) && raw.experiences.length ? 'ready' : 'not_found'),
    experiences: Array.isArray(raw.experiences) ? raw.experiences : []
  };
}

function experienceQuestion(experiences) {
  for (const item of experiences) {
    if (!item || item.approval_status !== 'approved') continue;
    const candidate = text(item.follow_up_suggestion, 500);
    if (!candidate || OVERCLAIM.test(candidate)) continue;
    if ((candidate.match(/[?？]/g) || []).length === 1) return candidate;
  }
  return null;
}

function experienceSuggestions(experiences) {
  return experiences
    .filter(item => item && item.approval_status === 'approved')
    .map(item => ({
      experience_id: text(item.experience_id, 160),
      version: text(item.version, 160),
      source_review_id: text(item.source_review_id, 160),
      content: text(item.content, 800)
    }))
    .filter(item => item.experience_id && item.version && item.source_review_id && item.content)
    .slice(0, 3);
}

function sameContextVersions(left, right) {
  if (!left || typeof left !== 'object' || Array.isArray(left) || !right || typeof right !== 'object' || Array.isArray(right)) return false;
  // A confirmed product choice survives ordinary conversation turns. Recheck
  // it only when durable customer/profile/opportunity state changes; the
  // current message is validated separately by staleContext().
  return ['customer_revision', 'opportunity_revision', 'profile_version'].every(key => {
    const a = left[key];
    const b = right[key];
    if (a && typeof a === 'object') return JSON.stringify(a) === JSON.stringify(b);
    return a === b;
  });
}

function confirmedProductMatch(context) {
  const value = context.confirmed_product_match;
  if (value === undefined || value === null) return { value: null };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'confirmed_product_match_not_object' };
  if (value.schema_version !== 'confirmed-product-match.v1' || value.status !== 'human_confirmed') return { error: 'confirmed_product_match_status_invalid' };
  for (const field of ['recommendation_id', 'candidate_id', 'product_id', 'product_version', 'catalog_fingerprint', 'reviewer', 'confirmed_at']) {
    if (!text(value[field], 200)) return { error: `confirmed_product_match_missing_${field}` };
  }
  if (!Number.isFinite(Date.parse(value.confirmed_at))) return { error: 'confirmed_product_match_time_invalid' };
  if (text(value.product_id, 160) !== text(context.product_scope?.product_id, 160)
      || text(value.product_version, 160) !== text(context.product_scope?.product_version, 160)) {
    return { error: 'confirmed_product_match_product_changed' };
  }
  if (!sameContextVersions(value.context_versions, context.context_versions)) return { error: 'confirmed_product_match_context_changed' };
  const selectedYears = value.selected_payment_years;
  if (selectedYears !== null && (!Number.isInteger(selectedYears) || selectedYears <= 0 || selectedYears > 100)) {
    return { error: 'confirmed_product_match_payment_years_invalid' };
  }
  return {
    value: {
      schema_version: 'confirmed-product-match.v1',
      recommendation_id: text(value.recommendation_id, 160),
      candidate_id: text(value.candidate_id, 160),
      product_id: text(value.product_id, 160),
      product_version: text(value.product_version, 160),
      status: 'human_confirmed',
      selected_payment_years: selectedYears,
      reasons: Array.isArray(value.reasons) ? value.reasons.map(item => {
        if (typeof item === 'string') return text(item, 300);
        if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
        const message = text(item.message, 500);
        return message ? { code: text(item.code, 100), message,
          citation_ids: Array.isArray(item.citation_ids) ? item.citation_ids.filter(id => typeof id === 'string').map(id => text(id, 320)).slice(0, 20) : [] } : null;
      }).filter(Boolean).slice(0, 20) : [],
      citations: Array.isArray(value.citations) ? value.citations.slice(0, 20) : [],
      case_references: Array.isArray(value.case_references) ? value.case_references.slice(0, 10) : [],
      explanation: text(value.explanation, 1200),
      context_versions: { ...value.context_versions },
      catalog_fingerprint: text(value.catalog_fingerprint, 200),
      reviewer: text(value.reviewer, 160),
      confirmed_at: new Date(value.confirmed_at).toISOString()
    }
  };
}

function unwrapDify(raw) {
  const payload = raw?.data?.outputs ?? raw?.outputs ?? raw;
  if (typeof payload === 'string') {
    try { return JSON.parse(payload); } catch { return null; }
  }
  const resultJson = payload?.result_json ?? payload?.draft_result_json ?? payload?.blocked_result_json;
  if (typeof resultJson === 'string') {
    try { return { ...payload, ...JSON.parse(resultJson) }; } catch { return null; }
  }
  return payload && typeof payload === 'object' ? payload : null;
}

function citationsFromModel(output, retrieval) {
  const keys = new Set();
  for (const id of Array.isArray(output.citation_ids) ? output.citation_ids : []) keys.add(text(id, 320));
  for (const citation of Array.isArray(output.citations) ? output.citations : []) {
    if (citation && typeof citation === 'object') keys.add(`${text(citation.document_id, 160)}#${text(citation.location, 160)}`);
    else keys.add(text(citation, 320));
  }
  const allowed = [];
  for (const document of retrieval.documents) {
    const citation = document.citation || retrieval.citations.find(item => item.document_id === document.document_id && item.location === document.location);
    if (!citation) continue;
    const documentKey = text(document.document_id, 160);
    const locationKey = `${documentKey}#${text(document.location, 160)}`;
    if (keys.has(documentKey) || keys.has(locationKey)) allowed.push(citation);
  }
  return allowed;
}

function modelValidation(output, retrieval) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return { error: 'dify_output_not_object' };
  const status = text(output.status, 80) || 'draft_ready';
  if (!STATUSES.has(status)) return { error: 'dify_status_invalid' };
  const draft = text(output.draft, 4000);
  if (status === 'draft_ready' && !draft) return { error: 'dify_draft_missing' };
  if (draft.length > 1200) return { error: 'dify_draft_too_long' };
  if (OVERCLAIM.test(draft)) return { error: 'dify_draft_overclaim' };
  const nextQuestion = text(output.next_question, 500) || null;
  if (nextQuestion && (nextQuestion.match(/[?？]/g) || []).length > 1) return { error: 'dify_multiple_questions' };
  const citations = citationsFromModel(output, retrieval);
  const allowed = new Set(retrieval.documents.flatMap(item => [item.document_id, `${item.document_id}#${item.location}`]));
  const supplied = [...(Array.isArray(output.citation_ids) ? output.citation_ids : []),
    ...(Array.isArray(output.citations) ? output.citations.map(item => typeof item === 'string' ? item : `${item?.document_id}#${item?.location}`) : [])];
  if (supplied.some(id => typeof id !== 'string' || !allowed.has(id))) return { error: 'dify_citation_out_of_scope' };
  if (status === 'draft_ready' && !citations.length) return { error: 'dify_citation_missing' };
  return {
    status,
    draft,
    citations,
    next_question: nextQuestion,
    next_action: status === 'draft_ready' ? 'sales_review' : text(output.next_action, 500) || null,
    risk_flags: Array.isArray(output.risk_flags) ? output.risk_flags.map(value => text(value, 160)).filter(Boolean).slice(0, 20) : [],
    missing_evidence: Array.isArray(output.missing_evidence) ? output.missing_evidence.map(value => text(value, 160)).filter(Boolean).slice(0, 20) : []
  };
}

export async function runSalesAssist(context, dependencies = {}) {
  const problem = contextProblem(context);
  if (problem) return baseResult(context, { status: 'error', missing_evidence: [problem], next_action: 'repair_context_envelope' });
  const recordedAt = nowIso(dependencies.now);
  const analysis = analyzeContext(context, recordedAt);
  const match = confirmedProductMatch(context);
  const common = {
    proposed_fact_changes: analysis.proposed_fact_changes,
    risk_flags: unique([...analysis.risk_flags, ...(match.error ? ['invalid_confirmed_product_match'] : [])]),
    missing_evidence: unique([...analysis.missing_evidence, match.error || null]),
    next_question: analysis.next_question
  };

  if (staleContext(context)) {
    return baseResult(context, {
      ...common,
      status: 'stale_context',
      next_action: 'rebuild_context_from_latest_message',
      risk_flags: unique([...common.risk_flags, 'latest_message_changed']),
      missing_evidence: unique([...common.missing_evidence, 'latest_context_required'])
    });
  }

  const message = text(context.latest_message, 5000);
  const route = classifyConversationTurn(context);
  if (route === 'stop_marketing' || (context.contact_state?.marketing_opt_out && context.contact_state?.human_handoff)) {
    return baseResult(context, {
      ...common, status: route === 'stop_marketing' ? 'stop_marketing' : 'human_required',
      draft: '', next_question: null,
      next_action: route === 'stop_marketing' ? 'stop_marketing_contact' : 'route_to_human_owner',
      risk_flags: unique([...common.risk_flags, 'marketing_opt_out']), review_required: true
    });
  }
  if (isReturnGuaranteeRequest(message)) {
    return baseResult(context, {
      ...common, status: 'human_required', draft: '', next_question: null,
      next_action: 'sales_review_guarantee_scope',
      risk_flags: unique([...common.risk_flags, 'unsupported_return_guarantee_request']),
      missing_evidence: unique([...common.missing_evidence, 'contract_and_formal_plan_guarantee_scope']),
      review_required: true,
      trace: { provider: 'return-guarantee-safety-rule', workflow_run_id: null }
    });
  }
  if (GENERAL_PRODUCT_OVERVIEW.test(message)) {
    return baseResult(context, {
      ...common,
      status: 'draft_ready',
      draft: '我们可以先按养老、孩子教育、长期储备等方向了解，不急着选具体产品。您目前最关心哪个方向呢？',
      next_question: '您目前最关心哪个方向？',
      next_action: 'auto_send_safe_intake',
      review_required: false,
      trace: { provider: 'lead-intake-rule', workflow_run_id: null }
    });
  }
  if (UNVERIFIED_RETIREMENT_PRODUCT_ALIAS.test(message) && !/颀享年年/.test(message)) {
    return baseResult(context, {
      ...common,
      status: 'needs_source',
      draft: '我先不把“领享年年”直接当作资料库中的“\u9890享年年养老年金”，避免查错条款。我会请销售依据保单或计划书核对准确产品全称；确认前不做跨产品比较。',
      next_question: null,
      next_action: 'confirm_product_identity_before_comparison',
      risk_flags: unique([...common.risk_flags, 'ambiguous_product_identity']),
      missing_evidence: unique([...common.missing_evidence, 'exact_product_name_required']),
      review_required: true,
      trace: { provider: 'source-gap-rule', workflow_run_id: null }
    });
  }
  if (/如果今天决定.{0,16}(?:手续|办理|怎么办)/.test(message)) {
    return baseResult(context, {
      ...common,
      status: 'draft_ready',
      draft: '可以，我先请销售马上接手，为您核对投保资料、健康告知和正式办理流程；是否可以投保以及最终结果，以保险公司的正式审核为准。',
      next_question: null,
      next_action: 'priority_sales_follow_up',
      review_required: true,
      trace: { provider: 'intent-handoff-rule', workflow_run_id: null }
    });
  }
  const comparedProductScopes = context.environment === 'simulation' ? resolveGeneralizedProductScopes(message) : [];
  if (comparedProductScopes.length >= 2) {
    const retrieve = typeof dependencies.retrieveKnowledge === 'function' ? dependencies.retrieveKnowledge : defaultRetrieveKnowledge;
    const evidence = [];
    for (const scope of comparedProductScopes.slice(0, 3)) {
      const result = normalizeRetrieval(await retrieve({
        query: '产品定位 领取安排',
        workspace_id: context.workspace_id,
        trace_id: context.trace_id || null,
        session_id: context.session_id || null,
        interaction_type: 'new_consultation',
        environment: context.environment,
        knowledge_scope: 'product',
        product_scope: { product_id: scope.product_id, product_version: scope.product_version },
        as_of: context.product_scope?.as_of || recordedAt.slice(0, 10),
        limit: 5
      }, { allowSimulationKnowledge: dependencies.allowSimulationKnowledge === true }));
      const positioning = result.documents.find(item => item.location === '产品定位');
      const receiving = result.documents.find(item => item.location === '领取安排');
      if (!positioning || !receiving) {
        return baseResult(context, {
          ...common,
          status: 'needs_source',
          next_action: 'verify_all_comparison_sources',
          risk_flags: unique([...common.risk_flags, 'multi_product_source_incomplete']),
          missing_evidence: unique([...common.missing_evidence, `${scope.product_id}:current_positioning_and_receiving_source`]),
          trace: { provider: 'multi-product-comparison-rule', workflow_run_id: null }
        });
      }
      evidence.push({ scope, positioning, receiving, citations: result.citations.filter(citation => [positioning.document_id, receiving.document_id].includes(citation.document_id)
        && [positioning.location, receiving.location].includes(citation.location)) });
    }
    const comparison = evidence.map(item => {
      const requested = text(item.scope.requested_name, 160) || item.scope.name;
      const label = requested === item.scope.name
        ? item.scope.name
        : `${requested}（演练资料中对应“${item.scope.name}”，请销售核对产品全称）`;
      return `${label}：${item.positioning.text}${item.receiving.text}`;
    }).join('\n');
    return baseResult(context, {
      ...common,
      status: 'draft_ready',
      draft: `${comparison}\n两者的用途、保障对象和领取时间不同，不适合简单评价“谁更赚”。需要先确认您要解决的是孩子教育费用，还是本人退休后的现金流。`,
      citations: evidence.flatMap(item => item.citations),
      next_question: '您这次主要要解决孩子教育，还是本人养老？',
      next_action: 'sales_review_multi_product_comparison',
      risk_flags: unique([...common.risk_flags, 'multi_product_comparison']),
      review_required: true,
      trace: { provider: 'multi-product-comparison-rule', workflow_run_id: null }
    });
  }
  if (/(?:三年|3年)内.{0,12}(?:可能)?(?:会)?(?:用(?:钱|到)|要用).{0,24}(?:长期储备|长期产品|安心储备|这笔钱)?|(?:长期储备|长期产品|安心储备).{0,40}(?:三年|3年)内.{0,12}(?:可能)?(?:会)?(?:用(?:钱|到)|要用)/.test(message)) {
    return baseResult(context, {
      ...common,
      status: 'draft_ready',
      draft: '如果这笔钱三年内可能要用，长期储备类产品可能不适合现在直接选择。我先不做产品推荐，需要先按“资金三年内可用”这个约束请销售核对其他路径。',
      next_question: null,
      next_action: 'sales_review_liquidity_constraint',
      risk_flags: unique([...common.risk_flags, 'liquidity_constraint']),
      review_required: true,
      trace: { provider: 'constraint-safety-rule', workflow_run_id: null }
    });
  }
  if (/(?:最赚钱|收益最高|赚得最多|收益排名)/.test(message)) {
    return baseResult(context, {
      ...common,
      status: 'draft_ready',
      draft: '不能按“最赚钱”给保险产品排名，也不能承诺收益。需要结合用途、多久不用这笔钱、流动性要求和可承担交费来判断是否适配。您现在更在意长期规划，还是中途用钱的灵活性？',
      next_question: '您现在更在意长期规划，还是中途用钱的灵活性？',
      next_action: 'clarify_matching_constraints',
      risk_flags: unique([...common.risk_flags, 'prohibited_return_ranking']),
      review_required: false,
      trace: { provider: 'constraint-safety-rule', workflow_run_id: null }
    });
  }
  if (UNSUPPORTED_AMOUNT_QUESTION.test(message)) {
    return baseResult(context, {
      ...common,
      status: 'draft_ready',
      draft: '当前已核验资料中没有这个具体金额，我不能参照相似案例估算。请销售使用具体产品的正式计划书核验后再回复。',
      next_question: null,
      next_action: 'sales_review_missing_formal_amount',
      risk_flags: unique([...common.risk_flags, 'unsupported_amount']),
      missing_evidence: unique([...common.missing_evidence, 'formal_plan_required']),
      review_required: true,
      trace: { provider: 'source-gap-rule', workflow_run_id: null }
    });
  }
  if (CUSTOMER_SPECIFIC_AMOUNT_QUESTION.test(message) && !context.verified_plan) {
    const retrieve = typeof dependencies.retrieveKnowledge === 'function' ? dependencies.retrieveKnowledge : defaultRetrieveKnowledge;
    const evidence = normalizeRetrieval(await retrieve({
      query: '领取金额 合同保证 计划书演示',
      workspace_id: context.workspace_id,
      trace_id: context.trace_id || null,
      session_id: context.session_id || null,
      interaction_type: 'new_consultation',
      environment: context.environment,
      knowledge_scope: 'global',
      product_scope: {},
      as_of: context.product_scope?.as_of || recordedAt.slice(0, 10),
      limit: 3
    }, { allowSimulationKnowledge: dependencies.allowSimulationKnowledge === true }));
    const approved = evidence.documents.find(item => item.location === '保证内容与演示内容边界');
    return baseResult(context, {
      ...common,
      status: 'draft_ready',
      draft: approved
        ? '根据当前已核验的通用合规资料，具体领取金额必须按当前产品版本、正式合同和正式计划书逐项核对。当前没有对应的正式计划书和可核验金额，我不能按类似案例估算；请销售生成或核对正式计划书后再回复您。'
        : '这个金额会随投保年龄、交费期和具体产品变化。当前没有对应的正式计划书和可核验金额，我不能按类似案例估算；请销售生成或核对正式计划书后再回复您。',
      citations: approved ? evidence.citations.filter(item => item.document_id === approved.document_id
        && item.location === approved.location) : [],
      next_question: null,
      next_action: 'sales_review_missing_formal_amount',
      risk_flags: unique([...common.risk_flags, 'unsupported_amount']),
      missing_evidence: unique([...common.missing_evidence, 'formal_plan_required']),
      review_required: true,
      trace: { provider: 'source-gap-rule', workflow_run_id: null }
    });
  }
  if (CLAIM_GUARANTEE_QUESTION.test(message)) {
    return baseResult(context, {
      ...common,
      status: 'human_required',
      draft: '是否理赔不能提前保证，需要结合保险合同、案件事实和保险公司的正式审核结果判断。这条我交给人工专员核对处理。',
      next_question: null,
      next_action: 'human_review_claim_coverage',
      risk_flags: unique([...common.risk_flags, 'claim_outcome_requires_human_review']),
      review_required: true,
      trace: { provider: 'claim-safety-rule', workflow_run_id: null }
    });
  }
  const mode = interactionType(context);
  const isService = mode === 'contract_service';
  if (route === 'human_required') {
    return baseResult(context, {
      ...common,
      status: 'human_required',
      draft: safetyAcknowledgement(route, message),
      next_question: null,
      next_action: 'route_to_human_owner',
      risk_flags: unique([...common.risk_flags, context.contact_state?.human_handoff ? 'human_handoff_active' : 'high_risk_service_request'])
    });
  }
  if (route === 'stop_marketing') {
    return baseResult(context, {
      ...common,
      status: 'stop_marketing',
      draft: safetyAcknowledgement(route, message),
      next_question: null,
      next_action: 'stop_marketing_contact',
      risk_flags: unique([...common.risk_flags, 'marketing_opt_out'])
    });
  }
  if (context.contact_state?.purchased_for_opportunity === true && !isService) {
    return baseResult(context, {
      ...common,
      status: 'human_required',
      next_question: null,
      next_action: 'route_to_service_or_create_new_opportunity',
      risk_flags: unique([...common.risk_flags, 'purchased_opportunity_not_for_resale'])
    });
  }
  if (isService && !text(context.product_scope?.policy_contract_version, 160)) {
    return baseResult(context, {
      ...common,
      status: 'needs_source',
      draft: '这是已有保单的服务问题，需要先核对对应的正式合同版本。当前资料不足，我先不凭经验回答；请销售或服务人员调取保单和合同后再回复您。',
      next_question: null,
      next_action: 'locate_bound_contract_source',
      missing_evidence: unique([...common.missing_evidence, 'policy_contract_version_required'])
    });
  }
  if (route === 'product_faq' && (!text(context.product_scope?.product_id, 160) || !text(context.product_scope?.product_version, 160))) {
    if (isProductActionQuestion(message)) {
      return baseResult(context, {
        ...common,
        status: 'draft_ready',
        draft: '交费年限和以后的领取方式都要看具体产品和正式资料，我现在不先凭经验猜。我已请销售核对产品全称、正式计划书和合同条款后跟进回复。',
        next_question: null,
        next_action: 'priority_sales_follow_up',
        risk_flags: unique([...common.risk_flags, 'product_scope_required']),
        missing_evidence: unique([...common.missing_evidence, 'product_scope_required', 'formal_product_material_required']),
        review_required: true,
        trace: { provider: 'source-gap-rule', workflow_run_id: null }
      });
    }
    if (GUARANTEED_AMOUNT_QUESTION.test(message)) {
      const retrieve = typeof dependencies.retrieveKnowledge === 'function' ? dependencies.retrieveKnowledge : defaultRetrieveKnowledge;
      const evidence = normalizeRetrieval(await retrieve({
        query: '领取金额 合同保证 计划书演示',
        workspace_id: context.workspace_id,
        trace_id: context.trace_id || null,
        session_id: context.session_id || null,
        interaction_type: 'new_consultation',
        environment: context.environment,
        knowledge_scope: 'global',
        product_scope: {},
        as_of: context.product_scope?.as_of || recordedAt.slice(0, 10),
        limit: 3
      }, { allowSimulationKnowledge: dependencies.allowSimulationKnowledge === true }));
      const approved = evidence.documents.find(item => item.location === '保证内容与演示内容边界');
      return baseResult(context, {
        ...common,
        status: 'draft_ready',
        draft: approved
          ? '根据当前已审核的通用合规资料：领取金额要区分“保险合同明确约定的保证内容”和“计划书中的演示内容”，不能笼统说都是保证的。当前还没绑定具体产品和正式计划书，我不能确认具体金额；请销售按合同和正式计划书逐项核对。'
          : '领取金额要区分“合同明确约定的保证内容”和“计划书中的演示内容”。当前没有可引用的已审核资料，不能确认具体金额，请销售按合同和正式计划书核对。',
        citations: approved ? evidence.citations.filter(item => item.document_id === approved.document_id && item.location === approved.location) : [],
        next_question: null,
        next_action: 'sales_review_guarantee_scope',
        risk_flags: unique([...common.risk_flags, 'guarantee_scope_requires_source']),
        missing_evidence: unique([...common.missing_evidence, 'product_scope_required', 'formal_plan_required']),
        review_required: true,
        trace: { provider: 'source-gap-rule', workflow_run_id: null }
      });
    }
    if (MID_TERM_LIQUIDITY_QUESTION.test(message) && !/(?:担心|顾虑|还是老问题|仍然)/.test(message)) {
      const retrieve = typeof dependencies.retrieveKnowledge === 'function' ? dependencies.retrieveKnowledge : defaultRetrieveKnowledge;
      const evidence = normalizeRetrieval(await retrieve({
        query: '中途急用钱 现金价值 保单贷款 减保 部分领取',
        workspace_id: context.workspace_id,
        trace_id: context.trace_id || null,
        session_id: context.session_id || null,
        interaction_type: 'new_consultation',
        environment: context.environment,
        knowledge_scope: 'global',
        product_scope: {},
        as_of: context.product_scope?.as_of || recordedAt.slice(0, 10),
        limit: 3
      }, { allowSimulationKnowledge: dependencies.allowSimulationKnowledge === true }));
      const approved = evidence.documents.find(item => item.location === '中途资金使用核对边界');
      return baseResult(context, {
        ...common,
        status: 'draft_ready',
        draft: approved
          ? '中途需要资金时，通常要逐项核对合同是否支持保单贷款、减保或部分领取，也要核对退保时的现金价值。不同产品不一定支持这些方式；办理后可能影响保额、保障、现金价值或合同效力，具体以合同和当时保单状态为准，不能承诺“随时取”或“没有损失”。'
          : '中途用钱时能否办理、有哪些方式以及会有什么影响，必须看具体产品合同和当时保单情况。在核对前不能承诺“随时取”，也不能承诺“没有损失”；请把产品全称或合同资料交给销售核对。',
        citations: approved ? evidence.citations.filter(item => item.document_id === approved.document_id && item.location === approved.location) : [],
        next_question: null,
        next_action: 'sales_review_liquidity_terms',
        risk_flags: unique([...common.risk_flags, 'liquidity_terms_require_source']),
        missing_evidence: unique([...common.missing_evidence, 'product_scope_required', 'policy_contract_version_required']),
        review_required: true,
        trace: { provider: 'source-gap-rule', workflow_run_id: null }
      });
    }
    if (AMBIGUOUS_PRODUCT_NAME.test(message)) {
      return baseResult(context, {
        ...common,
        status: 'draft_ready',
        draft: '先不根据俗称或近似名称猜产品，以免查错条款。请您发一下产品全称，或保单、计划书上产品名称的截图，再按正确产品和版本查询。',
        next_question: '请问产品全称是什么？',
        next_action: 'confirm_product_identity',
        risk_flags: unique([...common.risk_flags, 'ambiguous_product_identity']),
        missing_evidence: unique([...common.missing_evidence, 'exact_product_name_required']),
        review_required: false,
        trace: { provider: 'source-gap-rule', workflow_run_id: null }
      });
    }
    if (UNSUPPORTED_AMOUNT_QUESTION.test(message)) {
      return baseResult(context, {
        ...common,
        status: 'draft_ready',
        draft: '当前已核验资料中没有这个具体金额，我不能参照相似案例估算。请销售使用具体产品的正式计划书核验后再回复。',
        next_question: null,
        next_action: 'sales_review_missing_formal_amount',
        risk_flags: unique([...common.risk_flags, 'unsupported_amount']),
        missing_evidence: unique([...common.missing_evidence, 'formal_plan_required']),
        review_required: true,
        trace: { provider: 'source-gap-rule', workflow_run_id: null }
      });
    }
    if (CONTRACT_ORIGINAL_REQUEST.test(message)) {
      return baseResult(context, {
        ...common,
        status: 'draft_ready',
        draft: '合同原文必须来自可追溯的正式条款，不能用 FAQ 或口语解释代替。当前未确认具体产品和合同版本，请销售核对后发送正式条款；之后可以再将条款用通俗语言单独解释。',
        next_question: null,
        next_action: 'sales_send_official_contract_source',
        risk_flags: unique([...common.risk_flags, 'official_contract_source_required']),
        missing_evidence: unique([...common.missing_evidence, 'product_scope_required', 'policy_contract_version_required']),
        review_required: true,
        trace: { provider: 'source-gap-rule', workflow_run_id: null }
      });
    }
    if (/(?:频繁|多次|一直).{0,16}(?:问|询问).{0,20}(?:交费|缴费).{0,12}(?:领取)/.test(message)) {
      return baseResult(context, {
        ...common,
        status: 'human_required',
        draft: '看到您已经在具体了解交费和领取了。在还没确认购买对象和具体产品前，我不先做个性化结论，这条我优先请销售接手补齐必要信息。',
        next_question: null,
        next_action: 'priority_sales_follow_up',
        review_required: true,
        trace: { provider: 'intent-handoff-rule', workflow_run_id: null }
      });
    }
    if (GENERAL_PRODUCT_OVERVIEW.test(message)) {
      return baseResult(context, {
        ...common,
        status: 'draft_ready',
        draft: '我们可以先按养老、孩子教育、长期储备等方向了解，不急着选具体产品。您目前最关心哪个方向呢？',
        next_question: '您目前最关心哪个方向？',
        next_action: 'auto_send_safe_intake',
        review_required: false,
        trace: { provider: 'lead-intake-rule', workflow_run_id: null }
      });
    }
    if (DEFER_BUDGET_ASK_RECEIPT.test(message)) {
      return baseResult(context, {
        ...common,
        status: 'draft_ready',
        draft: '好的，预算先不问。什么时候开始领取要看具体产品和正式资料，我先请销售围绕领取时间给您核对说明。',
        next_question: null,
        next_action: 'sales_review_product_timing',
        risk_flags: unique([...common.risk_flags, 'product_scope_required']),
        missing_evidence: unique([...common.missing_evidence, 'product_scope_required']),
        review_required: true,
        trace: { provider: 'source-gap-rule', workflow_run_id: null }
      });
    }
    if (/(?:还是老问题|仍然|还是).{0,20}(?:担心|顾虑).{0,10}(?:中途用钱|流动性)|(?:担心|顾虑).{0,10}(?:中途用钱|流动性)/.test(message)) {
      return baseResult(context, {
        ...common,
        status: 'draft_ready',
        draft: '明白，这就是上次尚未解决的“中途可能要用钱”顾虑。我会合并到原来的流动性问题继续处理，不另建一个无关问题，也不会标记为已经解决；具体条件仍要按产品和正式资料核对。',
        next_question: null,
        next_action: 'sales_review_liquidity_constraint',
        risk_flags: unique([...common.risk_flags, 'liquidity_constraint']),
        missing_evidence: unique([...common.missing_evidence, 'product_scope_required']),
        review_required: true,
        trace: { provider: 'source-gap-rule', workflow_run_id: null }
      });
    }
    if (YIELD_QUESTION.test(message) && FORMAL_PLAN_MISSING.test(message)) {
      return baseResult(context, {
        ...common,
        status: 'draft_ready',
        draft: '目前没有您的正式计划书，我不能直接给出收益率数字。我先请销售核对正式计划书后，再根据正式资料回复您。',
        next_question: null,
        next_action: 'sales_review_missing_formal_plan',
        risk_flags: unique([...common.risk_flags, 'formal_plan_required']),
        missing_evidence: unique([...common.missing_evidence, 'product_scope_required', 'formal_plan_required']),
        review_required: true,
        trace: { provider: 'source-gap-rule', workflow_run_id: null }
      });
    }
    return baseResult(context, {
      ...common,
      status: 'draft_ready',
      draft: sourceGapDraft({ route, productKnown: false }),
      next_question: '请问产品全称是什么？',
      next_action: 'confirm_product_identity',
      risk_flags: unique([...common.risk_flags, 'ambiguous_product_identity']),
      missing_evidence: unique([...common.missing_evidence, 'product_scope_required', 'exact_product_name_required']),
      review_required: false,
      trace: { provider: 'source-gap-rule', workflow_run_id: null }
    });
  }
  if (route === 'product_match') {
    const explicitPlanRequest = /(?:具体)?计划书/.test(message) && /(?:年龄|预算)/.test(message);
    return baseResult(context, { ...common, status: 'needs_information',
      draft: explicitPlanRequest ? '已经记下您提供的年龄和预算。具体计划书需要销售核对正式资料，我已将这条设为优先处理。' : '',
      next_question: null, next_action: explicitPlanRequest ? 'priority_sales_follow_up' : 'run_product_match',
      review_required: true, trace: { provider: 'routing-rule', workflow_run_id: null } });
  }
  if (route === 'intake') {
    const intake = leadIntakeReply(message, context);
    if (intake.profileComplete) {
      return baseResult(context, {
        ...common,
        status: 'needs_information',
        draft: '',
        next_question: null,
        next_action: 'await_product_match_intent',
        review_required: true,
        trace: { provider: 'lead-intake-rule', workflow_run_id: null }
      });
    }
    return baseResult(context, {
      ...common,
      status: 'draft_ready',
      draft: intake.draft,
      next_question: common.next_question || intake.question,
      next_action: intake.nextAction || 'auto_send_safe_intake',
      review_required: intake.reviewRequired === true,
      trace: { provider: 'lead-intake-rule', workflow_run_id: null }
    });
  }

  const retrieve = typeof dependencies.retrieveKnowledge === 'function' ? dependencies.retrieveKnowledge : defaultRetrieveKnowledge;
  let retrieval;
  try {
    retrieval = normalizeRetrieval(await retrieve({
      query: message,
      workspace_id: context.workspace_id,
      trace_id: context.trace_id || null,
      session_id: context.session_id || null,
      interaction_type: mode,
      environment: context.environment,
      knowledge_scope: route === 'public_faq' ? 'global' : 'product',
      product_scope: { ...context.product_scope },
      as_of: context.product_scope?.as_of || recordedAt.slice(0, 10),
      limit: 5
    }, {
      allowSimulationKnowledge: dependencies.allowSimulationKnowledge === true
    }));
  } catch {
    return baseResult(context, {
      ...common,
      status: 'unavailable',
      draft: sourceGapDraft({ route, isService, productKnown: Boolean(text(context.product_scope?.product_id, 160)) }),
      next_action: 'retry_knowledge_retrieval',
      missing_evidence: unique([...common.missing_evidence, 'knowledge_retrieval_failed']),
      trace: { provider: 'knowledge-adapter', workflow_run_id: null }
    });
  }

  if (!retrieval.documents.length) {
    const contractMissing = isService && !text(context.product_scope?.policy_contract_version, 160);
    const productMissing = !isService && route !== 'public_faq' && !text(context.product_scope?.product_version, 160);
    const evidenceConflict = retrieval.evidence_status === 'conflict' || (Array.isArray(retrieval.conflicts) && retrieval.conflicts.length > 0);
    return baseResult(context, {
      ...common,
      status: 'needs_source',
      draft: sourceGapDraft({ route, isService, productKnown: Boolean(text(context.product_scope?.product_id, 160)) }),
      next_question: null,
      next_action: evidenceConflict ? 'resolve_knowledge_conflict' : isService ? 'locate_bound_contract_source' : 'verify_product_source',
      risk_flags: unique([...common.risk_flags, ...(evidenceConflict ? ['knowledge_evidence_conflict'] : []), ...(retrieval.review_candidates.length ? ['business_review_pending'] : [])]),
      missing_evidence: unique([
        ...common.missing_evidence,
        evidenceConflict ? 'conflicting_approved_sources' : null,
        contractMissing ? 'policy_contract_version_required' : null,
        productMissing ? 'product_version_required' : null,
        retrieval.review_candidates.length ? 'candidate_source_not_business_approved' : 'no_relevant_approved_source'
      ]),
      trace: { provider: 'knowledge-adapter', workflow_run_id: null }
    });
  }

  let experienceResult = { status: 'not_configured', experiences: [] };
  let experienceRiskFlags = [];
  if (typeof dependencies.retrieveExperiences === 'function') {
    try {
      experienceResult = normalizeExperiences(await dependencies.retrieveExperiences({
        workspace_id: context.workspace_id,
        environment: context.environment,
        product_scope: { ...context.product_scope },
        query: message,
        interaction_type: mode
      }));
    } catch {
      experienceResult = { status: 'error', experiences: [] };
      experienceRiskFlags = ['experience_retrieval_failed'];
    }
  }
  const experienceIds = experienceResult.experiences
    .map(item => text(item?.experience_id, 160)).filter(Boolean).slice(0, 5);
  const salesExperienceSuggestions = experienceSuggestions(experienceResult.experiences);
  const traceWithExperiences = (provider, workflowRunId = null) => ({
    provider,
    workflow_run_id: workflowRunId,
    experience_status: experienceResult.status,
    experience_ids: experienceIds
  });

  if (typeof dependencies.runDify !== 'function') {
    return baseResult(context, {
      ...common,
      experience_suggestions: salesExperienceSuggestions,
      status: 'unavailable',
      next_action: 'configure_isolated_dify_workflow',
      risk_flags: unique([...common.risk_flags, ...experienceRiskFlags]),
      missing_evidence: unique([...common.missing_evidence, 'dify_not_configured']),
      trace: traceWithExperiences('unconfigured')
    });
  }

  const difyPayload = {
    inputs: {
      schema_version: SCHEMA_VERSION,
      interaction_type: mode,
      latest_message: message,
      context_json: JSON.stringify({
        workspace_id: context.workspace_id,
        trace_id: context.trace_id || null,
        session_id: context.session_id || null,
        evaluation: context.evaluation || null,
        environment: context.environment,
        contact_state: context.contact_state,
        conversation_route: route,
        context_versions: context.context_versions,
        customer_id: context.customer_id,
        opportunity_id: context.opportunity_id,
        persons: context.persons,
        confirmed_facts: context.confirmed_facts,
        recent_messages: context.recent_messages,
        long_term_summary: context.long_term_summary,
        open_objections: context.open_objections,
        promises: context.promises,
        verified_plan: context.verified_plan,
        product_scope: context.product_scope,
        confirmed_product_match: match.value
      }),
      knowledge_json: JSON.stringify(retrieval.documents.map(document => ({
        citation_id: `${document.document_id}#${document.location}`,
        document_id: document.document_id,
        version: document.version,
        product_id: document.product_id ?? null,
        product_version: document.product_version ?? null,
        policy_contract_version: document.policy_contract_version ?? null,
        scope: document.scope,
        lifecycle_status: document.lifecycle_status,
        index_status: document.index_status,
        verification_status: document.verification_status,
        customer_use: document.customer_use,
        location: document.location,
        text: document.text,
        source: document.source
      })))
    },
    user: `workspace:${text(context.workspace_id, 160)}:customer:${text(context.customer_id, 160)}`
  };
  let raw;
  try {
    raw = await dependencies.runDify(difyPayload);
  } catch {
    return baseResult(context, {
      ...common,
      experience_suggestions: salesExperienceSuggestions,
      status: 'unavailable',
      next_action: 'retry_dify_workflow',
      risk_flags: unique([...common.risk_flags, ...experienceRiskFlags]),
      missing_evidence: unique([...common.missing_evidence, 'dify_call_failed']),
      trace: traceWithExperiences('dify')
    });
  }

  let output = unwrapDify(raw);
  let checked = modelValidation(output, retrieval);
  const invalidStructuredDraft = ['human_required', 'invalid_output'].includes(checked.status)
    && checked.risk_flags.includes('invalid_dify_output');
  if (invalidStructuredDraft) {
    try {
      raw = await dependencies.runDify(difyPayload);
      output = unwrapDify(raw);
      checked = modelValidation(output, retrieval);
    } catch {
      // The normal fail-closed path below handles the original invalid result.
    }
  }
  const workflowRunId = text(raw?.workflow_run_id || raw?.data?.id || raw?.id || output?.workflow_run_id, 200) || null;
  if (checked.error) {
    return baseResult(context, {
      ...common,
      experience_suggestions: salesExperienceSuggestions,
      status: checked.error === 'dify_citation_missing' ? 'needs_source' : 'invalid_output',
      draft: checked.error === 'dify_citation_missing'
        ? sourceGapDraft({ route, isService, productKnown: Boolean(text(context.product_scope?.product_id, 160)) })
        : '',
      next_question: null,
      next_action: checked.error === 'dify_citation_missing' ? 'regenerate_with_valid_citation' : 'review_invalid_ai_output',
      risk_flags: unique([...common.risk_flags, ...experienceRiskFlags, 'invalid_dify_output']),
      missing_evidence: unique([...common.missing_evidence, checked.error]),
      trace: traceWithExperiences(text(output?.provider, 120) || 'dify', workflowRunId)
    });
  }

  const directProductFactAnswered = route === 'product_faq'
    && Boolean(text(context.product_scope?.product_id, 160))
    && Boolean(text(context.product_scope?.product_version, 160))
    && checked.status === 'draft_ready'
    && checked.citations.length > 0
    && !common.next_question;
  const checkedDraft = checked.draft || (checked.status === 'needs_source'
    ? sourceGapDraft({ route, isService, productKnown: Boolean(text(context.product_scope?.product_id, 160)) })
    : '');
  const finalDraft = directProductFactAnswered
    ? withCurrentProductSourceCue(withoutTrailingQuestion(checkedDraft))
    : checkedDraft;

  return baseResult(context, {
    ...common,
    experience_suggestions: salesExperienceSuggestions,
    status: checked.risk_flags.includes('invalid_dify_output') ? 'invalid_output' : checked.status,
    draft: ['draft_ready', 'needs_source'].includes(checked.status) ? finalDraft : '',
    citations: checked.citations,
    next_question: directProductFactAnswered ? null : (common.next_question || checked.next_question || experienceQuestion(experienceResult.experiences)),
    next_action: checked.next_action,
    risk_flags: unique([...common.risk_flags, ...experienceRiskFlags, ...checked.risk_flags, ...(context.contact_state?.marketing_opt_out && isService ? ['marketing_opt_out_service_only'] : [])]),
    missing_evidence: unique([...common.missing_evidence, ...checked.missing_evidence]),
    trace: traceWithExperiences(text(output?.provider, 120) || 'dify', workflowRunId)
  });
}

export const __test = { contextProblem, interactionType, staleContext, normalizeRetrieval, normalizeExperiences, experienceQuestion, experienceSuggestions, leadIntakeReply, withoutTrailingQuestion, withCurrentProductSourceCue, sanitizeCustomerDraft, sameContextVersions, confirmedProductMatch, unwrapDify, modelValidation, citationsFromModel };
