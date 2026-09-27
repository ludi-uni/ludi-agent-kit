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
| `orchestrator.mjs` | The loop, `dryRun`, `formatPlan`, `formatReport`. |
| `api.mjs` | Start, resume, list, show and answer. CLI and the pi extension both call this. |

## Loop

Each round: take runnable tasks (pending, all dependencies completed), run up to
`max_parallel_tasks` of them, then evaluate each result.
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

`execution: subagent` runs `pi --mode json -p` with `--tools` limited by `access` (filesystem, shell, git, network). Shell is `ludi_exec` in `adapters/pi/shell-gate`, which refuses push, publish, deploy, reset, and recursive delete before the process runs. `--apply` still uses the old pipeline. With no subagent launcher, `subagent` falls back to the one-shot invoker. A child id, tool count, and turn count are stored on the run trace. Runtime, tool-call, and turn caps are `agent_runtime` in the decision policy. Only `MODEL_FAILURE` and `BACKEND_LIMIT` move up the routing ladder; a failing test retries the same capability with the previous attempt in the contract.

Dry-run prints mode, workspace, tools, model, dependencies, and acceptance, and does not start pi.

## Phase 4 gaps (Asana -> persistent orchestrator -> tool-capable agents -> Asana)

- An `ExternalProjectStore` implementation for Asana that maps tasks, sections and comments, is
  idempotent, and runs dry-run first. The run store stays separate from that project store.
- An intake adapter that turns an Asana task into a request plus acceptance criteria.
- A direct pi-subagents launcher. The current tool-capable child path uses `pi --mode json -p`;
  `createPiInvoker` remains a synchronous fallback for one-shot and model-planning calls.
- Parallel execution for one-shot invocations. Tool-capable children use asynchronous `spawn`,
  while the one-shot invoker still uses `spawnSync`.
- A reviewer severity schema and an acceptance rubric shared by all agents.
