'use strict';
(async function () {
  const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const uid = () => crypto.randomUUID();
  const settings = new URLSearchParams(location.search), workspace = 'copilot-preview';
  if (settings.get('mode') === 'sidebar') document.body.classList.add('sidebar');
  const state = { customers: [], cid: null, oid: null, epoch: 0, draft: null, editor: null, dirty: false,
    generation: false, switching: false, sending: false, snapshot: { risks: [], deliveries: [] }, messages: [], context: null, memory: [], recommendations: [], tasks: [], media: null, error: false };
  async function request(path, body) {
    const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': workspace }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const payload = await response.json();
    if (!response.ok) { const error = new Error(payload.error?.message || '请求失败'); error.code = payload.error?.code; throw error; }
    return payload.data;
  }
  const channel = createCopilotChannel(settings.get('channel'), request);
  const client = new SalesWorkbenchV2Client({ fetchImpl: (url, options = {}) => fetch(url, { ...options, headers: { ...options.headers, 'x-workspace-id': workspace } }) });
  const invoke = async (method, ...args) => (await client[method](...args)).data;
  const current = () => state.customers.find(x => x.customer_id === state.cid);
  const currentRisk = () => state.snapshot.risks.find(x => x.opportunity_id === state.oid);
  const attempts = () => state.snapshot.deliveries.filter(x => x.draft_id === state.draft?.draft_id);
  const unknownAttempt = () => attempts().find(x => x.state === 'unknown');
  const pendingNetwork = () => { try { return JSON.parse(sessionStorage.getItem(`copilot-attempt:${state.oid}`)); } catch { return null; } };
  const values = value => Array.isArray(value) ? value : value?.proposals || value?.recommendations || [];
  function toast(text) { $('#toast').textContent = text; $('#toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => $('#toast').hidden = true, 5000); }
  async function action(fn) { try { return await fn(); } catch (e) { toast(e.message); return null; } }
  function confirmAction(title, text) {
    return new Promise(resolve => {
      const dialog = $('#action-dialog'); $('#dialog-title').textContent = title; $('#dialog-copy').textContent = text;
      dialog.returnValue = ''; dialog.showModal();
      $('#dialog-cancel').onclick = () => dialog.close('cancel'); $('#dialog-confirm').onclick = () => dialog.close('confirm');
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
    });
  }
  function lockActions() {
    const blocked = !!currentRisk(), locked = state.switching || state.generation || state.sending || state.error || !!pendingNetwork();
    $('#generate').disabled = locked || blocked || !!unknownAttempt();
    $('#send').disabled = locked || blocked || !state.draft || state.draft.status !== 'draft_ready' || state.draft.stale || !$('#draft-editor').value.trim() || !!unknownAttempt();
    $('#draft-editor').disabled = state.switching || state.generation || state.sending || !!unknownAttempt() || !state.draft || state.draft.status !== 'draft_ready' || state.draft.stale;
    $('#discard').disabled = locked || !state.draft || state.draft.status !== 'draft_ready' || state.draft.stale || !!unknownAttempt();
    $('#restore').disabled = $('#draft-editor').disabled;
    $('#match-products').disabled = locked || blocked;
    $('#customer-select').disabled = state.switching || state.sending;
  }
  function renderContacts() {
    const query = $('#search').value;
    $('#contacts-list').innerHTML = state.customers.filter(c => c.name.includes(query)).map(c => `<button class="contact ${c.customer_id === state.cid ? 'selected' : ''}" data-customer="${esc(c.customer_id)}"><span class="avatar">${esc(c.name[0])}</span><span><strong>${esc(c.name)}</strong><small>${state.snapshot.risks.some(r => r.customer_id === c.customer_id) ? '需要人工接手' : '养老保障咨询'}</small></span></button>`).join('');
    $('#contacts-list').querySelectorAll('button').forEach(b => b.onclick = () => action(() => selectCustomer(b.dataset.customer)));
    $('#customer-select').innerHTML = state.customers.map(c => `<option value="${esc(c.customer_id)}">${esc(c.name)} · 演练</option>`).join('');
    $('#customer-select').value = state.cid || ''; $('#chat-name').textContent = current()?.name || '客户会话';
  }
  function renderMessages() {
    $('#messages').innerHTML = state.messages.map(m => `<div class="message ${m.role === 'sales' ? 'sales' : ''}"><span class="avatar">${m.role === 'sales' ? '陈' : esc(current()?.name[0] || '客')}</span><div class="bubble">${esc(m.text)}<small>${m.role === 'sales' ? '模拟发送成功 · ' : ''}${new Date(m.created_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</small></div></div>`).join('') || '<p class="empty">还没有客户消息</p>';
    $('#messages').scrollTop = $('#messages').scrollHeight;
  }
  function renderRisk() {
    const risk = currentRisk(); $('#risk-card').hidden = !risk;
    if (risk) {
      const seconds = Math.max(0, 300 - risk.elapsed_seconds), clock = risk.responded_at ? '已接手' : risk.overdue ? '响应已超时' : `${Math.floor(seconds / 60)}分${String(seconds % 60).padStart(2, '0')}秒内接手`;
      $('#risk-card').innerHTML = `<span class="time">${clock}</span><strong>需要人工处理</strong><small>${esc(risk.reason)}</small>${risk.responded_at ? '<small>已记录响应；营销草稿仍保持阻断。</small>' : '<button id="respond-risk">接手处理</button>'}`;
      $('#respond-risk')?.addEventListener('click', () => action(async () => { await request('/api/v2/copilot/respond', { risk_id: risk.risk_id }); await refreshSnapshot(); toast('已记录接手时间，营销发送保持阻断。'); }));
    }
    const overdue = state.snapshot.risks.filter(r => r.overdue && !r.responded_at);
    $('#overdue-list').innerHTML = overdue.map(r => `<div class="card"><div><strong>${esc(state.customers.find(c => c.customer_id === r.customer_id)?.name || '客户')}</strong><p>${esc(r.reason)}</p><small>销售：演练销售 · 触发时间 ${new Date(r.created_at).toLocaleTimeString('zh-CN')}</small></div><strong>超时 ${Math.floor((r.elapsed_seconds - 300) / 60)} 分钟</strong></div>`).join('') || '<div class="empty">当前没有超时且未响应的风险</div>';
    lockActions();
  }
  function renderDraft({ fill = true } = {}) {
    const draft = state.draft, fixture = draft?.trace?.provider === 'preview_fixture';
    if (fill) $('#draft-editor').value = state.editor && draft && state.editor.draft_id === draft.draft_id ? state.editor.final_text : draft?.draft || '';
    $('#draft-provider').textContent = fixture ? '演示样例' : draft ? 'AI 工作流' : '待生成';
    $('#suggestion-title').textContent = currentRisk() ? '停止营销，先处理风险' : draft?.status === 'draft_ready' ? '核对这一句，再发给客户' : '先了解，再推荐';
    $('#suggestion-copy').textContent = fixture ? '这是一条演示草稿，可先体验修改与发送。点击“生成草稿”会调用现有 AI 服务。' : draft?.reason || draft?.next_question || '结合客户最新消息生成回复。所有草稿都由你确认发送。';
    $('#original-draft').textContent = draft?.draft || '尚无原稿';
    const citations = draft?.citations || []; $('#citation-count').textContent = citations.length;
    $('#citations').innerHTML = citations.map(c => `<p>${esc(c.title || c.document_id || '引用资料')}<br>${esc(c.excerpt || c.quote || c.location || '')}</p>`).join('') || '<p>本条暂无产品事实引用。</p>';
    $('#editor-status').textContent = draft?.stale ? '草稿已失效，请重新生成' : draft?.status === 'simulated_sent' ? '已模拟发送' : state.editor ? '修改已保存' : draft ? '等待你确认' : '尚无草稿';
    renderEdit(); renderDelivery(); lockActions();
  }
  function renderEdit() {
    const text = $('#draft-editor').value; $('#char-count').textContent = `${text.length} 字`;
    $('#edit-label').textContent = state.draft && text !== state.draft.draft ? '已修改 · 发送时计算修改比例' : '原稿与终稿分别保存';
    lockActions();
  }
  function renderDelivery() {
    const pending = pendingNetwork();
    if (pending) {
      const box = $('#delivery-status'); box.hidden = false; box.className = 'delivery-status warning';
      box.innerHTML = '网络中断，上次请求尚未核对。<div><button id="recover-send">核对上次发送</button></div>';
      $('#recover-send').onclick = () => action(async () => {
        const key = `copilot-attempt:${state.oid}`;
        // Query first; if no record, replay the identical request ID, never create a new send.
        const known = await request(`/api/v2/copilot/delivery?attempt_id=${encodeURIComponent(pending.attempt_id)}`);
        if (!known) await channel.send(pending);
        sessionStorage.removeItem(key); await reloadActive({ includeDraft: true });
      });
      return;
    }
    const attempt = attempts()[0], box = $('#delivery-status'); box.hidden = !attempt;
    if (!attempt) return;
    box.className = 'delivery-status' + (attempt.state === 'success' ? '' : ' warning');
    const labels = { success: '模拟发送成功，终稿与修改记录已保存。', failed: '模拟发送失败。草稿已保留，核对后可以重试。', unknown: '结果未知：先核对回执，不能重复发送。' };
    box.innerHTML = `${labels[attempt.state]}${attempt.state === 'unknown' ? '<div><button data-receipt="success">模拟成功回执</button><button data-receipt="failed">模拟失败回执</button></div>' : ''}`;
    box.querySelectorAll('[data-receipt]').forEach(b => b.onclick = () => action(async () => {
      await channel.reconcile(attempt.attempt_id, b.dataset.receipt); await reloadActive({ includeDraft: true });
    }));
  }
  const factNames = { age: '年龄', annual_budget: '年度预算', budget: '预算', purpose: '需求方向', relationship: '关系', funds_usage_years: '资金使用时间', gender: '性别' };
  const intentNames = { unknown: '待确认', low: '低意向', medium: '中意向', high: '高意向' };
  function renderDetails() {
    const customer = current();
    const opportunity = customer?.opportunities?.find(o => o.opportunity_id === state.oid);
    $('#confirmed-intent').textContent = intentNames[opportunity?.intent_level] || '待确认';
    $('#sales-stage').value = opportunity?.sales_stage || 'new_contact';
    $('#facts').innerHTML = (customer?.facts || []).filter(f => f.status === 'confirmed').map(f => `<div class="fact"><span>${esc(factNames[f.field] || f.field)}</span><strong>${esc(typeof f.value === 'object' ? JSON.stringify(f.value) : f.value)}</strong></div>`).join('') || '<div class="empty">暂无已确认画像<br>AI候选需要你核对后才写入</div>';
    $('#proposals').innerHTML = state.memory.filter(m => m.status === 'pending').map(m => `<div class="card"><strong>${m.review_mode === 'conflict_review' ? '信息存在冲突' : '待确认画像'}</strong>${(m.facts || []).map(f => `<p>${esc(factNames[f.field] || f.field)}：${esc(f.value)}</p>`).join('')}${m.intent && !m.intent.preserve_current ? `<p>候选意向：${esc(intentNames[m.intent.level] || '待确认')}<br>${esc(m.intent.reason)}</p>` : ''}<button data-memory="${esc(m.proposal_id)}" data-decision="approve">核对无误，确认写入</button><button data-memory="${esc(m.proposal_id)}" data-decision="reject">不采用</button></div>`).join('') || '<div class="empty">暂无待确认变化</div>';
    $$('[data-memory]').forEach(b => b.onclick = () => action(async () => {
      const item = state.memory.find(x => x.proposal_id === b.dataset.memory);
      await invoke(b.dataset.decision === 'approve' ? 'approveMemoryProposal' : 'rejectMemoryProposal', item.proposal_id, { expected_revision: item.revision, idempotency_key: uid(), reviewer: '演练销售', reason: '销售在副驾核对' });
      await reloadActive(); toast('画像决定已保存；如有旧草稿，请重新生成。');
    }));
    $('#recommendations').innerHTML = state.recommendations.map(m => `<div class="card"><strong>${m.decision === 'accepted' ? '已采纳' : '产品候选'}</strong><p>${esc(m.result?.reason || m.reason || m.status || '')}</p>${(m.result?.candidates || []).map(c => `<h3>${esc(c.product_name || c.product_id)}</h3><p>${esc((c.reasons || c.match_reasons || []).join('；'))}</p><p>${esc((c.missing_fields || []).join('、'))}</p>`).join('')}${m.decision === 'pending' || !m.decision ? `<button data-match="${esc(m.recommendation_id)}" data-decision="accept">核对后采纳</button><button data-match="${esc(m.recommendation_id)}" data-decision="reject">不采用</button>` : ''}</div>`).join('') || '<div class="empty">暂无产品建议<br>先核对客户画像，再进行匹配</div>';
    $$('[data-match]').forEach(b => b.onclick = () => action(async () => {
      const item = state.recommendations.find(x => x.recommendation_id === b.dataset.match);
      await invoke(b.dataset.decision === 'accept' ? 'acceptRecommendation' : 'rejectRecommendation', item.recommendation_id, { expected_revision: item.revision, idempotency_key: uid(), reviewer: '演练销售', reason: '销售在副驾核对候选与依据' });
      await reloadActive(); toast('产品决定已保存。');
    }));
    $('#tasks').innerHTML = state.tasks.filter(t => t.opportunity_id === state.oid).map(t => `<div class="card"><strong>${esc(t.title || t.reason)}</strong><p>${new Date(t.due_at).toLocaleString('zh-CN')}</p><span>${t.status === 'completed' ? '已完成' : '待跟进'}</span>${t.status === 'open' ? `<button data-task="${esc(t.task_id)}">完成</button>` : ''}</div>`).join('') || '<div class="empty">暂无跟进计划</div>';
    $$('[data-task]').forEach(b => b.onclick = () => action(async () => {
      const task = state.tasks.find(t => t.task_id === b.dataset.task); await invoke('patchTask', task.task_id, { expected_revision: task.revision, changes: { status: 'completed', result: '销售确认已完成跟进' } }); await reloadActive();
    }));
  }
  let saveChain = Promise.resolve(), saveTimer;
  function saveEditor() {
    clearTimeout(saveTimer);
    const cid = state.cid, oid = state.oid, draftId = state.draft?.draft_id, text = $('#draft-editor').value;
    if (!state.dirty || !draftId || state.draft.status !== 'draft_ready') return saveChain;
    const epoch = state.epoch;
    saveChain = saveChain.catch(() => {}).then(async () => {
      if (epoch !== state.epoch) throw new Error('客户已切换，修改未覆盖新客户。');
      const result = await request('/api/v2/copilot/saveEditor', { customer_id: cid, opportunity_id: oid, draft_id: draftId, final_text: text, editor_revision: state.editor?.revision || 0 });
      if (epoch === state.epoch) {
        state.editor = result; state.dirty = $('#draft-editor').value !== text;
        $('#editor-status').textContent = state.dirty ? '保存中…' : '修改已保存';
      }
    });
    return saveChain;
  }
  async function refreshSnapshot() { state.snapshot = await request('/api/v2/copilot/snapshot'); renderRisk(); renderDelivery(); }
  async function reloadActive({ includeDraft = false } = {}) {
    const cid = state.cid, oid = state.oid, epoch = state.epoch;
    if (!oid) return;
    const results = await Promise.all([invoke('getCustomer', cid), invoke('listMessages', oid), invoke('getContext', oid),
      invoke('listMemoryProposals', { opportunity_id: oid }).catch(() => []), invoke('listRecommendations', oid).catch(() => []), invoke('listTasks').catch(() => []), request('/api/v2/copilot/snapshot'),
      includeDraft ? request(`/api/v2/opportunities/${encodeURIComponent(oid)}/drafts/latest`) : null,
      includeDraft ? request(`/api/v2/copilot/editor?opportunity_id=${encodeURIComponent(oid)}`) : null]);
    if (epoch !== state.epoch) return;
    const [customer, messages, context, memory, recommendations, tasks, snapshot, draft, editor] = results;
    state.customers = state.customers.map(c => c.customer_id === cid ? customer : c);
    Object.assign(state, { messages, context, memory: values(memory), recommendations: values(recommendations), tasks: values(tasks), snapshot });
    if (includeDraft) { state.draft = draft; state.editor = editor; state.dirty = false; }
    renderContacts(); renderMessages(); renderRisk(); renderDetails(); renderDraft({ fill: includeDraft });
  }
  async function selectCustomer(cid) {
    if (state.switching || cid === state.cid) return;
    if (state.sending) return toast('请等待本次发送结果。');
    state.switching = true; lockActions();
    try {
      await saveEditor();
      state.epoch++; state.cid = cid; state.oid = current()?.opportunities?.[0]?.opportunity_id;
      state.draft = null; state.editor = null; state.dirty = false; state.generation = false; clearMedia();
      await reloadActive({ includeDraft: true });
    } finally { state.switching = false; lockActions(); }
  }
  async function generate() {
    if (state.generation || currentRisk() || unknownAttempt()) return;
    if (state.draft?.status === 'draft_ready' && !state.draft.stale && !(await confirmAction('生成一份新草稿？', '当前原稿和修改记录会保留。只有新草稿生成成功，编辑框才会换成新内容。'))) return;
    await saveEditor(); const epoch = state.epoch, oid = state.oid, previous = state.draft;
    state.generation = true; $('#editor-status').textContent = 'AI生成中…'; lockActions();
    try {
      const context = await invoke('getContext', oid);
      const draft = await invoke('createDraft', oid, { latest_message_id: context.latest_message_id, expected_revision: context.context_versions.opportunity_revision });
      if (epoch !== state.epoch) return;
      if (draft.status !== 'draft_ready' || !draft.draft) throw new Error(draft.reason || draft.next_question || '本轮需要补充信息或人工处理，未替换原稿。');
      if (previous?.status === 'draft_ready' && !previous.stale) await request('/api/v2/copilot/discard', { customer_id: state.cid, opportunity_id: oid, draft_id: previous.draft_id, reason: '新草稿生成成功，销售选择替换' });
      state.draft = draft; state.editor = null; state.dirty = true; $('#draft-editor').value = draft.draft;
      // Read latest editor revision instead of assuming the old editor was deleted by another session.
      state.editor = await request(`/api/v2/copilot/editor?opportunity_id=${encodeURIComponent(oid)}`);
      await saveEditor(); await reloadActive(); renderDraft(); toast('草稿已生成，请核对后发送。');
    } finally { if (epoch === state.epoch) { state.generation = false; lockActions(); } }
  }
  async function send() {
    if ($('#send').disabled) return;
    await saveEditor();
    if (!(await confirmAction(`发送给${current().name}？`, '这是本机模拟发送，不会触达真实客户。发送成功后会保存原稿、终稿和修改比例。'))) return;
    const payload = { customer_id: state.cid, opportunity_id: state.oid, draft_id: state.draft.draft_id, expected_revision: state.draft.revision, final_text: $('#draft-editor').value, simulation_result: $('#send-outcome').value, attempt_id: uid() };
    state.sending = true; lockActions();
    try {
      // Retain request ID after a network failure; retrying the exact request is idempotent.
      sessionStorage.setItem(`copilot-attempt:${state.oid}`, JSON.stringify(payload));
      await channel.send(payload); sessionStorage.removeItem(`copilot-attempt:${state.oid}`);
      await reloadActive({ includeDraft: true });
    } catch (error) {
      await refreshSnapshot().catch(() => {});
      if (error.code) sessionStorage.removeItem(`copilot-attempt:${state.oid}`);
      else { $('#delivery-status').hidden = false; $('#delivery-status').textContent = '网络中断，发送状态待核对。刷新后先查询记录，不要重复发送。'; }
      throw error;
    } finally { state.sending = false; lockActions(); }
  }
  async function addMessage(text, source = 'manual') {
    const epoch = state.epoch, oid = state.oid;
    await saveEditor();
    await invoke('addMessage', oid, { role: 'customer', text, status: 'received', source, environment: 'simulation', idempotency_key: uid() });
    if (epoch !== state.epoch) return;
    await reloadActive();
    if (state.draft) state.draft.stale = true;
    renderDraft({ fill: false });
    toast('客户消息已加入，旧草稿已失效。请核对最新消息再生成。');
  }
  function clearMedia() {
    if (state.media?.url) URL.revokeObjectURL(state.media.url);
    state.media = null; $('#audio-file').value = ''; $('#audio-player').hidden = true; $('#audio-player').removeAttribute('src'); $('#transcript').value = '';
  }
  $('#search').oninput = renderContacts;
  $('#customer-select').onchange = e => action(() => selectCustomer(e.target.value));
  $('#draft-editor').oninput = () => { state.dirty = true; $('#editor-status').textContent = '保存中…'; renderEdit(); clearTimeout(saveTimer); saveTimer = setTimeout(() => action(saveEditor), 450); };
  $('#draft-editor').onblur = () => action(saveEditor);
  $('#generate').onclick = () => action(generate);
  $('#send').onclick = () => action(send);
  $('#restore').onclick = () => action(async () => { if (!state.draft) return; $('#draft-editor').value = state.draft.draft; state.dirty = true; renderEdit(); await saveEditor(); });
  $('#discard').onclick = () => action(async () => {
    if (!(await confirmAction('放弃这份草稿？', '仅这次明确放弃会被统计为未使用。删减文字、关闭页面或发送失败都不会算作放弃。'))) return;
    await saveEditor(); await request('/api/v2/copilot/discard', { customer_id: state.cid, opportunity_id: state.oid, draft_id: state.draft.draft_id }); await reloadActive({ includeDraft: true });
  });
  $('#refresh').onclick = () => action(async () => { await saveEditor(); await reloadActive({ includeDraft: true }); });
  $$('.copilot-tabs button').forEach(b => b.onclick = () => { $$('.copilot-tabs button').forEach(x => x.classList.toggle('active', x === b)); $$('[data-panel]').forEach(p => p.hidden = p.dataset.panel !== b.dataset.tab); });
  $('#message-form').onsubmit = e => { e.preventDefault(); const text = $('#customer-message').value.trim(); if (text) action(async () => { await addMessage(text); $('#customer-message').value = ''; }); };
  $('#customer-message').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#message-form').requestSubmit(); } };
  $('#simulate-risk').onclick = () => action(() => addMessage('我要投诉，请转人工处理。'));
  $('#supervisor-toggle').onclick = async () => { const show = $('#supervisor-view').hidden; $('#supervisor-view').hidden = !show; $('#desktop').hidden = show; $('#supervisor-toggle').textContent = show ? '返回销售副驾' : '主管视图'; await action(refreshSnapshot); };
  $('#extract-profile').onclick = () => action(async () => {
    $('#extract-profile').disabled = true;
    try { await invoke('createMemoryProposal', state.oid, { idempotency_key: uid() }); await reloadActive(); }
    finally { $('#extract-profile').disabled = false; }
  });
  $('#match-products').onclick = () => action(async () => {
    $('#match-products').disabled = true;
    try { const context = await invoke('getContext', state.oid); await invoke('generateRecommendation', state.oid, { idempotency_key: uid(), latest_message_id: context.latest_message_id, expected_revision: context.context_versions.opportunity_revision, expected_context_versions: context.context_versions }); await reloadActive(); }
    finally { lockActions(); }
  });
  $('#sales-stage').onchange = e => action(async () => {
    const next = e.target.value, opportunity = current().opportunities.find(o => o.opportunity_id === state.oid);
    await saveEditor();
    await invoke('patchOpportunity', state.oid, { expected_revision: opportunity.revision, changes: { sales_stage: next } });
    await reloadActive(); toast('销售阶段已确认保存。');
  });
  $('#followup-form').onsubmit = e => { e.preventDefault(); action(async () => {
    await invoke('createTask', { customer_id: state.cid, opportunity_id: state.oid, title: $('#followup-title').value, reason: $('#followup-title').value, owner: '演练销售', due_at: new Date($('#followup-time').value).toISOString(), idempotency_key: uid() });
    $('#followup-form').reset(); await reloadActive(); toast('跟进计划已保存。');
  }); };
  $('#audio-file').onchange = () => {
    const file = $('#audio-file').files[0]; if (!file) return;
    clearMedia();
    if (!file.type.startsWith('audio/') || file.size > 7000000) return toast('请选择7 MB以内的语音文件。');
    state.media = { file, url: URL.createObjectURL(file), epoch: state.epoch }; $('#audio-player').src = state.media.url; $('#audio-player').hidden = false;
  };
  $('#transcribe').onclick = () => action(async () => {
    const media = state.media, oid = state.oid; if (!media) return toast('请先选择语音文件。');
    $('#transcribe').disabled = true;
    try {
      const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = reject; reader.readAsDataURL(media.file); });
      const result = await invoke('transcribeMedia', oid, { filename: media.file.name, mime_type: media.file.type, data_base64: data, duration_seconds: Number.isFinite($('#audio-player').duration) ? $('#audio-player').duration : undefined });
      if (media === state.media && media.epoch === state.epoch) { $('#transcript').value = result.transcript; media.transcribed = true; toast('识别完成，请试听原音并核对文字。'); }
    } finally { $('#transcribe').disabled = false; }
  });
  $('#confirm-transcript').onclick = () => action(async () => { if (!state.media?.transcribed || !$('#transcript').value.trim()) return toast('请先识别并核对语音。'); await addMessage($('#transcript').value.trim(), 'media_transcription'); clearMedia(); });
  window.addEventListener('beforeunload', e => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });
  try {
    const boot = await channel.bootstrap(); state.customers = boot.customers; state.snapshot.risks = boot.risks;
    const requested = settings.get('customer'); await selectCustomer(state.customers.some(x => x.customer_id === requested) ? requested : state.customers.find(x => x.customer_id === 'preview-lin')?.customer_id || state.customers[0]?.customer_id);
    setInterval(() => { if (document.visibilityState === 'visible') action(refreshSnapshot); }, 10000);
  } catch (error) { state.error = true; $('#connection-error').hidden = false; $('#connection-error').textContent = error.message; $('#desktop').hidden = true; }
})();
