# Context Pack v1

A Context Pack is the *only* thing a high-cost model should need to receive for a bounded
task. It is produced by a cheap agent (typically `scout`) or by hand, and consumed by
`coder`, `visual` or `reviewer`. It replaces "read the whole repository".

Two equivalent serializations exist:

- **JSON** — validated against `context-pack.schema.json`.
- **Markdown** — one `# Context Pack` title followed by fixed `## <field>` sections.
  `lib/context-pack.mjs` parses Markdown into the JSON form and validates it.

## Fields

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `task` | string | yes | One-line identifier / summary of the task. |
| `goal` | string | yes | What "done" looks like from the requester's view. |
| `constraints` | string[] | yes (may be empty) | Hard limits: scope, style, forbidden actions, budgets. |
| `relevant_files` | `{path, reason?, lines?, create?}`[] | yes (≥1 unless `discovery.status = none`) | Files the consumer should look at or create. `lines` is `"start-end"`. Paths are repository-relative with `/` separators. `create: true` marks a file that does not exist yet and may be created by the consumer (Markdown: reason begins with `(new)`). |
| `discovery` | `{status, note?}` | no | Scout's discovery result: `found` (default), `partial`, or `none`. `none` is the only case in which `relevant_files` may be empty (greenfield / new-module tasks). Markdown: `## discovery` with `none — note`. |
| `relevant_snippets` | `{path, lines?, language?, content}`[] | no | Verbatim excerpts so the consumer need not read whole files. |
| `repo_rules` | string[] | no | Rules from AGENTS.md / project docs that apply to this task. |
| `observed_errors` | string[] | no | Verbatim error output, test failures, stack traces. |
| `test_commands` | string[] | no | Exact commands that verify the change. |
| `previous_attempts` | `{summary, outcome?}`[] | no | What was tried and why it did not succeed. |
| `expected_output` | string | yes | The shape of the deliverable: diff, report, list of findings, image verdict. |

Optional metadata: `version` (const `1`), `capability` (a routing capability name such as
`strong-code`), `produced_by` (agent name), `budget` (`{max_tokens?}`).

## Markdown form

```markdown
# Context Pack

## task
Fix crash when saving empty project

## goal
Saving an empty project writes a valid file and shows no error.

## constraints
- Do not change the file format version.
- Windows native only.

## relevant_files
- `src/save.ts` (lines 40-88) — serialization entry point
- `tests/save.test.ts` — existing coverage

## relevant_snippets
### `src/save.ts` (lines 40-52)
```ts
export function save(project) { ... }
```

## repo_rules
- Use the smallest sufficient change.

## observed_errors
```
TypeError: Cannot read properties of undefined (reading 'layers')
```

## test_commands
- `npm test -- save`

## previous_attempts
- Added a null check in `save()` — outcome: tests pass but empty file is still invalid.

## expected_output
A diff limited to `src/save.ts` and `tests/save.test.ts`, plus test output.
```

Parsing rules:

- Section headings are `## <field>` with the exact field name (snake_case). Unknown
  sections are an error; duplicate sections are an error.
- List fields take `- item` lines. `relevant_files` items are `` `path` `` optionally
  followed by `(lines a-b)` and `— reason` (or `- reason`).
- `relevant_snippets` uses `### `path` (lines a-b)` sub-headings, each followed by one
  fenced code block. The fence language becomes `language`.
- `observed_errors` accepts either `- item` lines or fenced blocks (one entry per block).
- `previous_attempts` items are `- summary — outcome: text` (outcome optional).
- Scalar fields take their trimmed body text.

## v1.1 additions (backwards compatible)

- `discovery` (optional) and `relevant_files[].create` (optional) were added after the first
  real scout runs: a greenfield task legitimately yields zero existing files. Packs written
  against v1.0 remain valid; validators that predate v1.1 reject the new keys, so producers
  should omit them when not needed.
- Lenient parsing (`parseContextPackMarkdown(text, { lenient: true })`, used by the
  normalizer) tolerates a missing `# Context Pack` title, `path:start-end` line refs,
  single-line refs (`path:12` → `12-12`), list-style snippet headers, and nested bullets.
  Canonical output from `toMarkdown` is always strict v1.

## Non-goals (v1)

No automatic generation, no token counting, no binary attachments. Image evidence is
referenced through `relevant_files` paths; the `visual` agent reads them itself.
