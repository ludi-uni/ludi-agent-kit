import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, join } from 'node:path';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadRouting, mergeLocalRouting, validateRouting, resolveBackends, resolveModels } from '../lib/routing.mjs';
import { loadAgents } from '../lib/agents.mjs';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const base = () => ({
  version: 1,
  backends: { a: { tier: 'low' }, b: { tier: 'high', vision: true }, c: {} },
  capabilities: { x: { primary: 'a', fallback: ['b'] }, see: { primary: 'b', fallback: ['a'], requires: { vision: true } } },
});

test('shipped routing.json validates', () => {
  const r = loadRouting(resolve(kit, 'routing/routing.json'));
  for (const c of ['cheap-code', 'strong-code', 'vision-reasoning', 'deep-review', 'browser']) assert.ok(r.capabilities[c], c);
  for (const b of ['local', 'cheap', 'sol', 'astra', 'codex']) assert.ok(r.backends[b], b);
});

test('valid minimal config has no errors', () => assert.deepEqual(validateRouting(base()), []));

test('local routes override, add and disable capabilities without changing shared routing', () => {
  const config = base();
  config.escalation = { ladders: { code: ['x', 'see'] } };
  const effective = mergeLocalRouting(config, { version: 1, capabilities: {
    x: null,
    see: { primary: 'b', fallback: ['c'] },
    new: { primary: 'a', fallback: ['c'] },
  } });
  assert.equal(config.capabilities.x.primary, 'a');
  assert.equal(effective.capabilities.x, undefined);
  assert.deepEqual(effective.escalation.ladders.code, ['see']);
  assert.deepEqual(resolveBackends(effective, 'new'), ['a', 'c']);
  assert.deepEqual(resolveBackends(effective, 'see'), ['b', 'c']);
});

test('local routes reject broken references and malformed overrides', () => {
  assert.throws(() => mergeLocalRouting(base(), { version: 1, capabilities: { x: { primary: 'missing' } } }), /not a defined backend/);
  assert.throws(() => mergeLocalRouting(base(), { version: 1, capabilities: { x: { primary: 'a', fallback: ['a'] } } }), /repeats primary/);
  assert.throws(() => mergeLocalRouting(base(), { version: 1, capabilities: { ghost: null } }), /unknown capability/);
});

test('loadRouting applies local file and excludes agents for disabled capabilities', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kit-routing-'));
  try {
    mkdirSync(join(dir, 'routing'));
    writeFileSync(join(dir, 'routing', 'routing.json'), JSON.stringify(base()));
    writeFileSync(join(dir, 'routing', 'routing.local.json'), JSON.stringify({ version: 1, capabilities: { x: null } }));
    const routing = loadRouting(join(dir, 'routing', 'routing.json'));
    assert.equal(routing.capabilities.x, undefined);
    assert.deepEqual(routing.disabledCapabilities, ['x']);
    const { agents, errors } = loadAgents(join(kit, 'agents'), mergeLocalRouting(loadRouting(join(kit, 'routing', 'routing.json')), { version: 1, capabilities: { 'cheap-code': null } }));
    assert.deepEqual(errors, []);
    assert.ok(!agents.some(agent => agent.meta.capability === 'cheap-code'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unknown primary / fallback backends are rejected', () => {
  const c = base(); c.capabilities.x.primary = 'nope'; c.capabilities.x.fallback = ['zzz'];
  const errs = validateRouting(c);
  assert.ok(errs.some(e => e.includes('primary "nope"')));
  assert.ok(errs.some(e => e.includes('fallback "zzz"')));
});

test('fallback may not repeat primary or itself', () => {
  const c = base(); c.capabilities.x.fallback = ['a', 'b', 'b'];
  const errs = validateRouting(c);
  assert.ok(errs.some(e => e.includes('repeats primary')));
  assert.ok(errs.some(e => e.includes('repeats "b"')));
});

test('vision requirement is enforced on primary only', () => {
  const c = base(); c.capabilities.see.primary = 'a';
  assert.ok(validateRouting(c).some(e => e.includes('requires vision')));
  assert.deepEqual(validateRouting(base()), []);
});

test('version, names and tiers are checked', () => {
  const c = base(); c.version = 2; c.backends['Bad Name'] = {}; c.backends.a.tier = 'ultra';
  const errs = validateRouting(c);
  assert.ok(errs.some(e => e.includes('version')));
  assert.ok(errs.some(e => e.includes('invalid backend name')));
  assert.ok(errs.some(e => e.includes('invalid tier')));
});

test('escalation ladders must reference known capabilities', () => {
  const c = base(); c.escalation = { ladders: { l: ['x', 'ghost'] } };
  assert.ok(validateRouting(c).some(e => e.includes('unknown capability "ghost"')));
});

test('an agent with an undefined (typo\'d) capability surfaces a validation error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kit-agents-'));
  try {
    writeFileSync(join(dir, 'broken.md'), '---\nname: broken\ndescription: d\ncapability: strong-cdoe\n---\nbody');
    const routing = loadRouting(join(kit, 'routing', 'routing.json'));
    const { agents, errors } = loadAgents(dir, routing);
    assert.deepEqual(agents.map(agent => agent.meta.name), ['broken']);
    assert.ok(errors.some(e => e.includes('capability "strong-cdoe" not defined')), JSON.stringify(errors));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an agent whose capability is intentionally disabled is skipped without errors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kit-agents-'));
  try {
    writeFileSync(join(dir, 'worker.md'), '---\nname: worker\ndescription: d\ncapability: x\n---\nbody');
    const routing = mergeLocalRouting(base(), { version: 1, capabilities: { x: null } });
    const { agents, errors } = loadAgents(dir, routing);
    assert.deepEqual(agents, []);
    assert.deepEqual(errors, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('layered local routing keeps disable provenance and supports re-enable', () => {
  const once = mergeLocalRouting(base(), { version: 1, capabilities: { x: null } });
  assert.equal(once.capabilities.x, undefined);
  assert.deepEqual(once.disabledCapabilities, ['x']);
  // Re-disabling an already disabled capability stays idempotent, not an error.
  const again = mergeLocalRouting(once, { version: 1, capabilities: { x: null } });
  assert.deepEqual(again.disabledCapabilities, ['x']);
  // An object override on a later layer re-enables the capability.
  const reenabled = mergeLocalRouting(once, { version: 1, capabilities: { x: { primary: 'b' } } });
  assert.equal(reenabled.capabilities.x.primary, 'b');
  assert.equal(reenabled.disabledCapabilities, undefined);
  assert.deepEqual(resolveBackends(reenabled, 'x'), ['b']);
});

test('resolveBackends returns primary then fallbacks in order', () => {
  assert.deepEqual(resolveBackends(base(), 'x'), ['a', 'b']);
  assert.throws(() => resolveBackends(base(), 'nope'));
});

test('resolveModels binds through a model map and skips unbound backends; no provider names in code', () => {
  const map = { version: 1, backends: { b: { provider: 'p1', model: 'm1' } } };
  const r = resolveModels(base(), map, 'x');
  assert.deepEqual(r.candidates.map(c => c.backend), ['b']);
  assert.deepEqual(r.unbound, ['a']);
  const swapped = { version: 1, backends: { a: { provider: 'other', model: 'other-m' }, b: { provider: 'p1', model: 'm1' } } };
  assert.equal(resolveModels(base(), swapped, 'x').candidates[0].provider, 'other');
  const vis = resolveModels(base(), swapped, 'see');
  assert.equal(vis.candidates[1].degraded, true);
});
