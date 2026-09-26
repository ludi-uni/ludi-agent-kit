# ludi-agent-kit

A backend-neutral foundation for running multiple AI coding agents on native Windows,
with **pi** as the primary execution/orchestration runtime and Codex, local models and
other providers treated uniformly as *backends*.

It succeeds the frozen `codex-setting` repository. Reusable knowledge (skills, rules,
verification scripts) was copied here; Codex-specific installers remain in the old repo.

## Layout and responsibilities

```
ludi-agent-kit/
├─ AGENTS.md            generated from rules/ (repo-level instructions)
├─ rules/               common operating rules, model-independent (single editable source)
├─ skills/              shared Skills: visual-verification, project-management, pi-workflow
├─ agents/              role definitions (scout, coder, reviewer, tester, visual, browser, orchestrator)
├─ routing/             capability -> backend routing config + JSON schema
├─ context-pack/        Context Pack v1 spec, JSON schema, examples
├─ lib/                 dependency-free loaders/validators (routing, agents, context pack)
├─ mcp/                 backend-neutral MCP server catalog (no secrets)
├─ adapters/
│  ├─ pi/               pi model map, settings/MCP templates, sync-pi.ps1 (dry-run), loop-guard extension
│  └─ codex/            Codex-specific notes and skill metadata
├─ scripts/             validate / resolve / context-pack CLI, environment check
├─ tests/               node --test + PowerShell fixture tests
└─ docs/                architecture, migration, roadmap
```

Boundary rule: **anything that names a concrete provider, model, CLI, config format or
install path lives under `adapters/<backend>/`.** `rules/`, `skills/`, `agents/`,
`routing/`, `context-pack/` and `lib/` stay neutral.

## Core ideas

- **Capabilities, not models.** Agents declare `capability: strong-code`; `routing/routing.json`
  maps capabilities to logical backends (`local`, `cheap`, `sol`, `astra`, `codex`);
  `adapters/<x>/models.json` binds backends to real provider/model ids. Swap a model by
  editing one adapter file. For machine-local capability routing, create
  `routing/routing.local.json` (gitignored) with `{"version":1,"capabilities":{"strong-code":{"primary":"devin","fallback":["sol"]}}}`.
  A `null` entry disables a shared capability; locally added capabilities can be removed
  by deleting their entry. Disabled capabilities are removed from escalation ladders and
  their agents are unavailable until restored. The shared `routing.json` remains unchanged.
- **Context Pack.** Expensive models receive a bounded, validated pack
  (`task / goal / constraints / relevant_files / …`) instead of the repository.
  See `context-pack/SPEC.md`.
- **Dry-run first.** `adapters/pi/sync-pi.ps1` renders everything into `adapters/pi/out/`
  and prints a plan. `-Apply` only creates Junctions and a generated `AGENTS.md`, backs
  up conflicts, and never touches `settings.json`, `auth.json`, `models.json`, `mcp.json`.

## Quick start

```powershell
node scripts/validate.mjs                       # routing, agents, skills, MCP catalog, context packs
node --test "tests/*.test.mjs"                  # unit tests
pwsh -NoProfile -File tests/test-sync-pi.ps1    # pi adapter against an isolated temp agent dir
pwsh -NoProfile -File adapters/pi/sync-pi.ps1   # dry-run against your real ~/.pi/agent (read-only)
pwsh -NoProfile -File scripts/check-environment.ps1
node scripts/context-pack.mjs context-pack/examples/example-fix.md --json
node scripts/resolve-capabilities.mjs routing/routing.json adapters/pi/models.json
```

Requirements for local validation: Windows, PowerShell 7, Git and Node.js with `node:sqlite` support (tested with Node 24). Core scripts use Node built-ins and need no `npm install`. Live agent runs additionally require an installed, authenticated pi runtime, available model IDs and quota; model bindings in `adapters/pi/models.json` are templates, not working credentials. Optional integrations have separate prerequisites; see [OSS and dependencies](docs/third-party.md).

## Executable path (Phase 2)

```powershell
Copy-Item adapters/pi/models.local.example.json adapters/pi/models.local.json   # then edit with `pi --list-models` ids
node scripts/resolve-capabilities.mjs                                            # chains + out/settings.proposal.json
node scripts/run-pipeline.mjs --repo <fixture-copy> --task "Fix the failing test" --dry-run
node scripts/run-pipeline.mjs --repo <fixture-copy> --task "Fix the failing test"           # real: scout -> pack -> coder -> tests
node tests/e2e-real-pi.mjs                                                       # opt-in real E2E (spends quota)
```

Every run writes `trace.json` (agent, capability, backend, modelId, ok, reason, duration per attempt),
`context-pack.md`, and the exact coder input. Escalation: primary -> fallback[0], max 2 attempts,
never the same modelId twice, failures appended to `previous_attempts`. See `docs/phase2-report.md`.

## Orchestration and safety

`node scripts/orchestrate.mjs --dry-run "<request>"` previews a rules-based plan without launching agents. A live invocation can call external models and consume quota; review the plan, model availability and `docs/orchestrator.md` before using it. `sync-pi.ps1` is dry-run by default; `-Apply` writes to the chosen pi agent directory. The optional real E2E scripts are not part of routine validation.

## Distribution checklist

- Review the files being published (`git status --short`, then the staged file list); this repository may start without a commit. Do not publish machine-local model bindings, auth, session/goal state, generated `adapters/pi/out/` traces or captured media. `.gitignore` excludes `.pi/`, local bindings and common secret/output patterns, but is not a substitute for inspecting staged files.
- Run `node scripts/validate.mjs`, `node --test tests/` and, on Windows with PowerShell 7, `pwsh -NoProfile -File tests/test-sync-pi.ps1`. Some tests/integrations depend on installed tools; report skipped or failing checks rather than claiming a clean release.
- Preserve `LICENSE` and review [OSS and dependencies](docs/third-party.md) if bundling third-party tools or their output. This repository does not vendor those tools.

## Status

This is a Windows-first kit with a working selection/pipeline path and a separate orchestration CLI; see `docs/roadmap.md` and `docs/orchestrator.md` for capabilities and limitations. The repository's model catalog and machine-specific examples do not guarantee current availability or pricing.

## License

MIT — see `LICENSE`. This license covers this repository's contents as distributed by its rights holder; external tools and services keep their own terms. See [OSS and dependencies](docs/third-party.md).
