import { DIMENSIONS } from '../../services/acquisition/contracts.mjs';

// Only injected by tests; the runnable service has no fixture/simulation mode.
export function validFixtureReport(paragraph) {
  return { summary: '接口测试报告：只用于验证流程与引用校验，不代表真实 AI 分析质量。',
    dimensions: DIMENSIONS.map(([id]) => ({ id, status: 'present', observation: '测试观察',
      evidence: [{ paragraph_id: paragraph.id, quote: paragraph.text }],
      possible_effect: '可能用于解释问题；此项是测试数据。', migration: '测试迁移方法', limitations: '接口测试材料' })),
    reusable_methods: ['接口测试方法'], replace_items: [], required_materials: [] };
}
export function fixtureRunner(custom) {
  const calls = [];
  return { configured: true, model: 'fixture-no-paid-api', provider: 'test_fixture', calls,
    async run(input) { calls.push(input); return custom ? custom(input, calls.length) : {
      output: validFixtureReport(input.payload.paragraphs[0]), model: 'fixture-no-paid-api', provider: 'test_fixture', usage: null }; } };
}
