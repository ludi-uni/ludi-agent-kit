# pi adapter

Binds the neutral kit to a native-Windows pi installation (`~/.pi/agent`, or
`$env:PI_CODING_AGENT_DIR`).

| File | Role |
| --- | --- |
| `models.json` | shared TEMPLATE: logical backend -> pi `provider`/`model`/`thinking`. Ships with `TODO-*` placeholders that the resolver skips. |
| `~/.pi/agent/ludi-agent-kit/models.local.json` | **Recommended durable user-level bindings**, outside the npm install (use `$env:PI_CODING_AGENT_DIR/ludi-agent-kit/models.local.json` when set). Copy `models.local.example.json` and fill from `pi --list-models`. Overrides package-local bindings per field and may add backends. Allowed keys: `provider, model, thinking, vision, note`; credentials are rejected. The kit reads this file but never writes it. |
| `models.local.json` | **gitignored package-local migration fallback**; still overrides `models.json` when present, but is overridden by the user-level file. Existing machine-local files continue to work without migration; a package upgrade may remove this file. |
| `lib/invoke.mjs` | one-shot model call through the installed pi CLI (`node <pi cli.js> -p --model provider/id:thinking --no-tools --no-session --no-approve --system-prompt ...`). Uses asynchronous `spawn` (no event-loop blocking); separate temporary prompt files; 16 MiB per stdout/stderr stream; optional AbortSignal. Timeout/cancel sends SIGTERM then SIGKILL only to the owned CLI PID and waits for confirmed close before returning/cleanup, even beyond grace (not process-tree isolation). Existing routing/concurrency limits stay unchanged. See [one-shot evidence](../../docs/reports/oneshot-async.md). Uses pi's own auth store. The prior subprocess path was verified against `qoder/Qwen3.8-Flash` and `devin/swe-2-high` — no provider-specific runner is needed; any provider registered in pi's model store works. CLI entry discovery: `LUDI_PI_ENTRY` first, then `pi` on PATH covering both the npm layout (`<dir>/node_modules/@earendil-works/pi-coding-agent`) and the managed install (`<agent>/bin` beside `<agent>/install/releases/<current-version>`); no fixed user paths. |
| `lib/subagent.mjs` | tool-capable child (`pi --mode json -p`). **Do not pass `--no-extensions`**: providers registered by pi extensions (qoder, devin) are absent from the static model store and only resolve once their extension has loaded; with `--no-extensions` `--model` fails `Model ... not found`. Kit extensions the child needs are passed explicitly (`-e shell-gate`). |
| `lib/native-subagent.mjs` | in-process child launcher used by the `ludi-orchestrator` extension. Registers one uniquely named runtime agent per invocation over `pi-subagents:runtime-agent-register:v1` and dispatches a foreground `prompt-template:subagent:request` with `context:'fresh'`, the pinned `provider/model[:thinking]`, `toolBudget:{hard, block:'*'}`, `skill:false`, `intercomBridge:{mode:'off'}`. The generated per-launch guard extension (`native-guard.mjs` + `shell-gate` bound policy) pins the tool allowlist, a hidden `ludi_guard` sentinel (required by the allowlist, so a missing guard fails before the prompt), `extensions:[]` (no ambient/configured/provider-plugin duplication, no MCP, no nested subagents), and hard turn/tool caps — enforced at `turn_start` before provider work and via sticky `tool_call` blocks, with a private sidecar recording sanitized stop metadata, pending tool count and shutdown state. Native enforces the resolved *initial* limits directly, with no adapter-local progress extension; parent-owned continuation/extension still applies. Only `pi.events` is used; no internal pi-subagents imports. If no compatible owner answers registration (pi-subagents absent), the host may pick the subprocess launcher **once, before dispatch** (`transportFallback:'no-native-owner'`); after dispatch, cancel, or failure the native verdict is terminal (`terminal:true`, `abort`) — never a model-candidate retry or subprocess rerun. On timeout/abort/uncertain emit the launcher emits the exact `{requestId, ownerRunId, nodeId}` cancel and drains a bounded grace (15 s default); if no matching terminal arrives, the result is an `unconfirmedStop` blocker, the writer lease is retained until the exact terminal **and** guard quiescence (`shutdown:true`, `pendingTools:0`), and the private retention Promise is stripped before results reach task/trace JSON — native writer leases are quarantined **before dispatch**, so host death also requires operator verification of orphan processes and manual recovery of the exact registry entry, never automatic reuse. `dispose()` keeps proof resources (listener/registration/guard dir) until terminal and quiescence proof; an owner shutdown that loses proof requires manual recovery, not merely an extension reload or host restart. Native shell cancellation waits for the owned shell/tree to stop; an elapsed kill grace is never treated as proof. The event bus is process-local and composes trusted code, not an OS sandbox: allowed commands still execute repository code in trusted workspaces. Runtime identities are temporary; named role overrides are not copied onto them. Operator-wide model scopes/ceilings and the kit's pinned routing remain authoritative. See [native evidence](../../docs/reports/native-launcher.md) for the installed-owner tests with a local deterministic provider (not live hosted-model evidence). |
| `lib/settings-proposal.mjs` | renders resolved agents into `subagents.agentOverrides.<agent>.{model,thinking}` — the shape verified in pi-subagents 0.68.0 (`docs/models.md`, `src/agents/agents.ts parseBuiltinOverrideEntry`). pi-subagents removed `fallbackModels`, so fallback chains are *not* expressible there; the kit runner owns escalation. |
| `model-catalog.json` | model facts for the maintenance task: status (active/free-campaign/deprecated/removed), cost + postCampaignCost, contextK, vision, toolUse, heuristic quality scores, `location`/`local` power metadata. Concrete ids allowed here (adapter layer). |
| `maintenance-policy.json` | Phase 2 execution policy: requiredQuality per tier (monitor/evaluate/reconfigure), effective-cost weights, electricity price, escalation thresholds. |
| `lib/list-models.mjs` | optional `pi --list-models` availability probe for the maintenance task. Read-only; a provider absent from the listing means *unknown*, never *gone*. Parses both `provider/model` and the space-separated `provider  model  context ...` table. |
| `lib/startup-check.mjs` | offline isolated startup/RPC registration check behind `scripts/check-pi.mjs`: temp agent dir populated by `sync-pi.ps1 -Apply` (never `-ApplySettings`), then `pi --mode rpc --offline` verifies `orchestrate` + the three skill commands with physical targets, zero activity/usage, and the single loop-guard entry. Agent definitions are verified structurally (junction target + parsed content) — RPC exposes no agent registry, and pi-subagents is a separate package this check does not install. No model calls, no user config writes. |
| `lib/settings-apply.mjs` | two-phase opt-in settings merger behind `sync-pi.ps1 -ApplySettings`: SHA256 snapshot captured before resolution, deterministic `settings.json.ludi-apply.lock` sidecar serializes cooperating kit applies (`wx`, never evicts), digest re-verified immediately before a same-directory staging file is atomically renamed into place. Merges only `subagents.agentOverrides.{scout,coder,visual,reviewer}.{model,thinking}`; every other field/role/key is preserved. Byte-for-byte backup under `<AgentDir>/ludi-agent-kit/backup-*/settings.json`; refuses malformed JSON/roots, concurrent create/edit/delete, busy locks and symlinked paths. Unit-tested in `tests/settings-apply.test.mjs`; also runnable as a CLI (`--settings/--proposal`). |
| `settings.template.json` | recommended `settings.json` fragment; sync only *reports* differences (these keys are never applied) |
| `mcp.template.json` | shape of the pi-mcp-adapter config; proposal goes to `out/mcp.proposal.json` |
| `sync-pi.ps1` | dry-run by default; `-Apply` creates Junctions + generated `AGENTS.md` only; `-ApplySettings` (separate opt-in, combinable) merges role models into `settings.json` with backup/round-trip/concurrency checks; `-BackupConflicts` moves conflicting link entries to `<AgentDir>/ludi-agent-kit/backup-*`. Without `-ApplySettings`, `settings.json` is never written. |
| `loop-guard/index.js` | model-independent pi Extension (ported from codex-setting) |
| `browser/agent-browser.mjs` | thin wrapper over the `agent-browser` CLI for the `browser` capability: argv construction, timeout, stdout/stderr normalization, and a per-command `kind` (read-only/low-risk/write/high-impact) kept for a future approval policy. No LLM logic inside. |
| `out/` | generated, gitignored: `AGENTS.md`, `plan.json` (link plan + `settingsApply` scope/digest section), `mcp.proposal.json`, `capabilities.resolved.json`, `settings.proposal.json`, `model-maintenance.{proposal,run,notification,state,lastrun}.json`, `model-maintenance.lock`, `model-observations.jsonl`, `catalog-diff.json`, `model-catalog.proposal.json`, `maintenance-preview.json`, `pipeline*/` traces |

## Model selection flow

```
agents/<name>.md  capability
   -> routing/routing.json   primary + fallback backends
   -> models.json < package-local models.local.json < user-level models.local.json
      provider/model/thinking per backend (later source overrides fields)
   -> "provider/model:thinking"  (pi --model syntax / pi-subagents model syntax)
```

Logical backends include `qoder` (cheap-first, bound to `qoder/Qwen3.8-Flash` on this
machine) and `devin` (strong-first, bound to `devin/swe-2-high`). Both are ordinary
pi providers — the kit never forks a runner per provider; bindings live only in
the user-level `models.local.json` (or legacy package-local file) and facts in `model-catalog.json`. If Codex quota is exhausted,
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

`out/settings.proposal.json` is a proposal only. To adopt it, either merge the `subagents.agentOverrides`
block into `~/.pi/agent/settings.json` yourself, or run `pwsh adapters/pi/sync-pi.ps1 -ApplySettings`
(explicit opt-in: backs up the original bytes, merges only `{scout,coder,visual,reviewer}.{model,thinking}`,
verifies the JSON round-trip, and refuses if the file changed since the plan was captured). Restart pi or
`/reload` afterwards. Higher-priority project settings or provider-scoped role overrides can
still win; inspect `/subagents-models` to confirm the effective live mapping. The apply uses
its own resolver output in memory, not the shared preview file, so simultaneous syncs for
different agent directories cannot exchange proposals.

## What `-Apply` creates in the agent dir

```
~/.pi/agent/
  AGENTS.md                      generated (old file backed up)
  skills/<each kit skill>/       Junction -> ludi-agent-kit/skills/<name>
  agents/ludi-agent-kit/         Junction -> ludi-agent-kit/agents   (pi-subagents discovers *.md recursively)
  extensions/ludi-agent-kit/     Junction -> ludi-agent-kit/adapters/pi/loop-guard
  ludi-agent-kit/backup-*/       retained backups
```

Never modified by `-Apply`: `settings.json`, `auth.json`, `models.json`, `models-store.json`, `mcp.json`, `sessions/`.
`-ApplySettings` modifies *only* `settings.json` (scoped to the four kit roles' `model`/`thinking`,
byte-for-byte backup first). Concurrency caveat: the digest check + `.ludi-apply.lock` sidecar detect
concurrent changes and serialize cooperating kit applies, but the check-then-rename is not a kernel
compare-and-swap — a non-cooperating external editor writing between the final check and rename
could still lose its edit; do not edit `settings.json` while a sync run is in flight.
A stale `.ludi-apply.lock` is never automatically evicted; remove it manually only after
confirming no apply process is active.

## Migrating from codex-setting Junctions

The current machine has `skills/*`, `agents` and `extensions/codex-settings` Junctions pointing at
`codex_setting`; the dry-run reports them as `conflict-junction->...`. `-Apply -BackupConflicts`
re-points the skill Junctions (link removal only; the target is untouched). Remove the old `agents`
and `extensions/codex-settings` links manually afterwards to avoid a duplicate loop guard.
