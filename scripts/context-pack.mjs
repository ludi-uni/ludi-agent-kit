#!/usr/bin/env node
// Validate one Context Pack (.md or .json) and optionally print its JSON or canonical Markdown.
// Usage: node scripts/context-pack.mjs <file> [--json|--md]
import { readFileSync } from 'node:fs';
import { parseContextPackMarkdown, validateContextPack, toMarkdown } from '../lib/context-pack.mjs';

const [file, mode] = process.argv.slice(2);
if (!file) { console.error('usage: context-pack.mjs <file.md|file.json> [--json|--md]'); process.exit(2); }
const text = readFileSync(file, 'utf8');
let pack;
try { pack = file.toLowerCase().endsWith('.json') ? JSON.parse(text) : parseContextPackMarkdown(text); }
catch (e) { console.error(e.message); process.exit(1); }
const errors = validateContextPack(pack);
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
if (mode === '--json') console.log(JSON.stringify(pack, null, 2));
else if (mode === '--md') console.log(toMarkdown(pack));
else console.log(`PASS ${file}: ${pack.relevant_files.length} files, ${(pack.relevant_snippets ?? []).length} snippets`);
