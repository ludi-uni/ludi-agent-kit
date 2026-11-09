// Real npm artifact + installed Pi/pi-subagents public API. No model requests.
// Explicit operator-supplied read-only runtime paths; all writes stay in OS temp.
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, renameSync, symlinkSync, existsSync, cpSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { Transform } from 'node:stream';
import { isolatedEnv, syntheticSettings, RPC_ARGS, rpcProbe, validateState, validateStats } from '../adapters/pi/lib/startup-check.mjs';
import { diagnosePackage, retireLegacyLink, restoreLegacyLink } from '../adapters/pi/lib/package-install.mjs';
const opts = Object.fromEntries(process.argv.slice(2).map(a => { const m = /^--(pi-entry|subagents-dir)=(.+)$/.exec(a); if (!m) throw new Error('Use --pi-entry=<cli.js> --subagents-dir=<package root>'); return [m[1], resolve(m[2])]; }));
assert.ok(opts['pi-entry'] && opts['subagents-dir'], 'Explicit installed runtime paths required');
const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(join(tmpdir(), 'ludi npm 日本語 '));
let probes = 0;
try {
  const agentDir = join(root, 'custom agent'), work = join(root, 'work');
  for (const dir of [agentDir, work, join(root, 'tmp')]) mkdirSync(dir, { recursive: true });
  const customRole = join(agentDir, 'agents', 'my-custom-role.md');
  mkdirSync(dirname(customRole), { recursive: true });
  const customText = '---\nname: my-custom-role\ndescription: operator owned\ntools: read\nmodel: fixture/operator\n---\nCustom role must survive package install/update.\n';
  writeFileSync(customRole, customText);
  const env = isolatedEnv(process.env, { agentDir, root });
  env.LUDI_PACKAGE_TEST_ROOT = root;
  const npm = process.env.npm_execpath || join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  assert.ok(existsSync(npm), 'npm CLI required next to Node (or npm_execpath)');
  const runNpm = args => {
    const result = spawnSync(process.execPath, [npm, ...args], { cwd: kit, env, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr || String(result.error)); return result.stdout;
  };
  const packed = JSON.parse(runNpm(['pack', '--json', '--ignore-scripts', '--pack-destination', root]))[0];
  const tarball = join(root, packed.filename);
  assert.ok(packed.files.some(f => f.path === 'adapters/pi/generated/agent-profiles/coder.md'));
  for (const f of packed.files) assert.ok(!/(^|\/)(?:\.git|\.orchestration|out|node_modules|sessions|auth\.json)(?:\/|$)|models\.local\.json$/.test(f.path), f.path);
  const prefix = join(agentDir, 'npm');
  runNpm(['install', '--prefix', prefix, '--ignore-scripts', '--legacy-peer-deps', '--offline', '--no-audit', '--no-fund', tarball]);
  const installed = join(prefix, 'node_modules', '@ludi-uni', 'ludi-agent-kit');
  const digestTree = async dir => {
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256');
    for (const file of readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => join(e.parentPath, e.name)).sort()) hash.update(file.slice(dir.length)).update(readFileSync(file));
    return hash.digest('hex');
  };
  const initialDigest = await digestTree(installed);
  for (const file of packed.files.filter(f => /\.(?:mjs|js|json|md|ps1)$/.test(f.path))) {
    const text = readFileSync(join(installed, file.path), 'utf8');
    // Existing path-normalization tests intentionally use the synthetic user
    // 'someone'. Everything else must be independent of the build machine.
    const inspected = text.replaceAll('C:/Users/someone', '<fixture-user>').replaceAll('C:\\\\Users\\\\someone', '<fixture-user>');
    assert.ok(!/[CD]:[\\/]Users[\\/][^\s"']+|[CD]:[\\/]0_my_folder[\\/]/i.test(inspected), `Personal path in ${file.path}`);
  }
  // Move the entire artifact after generation: wrappers must not retain build paths.
  const moved = join(root, '移動 package'); renameSync(installed, moved);
  const settingsPath = join(agentDir, 'settings.json');
  const settings = { ...syntheticSettings(), packages: [moved, opts['subagents-dir']] };
  const probeFile = join(root, 'probe.mjs'), reportPath = join(root, 'probe.json');
  writeFileSync(probeFile, `import { writeFileSync } from 'node:fs';
import { resolveSubagentLaunchContract } from ${JSON.stringify(pathToFileURL(join(opts['subagents-dir'], 'bundle', 'preflight.js')).href)};
import { probeSubagents } from ${JSON.stringify(pathToFileURL(join(moved, 'adapters', 'pi', 'lib', 'package-install.mjs')).href)};
export default function(pi) { pi.on('session_start', async (_e, ctx) => {
  const subagentsLoaded = await probeSubagents(pi);
  const results = [];
  for (const agent of subagentsLoaded ? ['coder', 'tester', 'scout', 'reviewer', 'browser', 'visual', 'design-planner', 'orchestrator'] : []) {
    results.push({agent, result: await resolveSubagentLaunchContract({agent, cwd: ctx.cwd, task:'inspection only', context:'fresh', agentScope:'user', projectTrusted:false, availableModels:[], sessionRoot:${JSON.stringify(join(root, 'sessions'))}, intercomBridge:{mode:'off'}})});
  }
  writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify({subagentsLoaded, modelSelected:!!ctx.model, results}));
}); }
`);
  const probe = async ({ withSubagents = true } = {}) => {
    writeFileSync(settingsPath, JSON.stringify({ ...settings, packages: withSubagents ? settings.packages : [moved] }));
    const proc = spawn(process.execPath, [opts['pi-entry'], ...RPC_ARGS, '-e', probeFile], { cwd: work, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    // pi-subagents publishes passive Fleet status over RPC UI notifications.
    // Keep the kit's strict startup probe unchanged; only these UI-only records
    // are removed here, with an explicit method allowlist checked below.
    const notifications = []; let buffer = '';
    const stdout = new Transform({ decodeStrings: false, transform(chunk, _encoding, callback) {
      buffer += chunk;
      const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) {
        let record; try { record = JSON.parse(line); } catch { /* strict probe reports malformed input */ }
        if (record?.type === 'extension_ui_request') notifications.push(record);
        else this.push(line + '\n');
      }
      callback();
    }, flush(callback) { if (buffer) this.push(buffer); callback(); } });
    proc.stdout.setEncoding('utf8'); proc.stdout.pipe(stdout);
    const result = await rpcProbe({ stdout, stderr: proc.stderr, stdin: proc.stdin, on: proc.on.bind(proc), kill: proc.kill.bind(proc) }, { timeoutMs: 60000 });
    assert.ok(notifications.every(n => ['setStatus', 'setWidget', 'setTitle', 'notify'].includes(n.method)), JSON.stringify(notifications));
    assert.deepEqual(result.errors, []); assert.equal(result.exit.code, 0); assert.equal(result.stderr, '');
    assert.deepEqual(validateState(result.responses.get('get_state').data).errors, []);
    assert.deepEqual(validateStats(result.responses.get('get_session_stats').data).errors, []);
    const commands = result.responses.get('get_commands').data.commands;
    for (const name of ['orchestrate', 'ludi-doctor', 'skill:pi-workflow', 'skill:project-management', 'skill:visual-verification']) assert.equal(commands.filter(c => c.name === name).length, 1, name);
    probes++;
    const diagnostics = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(diagnostics.subagentsLoaded, withSubagents, 'actual public owner ping');
    // Pi can select a catalog default even without persisted model settings or
    // credentials. Selection is not readiness; the filesystem diagnosis and
    // zero-usage RPC checks remain independent.
    assert.equal(typeof diagnostics.modelSelected, 'boolean');
    assert.ok(diagnosePackage({ agentDir, projectDir: work }).findings.some(f => f.code === 'model-not-configured'));
    if (withSubagents) {
      const { results } = diagnostics;
      assert.equal(results.length, 8);
      for (const { agent, result: r } of results) {
        assert.equal(r.ok, true, `${agent}: ${JSON.stringify(r)}`);
        assert.equal(r.contract.agent.source, 'package', `${agent}: ${JSON.stringify(r.contract.agent)}`);
        assert.ok(r.contract.agent.filePath.startsWith(moved));
        assert.equal(r.contract.agent.shadowedCandidates.filter(c => c.source === 'package').length, 0, `${agent} duplicated`);
        if (['coder', 'tester'].includes(agent)) {
          assert.ok(r.contract.tools.effectiveAllowlist.includes('ludi_exec'));
          assert.ok(!r.contract.tools.effectiveAllowlist.includes('bash'));
          assert.ok(!r.contract.tools.effectiveAllowlist.includes('powershell'));
          assert.ok(r.contract.tools.configuredExtensions.some(p => p.includes(`${agent}-shell-gate.mjs`)));
        } else assert.ok(!r.contract.tools.effectiveAllowlist.includes('ludi_exec'));
      }
      if (settings.subagents) {
        assert.equal(results.find(r => r.agent === 'coder').result.contract.model, 'fixture/custom:off');
        assert.deepEqual(JSON.parse(readFileSync(settingsPath, 'utf8')).subagents, settings.subagents);
      }
    }
  };
  await probe(); // fresh package + dependency, unconfigured model
  const afterFresh = await digestTree(moved);
  assert.equal(afterFresh, initialDigest, 'startup must not write inside package');
  // Deterministic actual provider execution via the installed host loader.
  const hostRequire = createRequire(opts['pi-entry']);
  const { createJiti } = await import(pathToFileURL(hostRequire.resolve('jiti')).href);
  const jiti = createJiti(import.meta.url, { alias: { typebox: hostRequire.resolve('typebox') } });
  for (const role of ['coder', 'tester']) {
    const provider = await jiti.import(join(moved, 'adapters', 'pi', 'generated', 'agent-profiles', 'extensions', `${role}-shell-gate.mjs`));
    let tool; provider.default({ registerTool(value) { tool = value; } }); assert.equal(tool.name, 'ludi_exec');
    const allowed = await tool.execute('allow', { command: 'node --version' }, undefined, undefined, { cwd: work });
    assert.equal(allowed.isError, false, JSON.stringify(allowed));
    for (const command of ['npm publish', 'git push', 'git reset --hard', 'Remove-Item -Recurse -Force .']) {
      const blocked = await tool.execute('deny', { command }, undefined, undefined, { cwd: work });
      assert.equal(blocked.isError, true); assert.match(blocked.content[0].text, /^POLICY_BLOCK/);
    }
  }
  await probe({ withSubagents: false }); // safe load even without dependency
  const absent = diagnosePackage({ agentDir, projectDir: work });
  assert.ok(absent.findings.some(f => f.code === 'dependency-unverified'));
  // Simulate a pre-manifest release, then perform a real npm version upgrade.
  // This is a legacy fixture, not a claim about an older published tarball.
  const legacy = join(root, 'legacy source'); mkdirSync(legacy);
  cpSync(join(moved, 'agents'), join(legacy, 'agents'), { recursive: true });
  writeFileSync(join(legacy, 'package.json'), JSON.stringify({ name: '@ludi-uni/ludi-agent-kit', version: '0.3.0', type: 'module', files: ['agents/'] }));
  const oldPack = JSON.parse(runNpm(['pack', legacy, '--json', '--ignore-scripts', '--pack-destination', root]))[0];
  runNpm(['install', '--prefix', prefix, '--ignore-scripts', '--legacy-peer-deps', '--offline', '--no-audit', '--no-fund', join(root, oldPack.filename)]);
  assert.equal(JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version, '0.3.0');
  settings.subagents = { agentOverrides: { coder: { model: 'fixture/custom', thinking: 'off' } } };
  runNpm(['install', '--prefix', prefix, '--ignore-scripts', '--legacy-peer-deps', '--offline', '--no-audit', '--no-fund', tarball]);
  assert.equal(JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version, packed.version);
  rmSync(moved, { recursive: true }); renameSync(installed, moved);
  await probe(); assert.equal(await digestTree(moved), initialDigest);
  // Old raw npm/source agents junction -> explicit backed-up retirement -> restore.
  mkdirSync(join(agentDir, 'agents'), { recursive: true });
  const entry = 'agents/ludi-agent-kit', target = join(moved, 'agents');
  symlinkSync(target, join(agentDir, entry), 'junction');
  assert.ok(diagnosePackage({ agentDir, projectDir: work }).findings.some(f => f.code === 'role-shadows-package'));
  const migration = retireLegacyLink({ agentDir, entry, expectTarget: target, apply: true });
  await probe();
  restoreLegacyLink({ agentDir, backupId: migration.backupId, apply: true });
  assert.ok(existsSync(join(agentDir, entry)));
  assert.equal(readFileSync(customRole, 'utf8'), customText);
  console.log(JSON.stringify({ ok: true, tarball: packed.filename, files: packed.files.length, rpcProbes: probes, modelCalls: 0, cases: ['fresh', 'relocation', 'provider-allow-deny', 'dependency-absent', 'update', 'legacy-migration-restore', 'unicode-spaces', 'PI_CODING_AGENT_DIR', 'no-package-writes'] }, null, 2));
} finally { rmSync(root, { recursive: true, force: true }); }
