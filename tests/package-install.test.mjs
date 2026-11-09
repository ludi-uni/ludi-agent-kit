import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOrchestrationContext } from '../lib/orchestrator/api.mjs';
import { diagnosePackage, piAgentDir, piRuntimePaths, retireLegacyLink, restoreLegacyLink, probeSubagents } from '../adapters/pi/lib/package-install.mjs';
const fixture = t => {
  const root = mkdtempSync(join(tmpdir(), 'ludi package 日本語 '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = join(root, 'custom agent'), kit = join(root, 'kit 旧');
  mkdirSync(agentDir); mkdirSync(join(kit, 'agents'), { recursive: true });
  writeFileSync(join(kit, 'package.json'), JSON.stringify({ name: '@ludi-uni/ludi-agent-kit' }));
  return { root, agentDir, kit };
};
test('package doctor is read-only and diagnoses absent dependency/model, duplicate sources, links and role shadowing', t => {
  const { root, agentDir, kit } = fixture(t);
  const settings = { packages: ['npm:@ludi-uni/ludi-agent-kit', kit], subagents: { agentOverrides: { coder: { model: 'mine', tools: 'read' } } } };
  const text = JSON.stringify(settings); writeFileSync(join(agentDir, 'settings.json'), text);
  mkdirSync(join(agentDir, 'agents'));
  writeFileSync(join(kit, 'agents', 'coder.md'), '---\nname: coder\ndescription: custom\n---\ncustom');
  symlinkSync(join(kit, 'agents'), join(agentDir, 'agents', 'ludi-agent-kit'), 'junction');
  mkdirSync(join(agentDir, 'extensions')); symlinkSync(join(kit, 'missing'), join(agentDir, 'extensions', 'ludi-agent-kit'), 'junction');
  const report = diagnosePackage({ agentDir, projectDir: root });
  for (const code of ['multiple-kit-sources', 'legacy-link', 'broken-link', 'role-shadows-package', 'dependency-unverified', 'model-not-configured', 'agent-overrides']) assert.ok(report.findings.some(f => f.code === code), code);
  assert.equal(readFileSync(join(agentDir, 'settings.json'), 'utf8'), text);
  assert.ok(!existsSync(join(agentDir, 'ludi-agent-kit')));
  assert.equal(piAgentDir({ PI_CODING_AGENT_DIR: agentDir }, root), agentDir);
});
test('legacy kit link migration and restore require apply and never overwrite custom roles/settings/targets', t => {
  const { root, agentDir, kit } = fixture(t);
  mkdirSync(join(agentDir, 'agents')); const entry = 'agents/ludi-agent-kit', target = join(kit, 'agents'), link = join(agentDir, entry);
  symlinkSync(target, link, 'junction'); writeFileSync(join(target, 'keep.md'), 'keep');
  const options = { agentDir, entry, expectTarget: target };
  assert.equal(retireLegacyLink(options).mode, 'dry-run'); assert.ok(lstatSync(link).isSymbolicLink());
  assert.throws(() => retireLegacyLink({ ...options, expectTarget: root, apply: true }), /target changed/);
  assert.throws(() => retireLegacyLink({ ...options, entry: 'agents/custom', apply: true }), /kit-owned/);
  const result = retireLegacyLink({ ...options, apply: true });
  assert.ok(!existsSync(link)); assert.equal(readFileSync(join(target, 'keep.md'), 'utf8'), 'keep');
  assert.equal(restoreLegacyLink({ agentDir, backupId: result.backupId }).mode, 'dry-run'); assert.ok(!existsSync(link));
  mkdirSync(link); assert.throws(() => restoreLegacyLink({ agentDir, backupId: result.backupId, apply: true }), /destination exists/);
  rmSync(link, { recursive: true });
  restoreLegacyLink({ agentDir, backupId: result.backupId, apply: true }); assert.ok(lstatSync(link).isSymbolicLink());
});
test('migration refuses custom directories, unverified ownership and linked parents', t => {
  const { root, agentDir, kit } = fixture(t);
  const target = join(kit, 'agents'); mkdirSync(join(agentDir, 'agents')); mkdirSync(join(agentDir, 'agents', 'ludi-agent-kit'));
  assert.throws(() => retireLegacyLink({ agentDir, entry: 'agents/ludi-agent-kit', expectTarget: target, apply: true }), /Only a junction/);
  rmSync(join(agentDir, 'agents'), { recursive: true });
  const external = join(root, 'external'); mkdirSync(external);
  mkdirSync(join(agentDir, 'agents')); symlinkSync(external, join(agentDir, 'agents', 'ludi-agent-kit'), 'junction');
  assert.throws(() => retireLegacyLink({ agentDir, entry: 'agents/ludi-agent-kit', expectTarget: external, apply: true }), /ownership cannot be verified/);
  assert.ok(lstatSync(join(agentDir, 'agents', 'ludi-agent-kit')).isSymbolicLink());
  rmSync(join(agentDir, 'agents'), { recursive: true });
  symlinkSync(external, join(agentDir, 'agents'), 'junction'); symlinkSync(target, join(external, 'ludi-agent-kit'), 'junction');
  assert.throws(() => retireLegacyLink({ agentDir, entry: 'agents/ludi-agent-kit', expectTarget: target, apply: true }), /parent refused/);
  assert.throws(() => restoreLegacyLink({ agentDir, backupId: '../evil', apply: true }), /Invalid backup/);
});
test('Pi runtime state follows PI_CODING_AGENT_DIR and refuses package paths including junction aliases', t => {
  const { root, agentDir, kit } = fixture(t);
  const paths = piRuntimePaths({ kitRoot: kit, env: { PI_CODING_AGENT_DIR: agentDir } });
  assert.equal(paths.storePath, join(agentDir, 'ludi-agent-kit', 'state.db'));
  assert.throws(() => piRuntimePaths({ kitRoot: kit, store: join(kit, 'state.db'), env: { PI_CODING_AGENT_DIR: agentDir } }), /inside the installed kit/);
  assert.throws(() => piRuntimePaths({ kitRoot: kit, env: { PI_CODING_AGENT_DIR: kit } }), /inside the installed kit/);
  const alias = join(root, 'alias'); symlinkSync(kit, alias, 'junction');
  assert.throws(() => piRuntimePaths({ kitRoot: kit, store: join(alias, 'state.db'), env: { PI_CODING_AGENT_DIR: agentDir } }), /inside the installed kit/);
});
for (const components of [['activity'], ['activity', 'clients']]) {
  test(`piRuntimePaths refuses ${components.join('/')} junctions into the package`, t => {
    const { agentDir, kit } = fixture(t);
    const link = join(agentDir, 'ludi-agent-kit', ...components);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(kit, link, 'junction');
    assert.throws(() => piRuntimePaths({ kitRoot: kit, env: { PI_CODING_AGENT_DIR: agentDir } }), /inside the installed kit/);
    assert.equal(existsSync(join(kit, 'clients')), false);
    assert.equal(existsSync(join(kit, 'pi-web-repro.json')), false);
  });
}
test('Pi context persists activity outside the package using adapter-selected paths', t => {
  const { agentDir } = fixture(t);
  const kitRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const paths = piRuntimePaths({ kitRoot, env: { PI_CODING_AGENT_DIR: agentDir } });
  const ctx = loadOrchestrationContext({ kit: kitRoot, ...paths, modelOptions: { env: { PI_CODING_AGENT_DIR: agentDir } }, clientContext: { kind: 'pi-web', sessionId: 'fixture' } });
  try {
    ctx.activity.bindRun({ runId: 'fixture', repoRoot: agentDir });
    assert.ok(existsSync(paths.storePath));
    assert.equal(ctx.activity.file, join(paths.activityDir, 'pi-web-fixture.json'));
    assert.equal(JSON.parse(readFileSync(ctx.activity.file, 'utf8')).runId, 'fixture');
  } finally { ctx.session.close(); }
});
test('public pi-subagents ping diagnoses presence/absence without registration or dispatch', async () => {
  const handlers = new Map(); const requests = [];
  const pi = { events: { on(event, fn) { handlers.set(event, fn); return () => handlers.delete(event); }, emit(event, request) {
    requests.push(event); handlers.get(`subagents:rpc:v1:reply:${request.requestId}`)?.({ success: true });
  } } };
  assert.equal(await probeSubagents(pi, 20), true); assert.equal(handlers.size, 0);
  assert.deepEqual(requests, ['subagents:rpc:v1:request']);
  pi.events.emit = () => {}; assert.equal(await probeSubagents(pi, 5), false); assert.equal(handlers.size, 0);
});
