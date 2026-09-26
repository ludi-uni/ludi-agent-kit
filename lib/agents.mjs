// Minimal agent definition loader: YAML-ish frontmatter (flat scalars + comma lists) + body.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { validateAccess, EXECUTION_MODES } from './orchestrator/permissions.mjs';
import { withLanguagePolicy } from './language-policy.mjs';

const NAME = /^[a-z][a-z0-9-]*$/;

function scalar(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?[0-9]+$/.test(value)) return Number(value);
  return value;
}

export function parseFrontmatter(text) {
  const m = text.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error('agent: missing frontmatter');
  const lines = m[1].split('\n');
  const meta = {};
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (/^\s/.test(raw)) throw new Error(`agent: unexpected indent "${raw.trim()}"`);
    const idx = raw.indexOf(':');
    if (idx < 0) throw new Error(`agent: invalid frontmatter line "${raw.trim()}"`);
    const key = raw.slice(0, idx).trim();
    const value = raw.slice(idx + 1).trim();
    if (value !== '') { meta[key] = scalar(value); continue; }
    const block = {};
    let nested = false;
    while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) {
      nested = true;
      const line = lines[++i].trim();
      if (!line || line.startsWith('#')) continue;
      const j = line.indexOf(':');
      if (j < 0) throw new Error(`agent: invalid frontmatter line "${line}"`);
      block[line.slice(0, j).trim()] = scalar(line.slice(j + 1).trim());
    }
    if (nested) meta[key] = block;
  }
  return { meta, body: m[2].trim() };
}

export function validateAgent(agent, routing) {
  const errors = [];
  const { meta } = agent;
  if (typeof meta.name !== 'string' || !NAME.test(meta.name)) errors.push('agent: name must be a lowercase identifier');
  if (typeof meta.description !== 'string' || !meta.description.trim()) errors.push(`agent ${meta.name}: description required`);
  if (typeof meta.capability !== 'string') errors.push(`agent ${meta.name}: capability required`);
  else if (routing && !(meta.capability in routing.capabilities)) errors.push(`agent ${meta.name}: capability "${meta.capability}" not defined in routing`);
  if ('model' in meta) errors.push(`agent ${meta.name}: must not pin a model; use capability`);
  if ('provider' in meta) errors.push(`agent ${meta.name}: must not pin a provider; use capability`);
  const execution = meta.execution?.preferred_mode ?? meta.execution;
  if (execution !== undefined && !EXECUTION_MODES.includes(execution)) errors.push(`agent ${meta.name}: execution must be oneshot|subagent|pipeline`);
  errors.push(...validateAccess(meta.access, meta.name));
  if (!agent.body) errors.push(`agent ${meta.name}: empty system prompt`);
  return errors;
}

export function loadAgents(dir, routing) {
  const agents = [];
  const errors = [];
  for (const file of readdirSync(dir).filter(f => f.endsWith('.md') && f !== 'README.md').sort()) {
    const agent = parseFrontmatter(readFileSync(join(dir, file), 'utf8'));
    agent.file = file;
    // Shared language policy (Japanese default) appended once here — not duplicated
    // into each agents/*.md. Provider-agnostic; schema keys/enums stay untranslated.
    agent.body = withLanguagePolicy(agent.body);
    // A locally disabled capability also disables its agents without changing
    // their shared definitions. Do not surface it as a validation error.
    if (routing && typeof agent.meta.capability === 'string' && !(agent.meta.capability in routing.capabilities)) continue;
    const errs = validateAgent(agent, routing);
    if (agent.meta.name !== file.replace(/\.md$/, '')) errs.push(`agent ${file}: name "${agent.meta.name}" must match filename`);
    errors.push(...errs);
    agents.push(agent);
  }
  return { agents, errors };
}
