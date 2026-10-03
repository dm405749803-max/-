'use strict';
// Host contract: resolve customer context, ingest authorized messages, submit and reconcile delivery.
// The real WeCom adapter deliberately fails closed until signed identity and message/receipt APIs exist.
class CopilotPreviewChannel {
  constructor(request) { this.request = request; this.kind = 'simulation'; }
  bootstrap() { return this.request('/api/v2/copilot/bootstrap', {}); }
  send(input) { return this.request('/api/v2/copilot/send', { ...input, channel: this.kind }); }
  reconcile(attemptId, result) { return this.request('/api/v2/copilot/reconcile', { attempt_id: attemptId, result }); }
}
class CopilotWeComChannel {
  constructor() { this.kind = 'wecom'; }
  async bootstrap() { throw new Error('企业微信接入待配置：需要企业身份、客户映射和授权消息接口。当前不会读取或发送微信消息。'); }
  async send() { throw new Error('企业微信发送渠道未接通。'); }
  async reconcile() { throw new Error('企业微信回执渠道未接通。'); }
}
window.createCopilotChannel = (kind, request) => kind === 'wecom' ? new CopilotWeComChannel() : new CopilotPreviewChannel(request);
