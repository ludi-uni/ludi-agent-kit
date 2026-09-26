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

## Install as an npm / Pi package

The published package is `@ludi-uni/ludi-agent-kit` (initial release `0.1.0`). For Pi, install it directly with `pi install npm:@ludi-uni/ludi-agent-kit`; alternatively use `pi install git:github.com/ludi-uni/ludi-agent-kit` to install from this repository. A Pi install loads the `pi-workflow`, `project-management` and `visual-verification` skills plus the loop guard and `ludi_orchestrate` extensions. Review the package source before enabling extensions: they run with your Pi process permissions. The `shell-gate` extension is **not** loaded globally; it is used only by the kit's tool-capable child path. No postinstall script modifies Pi settings, model bindings or credentials.

```powershell
pi install npm:@ludi-uni/ludi-agent-kit
pi list
# In Pi, check /skill:pi-workflow and the ludi_orchestrate tool.
```

`npm install @ludi-uni/ludi-agent-kit` alone only places the files in `node_modules`; Pi resource discovery requires `pi install` (or an explicitly configured local package). Pi does not automatically install the separate `pi-subagents` extension or register `agents/*.md` as pi-subagents roles. To use those roles, install/configure pi-subagents separately and explicitly configure agents/model bindings; see [the pi adapter](adapters/pi/README.md). The bundled `adapters/pi/sync-pi.ps1` is an **alternative** for a source checkout, not a post-install step: do not use `-Apply` on top of the same installed Pi package without checking for duplicate extensions and skills.

## Quick start from a source checkout

```powershell
node scripts/validate.mjs                       # routing, agents, skills, MCP catalog, context packs
node --test "tests/*.test.mjs"                  # unit tests
pwsh -NoProfile -File tests/test-sync-pi.ps1    # pi adapter against an isolated temp agent dir
pwsh -NoProfile -File adapters/pi/sync-pi.ps1   # dry-run against your real ~/.pi/agent (read-only)
pwsh -NoProfile -File scripts/check-environment.ps1
node scripts/context-pack.mjs context-pack/examples/example-fix.md --json
node scripts/resolve-capabilities.mjs routing/routing.json adapters/pi/models.json
```

Requirements for local validation: Windows, PowerShell 7, Git and Node.js with `node:sqlite` support (tested with Node 24). Core scripts use Node built-ins without a separate `npm install`; the Pi extensions import `typebox` supplied by a compatible Pi runtime (declared as a peer dependency). Live agent runs additionally require an installed, authenticated pi runtime, available model IDs and quota; model bindings in `adapters/pi/models.json` are templates, not working credentials. Optional integrations have separate prerequisites; see [OSS and dependencies](docs/third-party.md).

## Executable path (Phase 2)

```powershell
New-Item -ItemType Directory -Force "$HOME/.pi/agent/ludi-agent-kit" | Out-Null
Copy-Item adapters/pi/models.local.example.json "$HOME/.pi/agent/ludi-agent-kit/models.local.json"  # edit with `pi --list-models` ids; use $env:PI_CODING_AGENT_DIR/ludi-agent-kit if set
node scripts/resolve-capabilities.mjs                                            # chains + out/settings.proposal.json
node scripts/run-pipeline.mjs --repo <fixture-copy> --task "Fix the failing test" --dry-run
node scripts/run-pipeline.mjs --repo <fixture-copy> --task "Fix the failing test"           # real: scout -> pack -> coder -> tests
node tests/e2e-real-pi.mjs                                                       # opt-in real E2E (spends quota)
```

Every run writes `trace.json` (agent, capability, backend, modelId, ok, reason, duration per attempt),
`context-pack.md`, and the exact coder input. Escalation: primary -> fallback[0], max 2 attempts,
never the same modelId twice, failures appended to `previous_attempts`. See `docs/phase2-report.md`.

## Orchestration and safety

`node scripts/orchestrate.mjs --dry-run "<request>"` previews a rules-based plan without launching agents. A live invocation can call external models and consume quota; review the plan, model availability and `docs/orchestrator.md` before using it. Before creating a run, the orchestrator checks that each planned capability has at least one concrete model binding (and checks `orchestration` before model planning); a missing binding reports the user-level file to edit. This is a binding check, not an authentication/quota probe. `sync-pi.ps1` is dry-run by default; `-Apply` writes to the chosen pi agent directory. The optional real E2E scripts are not part of routine validation.

## Distribution checklist

- Review the files being published (`git status --short`, then the staged file list); for npm inspect `npm pack --dry-run --json` as well. Do not publish machine-local model bindings, auth, session/goal state, generated `adapters/pi/out/` traces or captured media. `.gitignore` excludes `.pi/`, local bindings and common secret/output patterns, but is not a substitute for inspecting staged files.
- Run `node scripts/validate.mjs`, `node --test tests/` and, on Windows with PowerShell 7, `pwsh -NoProfile -File tests/test-sync-pi.ps1`. Some tests/integrations depend on installed tools; report skipped or failing checks rather than claiming a clean release.
- Preserve `LICENSE` and review [OSS and dependencies](docs/third-party.md) if bundling third-party tools or their output. This repository does not vendor those tools.

## Status

This is a Windows-first kit with a working selection/pipeline path and a separate orchestration CLI; see `docs/roadmap.md` and `docs/orchestrator.md` for capabilities and limitations. The repository's model catalog and machine-specific examples do not guarantee current availability or pricing.

## License

MIT — see `LICENSE`. This license covers this repository's contents as distributed by its rights holder; external tools and services keep their own terms. See [OSS and dependencies](docs/third-party.md).
