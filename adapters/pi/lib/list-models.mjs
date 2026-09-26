// Optional availability probe: `pi --list-models` output -> { models:Set<"p/m">, providers:Set<p> }.
// A provider absent from `providers` means "not listed / unknown" — never "its models are gone".
// Callers must tolerate null (pi missing, timeout, unparseable output) and fall back to
// catalog status only. Read-only; never contacts a model or writes anywhere.
import { spawnSync } from 'node:child_process';
import { locatePiEntry } from './invoke.mjs';

export function parseModelList(text) {
  const models = new Set(), providers = new Set();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    // Accept both "provider / model" and the `pi --list-models` table
    // (two leading whitespace-separated columns: provider, model).
    let m = line.trim().match(/^([A-Za-z0-9_-]+)\s*\/\s*(\S+)/);
    if (!m && cols.length >= 2 && cols[0] !== 'provider') m = [null, cols[0], cols[1]];
    if (m) { providers.add(m[1]); models.add(`${m[1]}/${m[2]}`); }
  }
  return { models, providers };
}

/** Returns { models, providers, source } or null when the listing cannot be obtained. */
export function fetchPiAvailability({ piEntry = locatePiEntry(), timeoutMs = 30000 } = {}) {
  if (!piEntry) return null;
  const r = spawnSync(process.execPath, [piEntry, '--list-models'], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, env: { ...process.env, PI_SKIP_VERSION_CHECK: '1' }, maxBuffer: 8 * 1024 * 1024 });
  if (r.error || r.status !== 0) return null;
  const parsed = parseModelList(r.stdout ?? '');
  if (!parsed.providers.size) return null;
  return { ...parsed, source: 'pi --list-models' };
}
