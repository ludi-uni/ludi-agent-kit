// Router adapter: task -> capability -> agent -> model, entirely through the existing
// agents/*.md capability binding, routing.json and the adapter model registry (lib/resolve.mjs).
import { resolveCapability } from '../resolve.mjs';

export const ORCHESTRATOR_AGENT = 'orchestrator';

/** Agents that may receive delegated work (the orchestrator never assigns work to itself). */
export function workerAgents(agents) {
  return agents.filter(a => a.meta.name !== ORCHESTRATOR_AGENT);
}

export function agentForCapability(agents, capability) {
  return workerAgents(agents).find(a => a.meta.capability === capability) ?? null;
}

/**
 * Fill in agent/capability for a task spec and check both against the kit.
 * An explicit agent keeps its role; an explicit capability overrides only the model route.
 */
export function routeTask(spec, { agents, routing }) {
  const byName = Object.fromEntries(workerAgents(agents).map(a => [a.meta.name, a]));
  let agent = spec.assignedAgent ?? spec.agent;
  let capability = spec.capability;
  if (agent === ORCHESTRATOR_AGENT) return { error: `task "${spec.id}": work cannot be assigned to the orchestrator itself` };
  if (agent && !byName[agent]) return { error: `task "${spec.id}": unknown agent "${agent}"` };
  if (!agent && capability) agent = agentForCapability(agents, capability)?.meta.name;
  if (!agent) return { error: `task "${spec.id}": no agent for capability "${capability}"` };
  capability = capability ?? byName[agent].meta.capability;
  if (!routing.capabilities[capability]) return { error: `task "${spec.id}": capability "${capability}" is not defined in routing` };
  return { agent, capability };
}

/** Concrete model chain for a task's capability (report shape from resolveCapability). */
export function resolveTaskModels(task, { routing, registry }) {
  return resolveCapability(routing, registry, task.capability);
}

/** Next capability after `capability` in any routing escalation ladder (e.g. cheap-code -> strong-code). */
export function nextLadderCapability(routing, capability) {
  for (const steps of Object.values(routing.escalation?.ladders ?? {})) {
    const i = steps.indexOf(capability);
    if (i >= 0 && i + 1 < steps.length) return steps[i + 1];
  }
  return null;
}
