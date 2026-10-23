# Orchestrator (Phase 1)

One high-level request in, one integrated report out. The orchestrator plans, routes,
delegates, evaluates and decides; it never implements. Its main job is to cut down how
often the user gets asked something.

```
node scripts/orchestrate.mjs --dry-run "DOLL v2 Phase 2を進める"      # plan + routing only
node scripts/orchestrate.mjs --repo <dir> "Fix the failing test"       # run (agents read-only)
node scripts/orchestrate.mjs --repo <dir> --apply "..."                # coder tasks via scout->coder pipeline (writes)
  [--planner rules|model] [--policy <file>] [--out <dir>] [--json] [--trace]
```

Before starting a persistent run, the planner's capability (for `--planner model`) and every capability in the validated task plan must have at least one non-placeholder binding. Otherwise the call fails without creating a run and reports the user-level `models.local.json` path. Existing runs can still be listed/shown; resuming pending tasks checks their bindings. The check does not guarantee provider authentication, quota, or model availability. Configure `~/.pi/agent/ludi-agent-kit/models.local.json` (or `$env:PI_CODING_AGENT_DIR/ludi-agent-kit/models.local.json`) and see `adapters/pi/README.md` for migration precedence.

## Response language

All agents default to **Japanese** for user-facing output (summaries, reports, decisions,
status messages). The policy lives once in `lib/language-policy.mjs` and is appended to
every agent's system prompt by `loadAgents` — never duplicated into `agents/*.md`, never
per-provider. Schema keys/enums (`status`, `completed`, Context Pack `##` headings, JSON
field names) stay in English; only natural-language values are Japanese. An explicit user
language request ("英語で", "in English") overrides the default. `formatReport` already
renders 状態/完了/自動判断/未解決/ユーザー判断が必要 in Japanese.

## Modules (`lib/orchestrator/`)

| Module | Responsibility |
| --- | --- |
| `planner.mjs` | request -> task specs. `rules` (deterministic keyword template, default) or `model` (orchestrator agent returns JSON; invalid output falls back to rules). `validatePlan` checks ids, deps, cycles, agents, capabilities, `max_tasks`. |
| `task-store.mjs` | `createMemoryTaskStore` (Phase 1) plus `runnableTasks`, `strandedTasks`, `findCycle`. The persistent adapter is `store.mjs`. |
| `store.mjs` | SQLite run, task, decision, decision-memory, backend-health and trace store. |
| `health.mjs` | Classifies usage-limit and rate-limit failures and skips a backend until its TTL. |
| `router.mjs` | task -> agent -> capability through `agents/*.md` + `routing.json`; models via `lib/resolve.mjs`. Retries escalate along `routing.escalation.ladders`. |
| `runner.mjs` | AgentRunner adapter: `withEscalation` + adapter `invoke` (pi CLI), or `runPipeline` for `--apply`. Appends the structured-result contract; agent files are unchanged. |
| `evaluator.mjs` | Success only with status `completed`, a summary, required outputs present and every acceptance criterion `A<n>` met with evidence. |
| `escalation.mjs` | Escalation gate (below). |
| `policy.mjs` | Defaults <- `orchestration/decision-policy.json` <- `decision-policy.local.json` / `--policy`. |
| `execution-manager.mjs` | After a bounded task run, one deterministic action: complete / extend / continue / split / reassign / retry / escalate / approval_required / stop. |
| `review-policy.mjs` | Strict review-finding schema (severity info..blocking + `FINDING_CLASSES`), bounded repair/replan policy, `completionGate`. |
| `orchestrator.mjs` | The loop, `dryRun`, `formatPlan`, `formatReport`. |
| `api.mjs` | Start, resume, list, show and answer. CLI and the pi extension both call this. |

## Loop

Each round: take runnable tasks (pending, all dependencies completed), run up to
`max_parallel_tasks` read-only tasks, then evaluate each result. Write-capable agents
run in exclusive rounds in the shared workspace, without overlapping readers or other writers.
The standard runner also takes a cross-process writer lease before baselining or
execution. Its temporary SQLite registry is independent of run stores and uses
the physical repository root (including junction aliases/subdirectories). A
competing writer is blocked; retry after the owner finishes. Leases are released
on completion/error, and a live owning process is never evicted by a timeout.
Caller-injected runners must enforce the same ownership contract.
- **success**: the task completes, and any `newTasks` it reports are added (bounded by `max_tasks`).
  If a review reports blocking issues, the work is sent back to the implementer and a
  re-review is added (`max_rework_cycles`).
- **failure**: the retry strategy depends on the failure class (`failures.mjs`):
  - **Protocol-quality failures** (`MALFORMED_RESULT`, `EMPTY_RESPONSE`, and turn-limit
    `TIMEOUT` with no tool progress) mean the model could not honour the contract — the
    SAME attempt advances to the next routing candidate instead of retrying that model.
    When the current capability has no untried candidate left, the task escalates to the
    next capability on the ladder (e.g. cheap-code -> strong-code).
  - **Recoverable failures** (`TEST_FAILURE`, `TOOL_FAILURE`, validation `UNKNOWN`, a
    turn-limit `TIMEOUT` that DID make tool progress) retry the same model with feedback.
  - Two-layer tried history. `task.attemptedModels` is the CAPABILITY-LOCAL tried
    list (reset on escalation so the new capability's candidates re-resolve).
    `task.taskGlobalFailedModels` is the TASK-GLOBAL list: a model that hit a
    protocol-quality failure (malformed / empty / no-progress turn-limit) is skipped
    for the WHOLE task even after escalation — so cheap-code's failed Qwen is never
    re-invoked on strong-code. Recoverable failures (tool/test/validation) do NOT
    mark a model task-global.
  - Attempt budget: `model_attempts_per_task` caps candidates per attempt;
    `max_total_attempts_per_task` caps total REAL invocations. Only an actual
    model/provider invocation counts — health-TTL skips, unavailable candidates,
    already-tried skips and enumeration do NOT consume budget. Each result carries
    `counters = { candidatesConsidered, candidatesSkipped, invocationsStarted }` so
    the budget display shows real invocations (e.g. `3/4`), not candidates seen.
  Once retries (or the model-attempt budget) run out the task is marked failed.

### Subagent execution budget

Turn limits are per-role and per-complexity, not a single global value
(`agent_runtime.turn_budgets`). `classifyTaskComplexity` rates a task
simple/normal/heavy/repo-history-heavy from its goal; `initialTurnBudget` resolves
the starting turn cap. When a subagent reaches that cap, a deterministic
`progressScore` (tool calls + unique files + commands − repeats) decides whether
to grant a bounded extension (`extension_turns` × `max_extensions`, capped by
`absolute_max_turns`). A no-progress agent stops immediately as
`NO_PROGRESS_TIMEOUT` (task-global model failure); a progressing agent that still
exceeds the absolute cap is `PROGRESS_TIMEOUT` — recoverable, NOT a model-quality
failure, so it is not added to `taskGlobalFailedModels`. Extension happens inside
one model invocation and never consumes `max_total_attempts_per_task`.

The planner also splits multi-concern investigations (e.g. commit-history +
UI-implementation + synthesis) into focused sub-tasks so no single scout is
overloaded — task sizing comes before turn budget.
- **blocked**: the agent needs a decision, so each decision goes through the escalation gate.

Protocol reliability is audited per provider/model in the `protocol_stats` table
(malformed / empty / turn_limit / structured_ok counts). This is telemetry only — it is
NOT fed back into routing scores.

The loop stops when no task is runnable or `max_rounds` is reached. Tasks whose
dependency failed or is blocked become `blocked`. The full event log is kept in
`result.trace`, and the CLI writes it to `<out>/orchestration-trace.json`.

## Escalation gate

1. **Hard gate.** A decision flagged `external_publish`, `destructive_action`, `production_risk`,
   `high_cost`, `project_cancellation`, `major_direction_change` or `user_value_judgement` goes to
   the user when that flag is enabled in policy. Flags come from the agent, from numbers
   (`costUsd >= high_cost_threshold_usd`, `estimatedWeeks >= major_direction_change_weeks`), or
   from policy keywords. This step is first, so a remembered answer cannot authorize it.
2. **Current run.** Reuse a decision already made in this run with the same key.
3. **Persistent decision memory.** Reuse an explicit user answer (or another saved rule) from an
   earlier run when it is still in scope and not expired. Automatic choices are not saved.
4. **Single option.** Take the only viable option.
5. **Reversible.** Choose the best-scoring option (`reversible_decision: auto`).
6. **Low risk / low cost.** Choose one (`low_risk_decision: auto`).
7. **Project policy.** Prefer existing assets, maintainability and reversibility, but only
   when this gives a unique winner.
8. **Small experiment.** If the estimate is within `poc.prefer_if_estimated_hours_lte` hours,
   add an experiment task and resume the blocked task afterwards. Each decision gets at most one experiment.
9. **Otherwise** escalate. With a store, the run becomes `waiting_for_user` and the decision is
   kept until `orchestrate.mjs --resume <run> --answer <decision> "<text>"`.

## Persistent runs (Phase 2)

State lives in SQLite (`node:sqlite`), default `.orchestration/state.db`, override with `--store`
or `LUDI_ORCHESTRATION_STORE`. SQL stays in `lib/orchestrator/store.mjs`. `createMemoryTaskStore`
is the Phase 1 store; `openStore().openTaskStore(runId)` is the persistent one. The in-memory
loop is unchanged when no session is passed.

```
node scripts/orchestrate.mjs --list
node scripts/orchestrate.mjs --decisions
node scripts/orchestrate.mjs --show <run-id>
node scripts/orchestrate.mjs --resume <run-id> --answer <decision-id> "use the existing approach"
```

Resume does not rerun `completed` tasks, does not reset attempts, rework cycles, rounds or the
task cap, and uses the policy snapshot stored with the run. A task left `running` by a crash is
put back to `pending`. A backend that returns `usage limit has been reached` is skipped for the
rest of the run and, until `backend_health.usage_exhausted_ttl_hours`, for later runs. Rate limits
stay on the run that saw them. There is no permanent blacklist.

pi loads `adapters/pi/orchestrator-ext` as `extensions/ludi-orchestrator` (`/orchestrate`, tool
`ludi_orchestrate`). The programmatic boundary is `lib/orchestrator/api.mjs`.
During start/resume/answer, the orchestrator reports start, plan, dispatched tasks,
individual child arrivals, evaluated task status, and final status. The pi tool streams
these as live updates; `/orchestrate` uses UI notifications; the CLI writes progress to
stderr (keeping `--json` stdout parseable). The final integrated report remains unchanged.
Callers of `startOrchestration` / `resumeOrchestration` can supply `onProgress(message)`;
observer errors never interrupt execution.

## Tool-capable children (Phase 3)

`execution: subagent` launches a tool-capable child. In the pi-hosted orchestrator
(`extensions/ludi-orchestrator`) the child runs **natively in-process** via
`adapters/pi/lib/native-subagent.mjs`: each invocation registers a uniquely named
runtime agent (`pi-subagents:runtime-agent-register:v1`) carrying the agent's system
prompt, the access-derived tool allowlist plus a hidden `ludi_guard` sentinel, and a
generated guard extension enforcing the initial turn/tool caps at `turn_start`
(before provider work) and with sticky `tool_call` blocks (no adapter-local
progress extension — parent-owned budgets still grant continuation). The child is
then delegated through the `prompt-template:subagent:*` foreground contract with the
pinned model, `context:'fresh'`, `skill:false`, `intercomBridge:{mode:'off'}` and a
hard tool budget. If the pi-subagents owner is absent, the host picks the `pi --mode
json -p` subprocess launcher once — only before native dispatch — and records
`transportFallback: 'no-native-owner'`; after dispatch, cancel or failure the
native verdict is final for the task (never a silent fallback, rerun, or model
candidate advance). The CLI (`scripts/orchestrate.mjs`) keeps the
subprocess launcher unchanged. When a stop cannot be confirmed (cancel sent, no
matching terminal within the bounded grace), the task returns an `unconfirmedStop`
blocker. The workspace writer lease is released only after both the exact terminal
and the required child guard's quiescence proof (`shutdown:true`, `pendingTools:0`).
The native owner can hard-finish a cancelled session before a tool settles, so a terminal
alone is not enough. Missing/stale guard evidence also retains the lease. Native shell
execution waits for owned process/tree termination rather than treating kill grace expiry
as completion. Before native writer dispatch the generic lease is quarantined, so even
owner-process death does **not** permit automatic recovery: orphan shell processes may
survive the host. An operator must stop/verify those processes and manually recover the
specific registry entry. Restarting/reloading alone is not proof, and automation never
clears that entry without confirmation. Only cooperating runtimes with the updated
lease protocol honor this quarantine; it is not an OS sandbox. Private Promise state never reaches
SQLite/task JSON. Temporary runtime agent identities do not inherit named role overrides;
operator-wide model scopes/ceilings and the kit's routing still apply.

In the subprocess path (`pi --mode json -p`) `--tools` is limited by `access` (filesystem, shell, git, network). Shell is `ludi_exec` in `adapters/pi/shell-gate`, which refuses push, publish, deploy, reset, and recursive delete before the process runs. `--apply` still uses the old pipeline. With no subagent launcher, `subagent` falls back to the one-shot invoker. A child id, tool count, and turn count are stored on the run trace. Runtime, tool-call, and turn caps are `agent_runtime` in the decision policy. Only `MODEL_FAILURE` and `BACKEND_LIMIT` move up the routing ladder; a failing test retries the same capability with the previous attempt in the contract.

Shell commands must be single literal commands: command chaining, pipelines,
redirection, expansion and script expressions are refused. Executable paths and
supported global options are normalized; unsupported Git/package-manager option
forms are refused. PowerShell recursive-delete abbreviations are also refused.
Recursive deletion has
no exception for build directories. This gate is not an OS sandbox: allowed tests
and builds execute repository code, so use trusted workspaces.

The CLI previews `--delete ID` unless `--force` is supplied. `--dry-run` always
previews cleanup, even when combined with `--force`.

Dry-run prints mode, workspace, tools, model, dependencies, and acceptance, and does not start pi.

## Phase 4 gaps (Asana -> persistent orchestrator -> tool-capable agents -> Asana)

- An `ExternalProjectStore` implementation for Asana that maps tasks, sections and comments, is
  idempotent, and runs dry-run first. The run store stays separate from that project store.
- An intake adapter that turns an Asana task into a request plus acceptance criteria.
- ~~A direct pi-subagents launcher.~~ Implemented for the Pi-hosted orchestrator as
  `adapters/pi/lib/native-subagent.mjs` (runtime-agent registration + structured
  delegation over `pi.events`; see “Tool-capable children”). The CLI path still uses
  `pi --mode json -p`; `createPiInvoker` remains an asynchronous fallback for one-shot
  and model-planning calls. [Native evidence](reports/native-launcher.md) records the
  installed Pi/pi-subagents owner exercising reads, writes, gated shell, a turn cap and
  caller abort with a local deterministic provider; no hosted-model billing was used.
  Hermetic unit tests additionally exercise unconfirmed-stop lease retention.
- ~~Parallel execution for one-shot invocations.~~ Implemented with asynchronous
  `spawn` in `createPiInvoker`; existing concurrency limits and writer exclusion
  are unchanged. Local-process barrier tests prove real overlap and independent
  prompt lifetimes, without hosted-model calls; see [evidence](reports/oneshot-async.md).
  Optional caller signals stop candidate advancement in the oneshot runner. This
  does not add a new top-level cancel command or wire signals into every planner,
  maintenance or legacy pipeline caller. Timeout/abort requests target the owned
  CLI PID and wait for close, not an invented stop after a grace timer. It is not
  an OS process-tree sandbox.
- An acceptance rubric verified as shared by all agents. The review-finding severity/classification
  schema already exists (`review-policy.mjs`, injected via the task contract's
  `REVIEW_FINDING_CONTRACT` on review/verify/reverify tasks); what remains open is one common
  acceptance rubric validated across every agent type.
