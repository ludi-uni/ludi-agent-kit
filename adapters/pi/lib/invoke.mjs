// pi backend invoker: one-shot `pi -p --model <provider/model[:thinking]> --no-tools --no-session --no-approve`.
// Verified against the installed pi CLI help (--print, --model with provider/id and :<thinking>, --no-tools,
// --system-prompt, --no-session, --no-approve). Output text is stdout. No credentials are handled here;
// pi's own auth store is used. Model ids come from the caller (registry), never from this file.
//
// On Windows `pi.cmd` is a shell wrapper; spawning it with shell:true mangles multi-line arguments, so we
// locate the package's JS entry next to pi.cmd (<npm dir>/node_modules/@earendil-works/pi-coding-agent) and
// run it with the current node binary without a shell.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, delimiter } from 'node:path';

export function locatePiEntry(env = process.env) {
  if (env.LUDI_PI_ENTRY && existsSync(env.LUDI_PI_ENTRY)) return env.LUDI_PI_ENTRY;
  const names = process.platform === 'win32' ? ['pi.cmd', 'pi'] : ['pi'];
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)) {
    for (const n of names) {
      if (!existsSync(join(dir, n))) continue;
      const pkgDir = join(dir, 'node_modules', '@earendil-works', 'pi-coding-agent');
      const pkgJson = join(pkgDir, 'package.json');
      if (!existsSync(pkgJson)) continue;
      const pkg = JSON.parse(readFileSync(pkgJson, 'utf8'));
      const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.pi;
      if (bin) return join(pkgDir, bin);
    }
  }
  return null;
}

export function createPiInvoker({ piEntry = locatePiEntry(), timeoutMs = 240000, env = process.env } = {}) {
  if (!piEntry) throw new Error('pi CLI entry not found on PATH; set LUDI_PI_ENTRY to <pi-coding-agent>/dist/... cli.js');
  return async function invoke({ modelId, systemPrompt, prompt, cwd }) {
    const args = [piEntry, '-p', '--model', modelId, '--no-tools', '--no-session', '--no-approve', '--system-prompt', systemPrompt, '--', prompt];
    const started = Date.now();
    const r = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: timeoutMs, windowsHide: true, env: { ...env, PI_SKIP_VERSION_CHECK: '1' }, maxBuffer: 16 * 1024 * 1024 });
    const durationMs = Date.now() - started;
    if (r.error) return { ok: false, error: r.error.message, durationMs };
    if (r.status !== 0) return { ok: false, error: `pi exited ${r.status}: ${(r.stderr || r.stdout || '').slice(-800)}`, durationMs };
    const text = (r.stdout ?? '').trim();
    if (!text) return { ok: false, error: 'empty model response', durationMs };
    return { ok: true, text, durationMs };
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
