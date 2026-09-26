#!/usr/bin/env node
// Validate the whole kit: routing, agents, MCP catalog, Context Pack examples, skills, adapter model maps.
// Read-only. Exit code 1 on any error. Used by tests and by adapter sync scripts.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRouting } from '../lib/routing.mjs';
import { loadAgents } from '../lib/agents.mjs';
import { loadContextPack } from '../lib/context-pack.mjs';
import { loadPolicy } from '../lib/orchestrator/policy.mjs';

export function validateKit(kit) {
  const errors = [];
  const summary = {};
  let routing = null;

  try { routing = loadRouting(join(kit, 'routing/routing.json')); summary.capabilities = Object.keys(routing.capabilities); summary.backends = Object.keys(routing.backends); }
  catch (e) { errors.push(e.message); }

  const { agents, errors: agentErrors } = loadAgents(join(kit, 'agents'), routing);
  errors.push(...agentErrors);
  summary.agents = agents.map(a => `${a.meta.name}->${a.meta.capability}`);

  const mcp = JSON.parse(readFileSync(join(kit, 'mcp/servers.json'), 'utf8'));
  if (mcp.version !== 1 || typeof mcp.servers !== 'object') errors.push('mcp: servers.json must have version 1 and servers object');
  for (const [name, s] of Object.entries(mcp.servers ?? {})) {
    if (typeof s.enabled !== 'boolean') errors.push(`mcp: ${name}.enabled must be boolean`);
    if (!['http', 'stdio'].includes(s.transport)) errors.push(`mcp: ${name}.transport must be http|stdio`);
    if (s.transport === 'http' && typeof s.url !== 'string') errors.push(`mcp: ${name}.url required for http`);
    if (s.transport === 'stdio' && typeof s.command !== 'string') errors.push(`mcp: ${name}.command required for stdio`);
    for (const k of ['token', 'apiKey', 'password', 'secret']) if (k in s) errors.push(`mcp: ${name}.${k} must not be stored in the catalog`);
  }
  summary.mcpServers = Object.keys(mcp.servers ?? {});

  const examples = join(kit, 'context-pack/examples');
  summary.contextPacks = [];
  for (const f of readdirSync(examples)) {
    try { loadContextPack(join(examples, f)); summary.contextPacks.push(f); } catch (e) { errors.push(`context-pack ${f}: ${e.message}`); }
  }

  try { loadPolicy(join(kit, 'orchestration/decision-policy.json')); summary.decisionPolicy = 'orchestration/decision-policy.json'; }
  catch (e) { errors.push(e.message); }

  summary.skills = [];
  for (const d of readdirSync(join(kit, 'skills'), { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const skill = join(kit, 'skills', d.name, 'SKILL.md');
    if (!existsSync(skill)) { errors.push(`skill ${d.name}: SKILL.md missing`); continue; }
    const head = readFileSync(skill, 'utf8');
    if (!new RegExp(`^---\\r?\\nname: ${d.name}\\r?\\ndescription: [^\\r\\n]+\\r?\\n---`).test(head)) errors.push(`skill ${d.name}: invalid frontmatter`);
    summary.skills.push(d.name);
  }

  summary.adapters = [];
  for (const adapter of readdirSync(join(kit, 'adapters'))) {
    summary.adapters.push(adapter);
    const models = join(kit, 'adapters', adapter, 'models.json');
    if (!existsSync(models)) continue;
    const map = JSON.parse(readFileSync(models, 'utf8'));
    if (map.version !== 1 || typeof map.backends !== 'object') errors.push(`adapter ${adapter}: models.json must have version 1 and backends`);
    if (routing) for (const b of Object.keys(map.backends ?? {})) if (!(b in routing.backends)) errors.push(`adapter ${adapter}: models.json binds unknown backend "${b}"`);
  }
  return { result: errors.length ? 'FAIL' : 'PASS', summary, errors };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const report = validateKit(kit);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.errors.length ? 1 : 0;
}
