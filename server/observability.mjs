import { createHash, randomBytes } from 'node:crypto';

const json = value => JSON.stringify(value ?? null);
const parse = (value, fallback = null) => { try { return value == null ? fallback : JSON.parse(value); } catch { return fallback; } };
const iso = () => new Date().toISOString();
const TRACE_RE = /^[0-9a-f]{32}$/;
const SPAN_RE = /^[0-9a-f]{16}$/;

export function createTraceId(value = null) {
  return TRACE_RE.test(String(value || '')) ? String(value) : randomBytes(16).toString('hex');
}

export function createObservationId(value = null) {
  return SPAN_RE.test(String(value || '')) ? String(value) : randomBytes(8).toString('hex');
}

function sessionId(workspaceId, opportunityId) {
  const digest = createHash('sha256').update(`${workspaceId}\u0000${opportunityId}`).digest('hex').slice(0, 24);
  return `session_${digest}`;
}

export function createObservabilityService({ store, exporter = null, now = iso } = {}) {
  if (!store?.raw) throw new TypeError('observability requires openDatabase store');
  const db = store.raw;
  db.exec(`
    CREATE TABLE IF NOT EXISTS trace_sessions (
      workspace_id TEXT NOT NULL,session_id TEXT NOT NULL,customer_id TEXT,opportunity_id TEXT NOT NULL,
      environment TEXT NOT NULL DEFAULT 'real',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      PRIMARY KEY(workspace_id,session_id),UNIQUE(workspace_id,opportunity_id)
    );
    CREATE TABLE IF NOT EXISTS ai_traces (
      workspace_id TEXT NOT NULL,trace_id TEXT NOT NULL,session_id TEXT,customer_id TEXT,opportunity_id TEXT,message_id TEXT,
      case_id TEXT,eval_run_id TEXT,name TEXT NOT NULL,status TEXT NOT NULL,input_json TEXT,output_json TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',error_code TEXT,started_at TEXT NOT NULL,ended_at TEXT,duration_ms INTEGER,
      PRIMARY KEY(workspace_id,trace_id)
    );
    CREATE INDEX IF NOT EXISTS ai_traces_session ON ai_traces(workspace_id,session_id,started_at);
    CREATE INDEX IF NOT EXISTS ai_traces_eval ON ai_traces(workspace_id,eval_run_id,case_id);
    CREATE TABLE IF NOT EXISTS ai_observations (
      workspace_id TEXT NOT NULL,observation_id TEXT NOT NULL,trace_id TEXT NOT NULL,parent_observation_id TEXT,
      type TEXT NOT NULL,name TEXT NOT NULL,status TEXT NOT NULL,input_json TEXT,output_json TEXT,model TEXT,
      input_tokens INTEGER,output_tokens INTEGER,total_tokens INTEGER,cost_cny REAL,metadata_json TEXT NOT NULL DEFAULT '{}',
      error_code TEXT,started_at TEXT NOT NULL,ended_at TEXT,duration_ms INTEGER,
      PRIMARY KEY(workspace_id,observation_id),
      FOREIGN KEY(workspace_id,trace_id) REFERENCES ai_traces(workspace_id,trace_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS ai_observations_trace ON ai_observations(workspace_id,trace_id,started_at);
    CREATE TABLE IF NOT EXISTS badcases (
      workspace_id TEXT NOT NULL,badcase_id TEXT NOT NULL,case_id TEXT NOT NULL,eval_run_id TEXT NOT NULL,trace_id TEXT,
      status TEXT NOT NULL DEFAULT 'open',severity TEXT NOT NULL,failed_dimensions TEXT NOT NULL DEFAULT '[]',
      actual_json TEXT,expected_json TEXT,root_cause_layer TEXT,root_cause_note TEXT,fix_version TEXT,
      regression_status TEXT NOT NULL DEFAULT 'not_run',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      PRIMARY KEY(workspace_id,badcase_id),UNIQUE(workspace_id,eval_run_id,case_id)
    );
    CREATE TABLE IF NOT EXISTS analytics_events (
      workspace_id TEXT NOT NULL,event_id TEXT NOT NULL,event_name TEXT NOT NULL,category TEXT NOT NULL DEFAULT 'business',
      trace_id TEXT,session_id TEXT,customer_id_hash TEXT,opportunity_id TEXT,message_id TEXT,actor TEXT NOT NULL DEFAULT 'system',
      environment TEXT NOT NULL DEFAULT 'real',workflow TEXT,workflow_version TEXT,product_version TEXT,
      duration_ms INTEGER,numeric_value REAL,payload_json TEXT NOT NULL DEFAULT '{}',idempotency_key TEXT,
      occurred_at TEXT NOT NULL,created_at TEXT NOT NULL,
      PRIMARY KEY(workspace_id,event_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS analytics_events_idempotency
      ON analytics_events(workspace_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS analytics_events_name_time
      ON analytics_events(workspace_id,event_name,occurred_at);
    CREATE INDEX IF NOT EXISTS analytics_events_trace
      ON analytics_events(workspace_id,trace_id,occurred_at);
  `);
  const badcaseColumns = new Set(db.prepare('PRAGMA table_info(badcases)').all().map(row => row.name));
  for (const [name, definition] of [
    ['human_review_status', "TEXT NOT NULL DEFAULT 'pending'"],
    ['human_review_note', 'TEXT'],
    ['naturalness_score', 'INTEGER'],
    ['reviewed_by', 'TEXT'],
    ['reviewed_at', 'TEXT']
  ]) {
    if (!badcaseColumns.has(name)) db.exec(`ALTER TABLE badcases ADD COLUMN ${name} ${definition}`);
  }

  const getSession = (workspaceId, opportunityId, customerId = null, environment = 'real') => {
    let row = db.prepare('SELECT * FROM trace_sessions WHERE workspace_id=? AND opportunity_id=?').get(workspaceId, opportunityId);
    if (row) return row;
    const at = now(); const id = sessionId(workspaceId, opportunityId);
    db.prepare(`INSERT OR IGNORE INTO trace_sessions(workspace_id,session_id,customer_id,opportunity_id,environment,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?)`).run(workspaceId, id, customerId, opportunityId, environment, at, at);
    row = db.prepare('SELECT * FROM trace_sessions WHERE workspace_id=? AND opportunity_id=?').get(workspaceId, opportunityId);
    return row;
  };

  const customerHash = value => value == null || value === '' ? null
    : createHash('sha256').update(String(value)).digest('hex').slice(0, 24);

  const recordEvent = (workspaceId, input = {}) => {
    const eventName = String(input.event_name || input.name || '').trim();
    if (!/^[a-z][a-z0-9_]{1,79}$/.test(eventName)) throw new TypeError('analytics event_name must use lower_snake_case');
    const occurredAt = String(input.occurred_at || now());
    const eventId = String(input.event_id || `evt_${randomBytes(12).toString('hex')}`);
    const idempotencyKey = input.idempotency_key == null ? null : String(input.idempotency_key).slice(0, 240);
    const customerIdHash = input.customer_id_hash || customerHash(input.customer_id);
    db.prepare(`INSERT INTO analytics_events(
      workspace_id,event_id,event_name,category,trace_id,session_id,customer_id_hash,opportunity_id,message_id,actor,
      environment,workflow,workflow_version,product_version,duration_ms,numeric_value,payload_json,idempotency_key,occurred_at,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(workspace_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO UPDATE SET
      trace_id=COALESCE(excluded.trace_id,analytics_events.trace_id),duration_ms=COALESCE(excluded.duration_ms,analytics_events.duration_ms),
      numeric_value=COALESCE(excluded.numeric_value,analytics_events.numeric_value),payload_json=excluded.payload_json,
      occurred_at=excluded.occurred_at`).run(
      workspaceId,eventId,eventName,String(input.category || 'business'),input.trace_id || null,input.session_id || null,
      customerIdHash,input.opportunity_id || null,input.message_id || null,String(input.actor || 'system'),
      String(input.environment || 'real'),input.workflow || null,input.workflow_version || null,input.product_version || null,
      input.duration_ms != null && Number.isFinite(Number(input.duration_ms)) ? Number(input.duration_ms) : null,
      input.numeric_value != null && Number.isFinite(Number(input.numeric_value)) ? Number(input.numeric_value) : null,
      json(input.payload || {}),idempotencyKey,occurredAt,now()
    );
    const row = idempotencyKey
      ? db.prepare('SELECT * FROM analytics_events WHERE workspace_id=? AND idempotency_key=?').get(workspaceId,idempotencyKey)
      : db.prepare('SELECT * FROM analytics_events WHERE workspace_id=? AND event_id=?').get(workspaceId,eventId);
    return { ...row,payload:parse(row.payload_json,{}) };
  };

  const listEvents = (workspaceId, filters = {}) => {
    const clauses = ['workspace_id=?']; const args = [workspaceId];
    for (const [column,value] of [['event_name',filters.event_name],['trace_id',filters.trace_id],['opportunity_id',filters.opportunity_id]]) {
      if (value) { clauses.push(`${column}=?`); args.push(value); }
    }
    if (filters.from) { clauses.push('occurred_at>=?'); args.push(String(filters.from)); }
    if (filters.to) { clauses.push('occurred_at<=?'); args.push(String(filters.to)); }
    const limit = Math.max(1,Math.min(2000,Number(filters.limit)||200));
    return db.prepare(`SELECT * FROM analytics_events WHERE ${clauses.join(' AND ')} ORDER BY occurred_at DESC,rowid DESC LIMIT ?`)
      .all(...args,limit).map(row=>({ ...row,payload:parse(row.payload_json,{}) }));
  };

  const startTrace = input => {
    const at = now();
    const traceId = createTraceId(input.trace_id);
    db.prepare(`INSERT INTO ai_traces(workspace_id,trace_id,session_id,customer_id,opportunity_id,message_id,case_id,eval_run_id,name,status,input_json,metadata_json,started_at)
      VALUES (?,?,?,?,?,?,?,?,?,'running',?,?,?)
      ON CONFLICT(workspace_id,trace_id) DO UPDATE SET
        session_id=COALESCE(excluded.session_id,ai_traces.session_id),customer_id=COALESCE(excluded.customer_id,ai_traces.customer_id),
        opportunity_id=COALESCE(excluded.opportunity_id,ai_traces.opportunity_id),message_id=COALESCE(excluded.message_id,ai_traces.message_id),
        case_id=COALESCE(excluded.case_id,ai_traces.case_id),eval_run_id=COALESCE(excluded.eval_run_id,ai_traces.eval_run_id),
        metadata_json=excluded.metadata_json`).run(
      input.workspace_id, traceId, input.session_id || null, input.customer_id || null, input.opportunity_id || null,
      input.message_id || null, input.case_id || null, input.eval_run_id || null, input.name || 'customer-message',
      json(input.input), json(input.metadata || {}), at
    );
    return { ...input, trace_id: traceId, started_at: at };
  };

  const finishTrace = (workspaceId, traceId, update = {}) => {
    const row = db.prepare('SELECT * FROM ai_traces WHERE workspace_id=? AND trace_id=?').get(workspaceId, traceId);
    if (!row) return null;
    const ended = now(); const duration = Math.max(0, Date.parse(ended) - Date.parse(row.started_at));
    db.prepare(`UPDATE ai_traces SET status=?,output_json=?,error_code=?,ended_at=?,duration_ms=?,metadata_json=?
      WHERE workspace_id=? AND trace_id=?`).run(update.status || 'success', json(update.output), update.error_code || null,
      ended, duration, json({ ...parse(row.metadata_json, {}), ...(update.metadata || {}) }), workspaceId, traceId);
    const value = getTrace(workspaceId, traceId);
    Promise.resolve(exporter?.exportTrace?.(value)).catch(() => {});
    return value;
  };

  const startObservation = input => {
    const id = createObservationId(input.observation_id); const at = now();
    db.prepare(`INSERT INTO ai_observations(workspace_id,observation_id,trace_id,parent_observation_id,type,name,status,input_json,model,metadata_json,started_at)
      VALUES (?,?,?,?,?,?,'running',?,?,?,?)`).run(input.workspace_id, id, input.trace_id,
      input.parent_observation_id || null, input.type || 'span', input.name, json(input.input), input.model || null,
      json(input.metadata || {}), at);
    return { ...input, observation_id: id, started_at: at };
  };

  const finishObservation = (workspaceId, observationId, update = {}) => {
    const row = db.prepare('SELECT * FROM ai_observations WHERE workspace_id=? AND observation_id=?').get(workspaceId, observationId);
    if (!row) return null;
    const ended = now(); const duration = Math.max(0, Date.parse(ended) - Date.parse(row.started_at));
    const usage = update.usage || {};
    db.prepare(`UPDATE ai_observations SET status=?,output_json=?,model=COALESCE(?,model),input_tokens=?,output_tokens=?,total_tokens=?,cost_cny=?,
      metadata_json=?,error_code=?,ended_at=?,duration_ms=? WHERE workspace_id=? AND observation_id=?`).run(
      update.status || 'success', json(update.output), update.model || null, usage.input_tokens ?? null, usage.output_tokens ?? null,
      usage.total_tokens ?? null, usage.estimated_cost_cny ?? null,
      json({ ...parse(row.metadata_json, {}), ...(update.metadata || {}) }), update.error_code || null, ended, duration,
      workspaceId, observationId);
    const value = db.prepare('SELECT * FROM ai_observations WHERE workspace_id=? AND observation_id=?').get(workspaceId, observationId);
    const trace = getTrace(workspaceId, value.trace_id);
    Promise.resolve(exporter?.exportObservation?.(trace, {
      ...value,
      input: parse(value.input_json), output: parse(value.output_json), metadata: parse(value.metadata_json, {})
    })).catch(() => {});
    return value;
  };

  async function observe(input, work) {
    const observation = startObservation(input);
    try {
      const output = await work(observation);
      finishObservation(input.workspace_id, observation.observation_id, { status: 'success', output });
      return output;
    } catch (error) {
      finishObservation(input.workspace_id, observation.observation_id, {
        status: 'error', error_code: error?.code || error?.name || 'ERROR', output: { message: 'step_failed' }
      });
      throw error;
    }
  }

  function getTrace(workspaceId, traceId) {
    const trace = db.prepare('SELECT * FROM ai_traces WHERE workspace_id=? AND trace_id=?').get(workspaceId, traceId);
    if (!trace) return null;
    const observations = db.prepare('SELECT * FROM ai_observations WHERE workspace_id=? AND trace_id=? ORDER BY started_at,rowid').all(workspaceId, traceId);
    return {
      ...trace,
      input: parse(trace.input_json), output: parse(trace.output_json), metadata: parse(trace.metadata_json, {}),
      observations: observations.map(row => ({ ...row, input: parse(row.input_json), output: parse(row.output_json), metadata: parse(row.metadata_json, {}) }))
    };
  }

  const annotateTrace = (workspaceId, traceId, metadata = {}) => {
    if (!traceId) return null;
    const row = db.prepare('SELECT * FROM ai_traces WHERE workspace_id=? AND trace_id=?').get(workspaceId,traceId);
    if (!row) return null;
    db.prepare('UPDATE ai_traces SET metadata_json=? WHERE workspace_id=? AND trace_id=?')
      .run(json({ ...parse(row.metadata_json,{}),...metadata }),workspaceId,traceId);
    const value = getTrace(workspaceId,traceId);
    if (value?.ended_at) Promise.resolve(exporter?.exportTrace?.(value)).catch(()=>{});
    return value;
  };

  const listTraces = (workspaceId, filters = {}) => {
    const clauses = ['workspace_id=?']; const args = [workspaceId];
    for (const [column, value] of [['session_id',filters.session_id],['case_id',filters.case_id],['eval_run_id',filters.eval_run_id]]) {
      if (value) { clauses.push(`${column}=?`); args.push(value); }
    }
    const limit = Math.max(1, Math.min(200, Number(filters.limit) || 50));
    return db.prepare(`SELECT trace_id,session_id,customer_id,opportunity_id,message_id,case_id,eval_run_id,name,status,error_code,started_at,ended_at,duration_ms
      FROM ai_traces WHERE ${clauses.join(' AND ')} ORDER BY started_at DESC LIMIT ?`).all(...args, limit);
  };

  const upsertBadcase = (workspaceId, input = {}) => {
    const at = now();
    const badcaseId = String(input.badcase_id || `bad_${createHash('sha256').update(`${input.eval_run_id || ''}\u0000${input.case_id || ''}`).digest('hex').slice(0, 20)}`);
    const values = {
      badcase_id: badcaseId,
      case_id: String(input.case_id || ''),
      eval_run_id: String(input.eval_run_id || ''),
      trace_id: input.trace_id || null,
      status: input.status || 'open',
      severity: input.severity || 'P1',
      failed_dimensions: Array.isArray(input.failed_dimensions) ? input.failed_dimensions : [],
      actual: input.actual ?? null,
      expected: input.expected ?? null,
      root_cause_layer: input.root_cause_layer || 'unclassified',
      root_cause_note: input.root_cause_note || null,
      fix_version: input.fix_version || null,
      regression_status: input.regression_status || 'not_run'
    };
    if (!values.case_id || !values.eval_run_id) throw new TypeError('badcase requires case_id and eval_run_id');
    db.prepare(`INSERT INTO badcases(workspace_id,badcase_id,case_id,eval_run_id,trace_id,status,severity,failed_dimensions,actual_json,expected_json,root_cause_layer,root_cause_note,fix_version,regression_status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(workspace_id,eval_run_id,case_id) DO UPDATE SET
        trace_id=excluded.trace_id,status=excluded.status,severity=excluded.severity,failed_dimensions=excluded.failed_dimensions,
        actual_json=excluded.actual_json,expected_json=excluded.expected_json,root_cause_layer=excluded.root_cause_layer,
        root_cause_note=excluded.root_cause_note,fix_version=excluded.fix_version,regression_status=excluded.regression_status,updated_at=excluded.updated_at`)
      .run(workspaceId, values.badcase_id, values.case_id, values.eval_run_id, values.trace_id, values.status, values.severity,
        json(values.failed_dimensions), json(values.actual), json(values.expected), values.root_cause_layer, values.root_cause_note,
        values.fix_version, values.regression_status, at, at);
    if (input.reset_human_review === true) {
      db.prepare(`UPDATE badcases SET human_review_status='pending',human_review_note=NULL,naturalness_score=NULL,
        reviewed_by=NULL,reviewed_at=NULL,updated_at=? WHERE workspace_id=? AND eval_run_id=? AND case_id=?`)
        .run(at, workspaceId, values.eval_run_id, values.case_id);
    }
    const value = getBadcase(workspaceId, input.eval_run_id, input.case_id);
    const attention = value.status !== 'closed';
    recordEvent(workspaceId,{
      event_name:'badcase_classified',category:'quality',trace_id:value.trace_id,actor:'evaluation',
      idempotency_key:`badcase:${value.eval_run_id}:${value.case_id}:${value.updated_at}`,
      payload:{ badcase_id:value.badcase_id,case_id:value.case_id,eval_run_id:value.eval_run_id,status:value.status,severity:value.severity,root_cause_layer:value.root_cause_layer }
    });
    annotateTrace(workspaceId,value.trace_id,{
      quality_state:attention?'badcase':'passed',badcase_id:value.badcase_id,severity:value.severity,
      case_id:value.case_id,eval_run_id:value.eval_run_id,root_cause_layer:value.root_cause_layer
    });
    return value;
  };

  function getBadcase(workspaceId, evalRunId, caseId) {
    const row = db.prepare('SELECT * FROM badcases WHERE workspace_id=? AND eval_run_id=? AND case_id=?').get(workspaceId, evalRunId, caseId);
    return row && {
      ...row,
      failed_dimensions: parse(row.failed_dimensions, []),
      actual: parse(row.actual_json),
      expected: parse(row.expected_json)
    };
  }

  const listBadcases = (workspaceId, filters = {}) => {
    const clauses = ['workspace_id=?']; const args = [workspaceId];
    for (const [column, value] of [['eval_run_id', filters.eval_run_id], ['status', filters.status], ['severity', filters.severity], ['root_cause_layer', filters.root_cause_layer]]) {
      if (value) { clauses.push(`${column}=?`); args.push(value); }
    }
    const rows = db.prepare(`SELECT * FROM badcases WHERE ${clauses.join(' AND ')} ORDER BY
      created_at DESC,CASE severity WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END,case_id LIMIT 5000`).all(...args);
    return rows.map(row => ({ ...row, failed_dimensions: parse(row.failed_dimensions, []), actual: parse(row.actual_json), expected: parse(row.expected_json) }));
  };

  const reviewBadcase = (workspaceId, badcaseId, input = {}) => {
    const decision = String(input.decision || '');
    if (!['approved', 'rejected'].includes(decision)) throw new TypeError('badcase review decision must be approved or rejected');
    const current = db.prepare('SELECT * FROM badcases WHERE workspace_id=? AND badcase_id=?').get(workspaceId, badcaseId);
    if (!current) return null;
    const note = String(input.note || '').trim();
    if (decision === 'rejected' && !note) throw new TypeError('rejected badcase review requires a note');
    const naturalnessScore = input.naturalness_score == null || input.naturalness_score === '' ? null : Number(input.naturalness_score);
    if (naturalnessScore != null && (!Number.isInteger(naturalnessScore) || naturalnessScore < 1 || naturalnessScore > 5)) {
      throw new TypeError('badcase naturalness score must be an integer from 1 to 5');
    }
    const reviewer = String(input.reviewer || '人工复核员').trim().slice(0, 160) || '人工复核员';
    const at = now();
    const approved = decision === 'approved';
    db.prepare(`UPDATE badcases SET human_review_status=?,human_review_note=?,naturalness_score=?,reviewed_by=?,reviewed_at=?,
      status=?,regression_status=?,root_cause_layer=?,root_cause_note=?,updated_at=?
      WHERE workspace_id=? AND badcase_id=?`).run(
      decision, note || null, naturalnessScore, reviewer, at,
      approved ? 'closed' : 'open', approved ? 'passed' : 'failed_human_judgment',
      approved ? 'passed' : 'human_judgment',
      approved ? `人工复核通过${note ? `：${note}` : '。'}` : `人工复核未通过：${note}`,
      at, workspaceId, badcaseId
    );
    const row = db.prepare('SELECT * FROM badcases WHERE workspace_id=? AND badcase_id=?').get(workspaceId, badcaseId);
    recordEvent(workspaceId,{
      event_name:'regression_verified',category:'quality',trace_id:row.trace_id,actor:reviewer,
      idempotency_key:`review:${row.badcase_id}:${at}`,numeric_value:naturalnessScore,
      payload:{ badcase_id:row.badcase_id,case_id:row.case_id,decision,naturalness_score:naturalnessScore }
    });
    annotateTrace(workspaceId,row.trace_id,{
      quality_state:approved?'passed':'badcase',badcase_id:row.badcase_id,severity:row.severity,
      human_review_status:decision,naturalness_score:naturalnessScore
    });
    return { ...row, failed_dimensions: parse(row.failed_dimensions, []), actual: parse(row.actual_json), expected: parse(row.expected_json) };
  };

  const dashboard = (workspaceId, filters = {}) => {
    const runId = filters.eval_run_id || db.prepare(`SELECT eval_run_id FROM badcases WHERE workspace_id=?
      GROUP BY eval_run_id ORDER BY MAX(updated_at) DESC LIMIT 1`).get(workspaceId)?.eval_run_id || null;
    const cases = runId ? listBadcases(workspaceId,{ eval_run_id:runId }) : [];
    const total = cases.length;
    const closed = cases.filter(item=>item.status==='closed').length;
    const unresolved = cases.filter(item=>item.status!=='closed').length;
    const p0Unresolved = cases.filter(item=>item.severity==='P0'&&item.status!=='closed').length;
    const naturalness = cases.map(item=>Number(item.naturalness_score)).filter(value=>value>=1&&value<=5);
    const naturalnessAverage = naturalness.length ? Number((naturalness.reduce((a,b)=>a+b,0)/naturalness.length).toFixed(2)) : null;
    const traces = db.prepare(`SELECT status,COUNT(*) count,AVG(duration_ms) avg_duration_ms FROM ai_traces
      WHERE workspace_id=? GROUP BY status`).all(workspaceId);
    const eventSummary = db.prepare(`SELECT event_name,COUNT(*) count,COUNT(DISTINCT customer_id_hash) customer_uv,
      AVG(duration_ms) avg_duration_ms FROM analytics_events WHERE workspace_id=? GROUP BY event_name ORDER BY event_name`).all(workspaceId);
    const byName = Object.fromEntries(eventSummary.map(item=>[item.event_name,item]));
    const count = name => Number(byName[name]?.count||0);
    const ratio = (a,b) => b ? Number((a/b*100).toFixed(2)) : null;
    const generated = count('draft_generated'); const sent = count('draft_confirmed_sent');
    const workflowDone = count('workflow_completed'); const workflowFailed = count('workflow_failed');
    const highRiskEvents = listEvents(workspaceId,{ event_name:'evaluation_judged',limit:2000 })
      .filter(item=>item.payload?.high_risk===true);
    const highRiskMisses = highRiskEvents.filter(item=>item.payload?.high_risk_miss===true).length;
    const gates = [
      { key:'overall_core_pass_rate',name:'整体核心评测通过率',target:'≥90%',actual:total?ratio(closed,total):null,unit:'%',status:total?(ratio(closed,total)>=90?'passed':'failed'):'insufficient' },
      { key:'naturalness_average',name:'回复自然度人工均分',target:'≥4/5',actual:naturalnessAverage,unit:'/5',status:naturalnessAverage==null?'insufficient':naturalnessAverage>=4?'passed':'failed' },
      { key:'p0_unresolved',name:'P0未闭环案例',target:'=0',actual:total?p0Unresolved:null,unit:'条',status:total?(p0Unresolved===0?'passed':'failed'):'insufficient' },
      { key:'high_risk_miss_rate',name:'高风险漏检率',target:'=0',actual:highRiskEvents.length?ratio(highRiskMisses,highRiskEvents.length):null,unit:'%',status:highRiskEvents.length?(highRiskMisses===0?'passed':'failed'):'insufficient' }
    ];
    const readyGates = gates.filter(item=>item.status!=='insufficient');
    const traceTotal = traces.reduce((sum,item)=>sum+Number(item.count),0);
    return {
      generated_at:now(),eval_run_id:runId,
      release_status:readyGates.some(item=>item.status==='failed')?'blocked':gates.some(item=>item.status==='insufficient')?'data_pending':'ready',
      cases:{ total,closed,unresolved,p0_unresolved:p0Unresolved },
      traces:{ total:traceTotal,by_status:Object.fromEntries(traces.map(item=>[item.status,Number(item.count)])),average_duration_ms:traceTotal?Math.round(traces.reduce((sum,item)=>sum+(Number(item.avg_duration_ms)||0)*Number(item.count),0)/traceTotal):null },
      naturalness:{ count:naturalness.length,average:naturalnessAverage },
      funnel:{ customer_messages:count('message_received'),customer_uv:Number(byName.message_received?.customer_uv||0),drafts_generated:generated,drafts_sent:sent,draft_adoption_rate:ratio(sent,generated),workflow_success_rate:ratio(workflowDone,workflowDone+workflowFailed),human_handoffs:count('human_handoff_changed'),purchases:count('purchase_marked') },
      gates,event_summary:eventSummary.map(item=>({ ...item,count:Number(item.count),customer_uv:Number(item.customer_uv),avg_duration_ms:item.avg_duration_ms==null?null:Math.round(Number(item.avg_duration_ms)) }))
    };
  };

  return { getSession,startTrace,finishTrace,startObservation,finishObservation,observe,getTrace,listTraces,
    recordEvent,listEvents,dashboard,annotateTrace,upsertBadcase,listBadcases,reviewBadcase,createTraceId };
}

export const __test = { sessionId, TRACE_RE, SPAN_RE };
