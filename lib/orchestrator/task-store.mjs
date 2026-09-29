// Run-local task graph. The TaskStore holds orchestration state for one run only; an ExternalProjectStore
// (e.g. a future Asana adapter) receives lifecycle notifications and is never required for execution.
export const TASK_STATUSES = ['pending', 'running', 'completed', 'partial', 'failed', 'blocked', 'waiting_for_user', 'superseded'];
export const ARTIFACT_TYPES = ['code_change', 'test_result', 'design_report', 'audit_report', 'experiment_result', 'investigation', 'documentation'];
export const EXPECTED_OUTCOMES = ['code_change_required', 'evidence_or_change', 'evidence_only', 'artifact_required'];
export function expectedOutcomeForArtifact(type) {
  return type === 'code_change' ? 'code_change_required' : ['documentation', 'design_report'].includes(type) ? 'artifact_required' : 'evidence_only';
}
const LEGACY_ARTIFACT = { implement: 'code_change', verify: 'test_result', review: 'audit_report', investigate: 'investigation', experiment: 'experiment_result' };
/** Legacy tasks did not declare an artifact. Derivation is deterministic and does not rewrite the row. */
export function artifactTypeFor(task) {
  return task?.artifact_type ?? task?.artifactType ?? LEGACY_ARTIFACT[task?.kind] ?? 'code_change';
}
export function migrateTask(task) {
  return task.artifact_type == null ? { ...task, artifact_type: artifactTypeFor(task) } : task;
}
const TERMINAL = new Set(['completed', 'failed', 'blocked', 'superseded']);
const DEPENDENCY_STOP = new Set(['partial', 'failed', 'blocked', 'waiting_for_user', 'superseded']);

/**
 * @typedef {{ id: string, title: string, goal: string, capability: string, dependencies: string[],
 *   status: 'pending'|'running'|'completed'|'failed'|'blocked', assignedAgent?: string, result?: unknown,
 *   attempts: number, kind?: string, acceptance: string[], outputs: string[], origin?: string,
 *   feedback?: string[], decisions?: object[], blockedReason?: string }} OrchestratedTask
 */
export function newTask({ id, title, goal, capability, dependencies = [], assignedAgent, acceptance = [], outputs = [], kind, artifact_type, artifactType, expected_outcome, sourceWorkItemId, acceptanceIds = [], estimatedComplexity, recommendedRole, dependsOn, planningRef, likelyFiles = [], parentTaskId, rootTaskId, continuationIndex, sourceTaskId, splitDepth, remainingWorkId, sourceProgressReport, remainingWorkIds = [], remainingWork = [], inheritedArtifacts = [], inheritedEvidence = [], workspaceStateReference, handoff, progress, continuationContext, budget, extensionOf, budgetExtensionIndex, lastFailureSignature, executionRoute, routeHistory = [], escalationCount = 0, lastEscalationReason, failureHistory = [], routeLock, sourceFindingIds = [], sourceReviewTaskId, affectedAcceptanceIds = [], affectedFiles = [], repairScope, repairIndex, sourceImplementationRole, origin = 'plan' }) {
  if (!id || !title || !goal) throw new Error('task: id, title and goal are required');
  const type = artifact_type ?? artifactType;
  if (type != null && !ARTIFACT_TYPES.includes(type)) throw new Error(`task: invalid artifact type "${type}"`);
  if (expected_outcome != null && !EXPECTED_OUTCOMES.includes(expected_outcome)) throw new Error(`task: invalid expected_outcome "${expected_outcome}"`);
  const resolvedType = artifactTypeFor({ kind, artifact_type: type });
  const outcome = expected_outcome ?? (planningRef || parentTaskId || sourceTaskId || sourceFindingIds.length
    ? expectedOutcomeForArtifact(resolvedType) : undefined);
  return { id, title, goal, capability, dependencies: [...dependencies], status: 'pending', assignedAgent, result: undefined, attempts: 0, kind, artifact_type: resolvedType, expected_outcome: outcome, acceptance: [...acceptance], outputs: [...outputs], sourceWorkItemId, acceptanceIds: [...acceptanceIds], estimatedComplexity, recommendedRole, dependsOn: dependsOn ? [...dependsOn] : [...dependencies], planningRef, likelyFiles: [...likelyFiles], parentTaskId, rootTaskId, continuationIndex, sourceTaskId, splitDepth, remainingWorkId, sourceProgressReport, remainingWorkIds: [...remainingWorkIds], remainingWork: structuredClone(remainingWork), inheritedArtifacts: structuredClone(inheritedArtifacts), inheritedEvidence: structuredClone(inheritedEvidence), workspaceStateReference, handoff: handoff ? structuredClone(handoff) : undefined, progress: progress ? structuredClone(progress) : undefined, continuationContext: continuationContext ? structuredClone(continuationContext) : undefined, budget: budget ? structuredClone(budget) : undefined, extensionOf, budgetExtensionIndex, lastFailureSignature, executionRoute: executionRoute ? structuredClone(executionRoute) : undefined,
    routeHistory: structuredClone(routeHistory), escalationCount, lastEscalationReason, failureHistory: structuredClone(failureHistory),
    routeLock: routeLock ? structuredClone(routeLock) : undefined,
    sourceFindingIds: [...sourceFindingIds], sourceReviewTaskId, affectedAcceptanceIds: [...affectedAcceptanceIds], affectedFiles: [...affectedFiles],
    repairScope: repairScope ? structuredClone(repairScope) : undefined, repairIndex, sourceImplementationRole,
    origin, feedback: [], decisions: [] };
}

/** In-memory store for one process. Persistent runs use createPersistentTaskStore in store.mjs. */
export function createMemoryTaskStore() {
  const tasks = new Map();
  return {
    add(task) {
      if (tasks.has(task.id)) throw new Error(`task: duplicate id "${task.id}"`);
      tasks.set(task.id, task);
      return task;
    },
    get: id => tasks.get(id),
    has: id => tasks.has(id),
    list: () => [...tasks.values()],
    size: () => tasks.size,
    update(id, patch) {
      const t = tasks.get(id);
      if (!t) throw new Error(`task: unknown id "${id}"`);
      if (patch.status && !TASK_STATUSES.includes(patch.status)) throw new Error(`task: invalid status "${patch.status}"`);
      Object.assign(t, patch);
      return t;
    },
    snapshot: () => structuredClone([...tasks.values()]),
  };
}

export const createTaskStore = createMemoryTaskStore;

/** Pending tasks whose dependencies are all completed, in insertion order. */
export function runnableTasks(store) {
  return store.list().filter(t => t.status === 'pending' && t.dependencies.every(d => store.get(d)?.status === 'completed'));
}

/** Pending tasks that can never run because a dependency ended failed, blocked, or waiting on the user. */
export function strandedTasks(store) {
  return store.list().filter(t => t.status === 'pending' && t.dependencies.some(d => {
    const dep = store.get(d);
    return !dep || DEPENDENCY_STOP.has(dep.status);
  }));
}

export const isTerminal = t => TERMINAL.has(t.status);

/** Returns the ids forming a cycle, or null. */
export function findCycle(tasks) {
  const byId = new Map(tasks.map(t => [t.id, t]));
  const state = new Map();
  const stack = [];
  const visit = id => {
    if (state.get(id) === 2) return null;
    if (state.get(id) === 1) return stack.slice(stack.indexOf(id)).concat(id);
    state.set(id, 1); stack.push(id);
    for (const d of byId.get(id)?.dependencies ?? []) { const c = byId.has(d) ? visit(d) : null; if (c) return c; }
    stack.pop(); state.set(id, 2);
    return null;
  };
  for (const t of tasks) { const c = visit(t.id); if (c) return c; }
  return null;
}

/** No-op external project store. A future tracker (Asana) plugs in here; it is not the run store. */
export function createNullProjectStore() {
  return { name: 'none', async onPlan() {}, async onTaskUpdate() {}, async onFinal() {} };
}
