// Thin wrapper around the `agent-browser` CLI. No LLM logic lives here:
// the caller (a pi agent) decides which command to run; this module only locates
// the binary, builds the argv, runs it with a timeout, and normalizes
// stdout/stderr/exit code. Every call carries an action `kind` so a future
// approval/policy layer can classify without re-parsing argv.
//
// Command construction is data-driven from COMMANDS below; nothing is shell-
// evaluated, so quoting is handled by spawnSync's argument vector (safe on
// Windows where we invoke the native .exe or `node bin/agent-browser.js`).
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, delimiter, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Action classification. Kept as data so a policy layer can consume it.
//   read-only   : no page state change
//   low-risk    : navigation / clicks that a user could trivially undo
//   write       : enters text or toggles control state
//   high-impact : submits a form, downloads, or otherwise commits an action
// ---------------------------------------------------------------------------
export const ACTION_KINDS = ['read-only', 'low-risk', 'write', 'high-impact'];

// name -> { kind, args: (params) => string[] }
// params are already validated scalars; selectors are either "@eN" refs or CSS.
export const COMMANDS = {
  open:       { kind: 'low-risk',    args: p => ['open', p.url] },
  navigate:   { kind: 'low-risk',    args: p => ['open', p.url] }, // alias of open <url>
  snapshot:   { kind: 'read-only',   args: p => ['snapshot', ...(p.interactive === false ? [] : ['-i']), ...(p.compact ? ['-c'] : []), ...(p.depth ? ['-d', String(p.depth)] : [])] },
  click:      { kind: 'low-risk',    args: p => ['click', p.ref] },
  fill:       { kind: 'write',       args: p => ['fill', p.ref, p.text] },
  type:       { kind: 'write',       args: p => ['type', p.ref, p.text] },
  press:      { kind: 'write',       args: p => ['press', p.key] },
  select:     { kind: 'write',       args: p => ['select', p.ref, p.value] },
  check:      { kind: 'write',       args: p => ['check', p.ref] },
  uncheck:    { kind: 'write',       args: p => ['uncheck', p.ref] },
  hover:      { kind: 'low-risk',    args: p => ['hover', p.ref] },
  scroll:     { kind: 'low-risk',    args: p => ['scroll', p.direction, ...(p.px ? [String(p.px)] : [])] },
  getText:    { kind: 'read-only',   args: p => ['get', 'text', p.ref] },
  getValue:   { kind: 'read-only',   args: p => ['get', 'value', p.ref] },
  getTitle:   { kind: 'read-only',   args: () => ['get', 'title'] },
  getUrl:     { kind: 'read-only',   args: () => ['get', 'url'] },
  isVisible:  { kind: 'read-only',   args: p => ['is', 'visible', p.ref] },
  isChecked:  { kind: 'read-only',   args: p => ['is', 'checked', p.ref] },
  wait:       { kind: 'read-only',   args: p => p.ms ? ['wait', String(p.ms)] : ['wait', p.ref] },
  screenshot: { kind: 'read-only',   args: p => ['screenshot', ...(p.path ? [p.path] : []), ...(p.annotate ? ['--annotate'] : []), ...(p.full ? ['--full'] : [])] },
  eval:       { kind: 'high-impact', args: p => ['eval', p.js] },
  submit:     { kind: 'high-impact', args: p => ['press', 'Enter'] }, // form submit via Enter on focused control
  close:      { kind: 'low-risk',    args: () => ['close'] },
};

export function classify(command) {
  return COMMANDS[command]?.kind ?? null;
}

/** Build the argv for a supported command. Throws on unknown command or missing params. */
export function buildArgs(command, params = {}) {
  const spec = COMMANDS[command];
  if (!spec) throw new Error(`browser: unknown command "${command}" (known: ${Object.keys(COMMANDS).join(', ')})`);
  return spec.args(params);
}

// ---------------------------------------------------------------------------
// Binary location. agent-browser ships a native exe per platform plus a JS
// launcher (bin/agent-browser.js). For `--session`-isolated, scriptable use we
// prefer the JS launcher through the current node binary so we never depend on
// shell shims; fall back to a bare `agent-browser`/`agent-browser.exe` on PATH.
// ---------------------------------------------------------------------------
export function locateAgentBrowser(env = process.env) {
  if (env.LUDI_AGENT_BROWSER_ENTRY && existsSync(env.LUDI_AGENT_BROWSER_ENTRY)) {
    return { kind: 'js', entry: env.LUDI_AGENT_BROWSER_ENTRY };
  }
  if (env.LUDI_AGENT_BROWSER_BIN && existsSync(env.LUDI_AGENT_BROWSER_BIN)) {
    return { kind: 'bin', entry: env.LUDI_AGENT_BROWSER_BIN };
  }
  const pathEnv = env.PATH ?? env.Path ?? '';
  for (const dir of pathEnv.split(delimiter).filter(Boolean)) {
    // npm global layout: <prefix>\agent-browser.cmd next to <prefix>\node_modules\agent-browser\
    const jsEntry = join(dir, 'node_modules', 'agent-browser', 'bin', 'agent-browser.js');
    if (existsSync(jsEntry)) return { kind: 'js', entry: jsEntry };
    for (const name of ['agent-browser.exe', 'agent-browser.cmd', 'agent-browser']) {
      const p = join(dir, name);
      if (existsSync(p)) return { kind: name.endsWith('.js') ? 'js' : 'bin', entry: p };
    }
  }
  return null;
}

/**
 * Run one agent-browser command.
 * @returns {Promise<{ok:boolean, command:string, kind:string, argv:string[], status:number|null,
 *            stdout:string, stderr:string, durationMs:number, error?:string}>}
 * Never rejects for a failed invocation; throws only for unknown commands / no binary.
 * stdout is truncated to `maxOutput` chars to bound context size.
 *
 * Implementation note: agent-browser launches a detached daemon that inherits
 * stdio. `spawnSync` waits for every pipe to close, so the daemon keeps the
 * call alive past the command's own exit. We therefore use async `spawn` and
 * resolve on the child 'exit' event (the CLI's own exit code), not on 'close'
 * (which waits for stdio). No shell is used, so quoting is exact on Windows.
 */
export function runBrowser(command, params = {}, { env = process.env, timeoutMs = 60000, maxOutput = 20000, session, json = false, extraArgs = [] } = {}) {
  const argv = buildArgs(command, params);
  const located = locateAgentBrowser(env);
  if (!located) throw new Error('agent-browser not found on PATH; install with `npm i -g agent-browser` or set LUDI_AGENT_BROWSER_ENTRY / LUDI_AGENT_BROWSER_BIN');

  const globalFlags = [];
  if (session) globalFlags.push('--session', session);
  if (json) globalFlags.push('--json');
  const fullArgs = [...globalFlags, ...argv, ...extraArgs];

  const spawnArgs = located.kind === 'js' ? [located.entry, ...fullArgs] : fullArgs;
  const cmd = located.kind === 'js' ? process.execPath : located.entry;

  return new Promise((resolvePromise) => {
    const started = Date.now();
    const child = spawn(cmd, spawnArgs, {
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Detach so the daemon's inherited handles don't keep our pipes alive.
      detached: true,
    });
    let stdout = '', stderr = '', settled = false;
    const finish = (status, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result = {
        ok: status === 0 && !error,
        command,
        kind: classify(command),
        argv: fullArgs,
        status,
        stdout: stdout.slice(0, maxOutput),
        stderr: stderr.slice(0, maxOutput),
        durationMs: Date.now() - started,
      };
      if (error) result.error = error;
      else if (status !== 0) result.error = `exit ${status}`;
      resolvePromise(result);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      finish(null, `timeout after ${timeoutMs}ms`);
    }, timeoutMs);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', e => finish(null, e.message));
    child.on('exit', (code) => finish(code));
  });
}

// ---------------------------------------------------------------------------
// CLI: node agent-browser.mjs <command> [key=value ...]
//   node agent-browser.mjs open url=file:///C:/fixture/index.html
//   node agent-browser.mjs snapshot
//   node agent-browser.mjs fill ref=@e3 text=hello
//   node agent-browser.mjs click ref=@e2
// Prints a single JSON result line (kind + argv + stdout) so the caller keeps
// the action classification without re-parsing.
// ---------------------------------------------------------------------------
async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const params = {};
  const opts = {};
  for (const a of rest) {
    const i = a.indexOf('=');
    if (i < 0) { opts[a.replace(/^--/, '')] = true; continue; }
    const k = a.slice(0, i), v = a.slice(i + 1);
    if (k.startsWith('--')) opts[k.slice(2)] = v; else params[k] = v;
  }
  if (!command || command === 'help') {
    console.log(`usage: node agent-browser.mjs <command> [k=v ...] [--session=id] [--json] [--timeout=ms]\ncommands: ${Object.keys(COMMANDS).join(', ')}`);
    process.exit(0);
  }
  try {
    const res = await runBrowser(command, params, {
      session: opts.session,
      json: Boolean(opts.json),
      timeoutMs: opts.timeout ? Number(opts.timeout) : undefined,
    });
    console.log(JSON.stringify(res, null, 2));
    process.exitCode = res.ok ? 0 : 1;
  } catch (e) {
    console.log(JSON.stringify({ ok: false, command, error: e.message }));
    process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
