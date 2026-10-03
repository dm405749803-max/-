import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkflow } from '../../services/acquisition/workflow.mjs';
import { fixtureRunner, validFixtureReport } from './fixtures.mjs';

function setup(t, runner) {
  const dir = mkdtempSync(join(tmpdir(), 'acquisition-test-')); let workflow;
  const open = (currentRunner = runner) => workflow = createWorkflow({ databasePath: join(dir, 'tasks.sqlite'), checkpointPath: join(dir, 'graph.sqlite'), runner: currentRunner });
  const close = () => { workflow?.close(); workflow = null; };
  t.after(() => { close(); rmSync(dir, { recursive: true, force: true }); });
  return { open, close };
}
const confirm = (task, extra = {}) => ({ action: 'confirm', mode: 'full', command_id: crypto.randomUUID(), expected_revision: task.revision, ...extra });
test('真实 LangGraph 在原文确认前暂停，重启后恢复，并且只分析删减后的文字', async t => {
  const runner = fixtureRunner(), env = setup(t, runner); let w = env.open();
  const task = await w.create({ title: '确认门测试', platform: 'xiaohongshu', text: '先明确每年的支出。\n这个段落不采用。\n再考虑退休现金流。' });
  assert.equal(task.status, 'waiting_confirmation'); assert.equal(runner.calls.length, 0);
  assert.deepEqual((await w.graph.getState({ configurable: { thread_id: task.id } })).next, ['confirm_source']);
  env.close(); w = env.open();
  const selected = '先明确每年的支出。\n再考虑退休现金流。';
  const result = await w.command(task.id, confirm(task, { mode: 'trimmed', text: selected }));
  assert.equal(result.status, 'report_ready'); assert.equal(result.confirmed_text, selected);
  assert.equal(result.original_text, task.original_text); assert.equal(result.report.content.dimensions.length, 8);
  assert.deepEqual(runner.calls[0].payload.paragraphs.map(p => p.text), ['先明确每年的支出。', '再考虑退休现金流。']);
  assert.equal(result.runs[0].provider, 'test_fixture');
  env.close(); w = env.open(); assert.equal(w.store.get(task.id).report.content.summary, result.report.content.summary);
});
test('未配置模型时保存确认范围、记录零次调用；配置后重启从拆解节点继续', async t => {
  const disabled = { configured: false, model: 'deepseek-flash', provider: 'deepseek', run() { throw Error('不应被调用'); } };
  const env = setup(t, disabled); let w = env.open();
  const task = await w.create({ text: '先明确每年的开支，再考虑退休现金流。' });
  const blocked = await w.command(task.id, confirm(task));
  assert.equal(blocked.status, 'blocked'); assert.equal(blocked.error.code, 'MODEL_NOT_CONFIGURED');
  assert.equal(blocked.runs.length, 0); assert.equal(blocked.report, null);
  assert.deepEqual((await w.graph.getState({ configurable: { thread_id: task.id } })).next, ['wait_retry']);
  env.close(); const runner = fixtureRunner(); w = env.open(runner);
  const result = await w.command(task.id, { action: 'retry', expected_revision: blocked.revision, command_id: crypto.randomUUID() });
  assert.equal(result.status, 'report_ready'); assert.equal(runner.calls.length, 1);
  assert.equal(result.events.filter(e => e.action === '原文范围已确认').length, 1);
});
test('模型捏造原句不能成为有效报告；显式重试后才保存合格版本', async t => {
  const runner = fixtureRunner((input, count) => {
    const report = validFixtureReport(input.payload.paragraphs[0]);
    if (count === 1) report.dimensions[0].evidence[0].quote = '原文中不存在的承诺收益';
    return { output: report, model: 'fixture-no-paid-api', provider: 'test_fixture' };
  });
  const w = setup(t, runner).open(); const task = await w.create({ text: '规划退休现金流前，先确认日常支出和大额支出。' });
  const bad = await w.command(task.id, confirm(task));
  assert.equal(bad.report, null); assert.equal(bad.error.code, 'REPORT_EVIDENCE_INVALID'); assert.equal(bad.runs[0].status, 'failed');
  const good = await w.command(task.id, { action: 'retry', command_id: crypto.randomUUID(), expected_revision: bad.revision });
  assert.equal(good.status, 'report_ready'); assert.equal(good.runs.length, 2); assert.equal(good.confirmed_text, task.original_text);
});
test('并发确认与重复请求不会重复调用模型，旧版本和复用请求编号会被拒绝', async t => {
  let release; const gate = new Promise(resolve => release = resolve);
  const runner = fixtureRunner(async input => { await gate; return { output: validFixtureReport(input.payload.paragraphs[0]), provider: 'test_fixture' }; });
  const w = setup(t, runner).open(); const task = await w.create({ text: '先明确每年的支出，再考虑退休现金流。' });
  const command = confirm(task); const pending = w.command(task.id, command);
  try {
    await assert.rejects(w.command(task.id, confirm(task)), { code: 'REVISION_CONFLICT' });
    const repeat = await w.command(task.id, command); assert.equal(repeat.status, 'running');
    await assert.rejects(w.command(task.id, { ...command, mode: 'edited', text: '不同的采用内容' }), { code: 'COMMAND_CONFLICT' });
  } finally { release(); }
  const ready = await pending; assert.equal(ready.status, 'report_ready'); assert.equal(runner.calls.length, 1);
  const repeat = await w.command(task.id, command); assert.equal(repeat.status, 'report_ready'); assert.equal(runner.calls.length, 1);
});
test('删空、越限和删减模式插入文字在确认前被拒绝', async t => {
  const runner = fixtureRunner(), w = setup(t, runner).open();
  await assert.rejects(w.create({ text: ' ' }), { code: 'SOURCE_REQUIRED' });
  await assert.rejects(w.create({ text: '字'.repeat(20001) }), { code: 'SOURCE_TOO_LONG' });
  const task = await w.create({ text: '先明确每年的支出。' });
  await assert.rejects(w.command(task.id, confirm(task, { mode: 'trimmed', text: '不在原文中的文字' })), { code: 'NOT_A_DELETION' });
  await assert.rejects(w.command(task.id, confirm(task, { mode: 'trimmed', text: '' })), { code: 'SOURCE_REQUIRED' });
  assert.equal(w.store.get(task.id).status, 'waiting_confirmation'); assert.equal(runner.calls.length, 0);
});
