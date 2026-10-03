const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/Users/damo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const base = process.env.COPILOT_TEST_URL || 'http://127.0.0.1:8841';
(async () => {
  const directory = mkdtempSync(join(tmpdir(), 'copilot-browser-'));
  const server = process.env.COPILOT_TEST_URL ? null : spawn(process.execPath, ['local-server.mjs'], { stdio: 'ignore', env: { ...process.env,
    LOCAL_PORT: '8841', V2_DATABASE_PATH: join(directory, 'test.sqlite'), DIFY_APP_API_KEY: '', DIFY_MEMORY_APP_API_KEY: '', DIFY_MATCH_APP_API_KEY: '',
    TONGPIN_ENABLE_BACKEND_B1: '0', TONGPIN_ENABLE_BACKEND_B2: '0' } });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } }); const errors = [];
    page.setDefaultTimeout(10000); page.on('dialog', dialog => dialog.accept());
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/sales-copilot.html');
    await page.waitForFunction(() => document.querySelector('#draft-editor').value.length > 0);
    const original = await page.locator('#draft-editor').inputValue();
    const edited = original.replace('提前考虑', '提前规划');
    await page.locator('#draft-editor').fill(edited);
    await page.getByRole('button', { name: /周先生/ }).click();
    await page.waitForFunction(() => document.querySelector('#chat-name').textContent === '周先生');
    assert.equal(await page.locator('#draft-editor').inputValue(), '');
    assert.equal(await page.locator('#send').isEnabled(), false);
    await page.getByRole('button', { name: /林女士/ }).click();
    await page.waitForFunction(value => document.querySelector('#draft-editor').value === value, edited);
    await page.reload();
    await page.waitForFunction(value => document.querySelector('#draft-editor').value === value, edited);

    const send = async result => {
      await page.locator('#send-outcome').selectOption(result);
      await page.locator('#send').click();
      const sent = page.waitForResponse(r => r.url().endsWith('/copilot/send') && r.request().method() === 'POST');
      await page.locator('#dialog-confirm').click(); await sent;
    };
    await send('failed');
    await page.waitForFunction(() => document.querySelector('#delivery-status').textContent.includes('模拟发送失败'));
    assert.equal(await page.locator('.message.sales').count(), 0);
    assert.equal(await page.locator('#draft-editor').inputValue(), edited);
    await send('unknown');
    await page.waitForSelector('[data-receipt="success"]');
    assert.equal(await page.locator('#send').isEnabled(), false);
    assert.equal(await page.locator('#discard').isEnabled(), false);
    await page.reload(); await page.waitForSelector('[data-receipt="success"]');
    await page.locator('[data-receipt="success"]').click();
    await page.waitForSelector('.message.sales');
    assert.equal(await page.locator('.message.sales').count(), 1);
    assert.equal(await page.locator('#send').isEnabled(), false);

    await page.getByRole('button', { name: /周先生/ }).click();
    await page.waitForSelector('#respond-risk');
    await page.locator('#respond-risk').click();
    await page.waitForFunction(() => document.querySelector('#risk-card').textContent.includes('已接手'));
    assert.equal(await page.locator('#send').isEnabled(), false);
    await page.locator('#supervisor-toggle').click();
    assert.match(await page.locator('#overdue-list').textContent(), /当前没有/);
    await page.locator('#supervisor-toggle').click();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(base + '/sales-copilot.html?mode=sidebar');
    await page.waitForSelector('#customer-select option', { state: 'attached' });
    assert.equal(await page.locator('.chat-host').isVisible(), false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: 'work/copilot-preview/sidebar.png', fullPage: true });

    await page.goto(base + '/sales-copilot.html?channel=wecom');
    await page.waitForSelector('#connection-error:not([hidden])');
    assert.match(await page.locator('#connection-error').textContent(), /接入待配置/);
    assert.equal(await page.locator('#desktop').isVisible(), false);
    assert.deepEqual(errors, []);
    console.log('PASS — browser: edit/switch/reload, failed/unknown/success delivery, risk handoff, 390px sidebar, real-channel fail-closed; zero page errors.');
  } finally {
    await browser.close();
    if (server && server.exitCode === null) { server.kill('SIGTERM'); await new Promise(r => server.once('exit', r)); }
    rmSync(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
