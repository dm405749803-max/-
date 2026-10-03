import { ApiError, assertApi } from './errors.mjs';

const SALES_MEMORY_STATES = new Set(['manually_confirmed_sent', 'provider_confirmed_sent', 'simulated_sent']);
const DEFAULT_POLICY = Object.freeze({
  defaultTurns: 12,
  maxTurns: 20,
  maxRoleGroups: 40,
  maxMessages: 80,
  maxMessagesPerRoleGroup: 8,
  maxTokens: 12000,
  maxMessageTokens: 4000,
  maxCharacters: 20000,
  maxMessageCharacters: 6000,
  relatedHistoryLimit: 6
});

const IMPORTANT_HISTORY = /(?:承诺|答应|说好|计划书|方案|产品|保费|预算|领取|交费|缴费|年交|赸交|退保|现金价值|犹豫期|你上次说|之前那款|上次)/i;
const STOP_WORDS = new Set(['这个','那个','一下','什么','怎么','可以','还是','就是','然后','如果','因为','你们','我们','自己','一个']);

export function estimateTokens(value) {
  const body = String(value ?? '');
  let tokens = 0;
  for (const char of body) tokens += /[\u3400-\u9fff]/.test(char) ? 0.6 : /\s/.test(char) ? 0.05 : 0.3;
  return Math.max(1, Math.ceil(tokens));
}

function keywords(value) {
  const text = String(value || '').toLowerCase();
  const chinese = text.match(/[\u3400-\u9fff]{2,8}/g) || [];
  const latin = text.match(/[a-z0-9]{3,}/g) || [];
  return [...new Set([...chinese, ...latin].filter(word => !STOP_WORDS.has(word)))].slice(0, 24);
}

function topicScore(message, currentKeywords) {
  const body = String(message?.text || '').toLowerCase();
  let score = currentKeywords.reduce((total, word) => total + (body.includes(word) ? 2 : 0), 0);
  if (IMPORTANT_HISTORY.test(body)) score += 3;
  if (/\d/.test(body)) score += 1;
  return score;
}

export function isContextMessage(message, environment) {
  if (!message || message.environment !== environment) return false;
  if (message.role === 'customer') return message.status === 'received';
  if (message.status === 'simulated_sent' && environment !== 'simulation') return false;
  return message.role === 'sales' && SALES_MEMORY_STATES.has(message.status);
}

export function normalizeContextWindow(options = {}) {
  const policy = {};
  for (const [field, fallback] of Object.entries(DEFAULT_POLICY)) {
    const value = options[field] === undefined ? fallback : options[field];
    assertApi(Number.isInteger(value) && value > 0, 400, 'INVALID_CONTEXT_WINDOW', `${field} 必须是正整数。`, { field, value });
    policy[field] = value;
  }
  assertApi(policy.defaultTurns <= policy.maxTurns, 400, 'INVALID_CONTEXT_WINDOW', '默认轮数不能超过最大轮数。');
  assertApi(policy.maxTurns <= 40 && policy.maxRoleGroups <= 80 && policy.maxMessages <= 256 && policy.maxMessagesPerRoleGroup <= 64
    && policy.maxTokens <= 100_000 && policy.maxMessageTokens <= 20_000
    && policy.maxCharacters <= 100_000 && policy.maxMessageCharacters <= 20_000 && policy.relatedHistoryLimit <= 20,
  400, 'INVALID_CONTEXT_WINDOW', '上下文窗口配置超出安全范围。');
  assertApi(policy.maxMessageCharacters <= policy.maxCharacters, 400, 'INVALID_CONTEXT_WINDOW', '单条消息预算不能超过总字符预算。');
  assertApi(policy.maxMessageTokens <= policy.maxTokens, 400, 'INVALID_CONTEXT_WINDOW', '单条消息 Token 预算不能超过总 Token 预算。');
  return policy;
}

export function selectContextMessages(messages, options = {}) {
  const environment = options.environment || 'real';
  assertApi(['real', 'simulation'].includes(environment), 400, 'INVALID_CONTEXT_WINDOW', '上下文环境无效。');
  const policy = normalizeContextWindow(options);
  const eligible = messages.filter(message => isContextMessage(message, environment));
  const latestCustomer = eligible.findLast(message => message.role === 'customer');
  if (!latestCustomer) throw new ApiError(409, 'NO_CUSTOMER_MESSAGE', '该购买需求还没有合格的客户消息。');
  const latestLength = latestCustomer.text.length;
  const latestTokens = estimateTokens(latestCustomer.text);
  assertApi(latestLength <= policy.maxMessageCharacters && latestLength <= policy.maxCharacters
    && latestTokens <= policy.maxMessageTokens && latestTokens <= policy.maxTokens,
  422, 'CONTEXT_MESSAGE_TOO_LARGE', '最新客户问题超出上下文预算，未截断或调用 AI。', {
    message_id: latestCustomer.message_id, characters: latestLength, tokens: latestTokens,
    max_message_characters: policy.maxMessageCharacters, max_characters: policy.maxCharacters,
    max_message_tokens: policy.maxMessageTokens, max_tokens: policy.maxTokens
  });

  const groups = [];
  for (const message of eligible) {
    const last = groups.at(-1);
    if (last && last.role === message.role) last.messages.push(message);
    else groups.push({ index: groups.length, role: message.role, messages: [message] });
  }
  const groupByMessage = new Map();
  for (const group of groups) for (const message of group.messages) groupByMessage.set(message.message_id, group.index);

  const selectedIds = new Set([latestCustomer.message_id]);
  const selectedGroupCounts = new Map([[groupByMessage.get(latestCustomer.message_id), 1]]);
  const selectedGroups = new Set([groupByMessage.get(latestCustomer.message_id)]);
  let characters = latestLength;
  let tokens = latestTokens;
  const currentKeywords = keywords(latestCustomer.text);
  const latestGroupIndex = groupByMessage.get(latestCustomer.message_id);
  const defaultGroupFloor = Math.max(0, latestGroupIndex - (policy.defaultTurns * 2 - 1));
  const maxGroupFloor = Math.max(0, latestGroupIndex - (policy.maxTurns * 2 - 1));
  for (let index = eligible.length - 1; index >= 0; index -= 1) {
    const message = eligible[index];
    if (selectedIds.has(message.message_id)) continue;
    const groupIndex = groupByMessage.get(message.message_id);
    if (groupIndex < maxGroupFloor) continue;
    if (groupIndex < defaultGroupFloor && topicScore(message, currentKeywords) < 2) continue;
    if (!selectedGroups.has(groupIndex) && selectedGroups.size >= policy.maxRoleGroups) continue;
    if ((selectedGroupCounts.get(groupIndex) || 0) >= policy.maxMessagesPerRoleGroup) continue;
    if (selectedIds.size >= policy.maxMessages) continue;
    const messageTokens = estimateTokens(message.text);
    if (message.text.length > policy.maxMessageCharacters || characters + message.text.length > policy.maxCharacters
      || messageTokens > policy.maxMessageTokens || tokens + messageTokens > policy.maxTokens) continue;
    selectedIds.add(message.message_id);
    selectedGroups.add(groupIndex);
    selectedGroupCounts.set(groupIndex, (selectedGroupCounts.get(groupIndex) || 0) + 1);
    characters += message.text.length;
    tokens += messageTokens;
  }
  const selected = eligible.filter(message => selectedIds.has(message.message_id));
  const omitted = eligible.filter(message => !selectedIds.has(message.message_id));
  const omittedGroups = new Set(omitted.map(message => groupByMessage.get(message.message_id)));
  const relatedHistory = omitted.map(message => ({ message, score: topicScore(message, currentKeywords) }))
    .filter(item => item.score >= 2)
    .sort((left, right) => right.score - left.score || String(right.message.occurred_at).localeCompare(String(left.message.occurred_at)))
    .slice(0, policy.relatedHistoryLimit)
    .map(({ message }) => ({
      message_id: message.message_id, role: message.role, text: message.text, status: message.status,
      source: message.source, occurred_at: message.occurred_at
    }));
  return {
    latestCustomer,
    latestConversation: eligible.at(-1),
    messages: selected.map(message => ({
      message_id: message.message_id, role: message.role, text: message.text, status: message.status,
      source: message.source, occurred_at: message.occurred_at
    })),
    relatedHistory,
    window: {
      policy: { ...policy, token_count: 'estimated_for_context_budget', character_count: 'utf16_code_units', role_group: 'consecutive_same_role' },
      included_token_estimate: tokens,
      eligible_message_count: eligible.length,
      included_message_count: selected.length,
      omitted_message_count: omitted.length,
      omitted_role_group_count: omittedGroups.size,
      complete: omitted.length === 0
    }
  };
}

export { DEFAULT_POLICY };
