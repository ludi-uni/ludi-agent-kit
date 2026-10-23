# Getting started

[日本語版](getting-started.ja.md) · [README](../README.md)

## Requirements

For a **Pi package install**, use a compatible Pi runtime and authenticated providers. Live tasks require available model IDs and quota. For a **source checkout**, use Windows, PowerShell 7, Git, and Node.js with `node:sqlite` support (tested with Node 24). Core scripts do not need `npm install`; Pi supplies the `typebox` peer dependency to its extensions.

## Install for Pi

```powershell
pi install npm:@ludi-uni/ludi-agent-kit
pi list
```

Git is an alternative source: `pi install git:github.com/ludi-uni/ludi-agent-kit`. `npm install @ludi-uni/ludi-agent-kit` alone does not register skills/extensions with Pi. To update a package installed without a version pin, use `pi update npm:@ludi-uni/ludi-agent-kit`. A pinned specification such as `npm:@ludi-uni/ludi-agent-kit@0.1.2` will not advance on update: install the desired newer version explicitly and confirm it with `pi list`. Restart the Pi session to load updated extensions.

Pi loads the `pi-workflow`, `project-management`, and `visual-verification` skills and the loop guard and `ludi_orchestrate` extensions. These extensions run with Pi's process permissions: review their source before enabling them. The child-only `shell-gate` extension is not loaded globally. No postinstall script changes Pi settings or credentials.

### Bind models before live use

`adapters/pi/models.json` contains templates, **not working credentials or guaranteed model IDs**. In a source checkout, copy the example to the durable user-level binding path, then edit it using IDs available from `pi --list-models`:

```powershell
$agentDir = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $HOME '.pi/agent' }
$bindingDir = Join-Path $agentDir 'ludi-agent-kit'
New-Item -ItemType Directory -Force $bindingDir | Out-Null
Copy-Item adapters/pi/models.local.example.json (Join-Path $bindingDir 'models.local.json')
pi --list-models
```

If you installed the npm package instead of cloning the repository, use its `adapters/pi/models.local.example.json` as the source of the copy. The kit **reads but never writes** the user-level `models.local.json`; do not put credentials in it. See [Pi adapter: model selection](../adapters/pi/README.md#model-selection-flow) for precedence and migration details. The orchestrator checks bindings before creating a run, but that check does not authenticate a provider or guarantee quota.

Pi does not install the separate `pi-subagents` package or register `agents/*.md` as pi-subagents roles automatically. Configure those separately if you want to use them; the bundled `sync-pi.ps1` is an **alternative for a source checkout**, not a required post-install step. Do not apply it over the same installed package without checking for duplicate resources.

## Before running a task

From a source checkout, preview the orchestration plan without launching an agent:

```powershell
node scripts/orchestrate.mjs --dry-run "Fix the failing test"
```

A live run may call external models and spend quota; review the plan and [orchestrator options/safety rules](orchestrator.md) first. The default rules planner makes no planning-model call. `--planner model` opts into one. The Pi `ludi_orchestrate` tool also supports persistent runs, status, decisions, and resume.

## Source checkout

Validate the checkout without invoking external models:

```powershell
node scripts/validate.mjs
node --test (Get-ChildItem tests -Filter '*.test.mjs' | ForEach-Object FullName)
pwsh -NoProfile -File tests/test-sync-pi.ps1
pwsh -NoProfile -File adapters/pi/sync-pi.ps1  # dry-run; inspect before -Apply
pwsh -NoProfile -File scripts/check-environment.ps1
node scripts/check-pi.mjs                      # offline isolated startup/RPC registration check
```

`scripts/check-pi.mjs` (native Windows + pwsh + installed Pi required) creates a temporary agent dir, populates it with `sync-pi.ps1 -Apply` (never `-ApplySettings`), starts the installed Pi in offline RPC mode (`--offline --no-mcp --no-session`), and verifies the `orchestrate` command, the three `skill:*` commands, their physical targets, zero messages/tokens/cost, and exactly the expected kit links plus one loop-guard extension entry — using an owned temp dir it deletes afterwards (`--keep-temp` retains it for inspection). The sync also refreshes the kit's gitignored `adapters/pi/out/` preview files; real user configuration is untouched. It sends no prompts and calls no model. Agent definitions are checked structurally against the kit; RPC does not expose the agent registry or extension hook counts, and the separate `pi-subagents` package is not installed or verified. Run it against an installed Pi with `node scripts/check-pi.mjs --json`; the unit tests in `tests/pi-startup.test.mjs` use mocks only and do not prove the live check passes.

`sync-pi.ps1` generates proposals in `adapters/pi/out/` by default; `-Apply` writes Junctions and a generated `AGENTS.md`, backing up conflicts. It never edits `auth.json` or model credentials, and `settings.json` is modified only with the separate opt-in `-ApplySettings`: that merges resolved models into `subagents.agentOverrides.{scout,coder,visual,reviewer}` (`model`/`thinking` fields only, all other fields/roles/keys preserved), backs up the original byte-for-byte to `<AgentDir>/ludi-agent-kit/backup-*/settings.json`, verifies a JSON round-trip, and refuses if the file changed since the plan was captured — the check is advisory, not a kernel compare-and-swap, so don't edit settings while a sync run is in flight. Restart pi or `/reload` to pick up new agent models. Project settings or provider-scoped overrides may still take precedence; confirm the effective mapping with `/subagents-models`.

```powershell
pwsh -NoProfile -File adapters/pi/sync-pi.ps1                # inspect the proposal first
pwsh -NoProfile -File adapters/pi/sync-pi.ps1 -ApplySettings # explicit opt-in: four role model overrides only
```

Other source-checkout examples:

```powershell
node scripts/context-pack.mjs context-pack/examples/example-fix.md --json
node scripts/resolve-capabilities.mjs routing/routing.json adapters/pi/models.json
node scripts/run-pipeline.mjs --repo <fixture-copy> --task "Fix the failing test" --dry-run
```

The last command only previews. Remove `--dry-run` to run scout → Context Pack → coder → tests (uses providers and may write in the selected repository). Outputs are placed under `adapters/pi/out/`; see the [Phase 2 report](phase2-report.md). The opt-in `node tests/e2e-real-pi.mjs` also calls real models and spends quota.

For release checks, see the [distribution checklist](distribution.md). Optional tools and their terms are listed in [third-party dependencies](third-party.md).
