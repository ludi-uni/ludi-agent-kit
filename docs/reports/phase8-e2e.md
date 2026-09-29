# Phase 8 controlled orchestration E2E

Reproduce: `node --test tests/phase8-e2e.test.mjs` (then `node --test tests/`). The test creates disposable Git and SQLite repositories under the OS temp directory; it does not touch the real Strategy Evolution Lab repository. `tests/fixtures/phase8-runtime.mjs` supplies deterministic worker responses and three controlled route bindings. It does **not** replace the production design planner, orchestration loop, execution/budget/route policy, review policy, graph store, or SQLite persistence. The resume step launches `tests/fixtures/phase8-resume-child.mjs` in a new Node process and claims the same persisted run. The on-disk SQLite trace contains the full ordered `planning-start`, `planning-result`, `plan`, `round`, `result`, `execution-decision`, `child`, `task-added`, `review-finding`, `replan-diff`, `final-report` events, including the deliberately injected process error and the subsequent resume. A successful representative run had 13 initial work items, 24 final tasks, 13/13 satisfied acceptance criteria and four resolved findings.

## Initial graph and ledger

- `t1` current-state investigation → `t2` baseline → `t3` storage/resume → `t4` comparison → `t5` multi-seed experiment → `t6` CLI/storage/audit export → `t7` scientific investigation → `t8` validation → `t9` bias/leakage audit → `t10` documentation → `t11` integration review → `t12` integration assumption verification → `t13` documentation handoff verification.
- 13 immutable acceptance identities: `AC_STATE`, `AC_BASE`, `AC_RESUME`, `AC_COMPARE`, `AC_SEEDS`, `AC_S1`, `AC_S2`, `AC_S3`, `AC_ROLE`, `AC_ESC`, `AC_AUDIT`, `AC_DOC`, `AC_PLAN`. All began pending; at the crash checkpoint `AC_STATE` and `AC_BASE` were satisfied. The original canonical request expressly preserved dirty changes and prohibited paid models.
- At the interruption checkpoint a controlled user answer is recorded in the decision store: preserve dirty worktree changes and prohibit paid models. The answered decision survives process restart, escalation, repair and replan; the original goal retains the same constraints.
- The fixture's original tracked `preexisting.txt` was modified before execution. Its bytes remain unchanged after continuation, review, repair, replanning and process restart; generated `storage.py` and `runner.py` retain their worker output.

## Chronological decisions and rationale

| Step | Action | Persisted policy reason / observable consequence |
| --- | --- | --- |
| Design | plan | 13 distinct tasks spanning investigation, implementation, experiments, audit, documentation and verification; acceptance coverage validated. |
| `t3` | continue → `t3.c1` | `continue.partial-progress`: storage and loader complete; only CLI and test residuals handed off; original `t3` ran once. Process stopped after continuation commit and resumed in another Node process. |
| `t4` | extend → `t4.c1` | `budget.extend.healthy-progress`: comparison core done, recent progress near turn limit, bounded limit 32→48. |
| `t5` | retry | `retry.transient-signature`: first `UND_ERR_SOCKET`; no project repair or capability downgrade. |
| `t6` | split | `split.explicit-remaining-work`: three independent CLI, storage and audit export residuals, not a giant retry. |
| `t7` | reassign | `reassign.role-mismatch`: coder → scout, with no model escalation. |
| `t8` | retry → escalate | `escalate.safe-first-retry`, then `escalate.bounded-free-route`: repeated genuine capability failure on standard/free `fixture/a` → strong/free `fixture/b`; paid `fixture/c` invoked zero times. |
| `t11` | investigate / repair / reverify / replan | Blocking shell limitation used a read-only alternate audit path and generated zero project repairs; `runner.py` resume defect produced one focused repair and passing reverify; missing experiment evidence produced reverify without repair; invalid runtime/storage/comparison assumption went to the same design planner. |
| Final | completion gate | After residual execution and reverify, all 13 required criteria satisfied, all four findings resolved, no pending approval/reverify; completed. |

Separate terminal negative runs show stalled turn limits do **not** extend, repeated identical `UND_ERR_SOCKET` stops after one retry, and neither a pending criterion nor a blocking defect awaiting evidence permits completion. Existing escalation integration tests exercise paid-route `approval_required` with zero paid invocations.

## Replan graph diff and final graph

- Preserved verified `t1`–`t11`, the already completed `t3.c1`, `t4.c1`, `t6.s1-1`–`t6.s1-3`, and the other unaffected live focused tasks.
- Superseded (not deleted) obsolete `t12`; added `rp1-residual` for `AC_PLAN` and `rp1-t11-PLAN-verify`.
- Rewired still-pending `t13`: dependency `t12` → `rp1-t11-PLAN-verify`. Diff contains the changed dependency, complete kept/superseded/new task IDs, finding rationale, and targeted `AC_PLAN`. It does **not** supersede the unrelated pending `AC_RESUME` repair or `AC_AUDIT` investigation.
- Final graph: the 13 original tasks, `t3.c1`, `t4.c1`, three `t6` split children, alternate-path investigation, focused defect repair, two finding reverifications, replan residual and replan verification (24 task records). `t3`/`t4`/`t6` remain traceable partial parents and `t12` a traceable superseded node; all required active descendants complete.

## Metrics (representative passing run)

| Metric | Value |
| --- | ---: |
| Initial / final tasks | 13 / 24 |
| Continuations including bounded extension | 2 |
| Retries / splits / reassignments | 2 / 1 / 1 |
| Extensions / free escalations | 1 / 1 |
| Focused repairs / replans | 1 / 1 |
| Review rounds | 7 |
| Approval requests / blocked findings at completion | 0 / 0 |
| Prevented duplicate continuations / extensions / escalations / repairs on replay | 1 / 1 / 1 / 1 |
| Completed acceptance ratio | 13 / 13 |

The test replays persisted partial, budget and failure decision keys, repeats the identical defect finding in the reviewer output, checks duplicate-finding policy, and resumes the completed run with a runner that throws if any worker executes. Decision/task/finding counts do not increase.

## Original failure comparison

| Original failure | Phase 8 observation |
| --- | --- |
| Giant `t2` | 13-role design-first decomposition; implementation, experiment, scientific audit and documentation are separate. |
| Same task rerun after 49 turns | `t3` executes once; `t3.c1` only performs the remaining CLI and test work using recorded progress and `storage.py` workspace reference. |
| Shell limitation → repair `t5` | `environment_limitation` and alternate-path investigation; project repair count for this finding is zero. |
| Retry loses work | Continuation keeps lineage, residual IDs, workspace reference and existing file contents across a separate process. |
| Mechanical failure on turn ceiling | `t4` with recent progress extends 32→48; separately stalled work stops without extension. |

## Real-provider boundary

`pi auth check --provider freetoken` returned `ready`, and `pi --list-models freetoken` listed `Qwen3.6-35B-A3B-NVFP4`. However, the local `models.local.json` binds routing backend `local` to the remote provider `freetoken`, while `routing.json` describes `local` as *locally hosted/free*. Neither auth readiness nor model discovery proves this remote route is free/included. Accordingly no real-provider invocation was made under the explicit no-additional-cost restriction. The controlled fixture is a lifecycle integration run, not evidence of production-provider reliability or readiness for rollout.
