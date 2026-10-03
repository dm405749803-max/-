// B1 orchestration only: independent business modules own their storage/routes.
// This module is loaded only in the isolated, explicitly enabled B1 service.
import { createSalesOps, createSalesOpsApi } from './sales-ops/index.mjs';
import { createMemoryReviewApi } from './memory-review/index.mjs';
import { proposeMemory } from '../ai/memory-proposal.mjs';
import { randomUUID } from 'node:crypto';
import { createApprovedExperienceRetriever } from '../knowledge/experiences.mjs';

export function createBackendB1({ store, readJson, sendJson, runMemoryDify = null, now = () => new Date(), scanIntervalMs = 60_000 }) {
  const salesOps = createSalesOps({ store, now });
  const retrieveExperiences = createApprovedExperienceRetriever({
    listApprovedExperiences: (workspaceId, filters) => salesOps.listApprovedExperiences(workspaceId, filters)
  });
  const memoryReviewApi = createMemoryReviewApi({
    store, readJson, sendJson, now,
    proposeMemory: runMemoryDify ? context => proposeMemory(context, { runDify: runMemoryDify, now }) : null
  });
  const routes = [createSalesOpsApi({ store, salesOps, readJson, sendJson, now }), memoryReviewApi];

  // A local persistent notification is not an external message or OS push.
  // Repeated scans must remain idempotent inside the sales-ops service.
  function scanDueTasks() {
    const workspaces = store.raw.prepare(`SELECT DISTINCT workspace_id FROM (
      SELECT workspace_id FROM tasks UNION SELECT workspace_id FROM opportunities
    )`).all();
    for (const { workspace_id: workspaceId } of workspaces) {
      salesOps.scanDueTasks(workspaceId, { idempotency_key: `backend-scan:${randomUUID()}` });
      store.decayOpportunityIntents(workspaceId);
    }
    return { scanned_workspaces: workspaces.length };
  }
  function safeScan() {
    try { scanDueTasks(); }
    catch { console.error('B1 站内待办扫描失败；下一周期重试，未发送任何外部消息。'); }
  }
  const interval = Number.isFinite(scanIntervalMs) && scanIntervalMs > 0
    ? setInterval(safeScan, Math.max(1000, scanIntervalMs)) : null;
  interval?.unref();
  if (interval) safeScan();

  return {
    salesOps,
    scanDueTasks,
    close() { if (interval) clearInterval(interval); },
    async route(req, res, url) {
      for (const route of routes) if (await route(req, res, url)) return true;
      return false;
    },
    generateMemoryProposal({ workspaceId, opportunityId, messageId, idempotencyKey, traceId = null, sessionId = null, caseId = null, evalRunId = null }) {
      return memoryReviewApi.generateProposal(workspaceId, opportunityId, {
        idempotency_key: idempotencyKey,
        ...(messageId ? { latest_message_id: messageId } : {}),
        trace_id: traceId, session_id: sessionId, case_id: caseId, eval_run_id: evalRunId
      });
    },
    findMemoryProposal({ workspaceId, opportunityId, generationKey }) {
      return memoryReviewApi.findProposal(workspaceId, opportunityId, generationKey);
    },
    // Scope comes from server context; the adapter rechecks scope and relevance.
    retrieveExperiences
  };
}
