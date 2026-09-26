// Context Pack v1: Markdown parser + structural validator (see context-pack/SPEC.md).
// Dependency-free so it can run under plain Node in any adapter.
import { readFileSync } from 'node:fs';

export const SCALAR_FIELDS = ['task', 'goal', 'expected_output'];
export const LIST_FIELDS = ['constraints', 'repo_rules', 'observed_errors', 'test_commands'];
export const STRUCT_FIELDS = ['relevant_files', 'relevant_snippets', 'previous_attempts'];
export const REQUIRED_FIELDS = ['task', 'goal', 'constraints', 'relevant_files', 'expected_output'];
export const ALL_FIELDS = [...SCALAR_FIELDS, ...LIST_FIELDS, ...STRUCT_FIELDS];
const META_FIELDS = ['version', 'capability', 'produced_by', 'budget', 'discovery'];
export const DISCOVERY_STATUS = ['found', 'partial', 'none'];
const LINES = /^[0-9]+-[0-9]+$/;
const NAME = /^[a-z][a-z0-9-]*$/;

function splitSections(markdown, { lenient = false } = {}) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const sections = new Map();
  const order = [];
  let current = null, fence = null, buffer = [];
  let sawTitle = false;
  const flush = () => { if (current !== null) sections.set(current, buffer.join('\n').trim()); buffer = []; };
  for (const line of lines) {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1];
      else if (line.trim().startsWith(fence)) fence = null;
      buffer.push(line);
      continue;
    }
    if (!fence && /^# /.test(line)) { sawTitle = true; continue; }
    const heading = !fence && line.match(/^## +(\S.*?)\s*$/);
    if (heading) {
      flush();
      current = heading[1];
      if (sections.has(current)) throw new Error(`context-pack: duplicate section "## ${current}"`);
      order.push(current);
      sections.set(current, '');
      continue;
    }
    if (current !== null) buffer.push(line);
  }
  flush();
  if (!sawTitle && !(lenient && sections.has('task'))) throw new Error('context-pack: missing "# Context Pack" title');
  return { sections, order };
}

function listItems(body) {
  // Top-level bullets become items; indented sub-bullets are folded into the preceding item.
  const items = [];
  for (const raw of body.split('\n')) {
    if (/^[-*] /.test(raw)) items.push(raw.slice(2).trim());
    else if (/^\s+[-*] /.test(raw) && items.length) items[items.length - 1] += ' ' + raw.trim().slice(2).trim();
  }
  return items;
}
function fencedBlocks(body) {
  const blocks = [];
  const re = /^ *(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)\n? *\1[ \t]*$/gm;
  let m;
  while ((m = re.exec(body))) blocks.push({ language: m[2].trim() || undefined, content: m[3].replace(/\n$/, '') });
  return blocks;
}
const strip = s => s.replace(/^`|`$/g, '');

// Accepts: `path` (lines a-b) — reason | `path:a-b` — reason | `path:a` | path — reason
function parseFileItem(item) {
  const m = item.match(/^`([^`]+)`(?:\s*\(lines?\s+([0-9]+(?:-[0-9]+)?)\))?(?:\s*(?:—|--|-|:)\s*(.*))?$/);
  let path, lines, reason;
  if (m) { path = m[1]; lines = m[2]; reason = m[3]?.trim(); }
  else {
    const first = item.split(/\s+/)[0];
    path = strip(first);
    reason = item.slice(first.length).replace(/^\s*(?:—|--|-|:)\s*/, '').trim() || undefined;
  }
  let create = false;
  if (reason && /^\(new\)/i.test(reason)) { create = true; reason = reason.replace(/^\(new\)\s*(?:—|--|-|:)?\s*/i, '').trim() || undefined; }
  const suffix = path.match(/^(.*?):(\d+)(?:-(\d+))?$/);
  if (suffix && !/^[A-Za-z]:$/.test(suffix[1])) { path = suffix[1]; lines = lines ?? (suffix[3] ? `${suffix[2]}-${suffix[3]}` : `${suffix[2]}-${suffix[2]}`); }
  if (lines && !lines.includes('-')) lines = `${lines}-${lines}`;
  const out = { path };
  if (lines) out.lines = lines;
  if (reason) out.reason = reason;
  if (create) out.create = true;
  return out;
}
function parseSnippets(body) {
  const out = [];
  let parts = body.split(/^### +/m).slice(1);
  // Lenient: list-style headers "- `path:a-b`" followed by a fenced block.
  if (!parts.length) parts = body.split(/^[-*] +(?=`)/m).slice(1);
  for (const part of parts) {
    const nl = part.indexOf('\n');
    const head = (nl >= 0 ? part.slice(0, nl) : part).trim();
    const rest = nl >= 0 ? part.slice(nl + 1) : '';
    const hm = head.match(/^`([^`]+)`(?:\s*\(lines?\s+([0-9]+(?:-[0-9]+)?)\))?/);
    const block = fencedBlocks(rest)[0];
    const fileish = parseFileItem(hm ? `\`${hm[1]}\`${hm[2] ? ` (lines ${hm[2]})` : ''}` : head);
    const snippet = { path: fileish.path, content: block ? block.content : rest.trim() };
    if (fileish.lines) snippet.lines = fileish.lines;
    if (block?.language) snippet.language = block.language;
    out.push(snippet);
  }
  return out;
}
function parseAttempts(body) {
  return listItems(body).map(item => {
    const m = item.match(/^(.*?)\s*(?:—|--|-)\s*outcome:\s*(.*)$/i);
    return m ? { summary: m[1].trim(), outcome: m[2].trim() } : { summary: item };
  });
}

/** Parse Markdown Context Pack into the JSON form. Throws on structural errors. `lenient` tolerates a missing title. */
export function parseContextPackMarkdown(markdown, { lenient = false } = {}) {
  const { sections } = splitSections(markdown, { lenient });
  const pack = { version: 1 };
  for (const [name, body] of sections) {
    if (SCALAR_FIELDS.includes(name)) pack[name] = body;
    else if (LIST_FIELDS.includes(name)) {
      const blocks = name === 'observed_errors' ? fencedBlocks(body) : [];
      const items = blocks.length ? blocks.map(b => b.content) : listItems(body);
      pack[name] = name === 'test_commands' ? items.map(i => i.replace(/^`(.*)`$/, '$1')) : items;
    }
    else if (name === 'relevant_files') pack[name] = listItems(body).map(parseFileItem);
    else if (name === 'relevant_snippets') pack[name] = parseSnippets(body);
    else if (name === 'previous_attempts') pack[name] = parseAttempts(body);
    else if (name === 'capability' || name === 'produced_by') pack[name] = body;
    else if (name === 'discovery') {
      const m = body.match(/^\s*(found|partial|none)\b\s*(?:(?:—|--|-|:)\s*(.*))?/is);
      pack.discovery = m ? { status: m[1].toLowerCase(), ...(m[2]?.trim() ? { note: m[2].trim() } : {}) } : { status: body.trim() };
    }
    else throw new Error(`context-pack: unknown section "## ${name}"`);
  }
  return pack;
}

/** Structural validation mirroring context-pack.schema.json. Returns an array of error strings. */
export function validateContextPack(pack) {
  const errors = [];
  const err = m => errors.push(m);
  if (!pack || typeof pack !== 'object' || Array.isArray(pack)) return ['context-pack: root must be an object'];
  for (const key of Object.keys(pack)) if (!ALL_FIELDS.includes(key) && !META_FIELDS.includes(key)) err(`context-pack: unknown field "${key}"`);
  for (const f of REQUIRED_FIELDS) if (!(f in pack)) err(`context-pack: missing required field "${f}"`);
  if (pack.version !== undefined && pack.version !== 1) err('context-pack: version must be 1');
  if (pack.capability !== undefined && !(typeof pack.capability === 'string' && NAME.test(pack.capability))) err('context-pack: capability must be a lowercase capability name');
  if (pack.budget !== undefined) {
    if (typeof pack.budget !== 'object' || pack.budget === null) err('context-pack: budget must be an object');
    else if (pack.budget.max_tokens !== undefined && !(Number.isInteger(pack.budget.max_tokens) && pack.budget.max_tokens > 0)) err('context-pack: budget.max_tokens must be a positive integer');
  }
  for (const f of SCALAR_FIELDS) if (f in pack && !(typeof pack[f] === 'string' && pack[f].trim())) err(`context-pack: "${f}" must be a non-empty string`);
  for (const f of LIST_FIELDS) if (f in pack) {
    if (!Array.isArray(pack[f])) err(`context-pack: "${f}" must be an array`);
    else pack[f].forEach((v, i) => { if (!(typeof v === 'string' && v.trim())) err(`context-pack: "${f}[${i}]" must be a non-empty string`); });
  }
  if (pack.discovery !== undefined) {
    if (!pack.discovery || typeof pack.discovery !== 'object') err('context-pack: discovery must be an object');
    else {
      if (!DISCOVERY_STATUS.includes(pack.discovery.status)) err(`context-pack: discovery.status must be one of ${DISCOVERY_STATUS.join('|')}`);
      if (pack.discovery.note !== undefined && typeof pack.discovery.note !== 'string') err('context-pack: discovery.note must be a string');
      for (const k of Object.keys(pack.discovery)) if (!['status', 'note'].includes(k)) err(`context-pack: discovery has unknown key "${k}"`);
    }
  }
  if ('relevant_files' in pack) {
    const allowEmpty = pack.discovery?.status === 'none';
    if (!Array.isArray(pack.relevant_files)) err('context-pack: "relevant_files" must be an array');
    else if (pack.relevant_files.length === 0 && !allowEmpty) err('context-pack: "relevant_files" must contain at least one entry (or set discovery.status = none)');
    else pack.relevant_files.forEach((v, i) => {
      if (v?.create !== undefined && typeof v.create !== 'boolean') err(`context-pack: "relevant_files[${i}].create" must be boolean`);
      for (const k of Object.keys(v ?? {})) if (!['path', 'reason', 'lines', 'create'].includes(k)) err(`context-pack: "relevant_files[${i}]" has unknown key "${k}"`);
      if (!v || typeof v.path !== 'string' || !v.path.trim()) err(`context-pack: "relevant_files[${i}].path" is required`);
      if (v?.lines !== undefined && !LINES.test(v.lines)) err(`context-pack: "relevant_files[${i}].lines" must be "start-end"`);
      if (v?.path && /^[A-Za-z]:[\\/]|^\\\\/.test(v.path)) err(`context-pack: "relevant_files[${i}].path" must be repository-relative, not absolute`);
    });
  }
  if ('relevant_snippets' in pack) {
    if (!Array.isArray(pack.relevant_snippets)) err('context-pack: "relevant_snippets" must be an array');
    else pack.relevant_snippets.forEach((v, i) => {
      if (!v || typeof v.path !== 'string' || !v.path.trim()) err(`context-pack: "relevant_snippets[${i}].path" is required`);
      if (!v || typeof v.content !== 'string') err(`context-pack: "relevant_snippets[${i}].content" is required`);
      if (v?.lines !== undefined && !LINES.test(v.lines)) err(`context-pack: "relevant_snippets[${i}].lines" must be "start-end"`);
    });
  }
  if ('previous_attempts' in pack) {
    if (!Array.isArray(pack.previous_attempts)) err('context-pack: "previous_attempts" must be an array');
    else pack.previous_attempts.forEach((v, i) => {
      if (!v || typeof v.summary !== 'string' || !v.summary.trim()) err(`context-pack: "previous_attempts[${i}].summary" is required`);
    });
  }
  return errors;
}

export function loadContextPack(path) {
  const text = readFileSync(path, 'utf8');
  const pack = path.toLowerCase().endsWith('.json') ? JSON.parse(text) : parseContextPackMarkdown(text);
  const errors = validateContextPack(pack);
  if (errors.length) throw new Error(errors.join('\n'));
  return pack;
}

/** Serialize the JSON form back to canonical Markdown. */
export function toMarkdown(pack) {
  const out = ['# Context Pack', ''];
  const section = (name, body) => { out.push(`## ${name}`, body.trimEnd(), ''); };
  section('task', pack.task);
  section('goal', pack.goal);
  section('constraints', pack.constraints.map(c => `- ${c}`).join('\n') || '-');
  if (pack.discovery) section('discovery', `${pack.discovery.status}${pack.discovery.note ? ` — ${pack.discovery.note}` : ''}`);
  section('relevant_files', pack.relevant_files.map(f => `- \`${f.path}\`${f.lines ? ` (lines ${f.lines})` : ''}${f.create || f.reason ? ` — ${f.create ? '(new) ' : ''}${f.reason ?? ''}`.trimEnd() : ''}`).join('\n') || '(none)');
  if (pack.relevant_snippets?.length) section('relevant_snippets', pack.relevant_snippets.map(s => `### \`${s.path}\`${s.lines ? ` (lines ${s.lines})` : ''}\n\`\`\`${s.language ?? ''}\n${s.content}\n\`\`\``).join('\n\n'));
  if (pack.repo_rules?.length) section('repo_rules', pack.repo_rules.map(c => `- ${c}`).join('\n'));
  if (pack.observed_errors?.length) section('observed_errors', pack.observed_errors.map(e => `\`\`\`\n${e}\n\`\`\``).join('\n\n'));
  if (pack.test_commands?.length) section('test_commands', pack.test_commands.map(c => `- \`${c}\``).join('\n'));
  if (pack.previous_attempts?.length) section('previous_attempts', pack.previous_attempts.map(a => `- ${a.summary}${a.outcome ? ` — outcome: ${a.outcome}` : ''}`).join('\n'));
  section('expected_output', pack.expected_output);
  return out.join('\n');
}
