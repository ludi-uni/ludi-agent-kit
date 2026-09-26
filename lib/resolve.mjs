// agent -> capability -> routing backends -> registry binding -> concrete model candidates.
// Generic over adapters: the registry decides what "provider/model" means. No names hardcoded.
import { resolveBackends, degradedBackends } from './routing.mjs';
import { isPlaceholder } from './registry.mjs';

/** Format a binding as pi-style "provider/model[:thinking]" (pi CLI --model / pi-subagents model syntax). */
export function formatModelId(binding, { withThinking = true } = {}) {
  const id = `${binding.provider}/${binding.model}`;
  return withThinking && binding.thinking ? `${id}:${binding.thinking}` : id;
}

/** Ordered candidate chain for one capability. Placeholders/unbound backends are excluded but reported. */
export function resolveCapability(routing, registry, capability) {
  const chain = resolveBackends(routing, capability);
  const degraded = new Set(degradedBackends(routing, capability));
  const candidates = [], unbound = [], placeholder = [];
  for (const backend of chain) {
    const binding = registry.backends?.[backend];
    if (!binding) { unbound.push(backend); continue; }
    if (isPlaceholder(binding)) { placeholder.push(backend); continue; }
    candidates.push({ backend, provider: binding.provider, model: binding.model, thinking: binding.thinking, modelId: formatModelId(binding), degraded: degraded.has(backend) || undefined });
  }
  return { capability, chain, candidates, unbound, placeholder };
}

/** Resolve every agent (from lib/agents.mjs loadAgents) to its capability chain. */
export function resolveAgents(agents, routing, registry) {
  const out = {};
  for (const agent of agents) {
    const capability = agent.meta.capability;
    if (!(capability in routing.capabilities)) continue;
    out[agent.meta.name] = { agent: agent.meta.name, ...resolveCapability(routing, registry, capability) };
  }
  return out;
}
