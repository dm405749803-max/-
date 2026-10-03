// Project-defined products and benefit illustrations for the simulation workspace.
// They resemble common product structures but do not represent an insurer contract.
const version = 'practice-2026-09-v2';
const publisher = '同频产品方案演练';
const sourceLabel = '项目自主设定产品资料';

const common = [
  ['身故责任', ['身故', '受益人', '保障'], '身故责任按本产品利益演示中列明的身故给付与当时现金价值规则处理，给付后合同终止。受益人与份额需另行登记，同一情景中的现金价值、身故给付和未来领取不能重复相加。'],
  ['流动性与退出', ['现金价值', '退保', '中途', '用钱', '贷款', '减保'], '设15日犹豫期；犹豫期后解除按当时现金价值处理，早期可能低于累计已交保费。示例未写明贷款、减保或部分领取时，不能默认支持。具体退出金额按客户方案年度查询。'],
  ['交费中断', ['断交', '宽限期', '停交', '复效'], '续期保费设60日宽限期；宽限期满仍未交费，合同效力中止。中止后2年内可申请复效，需补齐约定款项并经审核，不能承诺必然复效。'],
  ['核验与服务边界', ['健康', '职业', '免责', '核保', '理赔', '资料'], '还需核对身份关系、职业、健康告知、受益人、缴费来源、销售地域及免责事项。基础规则匹配不等于通过核保；理赔、投诉、退保、争议及特殊申请转人工。']
];

const definitions = [
  {
    id: 'practice-retirement-annuity', name: '颐享年年养老年金',
    aliases: [],
    rules: { purpose_codes: ['retirement'], insured_age: { min: 18, max: 50 }, annual_budget: { min: 6000, max: 1000000, currency: 'CNY' }, funds_usage_years: { min: 15 }, payment_years: [5, 10, 20] },
    illustration: {
      assumptions: '38岁女性，年交30000元，10年交，共交300000元，60岁起按年领取至85岁；以下金额均为项目演练设定。',
      benefits: '60至85岁每年领取25000元，共26次，累计650000元；85岁之后的利益未在本演示中设定。',
      values: '第10年现金价值270000元；第20年390000元；第22年领取前420000元。',
      returns: '按每年期初交费、60至85岁每年期末领取计算，持有领取口径年化IRR约2.67%；第10年退保尚未回本。IRR只适用于本组演练现金流。'
    },
    chunks: [
      ['产品定位', ['养老', '退休', '用途', '产品'], '用于规划退休后的分期现金流。先确认退休时间、已有养老金、每月资金缺口、家庭应急金和持续交费能力；近期要用的钱不进入长期养老预算。'],
      ['领取安排', ['领取', '能领多少', '月领', '年领', '60岁', '65岁'], '可约定60岁或65岁起领，首次领取须在交费完成后。按年或按月领取至约定终点；不同年龄、交费期与起领年龄使用各自方案，不能套用演练金额。']
    ]
  },
  {
    id: 'practice-education-annuity', name: '启航成长教育年金',
    aliases: ['启航成长'],
    rules: { purpose_codes: ['education'], insured_age: { min: 0, max: 10 }, annual_budget: { min: 3000, max: 1000000, currency: 'CNY' }, funds_usage_years: { min: 8, max: 18 }, payment_years: [3, 5] },
    illustration: {
      assumptions: '6岁孩子，年交20000元，5年交，共交100000元；以下金额均为项目演练设定。',
      benefits: '18至21岁每年领取22000元，4次共88000元；22岁领取满期金45000元；累计领取133000元。',
      values: '第5年现金价值85000元；第10年96000元；第12年领取前103000元。',
      returns: '按每年期初交费、18至22岁每年期末领取计算，满期领取口径年化IRR约2.34%。不能把累计领取减总保费后直接除年数称作年化收益率。'
    },
    chunks: [
      ['产品定位', ['教育', '孩子', '大学', '用途', '产品'], '用于安排孩子大学阶段的分期教育支出。保障对象是孩子，交费能力核对对象通常是家长；家长和孩子的年龄必须分开记录。'],
      ['领取安排', ['领取', '能领多少', '教育金', '18岁', '21岁', '22岁', '满期'], '约定孩子18至21岁领取教育年金，22岁领取满期金后合同终止。实际金额与孩子年龄、保费和交费期绑定，需使用对应方案。']
    ]
  },
  {
    id: 'practice-wealth-life', name: '稳盈传家增额终身寿险',
    rules: { purpose_codes: ['wealth_preservation'], insured_age: { min: 18, max: 65 }, annual_budget: { min: 10000, max: 1000000, currency: 'CNY' }, funds_usage_years: { min: 10 }, payment_years: [3, 5, 10] },
    illustration: {
      assumptions: '40岁女性，年交50000元，5年交，共交250000元；以下金额均为项目演练设定。',
      benefits: '本产品不设固定生存年金。身故利益演示：第10年300000元、第20年400000元、第30年530000元，实际给付按发生时规则核对。',
      values: '现金价值演示：第5年220000元、第10年285000元、第20年380000元、第30年505000元。',
      returns: '以现金价值作为对应年度退保流入，第10年退保IRR约1.65%，第20年约2.35%；身故利益不是确定可领取收益，不能与现金价值叠加计算。'
    },
    chunks: [
      ['产品定位', ['财富', '保值', '长期储备', '用途', '产品'], '用于长期财富储备和身故保障，不适合承担三至五年内确定支出。需要确认计划持有期限、应急金和家庭保障缺口。'],
      ['领取与使用', ['领取', '能领多少', '减保', '现金价值'], '不设固定生存年金。客户需要资金时只能按当时合同支持的退保、减保或贷款规则办理；本演示仅提供现金价值，不自动承诺减保或贷款。']
    ]
  },
  {
    id: 'practice-legacy-annuity', name: '恒承家业传承年金',
    rules: { purpose_codes: ['legacy_planning'], insured_age: { min: 30, max: 70 }, annual_budget: { min: 20000, max: 2000000, currency: 'CNY' }, funds_usage_years: { min: 15 }, payment_years: [5, 10, 20] },
    illustration: {
      assumptions: '45岁男性，年交30000元，10年交，共交300000元；以下金额均为项目演练设定。',
      benefits: '身故传承金演示：第10年360000元、第20年480000元、第30年650000元；给付对象及比例以已登记受益人为准。',
      values: '现金价值演示：第10年280000元、第20年390000元、第30年520000元。',
      returns: '若仅为演示计算，身故传承金对应第10年现金流IRR约3.29%、第20年约3.05%；死亡时间不可预测，因此该数值不能作为客户可实现的确定收益率。退保只能使用现金价值口径另算。'
    },
    chunks: [
      ['产品定位', ['传承', '遗产', '受益人', '用途', '产品'], '用于明确长期身故给付与受益安排。销售需先确认家庭成员、债务、已有保障、受益人意愿及长期交费能力，不能用产品代替法律或税务意见。'],
      ['传承安排', ['领取', '传承金', '身故金', '受益人'], '产品不设本人固定生存领取；符合约定事件时向受益人给付传承金。受益人、份额、变更及理赔资料必须人工核对。']
    ]
  },
  {
    id: 'practice-savings-endowment', name: '安心储备两全保险',
    aliases: ['安心储备'],
    rules: { purpose_codes: ['general_savings'], insured_age: { min: 18, max: 60 }, annual_budget: { min: 3000, max: 500000, currency: 'CNY' }, funds_usage_years: { min: 10, max: 20 }, payment_years: [3, 5, 10] },
    illustration: {
      assumptions: '35岁女性，年交20000元，5年交，共交100000元，保险期间15年；以下金额均为项目演练设定。',
      benefits: '第15年生存领取满期金140000元并终止；保险期间内身故给付按累计已交保费与当时现金价值较大者。',
      values: '现金价值演示：第5年88000元、第10年112000元、第15年140000元。',
      returns: '按每年期初交费、第15年期末领取满期金计算，满期IRR约2.62%；第10年退保约为112000元，需按退保现金流单独计算，不能使用满期IRR。'
    },
    chunks: [
      ['产品定位', ['储蓄', '备用金', '满期', '用途', '产品'], '用于十至二十年后的确定性资金储备。短期应急金、日常开支和高波动投资目标不应放入本方案。'],
      ['领取安排', ['领取', '能领多少', '满期金', '15年'], '生存至第15年满期日领取满期金后合同终止，中途没有固定领取。实际满期金额与年龄、保费及交费期绑定。']
    ]
  }
];

function illustrationText(def) {
  const x = def.illustration;
  return `${x.assumptions}${x.benefits}${x.values}${x.returns}本利益演示用于测试产品推荐和方案说明，金额为人民币；名义金额未扣除通胀，不代表分红、万能账户或保险公司报价。更换年龄、性别、保费、交费期、领取时间或退出年度后必须重新生成，不能按比例直接外推。`;
}

export function generalizedProductBundles() {
  return definitions.map(def => {
    const documentId = `${def.id}-terms`;
    const rules = structuredClone(def.rules);
    const condition = `本项目自拟的“${def.name}”用于方案演练。投保年龄范围${rules.insured_age.min}至${rules.insured_age.max}周岁；可选${rules.payment_years.map(y => `${y}年交`).join('、')}。年度保费方案范围${rules.annual_budget.min}至${rules.annual_budget.max}元。资金使用期限至少${rules.funds_usage_years.min}年${rules.funds_usage_years.max ? `、至多${rules.funds_usage_years.max}年` : ''}。以上为基础讨论条件，不是核保结果。`;
    const document = {
      document_id: documentId, version, title: `${def.name}产品资料`, knowledge_type: 'product',
      product_id: def.id, product_version: version, policy_contract_versions: [], scopes: ['new_consultation'],
      lifecycle_status: 'active', index_status: 'ready', verification_status: 'business_verified',
      customer_use: 'approved_for_simulation', valid_from: '2026-09-23', valid_to: null,
      source: { publisher, label: sourceLabel, url: null, retrieved_at: '2026-09-24' }, topics: [],
      chunks: [
        { location: '投保范围与交费期', keywords: ['交费', '缴费', '年交', '几年', '投保年龄', '预算', '匹配'], text: condition },
        ...def.chunks.map(([location, keywords, text]) => ({ location, keywords, text })),
        { location: '利益演示与收益口径', keywords: ['领取', '金额', '收益', '收益率', 'IRR', '回本', '现金价值', '计划书'], text: illustrationText(def) },
        ...common.map(([location, keywords, text]) => ({ location, keywords, text }))
      ]
    };
    const catalog = {
      product_id: def.id, product_version: version, name: def.name, environment: 'simulation',
      catalog_status: 'active', valid_from: document.valid_from, valid_to: null, approval_status: 'approved',
      reviewer: '项目演练设定', approval_source: '用户授权的自拟产品设定，仅启用演练用途，不代表保险公司审批',
      source_kind: 'simulation_fixture',
      source_refs: [{ source_id: documentId, title: document.title, version, section: '投保范围与交费期' }],
      rules, idempotency_key: `seed-${def.id}-${version}`
    };
    return { catalog, document, illustration: structuredClone(def.illustration) };
  });
}

export function isGeneralizedProductScope(scope = {}) {
  return definitions.some(def => def.id === scope.product_id && scope.product_version === version);
}

export function isApprovedGeneralizedChunk(document, chunk) {
  const expected = generalizedProductBundles().find(item => item.document.document_id === document.document_id)?.document;
  return Boolean(expected && document.product_id === expected.product_id && document.product_version === version
    && document.version === version && document.source?.publisher === publisher && document.source?.label === sourceLabel
    && document.source?.url === null && expected.chunks.some(item => item.location === chunk.location && item.text === chunk.text));
}

export function resolveGeneralizedProductScopes(query = '') {
  const value = String(query || '');
  return definitions.flatMap(def => {
    const matched = [def.name, ...(def.aliases || [])]
      .filter(name => value.includes(name))
      .sort((left, right) => right.length - left.length)[0];
    return matched ? [{
      product_id: def.id,
      product_version: version,
      name: def.name,
      requested_name: matched
    }] : [];
  });
}
