---
name: project-management
description: Maintain Asana project state during substantive development, investigation, and verification through Main-owned work semantics, evidence, and bounded hygiene. Use when an existing project or safe task boundary can be resolved; skip casual questions and trivial work.
---

# Project Management

Keep Asana understandable as current work, progress, blockers, results and required
next actions. Repository and verification evidence remain the technical source of
truth. These are semantic operations performed by Main using existing Asana tools,
not executable API functions or a new integration service.

## Ownership and authorization

- Main owns the project, chooses work and priority within human constraints, validates
  evidence, resolves conflicts and makes final acceptance decisions.
- Implementation, research and verification subagents return scoped evidence to Main.
  They do not create, comment on, edit, move, reprioritize or complete Asana objects.
  Main invokes the existing connector directly; do not spawn an Asana-writing adapter.
- This Skill performs bookkeeping for the authorized current work. Routine reads,
  progress, necessary task/subtask creation, blocker updates and completion need no
  per-write human approval once the target boundary is established.
- Preserve explicit human priority, deadlines, exclusions, holds, cancellation and
  project boundaries. Bookkeeping does not authorize expanding implementation scope,
  deployments, messages to people, deleting work, or restructuring Asana.
- If other installed PM guidance also applies, keep one bookkeeping owner and one
  operation stream. Do not invoke both workflows for the same milestone. Follow the
  user's current ownership boundary; never relax tool permissions or role configuration
  to obtain access. If Main lacks the connector, report unavailable synchronization.

## Resolve before writing

Read [references/operations.md](references/operations.md) for operation contracts.
At the start of substantive work, resolve the exact task if supplied, its workspace,
project memberships, parent/subtasks, existing state conventions and user constraints.
Otherwise search for related work by repository identity and goal. Verify candidates
with task/project reads; a similar name alone is insufficient. Do not invent a default
workspace/project, move work across projects, or revive an explicitly cancelled goal.
If the boundary remains ambiguous, continue independent local work and ask only for
the missing target. Do not create a new project as a fallback.

Search before creating. Read plausible matches and inspect a bounded project listing
or parent subtasks if search is empty, unavailable or incomplete. Preserve pagination
and truncation uncertainty: zero search results alone do not prove no duplicate.
Reuse same-goal work; link overlapping work instead of duplicating it. A completed
task for a different delivery is context, not a task to reopen automatically.

## Maintain current state

Keep a concise managed block in the description, preserving human-authored text:

```text
[Codex current work]
Goal / scope / acceptance:
State: active | blocked | partial | ready for acceptance | completed | superseded
Progress and evidence:
Active blockers: what / why / required condition / next action
Result and remaining acceptance:
Required follow-up: existing task link or none
Next action:
[/Codex current work]
```

These are descriptive meanings, not new Asana custom-field values. Use the project's
existing sections and fields when their meaning is established. Synchronize meaningful
milestones, not tool calls or raw worker logs. Read immediately before a write and
merge only intended fields; if the description changed, rebuild from that fresh text.
Preserve rich text, links and attachments; use compatible html_notes editing when
plain notes would lose formatting. If preservation is uncertain, leave the description
untouched and report the limitation rather than overwrite it. Re-read after writes
to verify state, completion and applicable section agree. Serial writes are not an
atomic compare-and-swap: stop/reconcile on observed concurrent changes.

## Hygiene and priority

Maintain only the current task and demonstrably related work. Do not build a speculative
backlog, split minute-sized activities into tasks, bulk rename/reorganize, or delete.
Create a follow-up only for a known defect, failed acceptance, current-goal requirement
or user-defined next phase. One actionable outcome and observable acceptance per item.

Duplicates need identity evidence, not just similar names. Prefer linking a canonical
item and recording superseded/merged meaning with a reason; preserve history. Old age
alone does not make a task stale or complete. Reconcile stale active blockers/progress
only using fresh evidence. Never mark unfinished work completed just to tidy a list.

Main may adjust agent-managed priority using existing conventions and a concrete
dependency or urgency reason. Never overwrite human-set priority/deadline or a hold.
If priority provenance is unknown, preserve it. A section may encode priority as well
as status: do not move it if that would override a human constraint. Record the conflict
and keep the relevant acceptance/completion state truthful.

## Results and failures

Worker output should contain scope, summary, changed paths, revision, exact checks,
results, blockers, limitations and justified follow-ups. Main evaluates the whole
objective; worker completion is not project acceptance. Complete only when all required
acceptance passes and required child work/blockers are resolved. Record cancellations
and supersession separately from successful technical acceptance.

Return operation, target IDs, project_sync_status (succeeded, unchanged, partial,
failed or ambiguous), confirmed changes, unverified fields, reason and retryable.
On timeout/partial failure, re-read the exact target; never blindly repeat creation
or switch targets. Search the stable work identity before retrying an uncertain create.
Keep local results intact when Asana fails. Retry at the next normal invocation when
safe; do not add a queue, scheduler, database or credentials. Stop when Asana accurately
reflects the current outcome, remaining acceptance, blockers and next action.
