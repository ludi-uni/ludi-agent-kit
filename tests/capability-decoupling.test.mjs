// Capability-decoupling contract: mechanism tests pin task capabilities
// explicitly, shipped defaults keep a small read-only integration surface, and
// the shipped agent definitions are never mutated by routing or cloning.
//
// The shipped contract remains in kit.test.mjs. Synthetic cheap/strong defaults
// below independently exercise both routes without editing the shipped files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRouting } from '../lib/routing.mjs';
import { loadAgents } from '../lib/agents.mjs';
import { resolveCapability } from '../lib/resolve.mjs';
import { routeTask } from '../lib/orchestrator/router.mjs';
import { agentsWithCapabilities } from './helpers/capability-fixtures.mjs';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const routing = loadRouting(join(kit, 'routing/routing.json'));
const { agents } = loadAgents(join(kit, 'agents'), routing);
const scout = () => agents.find(a => a.meta.name === 'scout');

test('shipped scout default drives routing only when no capability is pinned', () => {
  const shipped = scout().meta.capability;
  // The test contract is intentionally dual: kit.test.mjs pins the exact
  // shipped value; here we only require it to be a known routing capability.
  assert.ok(shipped in routing.capabilities, `shipped scout capability "${shipped}" must exist in routing`);

  const unpinned = routeTask({ id: 'x', agent: 'scout' }, { agents, routing });
  assert.equal(unpinned.agent, 'scout');
  assert.equal(unpinned.capability, shipped, 'unpinned scout task follows the shipped role default');

  // An explicit capability overrides the shipped default in BOTH directions.
  const other = shipped === 'cheap-code' ? 'strong-code' : 'cheap-code';
  const pinned = routeTask({ id: 'x', agent: 'scout', capability: other }, { agents, routing });
  assert.deepEqual(pinned, { agent: 'scout', capability: other });
  const same = routeTask({ id: 'x', agent: 'scout', capability: shipped }, { agents, routing });
  assert.deepEqual(same, { agent: 'scout', capability: shipped });

  // Routing did not mutate the loaded definitions.
  assert.equal(scout().meta.capability, shipped);
});

test('the clone helper pins a role without touching the shipped definitions or other roles', () => {
  const before = new Map(agents.map(a => [a.meta.name, a.meta.capability]));
  const other = scout().meta.capability === 'cheap-code' ? 'strong-code' : 'cheap-code';

  const cloned = agentsWithCapabilities(agents, { scout: other }, routing);
  assert.equal(cloned.find(a => a.meta.name === 'scout').meta.capability, other);
  // Changing nested fixture metadata must also leave the source untouched.
  const snapshot = structuredClone(agents);
  cloned.find(a => a.meta.name === 'scout').meta.access.shell = 'false';
  assert.deepEqual(agents, snapshot);
  // Source agents unchanged — the fixture is independent of the shipped file.
  for (const [name, cap] of before) {
    assert.equal(agents.find(a => a.meta.name === name).meta.capability, cap);
  }
  // Unrelated roles keep their shipped capability — no blanket override.
  for (const a of cloned) if (a.meta.name !== 'scout') assert.equal(a.meta.capability, before.get(a.meta.name));

  // The shipped loader output is still the authoritative source afterwards.
  const fresh = loadAgents(join(kit, 'agents'), routing).agents;
  assert.equal(fresh.find(a => a.meta.name === 'scout').meta.capability, before.get('scout'));
});

test('the clone helper fails loudly on unknown roles or capabilities', () => {
  assert.throws(() => agentsWithCapabilities(agents, { ghost: 'cheap-code' }, routing), /unknown agent role "ghost"/);
  for (const capability of ['made-up-cap', 'toString', 'constructor']) {
    assert.throws(() => agentsWithCapabilities(agents, { scout: capability }, routing), /not defined in routing/);
  }
});

test('explicit and implicit routes resolve correctly under both scout defaults', () => {
  const snapshot = structuredClone(agents);
  const reg = { version: 1, backends: {
    devin: { provider: 'pd', model: 'md', thinking: 'high' },
    qoder: { provider: 'pq', model: 'mq', thinking: 'low' },
  } };
  const first = { 'cheap-code': 'pq/mq:low', 'strong-code': 'pd/md:high' };
  for (const defaultCapability of Object.keys(first)) {
    const fixture = agentsWithCapabilities(agents, { scout: defaultCapability }, routing);
    const context = { agents: fixture, routing };
    const implicit = routeTask({ id: 'implicit', agent: 'scout' }, context);
    assert.equal(implicit.capability, defaultCapability);
    assert.equal(resolveCapability(routing, reg, implicit.capability).candidates[0].modelId, first[defaultCapability]);
    for (const capability of Object.keys(first)) {
      const explicit = routeTask({ id: 'explicit', agent: 'scout', capability }, context);
      assert.deepEqual(explicit, { agent: 'scout', capability });
      assert.equal(resolveCapability(routing, reg, explicit.capability).candidates[0].modelId, first[capability]);
    }
  }
  assert.deepEqual(agents, snapshot, 'neither default nor explicit routes mutate the source agents');
});
