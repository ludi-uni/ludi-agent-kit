# pi adapter

Binds the neutral kit to a native-Windows pi installation (`~/.pi/agent`, or
`$env:PI_CODING_AGENT_DIR`).

| File | Role |
| --- | --- |
| `models.json` | shared TEMPLATE: logical backend -> pi `provider`/`model`/`thinking`. Ships with `TODO-*` placeholders that the resolver skips. |
| `models.local.json` | **gitignored** machine-local bindings; overrides `models.json` per backend and may add backends. Copy `models.local.example.json` and fill from `pi --list-models`. Allowed keys: `provider, model, thinking, vision, note`. Credentials are rejected by the validator. |
| `lib/invoke.mjs` | one-shot model call through the installed pi CLI (`node <pi cli.js> -p --model provider/id:thinking --no-tools --no-session --no-approve --system-prompt ...`). Uses pi's own auth store. Verified against `qoder/Qwen3.8-Flash` and `devin/swe-2-high` — no provider-specific runner is needed; any provider registered in pi's model store works. |
| `lib/subagent.mjs` | tool-capable child (`pi --mode json -p`). **Do not pass `--no-extensions`**: providers registered by pi extensions (qoder, devin) are absent from the static model store and only resolve once their extension has loaded; with `--no-extensions` `--model` fails `Model ... not found`. Kit extensions the child needs are passed explicitly (`-e shell-gate`). |
| `lib/settings-proposal.mjs` | renders resolved agents into `subagents.agentOverrides.<agent>.{model,thinking}` — the shape verified in pi-subagents 0.68.0 (`docs/models.md`, `src/agents/agents.ts parseBuiltinOverrideEntry`). pi-subagents removed `fallbackModels`, so fallback chains are *not* expressible there; the kit runner owns escalation. |
| `model-catalog.json` | model facts for the maintenance task: status (active/free-campaign/deprecated/removed), cost + postCampaignCost, contextK, vision, toolUse, heuristic quality scores, `location`/`local` power metadata. Concrete ids allowed here (adapter layer). |
| `maintenance-policy.json` | Phase 2 execution policy: requiredQuality per tier (monitor/evaluate/reconfigure), effective-cost weights, electricity price, escalation thresholds. |
| `lib/list-models.mjs` | optional `pi --list-models` availability probe for the maintenance task. Read-only; a provider absent from the listing means *unknown*, never *gone*. Parses both `provider/model` and the space-separated `provider  model  context ...` table. |
| `settings.template.json` | recommended `settings.json` fragment; sync only *reports* differences |
| `mcp.template.json` | shape of the pi-mcp-adapter config; proposal goes to `out/mcp.proposal.json` |
| `sync-pi.ps1` | dry-run by default; `-Apply` creates Junctions + generated `AGENTS.md`; `-BackupConflicts` moves conflicting entries to `<AgentDir>/ludi-agent-kit/backup-*`. Never writes `settings.json`. |
| `loop-guard/index.js` | model-independent pi Extension (ported from codex-setting) |
| `browser/agent-browser.mjs` | thin wrapper over the `agent-browser` CLI for the `browser` capability: argv construction, timeout, stdout/stderr normalization, and a per-command `kind` (read-only/low-risk/write/high-impact) kept for a future approval policy. No LLM logic inside. |
| `out/` | generated, gitignored: `AGENTS.md`, `plan.json`, `mcp.proposal.json`, `capabilities.resolved.json`, `settings.proposal.json`, `model-maintenance.{proposal,run,notification,state,lastrun}.json`, `model-maintenance.lock`, `model-observations.jsonl`, `catalog-diff.json`, `model-catalog.proposal.json`, `maintenance-preview.json`, `pipeline*/` traces |

## Model selection flow

```
agents/<name>.md  capability
   -> routing/routing.json   primary + fallback backends
   -> models.json + models.local.json   provider/model/thinking per backend
   -> "provider/model:thinking"  (pi --model syntax / pi-subagents model syntax)
```

Logical backends include `qoder` (cheap-first, bound to `qoder/Qwen3.8-Flash` on this
machine) and `devin` (strong-first, bound to `devin/swe-2-high`). Both are ordinary
pi providers — the kit never forks a runner per provider; bindings live only in
`models.local.json` and facts in `model-catalog.json`. If Codex quota is exhausted,
cheap-code still resolves `qoder -> cheap -> local -> sol` and strong-code
`devin -> qoder -> sol -> codex -> local`, so the orchestrator keeps running on
Qoder/Devin/FreeToken without any code change.

```powershell
node scripts/resolve-capabilities.mjs            # prints chains, writes out/settings.proposal.json + diff vs live settings
node scripts/run-pipeline.mjs --repo <dir> --task "..." --dry-run   # selection + prompts, no model call
node scripts/run-pipeline.mjs --repo <dir> --task "..."             # real run: scout -> pack -> coder -> tests
node scripts/run-pipeline.mjs --repo <dir> --task "..." --pack pack.md   # skip scout, supply a Context Pack
node scripts/reevaluate-models.mjs --events events.json --check-availability   # periodic re-evaluation -> out/model-maintenance.{proposal,run}.json
node scripts/reevaluate-models.mjs --events events.json --live                 # same, but really invokes the selected tier models via pi (spends quota; still proposal-only)
```

The maintenance task compares current bindings against `model-catalog.json` + provisioning
events and proposes changes only when a candidate beats the current model by a margin — a
free campaign ending alone never forces a switch. Phase 2 runs it as a tiered dry-run:
monitor -> evaluate -> reconfigure, each tier choosing its model under a
free -> cheapest-sufficient -> local-fallback policy (`maintenance-policy.json`), with the
selection rationale in `out/model-maintenance.run.json`. See `docs/model-maintenance.md`.

`orchestration` now resolves `qoder -> devin -> sol -> codex` for the optional model planner.
Normal orchestrator runs still default to the rules planner, which calls no planning model;
use `--planner model` on `scripts/orchestrate.mjs` to opt into model planning. This routing
does not change the model of the current pi chat or the live pi-subagents orchestrator agent.
The catalog records Qoder as a free campaign (expiry unknown) and Devin SWE-2-high
as user-reported free through 2026-10-10 JST, then priced. Verify the actual Devin
entitlement before live use. The maintenance run includes an advisory
`freeCapacityPlan` per capability, with quality gates, vision requirements and
campaign cutoffs; it does not rebind models automatically.

`out/settings.proposal.json` is a proposal only. To adopt it, merge the `subagents.agentOverrides`
block into `~/.pi/agent/settings.json` yourself (or wait for a future `-ApplySettings` that backs up
first). After that, `subagent({ agent: "coder" })` in pi launches with the routed model.

## What `-Apply` creates in the agent dir

```
~/.pi/agent/
  AGENTS.md                      generated (old file backed up)
  skills/<each kit skill>/       Junction -> ludi-agent-kit/skills/<name>
  agents/ludi-agent-kit/         Junction -> ludi-agent-kit/agents   (pi-subagents discovers *.md recursively)
  extensions/ludi-agent-kit/     Junction -> ludi-agent-kit/adapters/pi/loop-guard
  ludi-agent-kit/backup-*/       retained backups
```

Never modified: `settings.json`, `auth.json`, `models.json`, `models-store.json`, `mcp.json`, `sessions/`.

## Migrating from codex-setting Junctions

The current machine has `skills/*`, `agents` and `extensions/codex-settings` Junctions pointing at
`codex_setting`; the dry-run reports them as `conflict-junction->...`. `-Apply -BackupConflicts`
re-points the skill Junctions (link removal only; the target is untouched). Remove the old `agents`
and `extensions/codex-settings` links manually afterwards to avoid a duplicate loop guard.
