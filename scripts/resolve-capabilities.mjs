#!/usr/bin/env node
// Resolve agents -> capabilities -> concrete pi models using models.json + models.local.json,
// and render the pi-subagents settings proposal to adapters/pi/out/. Read-only w.r.t. ~/.pi.
// Usage: node scripts/resolve-capabilities.mjs [--adapter pi] [--capability name] [--live-settings <path>]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { loadRouting } from '../lib/routing.mjs';
import { loadRegistry } from '../lib/registry.mjs';
import { loadAgents } from '../lib/agents.mjs';
import { resolveAgents, resolveCapability } from '../lib/resolve.mjs';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const adapter = opt('adapter', 'pi');
const adapterDir = join(kit, 'adapters', adapter);
const routing = loadRouting(join(kit, 'routing/routing.json'));
const { registry, sources } = loadRegistry(join(adapterDir, 'models.json'), join(adapterDir, 'models.local.json'), routing);
const { agents, errors } = loadAgents(join(kit, 'agents'), routing);
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }

const only = opt('capability', null);
const out = { registrySources: sources, agents: only ? undefined : resolveAgents(agents, routing, registry), capability: only ? resolveCapability(routing, registry, only) : undefined };

if (adapter === 'pi' && !only) {
  const { buildSettingsProposal } = await import('../adapters/pi/lib/settings-proposal.mjs');
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
  const livePath = opt('live-settings', join(agentDir, 'settings.json'));
  const live = existsSync(livePath) ? JSON.parse(readFileSync(livePath, 'utf8')) : null;
  const proposal = buildSettingsProposal(out.agents, { liveSettings: live });
  const outDir = join(adapterDir, 'out');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'settings.proposal.json'), JSON.stringify(proposal.proposal, null, 2) + '\n');
  writeFileSync(join(outDir, 'capabilities.resolved.json'), JSON.stringify(out, null, 2) + '\n');
  out.settingsProposal = { file: join(outDir, 'settings.proposal.json'), diffAgainst: live ? livePath : null, diff: proposal.diff, notes: proposal.notes, target: proposal.target };
}
console.log(JSON.stringify(out, null, 2));
