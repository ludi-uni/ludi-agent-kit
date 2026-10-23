// pi backend invoker: one-shot `pi -p --model <provider/model[:thinking]> --no-tools --no-session --no-approve`.
// Verified against the installed pi CLI help (--print, --model with provider/id and :<thinking>, --no-tools,
// --system-prompt, --no-session, --no-approve). Output text is stdout. No credentials are handled here;
// pi's own auth store is used. Model ids come from the caller (registry), never from this file.
//
// On Windows `pi.cmd` is a shell wrapper; spawning it with shell:true mangles multi-line arguments, so we
// locate the package's JS entry next to pi.cmd (<npm dir>/node_modules/@earendil-works/pi-coding-agent) and
// run it with the current node binary without a shell.
//
// The transport is async `spawn` (never spawnSync): a model call must not block the host event loop, so
// orchestrator parallel read-only rounds actually overlap. One invoke = one child process; the result
// resolves only after `close` (confirmed exit) or a bounded kill grace (reported as unconfirmedStop).
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, delimiter, sep } from 'node:path';

/** Resolve the `bin`/`bin.pi` script of an installed pi-coding-agent package to an existing file kept inside the package dir. */
function packageBinEntry(pkgDir) {
  const pkgJson = join(pkgDir, 'package.json');
  if (!existsSync(pkgJson)) return null;
  let pkg;
  try { pkg = JSON.parse(readFileSync(pkgJson, 'utf8')); } catch { return null; }
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) return null;
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.pi;
  if (typeof bin !== 'string' || !bin) return null;
  const root = resolve(pkgDir), entry = resolve(pkgDir, bin);
  if (!entry.startsWith(root + sep)) return null; // bin must stay within the package
  try { return statSync(entry).isFile() ? entry : null; } catch { return null; }
}

/** Managed layout: <bin dir>/../install/releases/<current-version>/node_modules/@earendil-works/pi-coding-agent (same contract as pi-launcher.js). */
function managedPiEntry(binDir) {
  try {
    const version = readFileSync(join(binDir, '..', 'install', 'current-version'), 'utf8').trim();
    if (!/^[0-9A-Za-z._+-]+$/.test(version) || version === '.' || version === '..') return null;
    return packageBinEntry(join(binDir, '..', 'install', 'releases', version, 'node_modules', '@earendil-works', 'pi-coding-agent'));
  } catch { return null; }
}

export function locatePiEntry(env = process.env) {
  if (env.LUDI_PI_ENTRY && existsSync(env.LUDI_PI_ENTRY)) return env.LUDI_PI_ENTRY;
  const names = process.platform === 'win32' ? ['pi.cmd', 'pi'] : ['pi'];
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)) {
    for (const n of names) {
      if (!existsSync(join(dir, n))) continue;
      const entry = packageBinEntry(join(dir, 'node_modules', '@earendil-works', 'pi-coding-agent')) // npm layout: pi next to node_modules
        ?? managedPiEntry(dir); // managed layout: <agent>/bin/pi -> <agent>/install/releases/...
      if (entry) return entry;
    }
  }
  return null;
}

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024; // former spawnSync maxBuffer, applied per stream
const DEFAULT_TIMEOUT_MS = 240000;
const KILL_GRACE_MS = 5000;

// Refuse malformed explicit bounds rather than silently widening a caller budget.
function timerBound(value, name) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 0x7fffffff) throw new RangeError(`${name} must be an integer between 1 and 2147483647`);
  return value;
}

export function createPiInvoker({ piEntry = locatePiEntry(), timeoutMs = DEFAULT_TIMEOUT_MS, env = process.env, spawnImpl = spawn, killGraceMs = KILL_GRACE_MS } = {}) {
  if (!piEntry) throw new Error('pi CLI entry not found on PATH; set LUDI_PI_ENTRY to <pi-coding-agent>/dist/... cli.js');
  const effectiveTimeoutMs = timerBound(timeoutMs, 'timeoutMs');
  const effectiveKillGraceMs = timerBound(killGraceMs, 'killGraceMs');
  return async function invoke({ modelId, systemPrompt, prompt, cwd, signal }) {
    // Caller cancellation is not a model failure: report abort before any spawn
    // so the escalation loop never advances to another candidate.
    if (signal?.aborted) return { ok: false, error: 'cancelled before model invocation', durationMs: 0, abort: true, failureClass: 'UNKNOWN' };
    // A full task brief plus a repository survey exceeds Windows' command-line
    // length limit. Pi expands @file arguments; keep the prompt out of argv.
    const dir = mkdtempSync(join(tmpdir(), 'ludi-invoke-'));
    try {
      const promptPath = join(dir, 'prompt.md');
      writeFileSync(promptPath, prompt ?? '');
      const args = [piEntry, '-p', '--model', modelId, '--no-tools', '--no-session', '--no-approve', '--system-prompt', systemPrompt, '--', `@${promptPath}`];
      const started = Date.now();
      const result = await new Promise(resolve => {
        let child;
        try {
          child = spawnImpl(process.execPath, args, { cwd, windowsHide: true, env: { ...env, PI_SKIP_VERSION_CHECK: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (error) {
          return resolve({ ok: false, error: error.message, durationMs: Date.now() - started });
        }
        const stdoutChunks = [], stderrChunks = [];
        let stdoutBytes = 0, stderrBytes = 0, overflow = false;
        let settled = false, closed = false, closeCode = null, closeSignal = null;
        let childError = null, timedOut = false, aborted = false, killSent = false;
        let timer = null, graceTimer = null;
        const subscriptions = [];
        const listen = (emitter, event, handler) => {
          if (!emitter?.on) return;
          subscriptions.push([emitter, event, handler]);
          emitter.on(event, handler);
        };
        const done = value => {
          if (settled) return;
          settled = true;
          clearTimeout(timer); clearTimeout(graceTimer);
          signal?.removeEventListener?.('abort', onAbort);
          for (const [emitter, event, handler] of subscriptions) emitter.removeListener(event, handler);
          resolve({ ...value, durationMs: Date.now() - started });
        };
        const stdout = () => Buffer.concat(stdoutChunks).toString('utf8');
        const stderr = () => Buffer.concat(stderrChunks).toString('utf8');
        const tail = () => (stderr() || stdout()).slice(-800);
        // Classification happens only once `close` has confirmed the child is
        // gone — never declare success or a retryable exit on a live process.
        const classify = () => {
          if (aborted || signal?.aborted) return done({ ok: false, error: 'cancelled by caller signal', abort: true, failureClass: 'UNKNOWN' });
          if (timedOut) return done({ ok: false, error: `pi timed out after ${effectiveTimeoutMs}ms${tail() ? `: ${tail()}` : ''}` });
          if (overflow) return done({ ok: false, error: `model output exceeded ${MAX_OUTPUT_BYTES} bytes${tail() ? `: ${tail()}` : ''}` });
          if (childError) return done({ ok: false, error: childError.message });
          if (closeSignal) return done({ ok: false, error: `pi terminated by signal ${closeSignal}${tail() ? `: ${tail()}` : ''}` });
          if (closeCode !== 0) return done({ ok: false, error: `pi exited ${closeCode}: ${tail()}` });
          const text = stdout().trim();
          if (!text) return done({ ok: false, error: 'empty model response' });
          return done({ ok: true, text });
        };
        // Kill only the child this invocation owns. A kill request is not proof
        // of exit. Escalate once, then keep waiting if termination cannot be
        // confirmed: consumers must not retry or remove the prompt prematurely.
        const kill = () => {
          if (settled || killSent || closed) return;
          killSent = true;
          try { child.kill('SIGTERM'); } catch { /* unconfirmed */ }
          if (closed || settled) return;
          graceTimer = setTimeout(() => {
            if (closed || settled) return;
            try { child.kill('SIGKILL'); } catch { /* still unconfirmed; wait for close */ }
          }, effectiveKillGraceMs);
        };
        const onAbort = () => { aborted = true; kill(); };
        listen(child.stdout, 'data', chunk => {
          if (closed || settled) return;
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
          stdoutBytes += buf.length;
          if (stdoutBytes <= MAX_OUTPUT_BYTES) stdoutChunks.push(buf);
          else if (!overflow) { overflow = true; kill(); }
        });
        listen(child.stderr, 'data', chunk => {
          if (closed || settled) return;
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
          stderrBytes += buf.length;
          if (stderrBytes <= MAX_OUTPUT_BYTES) stderrChunks.push(buf);
          else if (!overflow) { overflow = true; kill(); }
        });
        const streamError = error => { childError = childError ?? error; kill(); };
        listen(child.stdout, 'error', streamError);
        listen(child.stderr, 'error', streamError);
        listen(child, 'error', error => {
          childError = childError ?? error;
          if (closed) return classify();
          // No pid => the process was never spawned; do not wait for a close
          // that doubles may not emit. A live pid waits for real close.
          if (child.pid == null) { closed = true; classify(); }
          else kill();
        });
        listen(child, 'close', (code, sig) => { closed = true; closeCode = code; closeSignal = sig; classify(); });
        timer = setTimeout(() => { timedOut = true; kill(); }, effectiveTimeoutMs);
        if (signal) {
          signal.addEventListener?.('abort', onAbort, { once: true });
          if (signal.aborted) onAbort(); // dispatch race: aborted between pre-check and registration
        }
      });
      return result;
    } finally {
      // Only a confirmed close (or known spawn failure) permits cleanup.
      // An unresponsive owned process leaves the invocation pending, never retryable.
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/** Deterministic fake invoker for tests: `script[modelId]` is a string, Error, function, or list consumed per call. */
export function createScriptedInvoker(script, calls = []) {
  return async function invoke(req) {
    calls.push({ modelId: req.modelId, backend: req.backend, promptChars: req.prompt.length });
    const entry = script[req.modelId] ?? script['*'];
    if (!entry) return { ok: false, error: `no scripted response for ${req.modelId}`, durationMs: 0 };
    const item = typeof entry === 'function' ? entry(req) : Array.isArray(entry) ? (entry.length > 1 ? entry.shift() : entry[0]) : entry;
    if (item instanceof Error) return { ok: false, error: item.message, durationMs: 0 };
    return { ok: true, text: typeof item === 'string' ? item : item(req), durationMs: 0 };
  };
}
