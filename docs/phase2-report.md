# Phase 2 — minimal executable path (report)

Goal: `task -> scout -> Context Pack -> coder -> validation -> success | escalation candidate`,
running on pi with capability-routed models.

## What runs for real (verified on this machine)

| Step | Evidence |
| --- | --- |
| Registry merge | `adapters/pi/models.local.json` (gitignored) overrides the `TODO-*` template; `scripts/resolve-capabilities.mjs` prints `registrySources.local`. |
| Model resolution | scout -> cheap-code -> `openai-codex/gpt-5.6-luna:low` -> fallback `freetoken/Qwen3.6-35B-A3B-NVFP4:off` -> `openai-codex/gpt-5.6-sol:medium`; coder -> strong-code -> `openai-codex/gpt-5.6-sol:medium` -> `openai-codex/gpt-5.5:high`. (Names come from `models.local.json`, not code.) |
| Settings proposal | `adapters/pi/out/settings.proposal.json` = `{"subagents":{"agentOverrides":{scout,coder,visual,reviewer:{model,thinking}}}}`, diffed against live `~/.pi/agent/settings.json` (all `add`). Live settings never written. |
| Real invocation | `adapters/pi/lib/invoke.mjs` runs `node <pi cli.js> -p --model ... --no-tools --no-session --no-approve`. Both `openai-codex` (OAuth) and `freetoken` (local endpoint) returned text with system prompt honored. |
| Real E2E | Fixture copied to `%TEMP%`; baseline red. scout (`gpt-5.6-luna:low`, 38 s) produced a pack that normalized cleanly (4 files, 2 snippets, in-repo relative paths; external `~/.pi/agent/AGENTS.md` reported, not rewritten). coder (`gpt-5.6-sol:medium`, 13 s) returned one FILE block; applied `src/math.js`; `npm test` 3/3. `outcome: success`. |
| Real escalation | With `sol` bound to a non-existent id: attempt 1 failed (`Codex error: ... model is not supported`), runner moved to fallback `codex` (`gpt-5.5:high`), tests passed, `outcome: success, escalated: true, attempts: 2`; failure appended to `## previous_attempts`. |
| Loop/limit | Later a real `usage limit has been reached` on all openai-codex models: scout fell back to the local model successfully, coder exhausted both candidates after exactly 2 attempts, `outcome: exhausted`, no retry of the same modelId. |

## Still mock / proposal

- `settings.proposal.json` is not applied; pi-subagents launches still inherit the session model until the block is merged.
- pi-subagents cannot express fallback (removed `fallbackModels`); escalation exists only in the kit runner (`lib/pipeline.mjs withEscalation`), not inside `subagent(...)` launches.
- The runner uses one-shot `pi -p` with `--no-tools`; agents do not use tools. Coder returns whole-file blocks confined to `relevant_files`.
- No task classifier; the pipeline is fixed scout->coder. `--agent/--capability` only influence `--dry-run` reporting.
- `visual`/`reviewer` resolve and appear in the proposal but are not exercised.

## Context Pack schema adjustment (v1.1, backwards compatible)

Real greenfield run ("add src/greet.js + test") showed `relevant_files` legitimately containing only
*new* files or nothing. Added, all optional: `discovery: {status: found|partial|none, note?}` — `none`
is the only case that permits an empty `relevant_files`; `relevant_files[].create: true` (Markdown
reason prefix `(new)`) marks files the coder may create. Validator, JSON schema (`if/then/else`),
`toMarkdown`, prompts and tests updated. v1.0 packs validate unchanged; older validators would reject
the new keys, so producers should omit them when not needed.

## Test inventory (47 + 1 PowerShell + 1 opt-in real)

`node --test "tests/*.test.mjs"`: routing 9, context-pack 9, kit 7, loop-guard 6, pipeline 16
(registry merge ×3, resolution, proposal, normalizer ×2, escalation ×2, loop prevention, scripted
E2E ×5, parser). `tests/test-sync-pi.ps1` PASS. `tests/e2e-real-pi.mjs` (opt-in, spends quota).
