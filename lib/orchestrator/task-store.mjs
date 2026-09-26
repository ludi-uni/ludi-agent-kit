// Run-local task graph. The TaskStore holds orchestration state for one run only; an ExternalProjectStore
// (e.g. a future Asana adapter) receives lifecycle notifications and is never required for execution.
export const TASK_STATUSES = ['pending', 'running', 'completed', 'failed', 'blocked', 'waiting_for_user'];
const TERMINAL = new Set(['completed', 'failed', 'blocked']);
const DEPENDENCY_STOP = new Set(['failed', 'blocked', 'waiting_for_user']);

/**
 * @typedef {{ id: string, title: string, goal: string, capability: string, dependencies: string[],
 *   status: 'pending'|'running'|'completed'|'failed'|'blocked', assignedAgent?: string, result?: unknown,
 *   attempts: number, kind?: string, acceptance: string[], outputs: string[], origin?: string,
 *   feedback?: string[], decisions?: object[], blockedReason?: string }} OrchestratedTask
 */
export function newTask({ id, title, goal, capability, dependencies = [], assignedAgent, acceptance = [], outputs = [], kind, origin = 'plan' }) {
  if (!id || !title || !goal) throw new Error('task: id, title and goal are required');
  return { id, title, goal, capability, dependencies: [...dependencies], status: 'pending', assignedAgent, result: undefined, attempts: 0, kind, acceptance: [...acceptance], outputs: [...outputs], origin, feedback: [], decisions: [] };
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
