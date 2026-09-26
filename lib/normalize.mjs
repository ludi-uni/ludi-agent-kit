// Normalize loosely-formed scout output into a Context Pack v1: parse -> normalize -> validate -> serialize.
// Path policy: relevant_files / snippet paths must be repo-relative. Absolute paths inside the repo are
// rewritten; absolute paths outside the repo are NOT silently rewritten — they are moved to
// `external_paths` in the returned report and dropped from relevant_files (constraints gains a note).
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { parseContextPackMarkdown, validateContextPack, toMarkdown, REQUIRED_FIELDS } from './context-pack.mjs';

const WIN_ABS = /^(?:[A-Za-z]:[\\/]|\\\\)/;
const ABS_PATH_IN_TEXT = /(?:[A-Za-z]:\\(?:[^\s:*?"<>|\\]+\\)*[^\s:*?"<>|\\]+|[A-Za-z]:\/(?:[^\s:*?"<>|/]+\/)*[^\s:*?"<>|/]+)/g;

export function toPosix(p) { return p.replace(/\\/g, '/'); }

/** Classify a path against repoRoot. Returns {kind:'relative'|'inside'|'outside', path}. */
export function classifyPath(p, repoRoot) {
  const raw = p.trim().replace(/^`|`$/g, '');
  if (!isAbsolute(raw) && !WIN_ABS.test(raw)) return { kind: 'relative', path: toPosix(raw).replace(/^\.\//, '') };
  const root = resolve(repoRoot);
  const abs = resolve(raw);
  const rel = relative(root, abs);
  if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) return { kind: 'inside', path: toPosix(rel) };
  return { kind: 'outside', path: toPosix(abs) };
}

/** Rewrite in-repo absolute paths inside free text (errors, attempts) to repo-relative; leave others. */
export function relativizeText(text, repoRoot) {
  const external = new Set();
  const out = text.replace(ABS_PATH_IN_TEXT, m => {
    const c = classifyPath(m, repoRoot);
    if (c.kind === 'inside') return c.path;
    if (c.kind === 'outside') external.add(c.path);
    return m;
  });
  return { text: out, external: [...external] };
}

function fillDefaults(pack, { task, capability, producedBy } = {}) {
  const p = { version: 1, ...pack };
  if (task && !p.task) p.task = task;
  if (!p.goal && p.task) p.goal = p.task;
  if (!Array.isArray(p.constraints)) p.constraints = [];
  if (!Array.isArray(p.relevant_files)) p.relevant_files = [];
  if (!p.expected_output) p.expected_output = 'A minimal diff limited to relevant_files plus the output of test_commands.';
  if (capability) p.capability = capability;
  if (producedBy) p.produced_by = producedBy;
  return p;
}

/**
 * Normalize a pack object (or scout markdown) for repoRoot.
 * Returns { pack, markdown, errors, report: { rewritten, external, dropped } }.
 */
export function normalizeContextPack(input, { repoRoot, task, capability, producedBy } = {}) {
  if (!repoRoot) throw new Error('normalize: repoRoot is required');
  let pack = typeof input === 'string' ? parseContextPackMarkdown(input, { lenient: true }) : structuredClone(input);
  pack = fillDefaults(pack, { task, capability, producedBy });
  const report = { rewritten: [], external: [], dropped: [] };

  const fixList = (list, field) => {
    const kept = [];
    for (const item of list ?? []) {
      const c = classifyPath(item.path ?? '', repoRoot);
      if (c.kind === 'outside') { report.external.push(c.path); report.dropped.push({ field, path: c.path }); continue; }
      if (c.kind === 'inside') report.rewritten.push({ from: item.path, to: c.path });
      kept.push({ ...item, path: c.path });
    }
    return kept;
  };
  pack.relevant_files = dedupeFiles(fixList(pack.relevant_files, 'relevant_files'));
  if (pack.relevant_snippets) pack.relevant_snippets = fixList(pack.relevant_snippets, 'relevant_snippets');

  for (const field of ['observed_errors', 'repo_rules', 'constraints', 'test_commands']) {
    if (!Array.isArray(pack[field])) continue;
    pack[field] = pack[field].map(t => { const r = relativizeText(String(t), repoRoot); report.external.push(...r.external); return r.text; });
  }
  if (Array.isArray(pack.previous_attempts)) {
    pack.previous_attempts = pack.previous_attempts.map(a => {
      const s = relativizeText(a.summary ?? '', repoRoot), o = relativizeText(a.outcome ?? '', repoRoot);
      report.external.push(...s.external, ...o.external);
      return { ...a, summary: s.text, ...(a.outcome !== undefined ? { outcome: o.text } : {}) };
    });
  }
  report.external = [...new Set(report.external)];
  if (report.dropped.length) pack.constraints.push(`unknown: ${report.dropped.length} path(s) outside the repository were excluded from relevant_files (see normalizer report)`);

  const errors = validateContextPack(pack);
  const markdown = errors.length ? null : toMarkdown(pack);
  return { pack, markdown, errors, report };
}

function dedupeFiles(files) {
  const seen = new Map();
  for (const f of files) {
    const prev = seen.get(f.path);
    if (!prev) { seen.set(f.path, { ...f }); continue; }
    if (!prev.lines && f.lines) prev.lines = f.lines;
    if (!prev.reason && f.reason) prev.reason = f.reason;
  }
  return [...seen.values()];
}

export { REQUIRED_FIELDS };
