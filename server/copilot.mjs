import { createHash } from 'node:crypto';
import { ApiError, assertApi } from './errors.mjs';
import { buildContext } from './context.mjs';
import { classifyConversationTurn } from '../ai/conversation-routing.mjs';
import { COPILOT_WORKSPACE } from './workspace-policy.mjs';

// The preview is an isolated channel. A WeCom client cannot opt into simulated delivery.
export { COPILOT_WORKSPACE };
export function draftDifference(original, final) {
  const a = Array.from(original), b = Array.from(final);
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, previous[j] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = next;
  }
  const distance = previous[b.length], ratio = distance / Math.max(a.length, 1);
  return { edit_distance: distance, edit_ratio: ratio, outcome: distance === 0 ? 'direct_send' : ratio <= .4 ? 'edited_send' : 'manual_rewrite' };
}

export function createCopilotService({ store, observability = null, knowledgeSafety = null, validateDraft = null, now = () => new Date() }) {
  const db = store.raw, ws = COPILOT_WORKSPACE;
  db.exec(`CREATE TABLE IF NOT EXISTS copilot_editors (
    workspace_id TEXT NOT NULL, opportunity_id TEXT NOT NULL, draft_id TEXT NOT NULL,
    final_text TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY(workspace_id, opportunity_id));
    CREATE TABLE IF NOT EXISTS copilot_deliveries (
    workspace_id TEXT NOT NULL, attempt_id TEXT NOT NULL, request_hash TEXT NOT NULL,
    opportunity_id TEXT NOT NULL, draft_id TEXT NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(workspace_id, attempt_id));
    CREATE TABLE IF NOT EXISTS copilot_risks (
    workspace_id TEXT NOT NULL, risk_id TEXT NOT NULL, customer_id TEXT NOT NULL, opportunity_id TEXT NOT NULL,
    message_id TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL, responded_at TEXT,
    PRIMARY KEY(workspace_id,risk_id), UNIQUE(workspace_id,message_id));`);
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const transaction = fn => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const emit = (name, oid, key, payload = {}) => {
    const opp = store._helpers.ensureOpportunity(ws, oid);
    const latest = store.listMessages(ws, oid).filter(x => x.role === 'customer').at(-1);
    observability?.recordEvent(ws, { event_name: name, opportunity_id: oid, customer_id: opp.customer_id,
      environment: 'simulation', actor: 'copilot-preview', trace_id: latest?.trace_id || null,
      idempotency_key: `copilot:${name}:${key}`, payload });
  };
  function scope(input) {
    const opp = store._helpers.ensureOpportunity(ws, input.opportunity_id);
    assertApi(opp.environment === 'simulation', 403, 'PREVIEW_ONLY', '副驾预览仅支持隔离的演练数据。');
    assertApi(opp.customer_id === input.customer_id, 409, 'CUSTOMER_MISMATCH', '客户已切换，请重新核对当前会话。');
    return opp;
  }
  function risks() {
    // Discover risks from persisted messages, including those received through existing APIs.
    for (const customer of store.listCustomers(ws)) {
      for (const opp of store.getCustomer(ws, customer.customer_id).opportunities) {
        for (const message of store.listMessages(ws, opp.opportunity_id).filter(x => x.role === 'customer')) {
          const route = classifyConversationTurn({ latest_message: message.text });
          if (!['human_required', 'stop_marketing'].includes(route) && !/理赔/.test(message.text)) continue;
          const riskId = `risk_${message.message_id}`;
          const inserted = run('INSERT OR IGNORE INTO copilot_risks VALUES (?,?,?,?,?,?,?,NULL)', ws, riskId, customer.customer_id, opp.opportunity_id, message.message_id,
            route === 'stop_marketing' ? '客户拒收营销，请停止营销触达' : '投诉、理赔或人工请求，需要销售接手', message.created_at);
          if (inserted.changes) {
            const current = store._helpers.ensureOpportunity(ws, opp.opportunity_id);
            store.patchOpportunity(ws, opp.opportunity_id, current.revision, { human_handoff: true, processing_status: 'human_handoff' });
            emit('risk_alert_created', opp.opportunity_id, riskId, { risk_id: riskId, clock: 'preview_24h' });
          }
        }
      }
    }
    return all('SELECT * FROM copilot_risks WHERE workspace_id=? ORDER BY created_at DESC', ws).map(row => {
      const elapsed = Math.max(0, Math.floor((now().getTime() - Date.parse(row.created_at)) / 1000));
      const overdue = !row.responded_at && now().getTime() - Date.parse(row.created_at) > 300000;
      if (overdue) emit('risk_alert_overdue', row.opportunity_id, row.risk_id, { risk_id: row.risk_id, threshold_seconds: 300, clock: 'preview_24h' });
      return { ...row, elapsed_seconds: elapsed, overdue };
    });
  }
  function sendGuard(input) {
    assertApi(input.channel === 'simulation', 503, 'WECOM_NOT_CONNECTED', '企业微信渠道尚未接通，不能发送真实消息。');
    const opp = scope(input), draft = store.getDraft(ws, input.draft_id);
    assertApi(draft.opportunity_id === opp.opportunity_id, 409, 'DRAFT_CUSTOMER_MISMATCH', '这份草稿不属于当前客户。');
    risks();
    assertApi(!risks().some(x => x.opportunity_id === opp.opportunity_id), 409, 'HUMAN_HANDOFF_ACTIVE', '当前会话已转人工，副驾停止发送销售草稿。');
    const text = String(input.final_text || '').trim();
    assertApi(text.length > 0 && text.length <= 4000, 400, 'INVALID_TEXT', '回复须为1—4000字。');
    const promises = text.replace(/(?:不能|无法|不会|不应|不可以|不可)(?:作出|做出|提前)?(?:保证|承诺).{0,5}(?:收益|回本|理赔|赔付)/g, '');
    assertApi(!/(?:保证|承诺|肯定|一定|绝对).{0,8}(?:收益|回本|理赔|赔付)|稳赚|保本保息/.test(promises), 409, 'UNSAFE_FINAL_TEXT', '终稿中出现收益或理赔保证，请核对并删除不当承诺。');
    assertApi(draft.status === 'draft_ready' && !draft.stale, 409, 'STALE_DRAFT', '草稿已发送、放弃或失效，请重新生成。');
    assertApi(draft.revision === input.expected_revision, 409, 'REVISION_CONFLICT', '草稿版本已变化。');
    const context = buildContext(store, ws, opp.opportunity_id);
    for (const field of ['customer_revision', 'profile_version', 'opportunity_revision', 'latest_conversation_message_id']) {
      assertApi(draft.context_versions[field] === context.context_versions[field], 409, 'STALE_CONTEXT', '会话或画像已变化，请重新生成草稿。');
    }
    knowledgeSafety?.assertAiAllowed(ws);
    validateDraft?.(draft);
    return { draft, text };
  }
  const deliveryDto = row => row ? { ...row, payload: JSON.parse(row.payload) } : null;
  function finish(row, state) {
    const input = JSON.parse(row.payload);
    if (state === 'success') {
      const { draft, text } = sendGuard(input);
      store.confirmDraft(ws, draft.draft_id, { expected_revision: draft.revision, final_text: text,
        delivery_mode: 'simulation', idempotency_key: row.attempt_id, editor_id: 'preview-sales', editor_role: 'sales' });
      emit('draft_action', row.opportunity_id, row.attempt_id, { draft_id: draft.draft_id, ...draftDifference(draft.content, text), delivery_mode: 'simulation' });
      run('DELETE FROM copilot_editors WHERE workspace_id=? AND opportunity_id=? AND draft_id=?', ws, row.opportunity_id, row.draft_id);
    }
    run('UPDATE copilot_deliveries SET state=?,updated_at=? WHERE workspace_id=? AND attempt_id=?', state, now().toISOString(), ws, row.attempt_id);
    emit('draft_send_result', row.opportunity_id, `${row.attempt_id}:${state}`, { draft_id: row.draft_id, attempt_id: row.attempt_id, state, channel: 'simulation' });
    return deliveryDto(one('SELECT * FROM copilot_deliveries WHERE workspace_id=? AND attempt_id=?', ws, row.attempt_id));
  }
  return {
    bootstrap() {
      return transaction(() => {
        for (const [cid, name, oid, message] of [
          ['preview-lin', '林女士', 'preview-lin-need', '想给妈妈了解一下养老保障，每年预算大概两万元。'],
          ['preview-zhou', '周先生', 'preview-zhou-need', '之前的理赔还没有结果，我要找人工处理。']
        ]) {
          if (store.listCustomers(ws).some(x => x.customer_id === cid)) continue;
          store.createCustomer(ws, { customer_id: cid, name });
          store.addOpportunity(ws, cid, { opportunity_id: oid, environment: 'simulation' });
          const { message: saved } = store.addMessage(ws, oid, { role: 'customer', text: message, status: 'received', source: 'manual', environment: 'simulation', idempotency_key: `seed:${oid}` });
          if (cid === 'preview-lin') {
            const context = buildContext(store, ws, oid);
            store.saveDraft(ws, oid, saved.message_id, context.context_versions.opportunity_revision, {
              draft: '给妈妈提前考虑养老保障，这个方向我了解了。每年两万元的预算先记下，妈妈今年多大年纪？',
              status: 'draft_ready', review_required: true, trace: { provider: 'preview_fixture' }, citations: [],
              reason: '演示样例，仅用于体验编辑和发送；点击生成可调用现有AI服务。'
            }, context);
          }
        }
        risks();
        return { workspace_id: ws, channel: 'simulation', real_delivery_available: false,
          customers: store.listCustomers(ws).map(c => store.getCustomer(ws, c.customer_id)), risks: risks() };
      });
    },
    snapshot() { return { channel: 'simulation', real_delivery_available: false, risks: risks(), deliveries: all('SELECT * FROM copilot_deliveries WHERE workspace_id=? ORDER BY created_at DESC LIMIT 100', ws).map(deliveryDto) }; },
    delivery(attemptId) { return deliveryDto(one('SELECT * FROM copilot_deliveries WHERE workspace_id=? AND attempt_id=?', ws, attemptId)); },
    editor(oid) { store._helpers.ensureOpportunity(ws, oid); return one('SELECT * FROM copilot_editors WHERE workspace_id=? AND opportunity_id=?', ws, oid) || null; },
    saveEditor(input) {
      scope(input);
      const draft = store.getDraft(ws, input.draft_id);
      assertApi(draft.opportunity_id === input.opportunity_id && draft.status === 'draft_ready', 409, 'DRAFT_MISMATCH', '草稿不可编辑。');
      assertApi(typeof input.final_text === 'string' && input.final_text.length <= 4000, 400, 'INVALID_TEXT', '草稿最多4000字。');
      return transaction(() => {
        const current = this.editor(input.opportunity_id);
        assertApi((current?.revision || 0) === input.editor_revision, 409, 'EDITOR_CONFLICT', '另一窗口已修改草稿，请刷新后核对。');
        run('INSERT INTO copilot_editors VALUES (?,?,?,?,?,?) ON CONFLICT(workspace_id,opportunity_id) DO UPDATE SET draft_id=excluded.draft_id,final_text=excluded.final_text,revision=excluded.revision,updated_at=excluded.updated_at',
          ws, input.opportunity_id, input.draft_id, input.final_text, (current?.revision || 0) + 1, now().toISOString());
        return this.editor(input.opportunity_id);
      });
    },
    discard(input) {
      scope(input);
      const draft = store.getDraft(ws, input.draft_id);
      assertApi(draft.opportunity_id === input.opportunity_id && draft.status === 'draft_ready', 409, 'DRAFT_MISMATCH', '草稿不可放弃。');
      assertApi(!one("SELECT 1 FROM copilot_deliveries WHERE workspace_id=? AND draft_id=? AND state IN ('unknown','success')", ws, draft.draft_id), 409, 'DELIVERY_UNRESOLVED', '发送结果待核对或已成功，不能放弃。');
      return transaction(() => {
        run("UPDATE drafts SET stale=1,stale_reason='sales_discarded',updated_at=? WHERE workspace_id=? AND draft_id=?", now().toISOString(), ws, draft.draft_id);
        run('DELETE FROM copilot_editors WHERE workspace_id=? AND opportunity_id=?', ws, input.opportunity_id);
        emit('draft_action', input.opportunity_id, draft.draft_id + ':discarded', { draft_id: draft.draft_id, outcome: 'discarded', reason: String(input.reason || '销售明确放弃').slice(0, 200) });
        return { discarded: true };
      });
    },
    send(input) {
      assertApi(input.channel === 'simulation', 503, 'WECOM_NOT_CONNECTED', '企业微信渠道尚未接通。');
      assertApi(typeof input.attempt_id === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(input.attempt_id), 400, 'ATTEMPT_ID_REQUIRED', '发送必须有稳定的请求编号。');
      const payload = { channel: input.channel, customer_id: input.customer_id, opportunity_id: input.opportunity_id, draft_id: input.draft_id,
        expected_revision: input.expected_revision, final_text: String(input.final_text || '').trim(), simulation_result: input.simulation_result || 'success' };
      const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
      const prior = one('SELECT * FROM copilot_deliveries WHERE workspace_id=? AND attempt_id=?', ws, input.attempt_id);
      if (prior) {
        assertApi(prior.request_hash === hash, 409, 'IDEMPOTENCY_CONFLICT', '同一发送请求的内容不能变化。');
        return { ...deliveryDto(prior), idempotent_replay: true };
      }
      assertApi(['success', 'failed', 'unknown'].includes(payload.simulation_result), 400, 'INVALID_SEND_RESULT', '模拟结果无效。');
      return transaction(() => {
        sendGuard(payload);
        assertApi(!one("SELECT 1 FROM copilot_deliveries WHERE workspace_id=? AND draft_id=? AND state IN ('unknown','success')", ws, input.draft_id), 409, 'DELIVERY_UNRESOLVED', '同一草稿已发送或结果未知，请先核对回执，不要重复发送。');
        const at = now().toISOString();
        run('INSERT INTO copilot_deliveries VALUES (?,?,?,?,?,?,?,?,?)', ws, input.attempt_id, hash, input.opportunity_id, input.draft_id, 'unknown', JSON.stringify(payload), at, at);
        return finish(one('SELECT * FROM copilot_deliveries WHERE workspace_id=? AND attempt_id=?', ws, input.attempt_id), payload.simulation_result);
      });
    },
    reconcile(input) {
      const row = one('SELECT * FROM copilot_deliveries WHERE workspace_id=? AND attempt_id=?', ws, input.attempt_id);
      assertApi(row, 404, 'ATTEMPT_NOT_FOUND', '发送记录不存在。');
      assertApi(['success', 'failed'].includes(input.result), 400, 'INVALID_RECEIPT', '请选择模拟成功或失败回执。');
      if (row.state !== 'unknown') {
        assertApi(row.state === input.result, 409, 'RECEIPT_CONFLICT', '不能改写已确认的发送结果。');
        return deliveryDto(row);
      }
      return transaction(() => finish(row, input.result));
    },
    respond(input) {
      const risk = risks().find(x => x.risk_id === input.risk_id);
      assertApi(risk, 404, 'RISK_NOT_FOUND', '风险提醒不存在。');
      if (!risk.responded_at) transaction(() => {
        run('UPDATE copilot_risks SET responded_at=? WHERE workspace_id=? AND risk_id=?', now().toISOString(), ws, input.risk_id);
        emit('risk_alert_responded', risk.opportunity_id, risk.risk_id, { risk_id: risk.risk_id, response_seconds: risk.elapsed_seconds, overdue: risk.overdue });
      });
      return risks().find(x => x.risk_id === input.risk_id);
    }
  };
}

export function createCopilotApi(options) {
  const service = createCopilotService(options);
  return async (req, res, url) => {
    if (!url.pathname.startsWith('/api/v2/copilot/')) return false;
    try {
      assertApi((req.headers['x-workspace-id'] || '') === COPILOT_WORKSPACE, 403, 'PREVIEW_WORKSPACE_REQUIRED', '请从副驾预览入口打开。');
      const path = url.pathname.slice('/api/v2/copilot/'.length);
      let data;
      if (req.method === 'GET' && path === 'snapshot') data = service.snapshot();
      else if (req.method === 'GET' && path === 'delivery') data = service.delivery(url.searchParams.get('attempt_id'));
      else if (req.method === 'GET' && path === 'editor') data = service.editor(url.searchParams.get('opportunity_id'));
      else if (req.method === 'POST') {
        assertApi(['bootstrap', 'saveEditor', 'discard', 'send', 'reconcile', 'respond'].includes(path), 404, 'NOT_FOUND', '接口不存在。');
        data = service[path](await options.readJson(req, 30000));
      } else throw new ApiError(404, 'NOT_FOUND', '接口不存在。');
      options.sendJson(res, 200, { data });
    } catch (error) {
      const known = error instanceof ApiError;
      options.sendJson(res, known ? error.status : 500, { error: { code: known ? error.code : 'COPILOT_ERROR', message: known ? error.message : '副驾请求未完成，请刷新后重试。' } });
    }
    return true;
  };
}
