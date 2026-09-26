// Adapter model registry: shared template, package-local migration file, then durable user bindings.
// Validates against routing backends. Contains no provider/model names.
import { readFileSync, existsSync } from 'node:fs';

const BINDING_KEYS = new Set(['provider', 'model', 'thinking', 'note', 'vision']);
const THINKING = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const SECRET_KEYS = /^(apiKey|api_key|token|secret|password|bearer|authorization)$/i;
const SECRET_VALUE = /(sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN)/;

export function validateRegistry(registry, routing, label = 'registry') {
  const errors = [];
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) return [`${label}: root must be an object`];
  for (const key of Object.keys(registry)) {
    if (!['version', 'backends', '$comment'].includes(key)) errors.push(`${label}: unknown top-level key "${key}"`);
  }
  if (registry.version !== 1) errors.push(`${label}: version must be 1`);
  if (!registry.backends || typeof registry.backends !== 'object' || Array.isArray(registry.backends)) {
    errors.push(`${label}: backends must be an object`);
    return errors;
  }
  for (const [backend, binding] of Object.entries(registry.backends)) {
    if (routing && !(backend in routing.backends)) errors.push(`${label}: backend "${backend}" is not defined in routing`);
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) { errors.push(`${label}: backend "${backend}" binding must be an object`); continue; }
    for (const key of Object.keys(binding)) {
      if (SECRET_KEYS.test(key)) errors.push(`${label}: backend "${backend}" must not store credentials ("${key}")`);
      else if (!BINDING_KEYS.has(key)) errors.push(`${label}: backend "${backend}" has unknown key "${key}"`);
      if (typeof binding[key] === 'string' && SECRET_VALUE.test(binding[key])) errors.push(`${label}: backend "${backend}".${key} looks like a credential`);
    }
    if (binding.provider !== undefined && (typeof binding.provider !== 'string' || !binding.provider.trim())) errors.push(`${label}: backend "${backend}".provider must be a non-empty string`);
    if (binding.model !== undefined && (typeof binding.model !== 'string' || !binding.model.trim())) errors.push(`${label}: backend "${backend}".model must be a non-empty string`);
    if (binding.thinking !== undefined && !THINKING.has(binding.thinking)) errors.push(`${label}: backend "${backend}".thinking must be one of ${[...THINKING].join('|')}`);
  }
  return errors;
}

/** Shallow-per-backend merge: local binding fields override template fields; local may add backends. */
export function mergeRegistries(base, local) {
  const out = { version: 1, backends: {} };
  for (const [b, v] of Object.entries(base?.backends ?? {})) out.backends[b] = { ...v };
  for (const [b, v] of Object.entries(local?.backends ?? {})) out.backends[b] = { ...(out.backends[b] ?? {}), ...v };
  return out;
}

export function isPlaceholder(binding) {
  return !binding || !binding.provider || !binding.model || /^TODO/i.test(binding.provider) || /^TODO/i.test(binding.model);
}

/**
 * Load the template, then optional package-local and user-level bindings (highest priority).
 * Throws on validation errors in any present file.
 */
export function loadRegistry(modelsPath, localPath, routing, userPath = null) {
  const base = JSON.parse(readFileSync(modelsPath, 'utf8'));
  const errors = validateRegistry(base, routing, 'models.json');
  let local = null;
  if (localPath && existsSync(localPath)) {
    local = JSON.parse(readFileSync(localPath, 'utf8'));
    errors.push(...validateRegistry(local, routing, 'models.local.json'));
  }
  let user = null;
  if (userPath && existsSync(userPath)) {
    user = JSON.parse(readFileSync(userPath, 'utf8'));
    errors.push(...validateRegistry(user, routing, userPath));
  }
  if (errors.length) throw new Error(errors.join('\n'));
  const merged = mergeRegistries(mergeRegistries(base, local), user);
  return { registry: merged, sources: { models: modelsPath, local: local ? localPath : null, user: user ? userPath : null } };
}
