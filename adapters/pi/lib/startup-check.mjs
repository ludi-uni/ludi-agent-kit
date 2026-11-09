// Offline isolated pi startup/RPC registration check.
//
// Creates a temporary pi agent dir, populates it with `sync-pi.ps1 -Apply` (never
// -ApplySettings, never user config), boots the installed pi in offline RPC mode and
// verifies that the kit's extension command and skills actually register, that no
// model/agent activity or usage occurs, and that the isolated layout holds the
// expected kit links plus exactly one loop-guard extension entry.
//
// Boundaries: RPC `get_commands` does not expose the agent registry or per-extension
// hook counts. Agent definitions are therefore verified STRUCTURALLY (junction target
// + parsed content via the neutral loader), and loop-guard is verified as a unique
// installed extension entry — not as a runtime hook registration. The separate
// pi-subagents package is not installed or registered by this check.
//
// No model calls are made: only get_commands / get_state / get_session_stats are sent.
// The child receives a minimal environment — never API keys, proxies, auth files, or
// the parent's pi/session env. sync-pi also refreshes the kit's gitignored
// adapters/pi/out/ previews; no real user configuration is written.
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync,
  lstatSync, realpathSync, rmSync, unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { locatePiEntry } from './invoke.mjs';
import { loadAgents } from '../../../lib/agents.mjs';
import { loadRouting } from '../../../lib/routing.mjs';
import { accessOf } from '../../../lib/orchestrator/permissions.mjs';
import { SHELL_PROFILE_ROLES } from './agent-profiles.mjs';

export const EXPECTED_SKILLS = ['pi-workflow', 'project-management', 'visual-verification'];
export const EXPECTED_EXTENSIONS = {
  'ludi-agent-kit': 'adapters/pi/loop-guard',
  'ludi-orchestrator': 'adapters/pi/orchestrator-ext',
};
// Roles whose derived profile must carry `ludi_exec` plus a generated
// policy-explicit shell-gate provider. Only the parent-approved coder/tester
// workers are adapted; every other role keeps its source tools verbatim.
export const EXPECTED_SHELL_PROFILES = [...SHELL_PROFILE_ROLES].sort();
export const REQUESTS = [
  { id: 'ludi-startup-commands', type: 'get_commands' },
  { id: 'ludi-startup-state', type: 'get_state' },
  { id: 'ludi-startup-stats', type: 'get_session_stats' },
];

export const RPC_ARGS = [
  '--mode', 'rpc', '--no-session', '--no-tools', '--offline', '--no-mcp',
  '--no-approve', '--no-context-files', '--no-prompt-templates', '--no-themes',
];

// Records that indicate model/agent activity. The check sends no prompts, so any of
// these means unexpected work; the child is terminated and the check fails.
const ACTIVITY_RE = /^(agent_|message|tool_|turn_|bash_|compaction|summarization_|auto_|retry|model_|session_)/i;

const ENV_ALLOWLIST = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR',
  'COMSPEC', 'SYSTEMDRIVE', 'TEMP', 'TMP',
];

/** Minimal child environment: OS essentials + everything redirected into the temp root. Never copies credentials/proxies/parent pi env. */
export function isolatedEnv(env, { agentDir, root }) {
  const out = {};
  for (const key of ENV_ALLOWLIST) if (env[key]) out[key] = env[key];
  Object.assign(out, {
    HOME: root,
    USERPROFILE: root,
    APPDATA: join(root, 'appdata'),
    LOCALAPPDATA: join(root, 'localappdata'),
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_CACHE_HOME: join(root, 'cache'),
    TEMP: join(root, 'tmp'),
    TMP: join(root, 'tmp'),
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
    NO_COLOR: '1',
  });
  return out;
}

/** Synthetic settings for the isolated agent dir: enables skill commands, disables telemetry/analytics/packages. */
export function syntheticSettings() {
  return {
    enableSkillCommands: true,
    enableInstallTelemetry: false,
    enableAnalytics: false,
    defaultProjectTrust: 'never',
    packages: [],
  };
}

/** Strict CLI argument parser for `scripts/check-pi.mjs`. */
export function parseCheckArgs(argv) {
  const opts = { json: false, keepTemp: false, timeoutMs: 60000, help: false };
  for (const arg of argv) {
    if (arg === '--json') opts.json = true;
    else if (arg === '--keep-temp') opts.keepTemp = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg.startsWith('--timeout-ms=')) {
      const value = Number(arg.slice('--timeout-ms='.length));
      if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647) throw new Error(`usage: --timeout-ms には正の数を指定してください (got "${arg}")`);
      opts.timeoutMs = value;
    } else {
      throw new Error(`usage: 不明な引数 "${arg}" — 使い方: node scripts/check-pi.mjs [--json] [--keep-temp] [--timeout-ms=<ms>]`);
    }
  }
  return opts;
}

function samePath(a, b) {
  if (a == null || b == null) return false;
  const na = resolve(a), nb = resolve(b);
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

function pathWithin(path, dir) {
  if (path == null) return false;
  const np = resolve(path), nd = resolve(dir);
  const cmp = process.platform === 'win32' ? [np.toLowerCase(), nd.toLowerCase()] : [np, nd];
  return cmp[0] === cmp[1] || cmp[0].startsWith(cmp[1] + sep);
}

/** Link evidence for one expected junction entry. Returns a check record; never follows into the target for writes. */
function linkEntry(agentDir, rel, kitTarget) {
  const dest = join(agentDir, rel);
  if (!existsSync(dest) && !lstatExists(dest)) return { ok: false, rel, detail: 'missing' };
  const stat = lstatSync(dest);
  if (!stat.isSymbolicLink()) return { ok: false, rel, detail: 'not a junction/symlink' };
  let physical;
  try { physical = realpathSync(dest); } catch (e) { return { ok: false, rel, detail: `realpath failed: ${e.message}` }; }
  if (!samePath(physical, kitTarget)) return { ok: false, rel, detail: `target mismatch -> ${physical}` };
  return { ok: true, rel, target: physical };
}

function lstatExists(path) {
  try { lstatSync(path); return true; } catch { return false; }
}

/**
 * Structural validation of the populated temp agent dir against the kit.
 * Pure fs checks — no process spawn. Returns { checks: [...], errors: [...], evidence }.
 */
export function validateLayout(agentDir, kitRoot) {
  const checks = [];
  const errors = [];
  const evidence = { links: [], agents: [], extensions: [] };
  const add = (name, ok, detail) => {
    checks.push({ name, status: ok ? 'pass' : 'fail', message: detail });
    if (!ok) errors.push(`${name}: ${detail}`);
  };

  const push = (name, r) => {
    evidence.links.push(r);
    add(name, r.ok, r.ok ? `${r.rel} -> ${r.target}` : `${r.rel}: ${r.detail}`);
  };

  // Expected junction entries exactly as sync-pi.ps1 -Apply plans them.
  for (const skill of EXPECTED_SKILLS) {
    push(`link:skills/${skill}`, linkEntry(agentDir, join('skills', skill), join(kitRoot, 'skills', skill)));
  }
  // The agents junction must target the GENERATED pi-subagents profiles under
  // adapters/pi/out/agent-profiles — never the raw common agents dir. The raw
  // definitions intentionally lack the strict tools/provider contract pi-subagents
  // requires for gated shell access.
  const profilesDir = join(kitRoot, 'adapters', 'pi', 'out', 'agent-profiles');
  push('link:agents/ludi-agent-kit', linkEntry(agentDir, join('agents', 'ludi-agent-kit'), profilesDir));
  for (const [name, target] of Object.entries(EXPECTED_EXTENSIONS)) {
    push(`link:extensions/${name}`, linkEntry(agentDir, join('extensions', name), join(kitRoot, target)));
  }

  // AGENTS.md generated by -Apply.
  const agentsMd = join(agentDir, 'AGENTS.md');
  const agentsText = existsSync(agentsMd) ? readFileSync(agentsMd, 'utf8') : '';
  add('AGENTS.md', agentsText.startsWith('<!-- Generated by ludi-agent-kit'), agentsText ? 'generated file present' : 'missing or not generated');

  // Skill dirs resolve physically to kit skills with SKILL.md present.
  for (const skill of EXPECTED_SKILLS) {
    let ok = false, detail = '';
    try {
      const physical = realpathSync(join(agentDir, 'skills', skill));
      ok = samePath(physical, join(kitRoot, 'skills', skill)) && existsSync(join(physical, 'SKILL.md'));
      detail = ok ? physical : `physical target ${physical} lacks SKILL.md or mismatches kit`;
    } catch (e) { detail = e.message; }
    add(`skill:${skill}`, ok, detail);
  }

  // agents/ must contain only the ludi-agent-kit junction — nothing extra may be
  // discovered by a (separately installed) pi-subagents package.
  const agentsParent = join(agentDir, 'agents');
  const agentEntries = existsSync(agentsParent) ? readdirSync(agentsParent).sort() : [];
  add('agents:exclusive', agentEntries.length === 1 && agentEntries[0] === 'ludi-agent-kit',
    agentEntries.length ? `entries: ${agentEntries.join(', ')}` : 'agents dir missing');

  // Installed agent definitions: derived profiles carry the same roles and
  // bodies as the common agents. Only coder/tester have `tools` rewritten from
  // `access` (ludi_exec + provider); every other role passes its authored
  // frontmatter through verbatim. Structural comparison is meta-name/body plus
  // the derived contract, not byte equality with the source files.
  let routing = null;
  try { routing = loadRouting(join(kitRoot, 'routing', 'routing.json')); }
  catch (e) { add('agents:routing', false, e.message); }
  if (routing) {
    const kitAgents = loadAgents(join(kitRoot, 'agents'), routing);
    let installed = { agents: [], errors: ['unread'] };
    try { installed = loadAgents(join(agentsParent, 'ludi-agent-kit'), routing); }
    catch (e) { installed = { agents: [], errors: [e.message] }; }
    add('agents:kit-valid', kitAgents.errors.length === 0, kitAgents.errors.join('; ') || `${kitAgents.agents.length} definitions valid`);
    add('agents:installed-valid', installed.errors.length === 0, installed.errors.join('; ') || `${installed.agents.length} definitions valid`);
    const kitNames = kitAgents.agents.map(a => a.meta.name).sort();
    const instNames = installed.agents.map(a => a.meta.name).sort();
    evidence.agents = instNames;
    add('agents:set', JSON.stringify(kitNames) === JSON.stringify(instNames),
      JSON.stringify(kitNames) === JSON.stringify(instNames) ? `installed: ${instNames.join(', ')}` : `expected [${kitNames}] got [${instNames}]`);
    // Body equality: derived profiles must not inject adapter detail into prompts.
    const bodyMismatch = kitAgents.agents.filter(a => {
      const other = installed.agents.find(b => b.meta.name === a.meta.name);
      return !other || other.body !== a.body;
    }).map(a => a.meta.name);
    add('agents:content', bodyMismatch.length === 0,
      bodyMismatch.length ? `body differs: ${bodyMismatch.join(', ')}` : 'installed bodies match kit content');
    // Derived shell contract: only the approved coder/tester worker roles are
    // adapted. Their `tools` is rewritten to the access-derived allowlist
    // (gaining ludi_exec, never raw powershell/bash) and they get a generated
    // policy-explicit provider. Every other role must keep its source tools
    // and provider fields verbatim — the derivation adds no permissions to
    // them, so legacy powershell entries on e.g. browser are preserved, not
    // stripped or added to.
    for (const inst of installed.agents) {
      const role = inst.meta.name;
      const tools = String(inst.meta.tools ?? '').split(',').map(s => s.trim()).filter(Boolean);
      const src = kitAgents.agents.find(a => a.meta.name === role);
      if (!src) {
        add(`profile:${role}:source`, false, 'no matching source agent in kit');
        continue;
      }
      if (!EXPECTED_SHELL_PROFILES.includes(role)) {
        const srcTools = String(src.meta.tools ?? '').split(',').map(s => s.trim()).filter(Boolean);
        add(`profile:${role}:tools-verbatim`, JSON.stringify(tools) === JSON.stringify(srcTools),
          JSON.stringify(tools) === JSON.stringify(srcTools) ? `tools preserved: ${tools.join(',')}` : `derived tools [${tools.join(',')}] differ from source [${srcTools.join(',')}]`);
        add(`profile:${role}:no-provider`, inst.meta.subagentOnlyExtensions === src.meta.subagentOnlyExtensions,
          inst.meta.subagentOnlyExtensions === src.meta.subagentOnlyExtensions ? 'no provider added' : `unexpected provider ${inst.meta.subagentOnlyExtensions}`);
        continue;
      }
      // Permissions must be derived from the source definition, not the
      // installed profile: an installed file that lacks `access` would
      // otherwise be re-inferred from its rewritten tools and could hide a
      // missing ludi_exec/provider contract.
      const access = accessOf(src);
      if (access.shell === 'false') {
        const hasGate = tools.includes('ludi_exec') || inst.meta.subagentOnlyExtensions !== undefined;
        add(`profile:${role}:no-shell-provider`, !hasGate,
          hasGate ? `unexpected shell provider (tools=${tools.join(',')} ext=${inst.meta.subagentOnlyExtensions})` : 'no shell provider');
        continue;
      }
      add(`profile:${role}:ludi_exec`, tools.includes('ludi_exec'), `tools=${tools.join(',')}`);
      const ext = inst.meta.subagentOnlyExtensions;
      const extOk = typeof ext === 'string' && /^\.(?:\\|\/)extensions(?:\\|\/)/.test(ext);
      add(`profile:${role}:provider`, extOk, `subagentOnlyExtensions=${ext ?? '(absent)'}`);
      if (extOk) {
        const providerPath = join(agentsParent, 'ludi-agent-kit', ext.replace(/^\.(?:\\|\/)/, ''));
        let providerOk = false, providerDetail = '';
        try {
          const src = readFileSync(providerPath, 'utf8');
          providerOk = /createShellGate/.test(src) && new RegExp(`"agent":"${role}"`).test(src)
            && new RegExp(`"shell":"${access.shell}"`).test(src) && !/process\.env/.test(src);
          providerDetail = providerOk ? providerPath : 'provider file lacks createShellGate/role/shell config';
        } catch (e) { providerDetail = e.message; }
        add(`profile:${role}:provider-file`, providerOk, providerDetail);
      }
    }
    // The adapted roles never carry raw shell in their derived allowlist.
    const rawShell = installed.agents.filter(a =>
      EXPECTED_SHELL_PROFILES.includes(a.meta.name) &&
      String(a.meta.tools ?? '').split(',').map(s => s.trim()).some(t => t === 'powershell' || t === 'bash'))
      .map(a => a.meta.name);
    add('profiles:no-raw-shell', rawShell.length === 0,
      rawShell.length ? `raw shell in adapted allowlist: ${rawShell.join(', ')}` : 'no powershell/bash in adapted profiles');
  }

  // Extensions: exactly the two kit junctions; loop-guard resolves to exactly one
  // installed physical entry file. There is no public RPC inventory for hook
  // factories, so this is structural evidence, not a runtime registration proof.
  const extParent = join(agentDir, 'extensions');
  const extEntries = existsSync(extParent) ? readdirSync(extParent).sort() : [];
  const expectedExt = Object.keys(EXPECTED_EXTENSIONS).sort();
  add('extensions:set', JSON.stringify(extEntries) === JSON.stringify(expectedExt),
    extEntries.length ? `entries: ${extEntries.join(', ')}` : 'extensions dir missing');
  evidence.extensions = extEntries;
  let loopOk = false, loopDetail = '';
  try {
    const entry = join(extParent, 'ludi-agent-kit', 'index.js');
    if (!existsSync(entry)) { loopDetail = 'extensions/ludi-agent-kit/index.js missing'; }
    else {
      const physical = realpathSync(entry);
      const expected = realpathSync(join(kitRoot, EXPECTED_EXTENSIONS['ludi-agent-kit'], 'index.js'));
      loopOk = samePath(physical, expected);
      loopDetail = loopOk ? `single loop-guard entry: ${physical}` : `entry resolves to ${physical}, expected ${expected}`;
    }
  } catch (e) { loopDetail = e.message; }
  add('loop-guard:entry', loopOk, loopDetail);

  return { checks, errors, evidence };
}

/**
 * RPC conversation driver. Sends exactly the three inspection commands, drains stdout
 * as LF-delimited records (arbitrary chunk boundaries, optional CR, no Unicode
 * separator splitting), and returns the correlated responses plus process outcome.
 * Anything that is not a well-formed matching response is recorded and fails the
 * caller; activity-looking records terminate the child immediately.
 * spawnImpl must return a child with stdout/stderr/stdin streams and kill/on.
 */
export function rpcProbe(proc, { timeoutMs = 60000, maxStdoutBytes = 4 * 1024 * 1024, maxStderrBytes = 256 * 1024, killGraceMs = 3000 } = {}) {
  return new Promise(resolvePromise => {
    const responses = new Map();
    const unexpected = [];
    const errors = [];
    let stdoutBytes = 0, stderrBytes = 0, stderrText = '';
    let buffer = '', done = false, killed = false, timedOut = false, outputOverflow = false;
    let killTimer = null, reapTimer = null;
    let exit = { code: null, signal: null };
    let stdinClosed = false;

    const fail = msg => errors.push(msg);

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      clearTimeout(killTimer);
      clearTimeout(reapTimer);
      resolvePromise({
        responses, unexpected, errors, exit,
        stderr: stderrText, timedOut, outputOverflow, killed,
      });
    };

    const terminate = reason => {
      if (killed) return;
      killed = true;
      fail(reason);
      try { proc.kill('SIGTERM'); } catch { /* already gone */ }
      if (done) return;
      killTimer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* already gone */ }
        // Bound the wait even if close never arrives; never report an unobserved exit as clean.
        if (!done) reapTimer = setTimeout(finish, 500);
      }, killGraceMs);
    };

    const maybeClose = () => {
      if (done || killed) return;
      if (responses.size === REQUESTS.length && !stdinClosed) {
        stdinClosed = true;
        try { proc.stdin.end(); } catch (e) { fail(`stdin close failed: ${e.message}`); }
      }
    };

    const handleLine = line => {
      const text = line.endsWith('\r') ? line.slice(0, -1) : line;
      if (!text.trim()) return;
      let record;
      try { record = JSON.parse(text); }
      catch {
        unexpected.push({ reason: 'malformed-json', line: text.slice(0, 300) });
        fail('stdout に JSON として解析できないレコードがありました');
        return;
      }
      if (record && record.type === 'response' && typeof record.command === 'string' && typeof record.id === 'string') {
        const req = REQUESTS.find(r => r.id === record.id);
        if (!req) {
          unexpected.push({ reason: 'unknown-response-id', id: record.id });
          fail(`未知のレスポンス id "${record.id}" を受信しました`);
          return;
        }
        if (record.command !== req.type) {
          unexpected.push({ reason: 'command-mismatch', id: record.id, command: record.command });
          fail(`レスポンス id "${record.id}" の command "${record.command}" が要求 "${req.type}" と一致しません`);
          return;
        }
        if (responses.has(req.type)) {
          unexpected.push({ reason: 'duplicate-response', id: record.id });
          fail(`要求 "${req.type}" に対する重複レスポンスを受信しました`);
          return;
        }
        if (record.success !== true) {
          fail(`${req.type}: pi がエラーを返しました: ${record.error ?? 'unknown'}`);
        }
        responses.set(req.type, record);
        maybeClose();
        return;
      }
      if (record && ACTIVITY_RE.test(String(record.type ?? ''))) {
        unexpected.push({ reason: 'activity-record', type: record.type });
        terminate(`予期しないアクティビティレコード "${record.type}" を検出したため子プロセスを終了しました`);
        return;
      }
      unexpected.push({ reason: 'unexpected-record', type: record?.type ?? typeof record });
      fail(`予期しない stdout レコード (type=${record?.type ?? typeof record}) を受信しました`);
    };

    const deadline = setTimeout(() => {
      timedOut = true;
      terminate(`${timeoutMs}ms の制限時間を超過しました`);
    }, timeoutMs);

    // A child that exits early can make stdin writes emit EPIPE asynchronously;
    // that is already reported via the close handler, so swallow the stream error.
    proc.stdin.on?.('error', () => {});
    proc.stdout.setEncoding?.('utf8');
    proc.stderr.setEncoding?.('utf8');
    proc.stdout.on('data', chunk => {
      if (done) return;
      stdoutBytes += Buffer.byteLength(chunk, 'utf8');
      if (stdoutBytes > maxStdoutBytes) {
        outputOverflow = true;
        terminate(`stdout が上限 ${maxStdoutBytes} バイトを超えました`);
        return;
      }
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) handleLine(line);
    });
    proc.stderr.on('data', chunk => {
      if (done) return;
      stderrBytes += Buffer.byteLength(chunk, 'utf8');
      if (stderrBytes > maxStderrBytes) {
        outputOverflow = true;
        terminate(`stderr が上限 ${maxStderrBytes} バイトを超えました`);
        return;
      }
      stderrText += chunk;
    });
    proc.on('error', e => { fail(`pi プロセスの起動に失敗しました: ${e.message}`); finish(); });
    proc.on('close', (code, signal) => {
      exit = { code, signal };
      if (buffer.trim()) fail('stdout が LF 終端のない不完全な JSONL レコードで終了しました');
      if (responses.size < REQUESTS.length && !timedOut) {
        fail(`全応答 (${REQUESTS.length} 件) を受信する前に pi が終了しました (exit=${code ?? signal})`);
      }
      finish();
    });

    // Send the three inspection commands. Nothing else is ever written: no prompt,
    // steer, follow_up, bash or compact calls.
    try {
      for (const req of REQUESTS) proc.stdin.write(JSON.stringify({ id: req.id, type: req.type }) + '\n');
    } catch (e) {
      fail(`pi への要求送信に失敗しました: ${e.message}`);
      terminate('stdin への書き込みに失敗しました');
    }
  });
}

/** Validate data.commands against the kit: exactly one orchestrate extension command and the three skills, with correct source and physical targets. Extra builtins are ignored. */
export function validateCommands(commands, { agentDir, kitRoot }) {
  const checks = [];
  const errors = [];
  const evidence = [];
  const list = Array.isArray(commands) ? commands : [];

  const add = (name, ok, detail) => {
    checks.push({ name, status: ok ? 'pass' : 'fail', message: detail });
    if (!ok) errors.push(`${name}: ${detail}`);
  };

  const expected = [
    { name: 'orchestrate', source: 'extension', dir: join(agentDir, 'extensions', 'ludi-orchestrator'), kitFile: join(kitRoot, 'adapters', 'pi', 'orchestrator-ext', 'index.js') },
    ...EXPECTED_SKILLS.map(s => ({
      name: `skill:${s}`, source: 'skill',
      dir: join(agentDir, 'skills', s), kitFile: join(kitRoot, 'skills', s, 'SKILL.md'),
    })),
  ];

  for (const exp of expected) {
    const matches = list.filter(c => c?.name === exp.name);
    if (matches.length === 0) { add(`cmd:${exp.name}`, false, 'コマンド未登録'); evidence.push({ name: exp.name, present: false }); continue; }
    if (matches.length > 1) { add(`cmd:${exp.name}`, false, `重複登録 (${matches.length} 件)`); evidence.push({ name: exp.name, present: true, duplicates: matches.length }); continue; }
    const cmd = matches[0];
    const sourcePath = cmd.sourceInfo?.path;
    let physical = null;
    try { physical = sourcePath ? realpathSync(sourcePath) : null; } catch (e) { physical = `realpath-failed:${e.message}`; }
    const sourceOk = cmd.source === exp.source;
    const locatedOk = sourceOk && typeof sourcePath === 'string' && pathWithin(sourcePath, exp.dir);
    const physOk = locatedOk && typeof physical === 'string' && samePath(physical, exp.kitFile);
    evidence.push({ name: exp.name, present: true, source: cmd.source, sourcePath, physicalPath: physical });
    const detail = `source=${cmd.source} path=${sourcePath} physical=${physical}`;
    add(`cmd:${exp.name}`, sourceOk && locatedOk && physOk,
      sourceOk && locatedOk && physOk ? detail
        : !sourceOk ? `source "${cmd.source}" は "${exp.source}" ではありません (${detail})`
        : !locatedOk ? `登録パスが隔離ディレクトリ外です (${detail})`
        : `物理ターゲットがキットと一致しません (${detail})`);
  }
  return { checks, errors, evidence, commandNames: list.map(c => c?.name).filter(Boolean).sort() };
}

/** get_state must show an idle agent with no messages and no session file. */
export function validateState(data) {
  const checks = [];
  const errors = [];
  const add = (name, ok, detail) => {
    checks.push({ name, status: ok ? 'pass' : 'fail', message: detail });
    if (!ok) errors.push(`${name}: ${detail}`);
  };
  const d = data ?? {};
  add('state:streaming', d.isStreaming === false, `isStreaming=${d.isStreaming}`);
  add('state:compacting', d.isCompacting === false, `isCompacting=${d.isCompacting}`);
  add('state:messages', d.messageCount === 0 && d.pendingMessageCount === 0,
    `messageCount=${d.messageCount} pendingMessageCount=${d.pendingMessageCount}`);
  add('state:session-file', d.sessionFile === undefined || d.sessionFile === null,
    `sessionFile=${d.sessionFile ?? '(absent)'}`);
  return { checks, errors };
}

/** get_session_stats must show zero messages, tool use, tokens and cost. */
export function validateStats(data) {
  const checks = [];
  const errors = [];
  const add = (name, ok, detail) => {
    checks.push({ name, status: ok ? 'pass' : 'fail', message: detail });
    if (!ok) errors.push(`${name}: ${detail}`);
  };
  const d = data ?? {};
  const counts = ['userMessages', 'assistantMessages', 'toolCalls', 'toolResults', 'totalMessages'];
  const badCounts = counts.filter(k => d[k] !== 0);
  add('stats:counts', badCounts.length === 0, badCounts.length ? `非ゼロ: ${badCounts.map(k => `${k}=${d[k]}`).join(', ')}` : 'messages/tool use all zero');
  const tokens = d.tokens ?? {};
  const tokenKeys = [...new Set(['input', 'output', 'cacheRead', 'cacheWrite', 'total', ...Object.keys(tokens)])];
  const badTokens = tokenKeys.filter(k => tokens[k] !== 0);
  add('stats:tokens', badTokens.length === 0, badTokens.length ? `非ゼロトークン: ${badTokens.map(k => `${k}=${tokens[k]}`).join(', ')}` : 'all token counts zero');
  add('stats:cost', d.cost === 0, `cost=${d.cost}`);
  const ctxTokens = d.contextUsage?.tokens;
  add('stats:context-usage', ctxTokens === undefined || ctxTokens === null || ctxTokens === 0, `contextUsage.tokens=${ctxTokens ?? '(absent)'}`);
  return { checks, errors };
}

/** Remove only junction/symlink links under dir (never their targets), then the dir itself. */
export function removeIsolatedTree(root) {
  if (!lstatExists(root)) return;
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('隔離ルートが通常ディレクトリではないため削除を拒否しました');
  const links = [];
  const walk = dir => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      let st;
      try { st = lstatSync(p); } catch { continue; }
      if (st.isSymbolicLink()) { links.push(p); continue; }
      if (st.isDirectory()) walk(p);
    }
  };
  walk(root);
  for (const link of links) {
    try { unlinkSync(link); } catch { try { rmSync(link, { force: true }); } catch { /* best effort */ } }
  }
  rmSync(root, { recursive: true, force: true });
}

/**
 * Full offline startup check.
 * Options: kitRoot, piEntry (or located via LUDI_PI_ENTRY/PATH), env, platform,
 * timeoutMs, syncTimeoutMs, keepTemp, tmpRoot, spawnImpl, spawnSyncImpl.
 * Returns a JSON-safe report; never throws for expected failure modes.
 */
export async function runStartupCheck({
  kitRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'),
  piEntry = undefined,
  env = process.env,
  platform = process.platform,
  timeoutMs = 60000,
  syncTimeoutMs = 45000,
  killGraceMs = 3000,
  maxStdoutBytes = 4 * 1024 * 1024,
  maxStderrBytes = 256 * 1024,
  keepTemp = false,
  tmpRoot = undefined,
  spawnImpl = spawn,
  spawnSyncImpl = spawnSync,
  nodeBin = process.execPath,
} = {}) {
  const checks = [];
  const errors = [];
  const report = {
    ok: false,
    kind: 'pi-startup-check',
    platform,
    piEntry: null,
    paths: {},
    checks,
    errors,
    evidence: {},
    limitations: [
      'RPC get_commands はエージェントレジストリと拡張フックの登録数を公開しません。エージェント定義は隔離ディレクトリの構造（ジャンクション先とパース済み内容）で検証しており、pi-subagents の実行時登録は別パッケージのため対象外です。',
      'loop-guard は拡張エントリが物理的に一意に解決されることのみ検証します。フックが実際に 1 回だけ登録されたかどうかは公開 RPC からは観測できません。',
      'オフラインモードで検査用 RPC だけを送り、モデルへのプロンプトは送りません。unknown model でも認証なしで検証できます。オフライン設定は OS のネットワークサンドボックスではありません。',
      '一時領域に加え、sync-pi.ps1 がキット内の adapters/pi/out/（gitignored）のプレビューを更新します。実ユーザー設定は変更しません。',
    ],
    cleanup: { tempRootRemoved: false, kept: false },
  };
  const add = (name, ok, detail) => {
    checks.push({ name, status: ok ? 'pass' : 'fail', message: detail });
    if (!ok) errors.push(`${name}: ${detail}`);
  };

  if (platform !== 'win32') {
    add('platform', false, `このチェックはネイティブ Windows (Junction + pwsh) が必要です: platform=${platform}`);
    return report;
  }
  add('platform', true, 'win32');

  const syncScript = join(kitRoot, 'adapters', 'pi', 'sync-pi.ps1');
  if (!existsSync(syncScript)) { add('kit:sync-script', false, `sync-pi.ps1 が見つかりません: ${syncScript}`); return report; }
  add('kit:sync-script', true, syncScript);

  const entry = piEntry ?? locatePiEntry(env);
  if (!entry) {
    add('pi:entry', false, 'pi CLI が見つかりません。LUDI_PI_ENTRY または PATH 上の pi (npm/managed レイアウト) を設定してください');
    return report;
  }
  report.piEntry = entry;
  add('pi:entry', true, entry);

  // --- isolated temp root ---------------------------------------------------
  let root;
  try {
    if (tmpRoot !== undefined) {
      // Injection seam for tests: never adopt an existing nonempty/user directory.
      const st = lstatSync(tmpRoot);
      if (!st.isDirectory() || st.isSymbolicLink() || !pathWithin(tmpRoot, tmpdir())
        || samePath(tmpRoot, tmpdir()) || readdirSync(tmpRoot).length !== 0) {
        throw new Error('tmpRoot には OS temp 配下の空の通常ディレクトリだけを指定できます');
      }
    }
    root = tmpRoot ?? mkdtempSync(join(tmpdir(), 'ludi-check-pi-'));
  } catch (e) {
    add('temp:root', false, `一時ディレクトリの作成に失敗: ${e.message}`);
    return report;
  }
  const agentDir = join(root, 'agent');
  const workDir = join(root, 'work');
  report.paths = { tempRoot: root, agentDir, workDir };
  const cleanup = () => {
    if (report.cleanup.tempRootRemoved || report.cleanup.kept) return;
    if (keepTemp) { report.cleanup.kept = true; return; }
    try { removeIsolatedTree(root); report.cleanup.tempRootRemoved = true; }
    catch (e) {
      report.cleanup.error = e.message;
      if (!errors.includes(`cleanup: ${e.message}`)) add('cleanup', false, e.message);
      report.ok = false;
    }
  };
  try {
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });
    mkdirSync(join(root, 'tmp'), { recursive: true });
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify(syntheticSettings()));
    add('temp:prepare', true, root);
  } catch (e) {
    add('temp:prepare', false, e.message);
    cleanup();
    return report;
  }

  try {
  const childEnv = isolatedEnv(env, { agentDir, root });

  // --- populate via sync-pi.ps1 -Apply (never -ApplySettings / -BackupConflicts) ---
  let sync;
  try {
    sync = spawnSyncImpl('pwsh', ['-NoProfile', '-File', syncScript, '-AgentDir', agentDir, '-Apply'], {
      cwd: workDir, env: childEnv, encoding: 'utf8', timeout: syncTimeoutMs,
      windowsHide: true, maxBuffer: 4 * 1024 * 1024,
    });
  } catch (e) {
    add('sync:apply', false, `pwsh の起動に失敗: ${e.message}`);
    cleanup();
    return report;
  }
  if (sync?.error) {
    const code = sync.error.code === 'ENOENT' ? 'pwsh が見つかりません (PowerShell 7 が必要)' : sync.error.message;
    add('sync:apply', false, `sync-pi.ps1 を実行できません: ${code}`);
    cleanup();
    return report;
  }
  if (sync?.status !== 0 || sync?.signal) {
    const tail = String(sync?.stderr ?? sync?.stdout ?? '').trim().slice(-600);
    add('sync:apply', false, `sync-pi.ps1 が status=${sync?.status} signal=${sync?.signal ?? 'none'} で終了${tail ? `: ${tail}` : ''}`);
    cleanup();
    return report;
  }
  add('sync:apply', true, 'exit 0 (-Apply only; settings/auth/model ファイルは未変更の合成 settings.json)');

  // --- structural validation -------------------------------------------------
  const layout = validateLayout(agentDir, kitRoot);
  checks.push(...layout.checks);
  errors.push(...layout.errors);
  report.evidence.layout = layout.evidence;
  if (layout.errors.length) return report; // never load resources whose installation failed validation

  // --- offline RPC probe -----------------------------------------------------
  let proc;
  try {
    proc = spawnImpl(nodeBin, [entry, ...RPC_ARGS], {
      cwd: workDir, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
  } catch (e) {
    add('rpc:spawn', false, `pi プロセスの起動に失敗: ${e.message}`);
    cleanup();
    return report;
  }
  if (!proc || !proc.stdout || !proc.stdin || !proc.stderr) {
    try { proc?.kill?.('SIGKILL'); } catch { /* invalid injected child */ }
    add('rpc:spawn', false, 'spawn が有効な子プロセスを返しませんでした');
    cleanup();
    return report;
  }
  const probe = await rpcProbe(proc, { timeoutMs, maxStdoutBytes, maxStderrBytes, killGraceMs });
  report.evidence.rpc = {
    unexpected: probe.unexpected.map(u => { const { line, ...rest } = u; return rest; }),
    stderr: probe.stderr.slice(0, 2000),
    exit: probe.exit,
    timedOut: probe.timedOut,
    outputOverflow: probe.outputOverflow,
    killed: probe.killed,
  };
  errors.push(...probe.errors);
  for (const e of probe.errors) checks.push({ name: 'rpc:protocol', status: 'fail', message: e });
  if (!probe.errors.length) add('rpc:protocol', true, `${probe.responses.size} 件の応答を受信; 予期しないレコードなし`);

  if (!probe.exit || probe.exit.code !== 0) {
    add('rpc:exit', false, `pi がクリーンに終了しませんでした (exit=${probe.exit?.code} signal=${probe.exit?.signal ?? 'none'}${probe.killed ? ', killed' : ''})`);
  } else {
    add('rpc:exit', true, 'stdin クローズ後に exit 0');
  }
  if (probe.stderr.trim()) {
    add('rpc:stderr', false, `stderr に出力があります: ${probe.stderr.trim().slice(0, 400)}`);
  } else {
    add('rpc:stderr', true, 'stderr 空');
  }

  // --- registration + idle checks -------------------------------------------
  const cmdResp = probe.responses.get('get_commands');
  if (cmdResp) {
    const v = validateCommands(cmdResp.data?.commands, { agentDir, kitRoot });
    checks.push(...v.checks);
    errors.push(...v.errors);
    report.evidence.commands = v.evidence;
    report.evidence.allCommandNames = v.commandNames;
  } else if (!probe.errors.length) {
    add('cmd:get_commands', false, 'get_commands の応答がありません');
  }

  const stateResp = probe.responses.get('get_state');
  if (stateResp) {
    const v = validateState(stateResp.data);
    checks.push(...v.checks);
    errors.push(...v.errors);
    report.evidence.state = stateResp.data;
  } else if (!probe.errors.length) {
    add('state:response', false, 'get_state の応答がありません');
  }

  const statsResp = probe.responses.get('get_session_stats');
  if (statsResp) {
    const v = validateStats(statsResp.data);
    checks.push(...v.checks);
    errors.push(...v.errors);
    report.evidence.stats = statsResp.data;
  } else if (!probe.errors.length) {
    add('stats:response', false, 'get_session_stats の応答がありません');
  }

  report.ok = errors.length === 0;
  return report;
  } catch (e) {
    add('check:error', false, `検証中に例外が発生しました: ${e.message}`);
    report.ok = false;
    return report;
  } finally {
    cleanup();
  }
}
