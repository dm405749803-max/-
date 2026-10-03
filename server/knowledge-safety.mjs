import { randomUUID } from 'node:crypto';
import { assertApi } from './errors.mjs';

const json = value => JSON.stringify(value ?? null);
const parse = (value, fallback = null) => { try { return value == null ? fallback : JSON.parse(value); } catch { return fallback; } };
const READY = new Set(['ready','approved']);

export function createKnowledgeSafetyService({ store, now = () => new Date() } = {}) {
  assertApi(store?.raw, 500, 'KNOWLEDGE_SAFETY_STORE_REQUIRED', '知识版本安全锁需要数据库。');
  const db = store.raw;
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_release_batches (
      workspace_id TEXT NOT NULL,release_id TEXT NOT NULL,product_id TEXT NOT NULL,version_id TEXT NOT NULL,
      environment TEXT NOT NULL DEFAULT 'simulation',rules_status TEXT NOT NULL DEFAULT 'missing',
      rag_status TEXT NOT NULL DEFAULT 'missing',review_status TEXT NOT NULL DEFAULT 'pending',
      effective_at TEXT,active INTEGER NOT NULL DEFAULT 1,details TEXT NOT NULL DEFAULT '{}',
      revision INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      PRIMARY KEY(workspace_id,release_id),UNIQUE(workspace_id,environment,product_id,version_id)
    );
    CREATE TABLE IF NOT EXISTS ai_safety_lock_events (
      workspace_id TEXT NOT NULL,event_id TEXT NOT NULL,locked INTEGER NOT NULL,reason TEXT,
      release_id TEXT,actor TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(workspace_id,event_id)
    );
  `);
  const rowStatus = row => {
    const effective = !row.effective_at || Date.parse(row.effective_at) <= now().getTime();
    const ready = READY.has(row.rules_status) && READY.has(row.rag_status) && row.review_status === 'approved' && effective;
    return { ready, effective };
  };
  const dto = row => ({ ...row, active: Boolean(row.active), details: parse(row.details, {}), ...rowStatus(row) });
  const status = workspaceId => {
    const releases = db.prepare('SELECT * FROM knowledge_release_batches WHERE workspace_id=? AND active=1 ORDER BY updated_at DESC').all(workspaceId).map(dto);
    const broken = releases.filter(item => !item.ready);
    const manual = db.prepare('SELECT * FROM ai_safety_lock_events WHERE workspace_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(workspaceId);
    const manuallyLocked = Boolean(manual?.locked);
    const locked = manuallyLocked || broken.length > 0;
    return {
      locked,
      state: locked ? 'blocked' : releases.length ? 'ready' : 'not_configured',
      reason: manuallyLocked ? manual.reason : broken.length ? 'knowledge_version_not_atomic' : null,
      affected_releases: broken.map(item => ({ release_id: item.release_id, product_id: item.product_id, version_id: item.version_id,
        rules_status: item.rules_status, rag_status: item.rag_status, review_status: item.review_status, effective_at: item.effective_at }))
    };
  };
  const service = {
    status,
    assertAiAllowed(workspaceId) {
      const value = status(workspaceId);
      assertApi(!value.locked, 409, 'AI_KNOWLEDGE_SAFETY_LOCKED', '知识库与产品规则版本不一致，已停止所有 AI 对客输出，请人工接管。', value);
      return value;
    },
    upsertRelease(workspaceId, input = {}) {
      for (const field of ['product_id','version_id','rules_status','rag_status','review_status']) {
        assertApi(String(input[field] || '').trim(), 400, 'KNOWLEDGE_RELEASE_FIELD_REQUIRED', `知识发布缺少 ${field}。`);
      }
      assertApi(['real','simulation'].includes(input.environment || 'simulation'), 400, 'INVALID_ENVIRONMENT', '知识发布环境无效。');
      assertApi(['missing','pending','ready','approved','rejected','expired'].includes(input.rules_status), 400, 'INVALID_RULES_STATUS', '结构化规则状态无效。');
      assertApi(['missing','pending','ready','approved','rejected','expired'].includes(input.rag_status), 400, 'INVALID_RAG_STATUS', 'RAG状态无效。');
      assertApi(['pending','approved','rejected'].includes(input.review_status), 400, 'INVALID_REVIEW_STATUS', '人工审核状态无效。');
      if (input.effective_at) assertApi(Number.isFinite(Date.parse(input.effective_at)), 400, 'INVALID_EFFECTIVE_AT', '生效时间无效。');
      const current = db.prepare('SELECT * FROM knowledge_release_batches WHERE workspace_id=? AND environment=? AND product_id=? AND version_id=?')
        .get(workspaceId,input.environment || 'simulation',input.product_id,input.version_id);
      const at = now().toISOString();
      const releaseId = current?.release_id || input.release_id || `release_${randomUUID()}`;
      if (current) db.prepare(`UPDATE knowledge_release_batches SET rules_status=?,rag_status=?,review_status=?,effective_at=?,active=?,details=?,revision=revision+1,updated_at=?
        WHERE workspace_id=? AND release_id=?`).run(input.rules_status,input.rag_status,input.review_status,input.effective_at || null,input.active === false ? 0 : 1,json(input.details || {}),at,workspaceId,releaseId);
      else db.prepare(`INSERT INTO knowledge_release_batches(workspace_id,release_id,product_id,version_id,environment,rules_status,rag_status,review_status,effective_at,active,details,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(workspaceId,releaseId,input.product_id,input.version_id,input.environment || 'simulation',input.rules_status,input.rag_status,input.review_status,input.effective_at || null,input.active === false ? 0 : 1,json(input.details || {}),at,at);
      return { release: dto(db.prepare('SELECT * FROM knowledge_release_batches WHERE workspace_id=? AND release_id=?').get(workspaceId,releaseId)), safety: status(workspaceId) };
    },
    setManualLock(workspaceId, { locked, reason, release_id = null, actor = 'system' } = {}) {
      assertApi(typeof locked === 'boolean', 400, 'INVALID_LOCK_STATE', '安全锁状态无效。');
      if (!locked) {
        const current = status(workspaceId);
        assertApi(current.affected_releases.length === 0, 409, 'KNOWLEDGE_RELEASES_NOT_READY', '版本校验仍未通过，不能解锁。', current);
      }
      const at = now().toISOString();
      db.prepare('INSERT INTO ai_safety_lock_events VALUES (?,?,?,?,?,?,?)').run(workspaceId,`lock_${randomUUID()}`,locked ? 1 : 0,String(reason || '').slice(0,1000) || null,release_id,actor,at);
      return status(workspaceId);
    },
    listReleases(workspaceId) {
      return db.prepare('SELECT * FROM knowledge_release_batches WHERE workspace_id=? ORDER BY updated_at DESC').all(workspaceId).map(dto);
    }
  };
  return service;
}
