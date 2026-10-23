# Real-provider orchestration E2E

## Scope and authorization

The user authorized either Devin SWE-2 or Qoder Qwen3.8 Flash for this bounded
acceptance run. This is authorization for those routes, **not** evidence that they
are free, included, or permanently available. Billing totals were not measured.

The test used the production orchestrator, agent contracts, evaluator, runner,
shell gate, workspace lease and SQLite store. Its explicit four-task plan was
investigation -> implementation -> test -> review. It did not test model planning,
crash/resume, adaptive replanning, or every Phase 8 scenario with a live provider.

## Execution controls

- Each attempt used a fresh temporary Git copy of `tests/fixtures/math-repo`.
- Routing and registry restrictions were in memory only: one selected backend,
  no fallback candidates and no escalation ladder. User settings were untouched.
- At most four model invocations per run, one per task, zero retries/rework,
  120 seconds per invocation, eight turns and sixteen tool calls per task,
  with no budget extensions. One-shot fallback was explicitly forbidden.
- The parent ran the initial failing tests and independently checked the final
  tests and Git changes. Models did not modify this kit repository.

## Observed runs (2026-10-22 UTC)

| Run | Model | Observed outcome |
| --- | --- | --- |
| `run-mvjmk9ir-37a91b` | `qoder-bridge/Qwen3.8-Flash:low` | Investigation completed without recorded tool calls (the contract included a repository survey). Its `reviewFindings` contained a string instead of a structured finding. Implementation timed out after 120 seconds with no recorded tool calls or file changes; downstream tasks were blocked. Two invocations. |
| `run-mvjmox6j-35e789` | `devin/swe-2-high:high` | Investigation used three tools/two turns and correctly reproduced the failing test. The evaluator rejected its unannotated failed verification as `CONTRADICTORY_EVIDENCE`; downstream tasks were blocked. One invocation. |
| `run-mvjn0jpf-278393` | `devin/swe-2-high:high` | After the focused evaluator/contract correction, all four tasks completed, with no escalation, retry or unresolved issue. Four invocations. |

The Qoder observation does not establish a general provider defect or permanent
unavailability. No identical timeout trial was repeated. The first Devin result
remains rejected under the new rules: unannotated failures are not retroactively
converted into successful evidence.

## Focused correction

`lib/orchestrator/evaluator.mjs` now recognizes an explicitly annotated expected
failure only for `kind: investigate` and `artifact_type: investigation`:

- The check retains `result: fail`, with `purpose: reproduction` and
  `expected_result: fail`.
- Typed `command_result` or `test_result` evidence must link the exact command to
  a required acceptance ID reported as met.
- The investigation contract explains the fields and limits. For example,
  reproducing an intentionally red test can satisfy a diagnostic criterion; it
  does not mean the project tests passed.
- Unannotated/unlinked failures, fabricated acceptance IDs, unrelated failing
  checks, policy/tool errors and runner-level failed tool results remain blocking.
  The marker has no effect on implementation, verification or review tasks.

Regression coverage is in `tests/outcome-evaluation.test.mjs`, including linked
`evidence_only` reproduction and negative safety cases.

## Passing run evidence

Artifacts remain under `%TEMP%/ludi-approved-devin-0Qayo9/`:
`state.db`, `trace.json`, `summary.json`, `baseline.log`, `final-tests.log`,
`fix.diff`, and the disposable `repo/`.

| Task | Tool calls | Turns | Result |
| --- | ---: | ---: | --- |
| Investigate/reproduce | 5 | 4 | completed; `EXPECTED_FAILURE_REPRODUCED`, raw failed check preserved |
| Implement | 7 | 7 | completed |
| Test | 1 | 2 | completed |
| Review | 4 | 4 | completed |

The parent independently observed `npm test` exit 0 (3/3 passing) and exactly one
modified path, `src/math.js`. The change replaces division by `values.length + 1`
with division by `values.length`. The run ended `completed` in four rounds.

## Regression validation

After the correction, all 514 automatic Node tests passed using an explicit
`tests/*.test.mjs` file list under PowerShell. `node scripts/validate.mjs`,
`pwsh -NoProfile -File tests/test-sync-pi.ps1`, syntax checking of the retained live
driver, and `git diff --check` also passed. No user settings were changed.

## Reproduction and limits

The passing run used the local acceptance driver
`.orchestration/e2e-authorized-provider.mjs`. Its procedure is retained in the
opt-in `tests/e2e-real-approved-provider.mjs` with explicit argument validation:

```powershell
# Requires renewed confirmation that the selected provider/model may be used.
node tests/e2e-real-approved-provider.mjs . devin
# Alternative authorized model; the observed Qoder trial above did not pass.
node tests/e2e-real-approved-provider.mjs . qoder
```

The driver reads current bindings, rejects bindings outside the named model
families, and never changes settings. It writes a local artifact pointer to
`.orchestration/latest-approved-e2e.json`. Neither this driver nor other live E2E
scripts are included in the automatic `*.test.mjs` suite.

This is one passing live smoke test, not proof of general provider reliability,
free entitlement, or production rollout readiness. Temporary artifacts can be
removed by OS cleanup. The npm shell invocation emitted Node's `DEP0190` warning;
commands in this fixture were fixed literals, and no general shell API was changed.
