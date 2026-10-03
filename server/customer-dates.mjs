import { assertApi } from './errors.mjs';

export const WECHAT_JOINED_SOURCES = Object.freeze(['manual', 'import', 'platform', 'unknown']);
const SOURCE_SET = new Set(WECHAT_JOINED_SOURCES);
const MIN_JOINED_DATE = '1900-01-01';

function dateParts(value, field) {
  assertApi(typeof value === 'string', 400, 'INVALID_WECHAT_JOINED_DATE', `${field} 必须是日期字符串或 null。`, { field });
  const input = value.trim();
  let match = input.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) match = input.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  assertApi(match, 400, 'INVALID_WECHAT_JOINED_DATE', `${field} 只接受 YYYY-MM-DD 或 YYYY/M/D。`, { field, value });
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  assertApi(year >= 1900 && year <= 9999 && month >= 1 && month <= 12 && day >= 1 && day <= 31,
    400, 'INVALID_WECHAT_JOINED_DATE', `${field} 超出允许日期范围。`, { field, value });
  const date = new Date(Date.UTC(year, month - 1, day));
  assertApi(date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day,
    400, 'INVALID_WECHAT_JOINED_DATE', `${field} 不是有效日历日期。`, { field, value });
  return { year, month, day };
}

export function normalizeWechatJoinedOn(value, { field = 'wechat_joined_on', max = null } = {}) {
  if (value === null) return null;
  const { year, month, day } = dateParts(value, field);
  const normalized = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  assertApi(normalized >= MIN_JOINED_DATE && (!max || normalized <= max), 400, 'WECHAT_JOINED_DATE_OUT_OF_RANGE', `${field} 超出允许日期范围。`, { field, value, min: MIN_JOINED_DATE, max });
  return normalized;
}

export function formatWechatJoinedLabel(value) {
  if (value == null) return null;
  const { year, month, day } = dateParts(value, 'wechat_joined_on');
  return `${year}/${month}/${day}`;
}

export function normalizeWechatJoinedSource(value, { field = 'wechat_joined_source', required = false } = {}) {
  if (value === undefined && !required) return null;
  assertApi(typeof value === 'string' && SOURCE_SET.has(value), 400, 'INVALID_WECHAT_JOINED_SOURCE', `${field} 必须是 manual、import、platform 或 unknown。`, { field, value });
  return value;
}

export function normalizeWechatJoinedActor(value) {
  if (value === undefined || value === null) return null;
  assertApi(typeof value === 'string' && value.trim() && value.trim().length <= 160, 400, 'INVALID_WECHAT_JOINED_ACTOR', 'wechat_joined_actor 必须是不超过 160 字符的非空字符串。');
  return value.trim();
}

export function normalizeJoinedFilters(filters = {}) {
  assertApi(filters && typeof filters === 'object' && !Array.isArray(filters), 400, 'INVALID_JOINED_FILTER', '加入日期筛选必须是对象。');
  const allowed = new Set(['joined_from', 'joined_to', 'joined_on']);
  assertApi(Object.keys(filters).every(key => allowed.has(key)), 400, 'INVALID_JOINED_FILTER', '包含不支持的加入日期筛选字段。');
  const hasExact = filters.joined_on !== undefined;
  const hasRange = filters.joined_from !== undefined || filters.joined_to !== undefined;
  assertApi(!(hasExact && hasRange), 400, 'JOINED_FILTER_CONFLICT', 'joined_on 不能与 joined_from/joined_to 同时使用。');
  const normalized = {
    joined_on: hasExact ? normalizeWechatJoinedOn(filters.joined_on, { field: 'joined_on' }) : null,
    joined_from: filters.joined_from === undefined ? null : normalizeWechatJoinedOn(filters.joined_from, { field: 'joined_from' }),
    joined_to: filters.joined_to === undefined ? null : normalizeWechatJoinedOn(filters.joined_to, { field: 'joined_to' })
  };
  assertApi(!hasExact || normalized.joined_on !== null, 400, 'INVALID_JOINED_FILTER', 'joined_on 必须是具体日期。');
  assertApi(!hasRange || normalized.joined_from !== null || normalized.joined_to !== null, 400, 'INVALID_JOINED_FILTER', '日期范围必须至少包含一个端点。');
  assertApi(!normalized.joined_from || !normalized.joined_to || normalized.joined_from <= normalized.joined_to,
    400, 'INVALID_JOINED_DATE_RANGE', 'joined_from 不能晚于 joined_to。', { joined_from: normalized.joined_from, joined_to: normalized.joined_to });
  return normalized;
}

export function installCustomerDateSchema(db) {
  const columns = db.prepare('PRAGMA table_info(customers)').all();
  if (!columns.some(column => column.name === 'wechat_joined_on')) db.exec('ALTER TABLE customers ADD COLUMN wechat_joined_on TEXT');
  if (!columns.some(column => column.name === 'wechat_joined_source')) db.exec("ALTER TABLE customers ADD COLUMN wechat_joined_source TEXT NOT NULL DEFAULT 'unknown'");
  db.exec(`
    CREATE TABLE IF NOT EXISTS customer_joined_date_audit (
      workspace_id TEXT NOT NULL,
      audit_id TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      before_on TEXT,
      after_on TEXT,
      before_source TEXT NOT NULL,
      after_source TEXT NOT NULL,
      actor TEXT,
      changed_at TEXT NOT NULL,
      PRIMARY KEY(workspace_id, audit_id),
      FOREIGN KEY(workspace_id, customer_id) REFERENCES customers(workspace_id, customer_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS customer_joined_date_audit_by_customer
      ON customer_joined_date_audit(workspace_id, customer_id, changed_at);
  `);
}
