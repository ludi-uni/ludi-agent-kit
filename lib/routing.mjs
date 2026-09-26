// Minimal routing config loader/validator. No provider or model names are hardcoded here;
// everything comes from routing.json (logical backends) and adapter model maps (concrete bindings).
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

const NAME = /^[a-z][a-z0-9-]*$/;
const TIERS = new Set(['free', 'low', 'mid', 'high']);

export function validateRouting(config) {
  const errors = [];
  const err = m => errors.push(m);
  if (!config || typeof config !== 'object' || Array.isArray(config)) return ['routing: root must be an object'];
  if (config.version !== 1) err('routing: version must be 1');
  const backends = config.backends;
  if (!backends || typeof backends !== 'object' || Object.keys(backends).length === 0) {
    err('routing: backends must be a non-empty object');
  } else {
    for (const [name, b] of Object.entries(backends)) {
      if (!NAME.test(name)) err(`routing: invalid backend name "${name}"`);
      if (!b || typeof b !== 'object') { err(`routing: backend "${name}" must be an object`); continue; }
      if (b.tier !== undefined && !TIERS.has(b.tier)) err(`routing: backend "${name}" has invalid tier "${b.tier}"`);
      if (b.vision !== undefined && typeof b.vision !== 'boolean') err(`routing: backend "${name}".vision must be boolean`);
    }
  }
  const caps = config.capabilities;
  if (!caps || typeof caps !== 'object' || Object.keys(caps).length === 0) {
    err('routing: capabilities must be a non-empty object');
  } else {
    for (const [name, c] of Object.entries(caps)) {
      if (!NAME.test(name)) err(`routing: invalid capability name "${name}"`);
      if (!c || typeof c !== 'object') { err(`routing: capability "${name}" must be an object`); continue; }
      if (typeof c.primary !== 'string') err(`routing: capability "${name}" requires string primary`);
      else if (backends && !(c.primary in backends)) err(`routing: capability "${name}" primary "${c.primary}" is not a defined backend`);
      const fallback = c.fallback ?? [];
      if (!Array.isArray(fallback)) err(`routing: capability "${name}".fallback must be an array`);
      else {
        const seen = new Set();
        for (const f of fallback) {
          if (typeof f !== 'string') { err(`routing: capability "${name}" fallback entries must be strings`); continue; }
          if (backends && !(f in backends)) err(`routing: capability "${name}" fallback "${f}" is not a defined backend`);
          if (f === c.primary) err(`routing: capability "${name}" fallback repeats primary "${f}"`);
          if (seen.has(f)) err(`routing: capability "${name}" fallback repeats "${f}"`);
          seen.add(f);
        }
      }
      // requires.vision is enforced on primary; fallbacks may be degraded (reported by resolveBackends).
      if (c.requires?.vision === true && backends && backends[c.primary] && backends[c.primary].vision !== true) {
        err(`routing: capability "${name}" requires vision but primary backend "${c.primary}" is not vision-capable`);
      }
    }
  }
  if (config.escalation?.ladders) {
    for (const [ladder, steps] of Object.entries(config.escalation.ladders)) {
      if (!Array.isArray(steps) || steps.length === 0) { err(`routing: ladder "${ladder}" must be a non-empty array`); continue; }
      for (const s of steps) if (caps && !(s in caps)) err(`routing: ladder "${ladder}" references unknown capability "${s}"`);
    }
  }
  return errors;
}

// Machine-local capability overrides: null disables a shared capability;
// an object overrides its route or adds a new capability. The shared file is
// never modified. Deleted capabilities are removed from escalation ladders
// in the effective view; agents referencing them are unavailable.
export function mergeLocalRouting(base, local) {
  if (!local || local.version !== 1 || !local.capabilities || typeof local.capabilities !== 'object' || Array.isArray(local.capabilities) ||
      Object.keys(local).some(k => !['version', 'capabilities', '$comment'].includes(k))) {
    throw new Error('routing.local.json: expected version 1 and capabilities object');
  }
  const config = { ...base, capabilities: { ...base.capabilities } };
  for (const [name, override] of Object.entries(local.capabilities)) {
    if (!NAME.test(name)) throw new Error(`routing.local.json: invalid capability name "${name}"`);
    if (override === null) {
      if (!(name in base.capabilities)) throw new Error(`routing.local.json: cannot delete unknown capability "${name}"`);
      delete config.capabilities[name];
      continue;
    }
    if (!override || typeof override !== 'object' || Array.isArray(override) ||
        Object.keys(override).some(k => !['primary', 'fallback', 'description'].includes(k))) {
      throw new Error(`routing.local.json: invalid capability override "${name}"`);
    }
    if (override.primary !== undefined && typeof override.primary !== 'string') throw new Error(`routing.local.json: capability "${name}" primary must be a string`);
    if (override.fallback !== undefined && (!Array.isArray(override.fallback) || override.fallback.some(value => typeof value !== 'string'))) throw new Error(`routing.local.json: capability "${name}" fallback must be an array of strings`);
    if (override.description !== undefined && typeof override.description !== 'string') throw new Error(`routing.local.json: capability "${name}" description must be a string`);
    config.capabilities[name] = { ...(base.capabilities[name] ?? {}), ...override };
  }
  if (base.escalation?.ladders) {
    const ladders = Object.fromEntries(Object.entries(base.escalation.ladders)
      .map(([name, steps]) => [name, steps.filter(step => step in config.capabilities)])
      .filter(([, steps]) => steps.length));
    config.escalation = { ...base.escalation, ladders };
  }
  const errors = validateRouting(config);
  if (errors.length) throw new Error(errors.join('\n'));
  return config;
}

export function loadRouting(path) {
  const config = JSON.parse(readFileSync(path, 'utf8'));
  const errors = validateRouting(config);
  if (errors.length) throw new Error(errors.join('\n'));
  const localPath = join(dirname(path), 'routing.local.json');
  return existsSync(localPath) ? mergeLocalRouting(config, JSON.parse(readFileSync(localPath, 'utf8'))) : config;
}

/** Ordered backend candidates for a capability: primary first, then fallbacks. */
export function resolveBackends(config, capability) {
  const cap = config.capabilities[capability];
  if (!cap) throw new Error(`routing: unknown capability "${capability}"`);
  return [cap.primary, ...(cap.fallback ?? [])];
}

/** Backends in the chain that do not satisfy the capability's `requires` (e.g. non-vision fallback). */
export function degradedBackends(config, capability) {
  const cap = config.capabilities[capability];
  if (!cap?.requires) return [];
  return resolveBackends(config, capability).filter(b => {
    const backend = config.backends[b] ?? {};
    return cap.requires.vision === true && backend.vision !== true;
  });
}

/**
 * Resolve a capability to concrete provider/model candidates using an adapter model map
 * of shape { backends: { <backend>: { provider, model, ... } } }. Backends without a
 * binding are skipped (reported in `unbound`), so a missing local model never breaks routing.
 */
export function resolveModels(config, modelMap, capability) {
  const bound = [], unbound = [];
  const degraded = degradedBackends(config, capability);
  for (const backend of resolveBackends(config, capability)) {
    const binding = modelMap?.backends?.[backend];
    if (binding && binding.provider && binding.model) bound.push({ backend, ...binding, degraded: degraded.includes(backend) || undefined });
    else unbound.push(backend);
  }
  return { capability, candidates: bound, unbound, degraded };
}
