// Read-only installation diagnostics and explicitly selected legacy-link retirement.
// Package declarations/models/custom files are user-owned and are never rewritten.
import { existsSync, readFileSync, readdirSync, lstatSync, realpathSync, readlinkSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join, relative, isAbsolute, sep } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { parseFrontmatter } from '../../../lib/agents.mjs';
export const KIT_PACKAGE = '@ludi-uni/ludi-agent-kit';
// Passive public ping only; never launches or registers an agent.
export function probeSubagents(pi, timeoutMs = 500) {
  return new Promise(resolveProbe => {
    const requestId = randomUUID();
    let timer;
    const finish = available => { clearTimeout(timer); unsubscribe(); resolveProbe(available); };
    const unsubscribe = pi.events.on(`subagents:rpc:v1:reply:${requestId}`, reply => finish(reply?.success === true));
    timer = setTimeout(() => finish(false), timeoutMs);
    pi.events.emit('subagents:rpc:v1:request', { version: 1, requestId, method: 'ping', params: {} });
  });
}
const LEGACY = ['agents/ludi-agent-kit', 'extensions/ludi-agent-kit', 'extensions/ludi-orchestrator', 'skills/pi-workflow', 'skills/project-management', 'skills/visual-verification'];
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const stat = path => { try { return lstatSync(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const same = (a, b) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
export function piAgentDir(env = process.env, home = homedir()) { return resolve(env.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent')); }
export function piStateDir(env = process.env, home = homedir()) { return join(piAgentDir(env, home), 'ludi-agent-kit'); }
export function piRuntimePaths({ kitRoot, store, env = process.env } = {}) {
  const stateDir = piStateDir(env);
  const storePath = resolve(store || env.LUDI_ORCHESTRATION_STORE || join(stateDir, 'state.db'));
  const activityDir = join(stateDir, 'activity', 'clients');
  const physical = path => {
    let parent = resolve(path), tail = [];
    while (!stat(parent)) { tail.unshift(parent.split(sep).at(-1)); parent = dirname(parent); }
    return resolve(realpathSync(parent), ...tail);
  };
  const kit = physical(kitRoot);
  for (const path of [stateDir, storePath, activityDir]) {
    const rel = relative(kit, physical(path));
    if (!rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))) throw new Error('Refusing runtime state inside the installed kit; select a path outside the package');
  }
  return { storePath, activityDir };
}
function packageOwner(path) {
  for (let p = resolve(path); ; p = dirname(p)) {
    try { if (json(join(p, 'package.json')).name === KIT_PACKAGE) return p; } catch { /* not a kit package */ }
    if (dirname(p) === p) return null;
  }
}
function sourceOf(entry) { return typeof entry === 'string' ? entry : entry?.source; }
function localSource(source, base) {
  if (typeof source !== 'string' || /^(?:npm:|git:|https?:)/.test(source)) return null;
  return resolve(base, source.startsWith('~/') ? join(homedir(), source.slice(2)) : source);
}
function kitSource(source, base) {
  const local = localSource(source, base);
  return typeof source === 'string' && (/^npm:@ludi-uni\/ludi-agent-kit(?:@[^\s]+)?$/.test(source) || !!local && same(packageOwner(local) ?? '', local));
}
function safeParents(root, path) {
  const rel = relative(root, path);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Path escapes agent directory');
  // Never perform migration/restore through a linked ancestor, even when the
  // selected leaf is kit-owned (e.g. an operator-owned agents junction).
  for (let p = dirname(path); ; p = dirname(p)) {
    const s = stat(p);
    if (s && (!s.isDirectory() || s.isSymbolicLink())) throw new Error(`Linked/non-directory parent refused: ${p}`);
    if (same(p, root)) break;
    if (dirname(p) === p) throw new Error('Agent directory is not an ancestor');
  }
}
export function diagnosePackage({ agentDir = piAgentDir(), projectDir = process.cwd() } = {}) {
  agentDir = resolve(agentDir); projectDir = resolve(projectDir);
  const findings = [], packages = [], roles = new Map(), seen = new Set();
  const add = (code, detail) => findings.push({ code, detail });
  const readSettings = (base, scope) => {
    let settings = {};
    try { settings = json(join(base, 'settings.json')); } catch (e) { if (e.code !== 'ENOENT') add('invalid-settings', scope); }
    for (const entry of settings.packages ?? []) {
      const source = sourceOf(entry);
      if (kitSource(source, base)) packages.push({ source, scope });
      else if (typeof source === 'string' && source.includes('ludi-agent-kit')) add('unresolved-kit-source', `${scope}: ${source}`);
      const local = localSource(source, base);
      if (local && !existsSync(local)) add('broken-package-source', `${scope}: ${source}`);
    }
    for (const kind of ['extensions', 'skills']) for (const value of settings[kind] ?? []) {
      if (typeof value === 'string' && value.includes('ludi')) add('explicit-resource', `${scope}.${kind}: ${value}`);
    }
    if (settings.subagents?.agentScanDirs?.length) add('extra-agent-scan-dirs', `${scope}: run /subagents-doctor to inspect additional scan roots`);
    if (settings.subagents?.agentExcludeDirs?.length) add('agent-exclusions', `${scope}: package roles may be excluded`);
    if (Object.keys(settings.subagents?.agentOverrides ?? {}).length) add('agent-overrides', `${scope}: preserved; local tool/model overrides can change package policy`);
    return settings;
  };
  const settings = readSettings(agentDir, 'user');
  readSettings(join(projectDir, '.pi'), 'project');
  if (packages.length === 0) add('package-not-configured', 'Install exactly one kit source with pi install');
  if (packages.length > 1) add('multiple-kit-sources', 'Equivalent npm identities may deduplicate; local/npm identities do not. Use pi list and explicitly remove the unwanted source');
  const subagents = join(agentDir, 'npm', 'node_modules', 'pi-subagents', 'package.json');
  let dependencyVersion = null;
  try { dependencyVersion = json(subagents).version; } catch { /* separately installed local/git packages need host confirmation */ }
  add(dependencyVersion ? 'dependency-on-disk' : 'dependency-unverified', dependencyVersion ? `pi-subagents ${dependencyVersion}; confirm loaded with /subagents-doctor` : 'pi-subagents is separate: pi install npm:pi-subagents; local/git installs require /subagents-doctor');
  if (!settings.defaultModel && !settings.subagents?.defaultModel) add('model-not-configured', 'Package roles do not pin models. Select a Pi model or subagents.defaultModel; no authentication/model call is performed');
  const walk = (path, scope, depth = 0) => {
    if (depth > 20) { add('scan-limit', path); return; }
    const s = stat(path); if (!s) return;
    if (s.isSymbolicLink()) {
      let target;
      try { target = realpathSync(path); } catch { add('broken-link', path); return; }
      add('legacy-link', `${path} -> ${target}`);
    }
    let physical; try { physical = realpathSync(path); } catch { return; }
    if (seen.has(physical)) return; seen.add(physical);
    if (lstatSync(physical).isDirectory()) {
      for (const name of readdirSync(path)) walk(join(path, name), scope, depth + 1);
    } else if (path.endsWith('.md') && !path.endsWith('.chain.md')) {
      try { const { meta } = parseFrontmatter(readFileSync(path, 'utf8')); if (meta.name) {
        const entries = roles.get(meta.name) ?? []; entries.push({ scope, path }); roles.set(meta.name, entries);
      } } catch { /* README/non-agent markdown */ }
    }
  };
  walk(join(agentDir, 'agents'), 'user'); walk(join(projectDir, '.agents'), 'legacy-project'); walk(join(projectDir, '.pi', 'agents'), 'project');
  for (const [name, entries] of roles) {
    if (entries.length > 1) add('role-collision', `${name}: ${entries.map(e => e.path).join(', ')}`);
    if (['browser', 'coder', 'design-planner', 'orchestrator', 'reviewer', 'scout', 'tester', 'visual'].includes(name)) add('role-shadows-package', `${name}: user/project definition wins; preserved`);
  }
  for (const entry of LEGACY.filter(e => !e.startsWith('agents/'))) {
    const path = join(agentDir, entry), s = stat(path);
    if (s?.isSymbolicLink()) add(existsSync(path) ? 'legacy-link' : 'broken-link', path);
  }
  return { mode: 'read-only', agentDir, projectDir, packages, dependencyVersion, findings };
}

// Only these named kit links can be retired. No guessed ownership for dangling
// targets: require an intact enclosing kit package.json, otherwise manual review.
export function retireLegacyLink({ agentDir = piAgentDir(), entry, expectTarget, apply = false } = {}) {
  agentDir = resolve(agentDir);
  if (!LEGACY.includes(entry)) throw new Error('Not a kit-owned legacy link slot');
  const path = join(agentDir, entry); safeParents(agentDir, path);
  if (!stat(path)?.isSymbolicLink()) throw new Error('Only a junction/symlink may be retired; custom files/directories are preserved');
  const rawTarget = readlinkSync(path);
  if (!isAbsolute(rawTarget)) throw new Error('Relative legacy links require manual review to preserve backup semantics');
  const target = resolve(rawTarget);
  if (!expectTarget || !same(target, expectTarget)) throw new Error('Link target changed or --expect-target does not match');
  if (!packageOwner(target)) throw new Error('Kit ownership cannot be verified; manual review required');
  const report = { mode: apply ? 'apply' : 'dry-run', entry, target };
  if (!apply) return report;
  const id = randomUUID(), backup = join(agentDir, 'ludi-agent-kit', 'migrations', id);
  safeParents(agentDir, join(backup, 'link'));
  mkdirSync(backup, { recursive: true });
  // Write recovery metadata before moving the link. A failed move leaves the
  // original untouched and the manifest cannot restore a nonexistent backup.
  writeFileSync(join(backup, 'manifest.json'), JSON.stringify({ version: 1, entry, target }), { flag: 'wx' });
  renameSync(path, join(backup, 'link'));
  return { ...report, backupId: id };
}
export function restoreLegacyLink({ agentDir = piAgentDir(), backupId, apply = false } = {}) {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(backupId ?? '')) throw new Error('Invalid backup ID');
  agentDir = resolve(agentDir);
  const backup = join(agentDir, 'ludi-agent-kit', 'migrations', backupId);
  safeParents(agentDir, join(backup, 'link'));
  const manifest = json(join(backup, 'manifest.json'));
  if (manifest.version !== 1 || !LEGACY.includes(manifest.entry)) throw new Error('Invalid backup manifest');
  const path = join(agentDir, manifest.entry); safeParents(agentDir, path);
  if (stat(path)) throw new Error('Restore destination exists; refusing to overwrite');
  const link = join(backup, 'link');
  if (!stat(link)?.isSymbolicLink() || !same(resolve(dirname(link), readlinkSync(link)), manifest.target)) throw new Error('Backup link changed or unavailable');
  if (apply) { mkdirSync(dirname(path), { recursive: true }); renameSync(link, path); }
  return { mode: apply ? 'apply' : 'dry-run', entry: manifest.entry, target: manifest.target };
}
