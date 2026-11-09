// Narrow rules/native investigation continuation. Never changes provider, access,
// acceptance or absolute caps; stopped output remains unaccepted evidence.
import { buildContinuationTask, parseProgressReport } from './progress-contract.mjs';

export function isRulesInvestigation(task) {
  return task.assignedAgent === 'scout' && task.kind === 'investigate' && !task.planningRef
    && ((!task.parentTaskId && !task.sourceTaskId) || !!task.rulesContinuation);
}

export function planRulesHandoff({ task, run, runtime, maxAttempts, ledger = [], evaluator = null }) {
  const fail = reason => ({ ok: false, reason });
  if (!isRulesInvestigation(task)) return fail('not a rules investigation');
  if (evaluator?.verdict === 'blocked' || run.gate || run.result?.remainingIssues?.some(i => i.blocking)
    || run.worktree?.agentChanges?.length) return fail('parent safety gate, blocking issue or unexpected writes prevent continuation');
  const child = run.child;
  if (child?.transport !== 'native' || child.guardQuiescent !== true || child.cancelRequested || run.retainWorkspaceUntil
    || run.unconfirmedStop || /cancel|interrupt|unconfirmed|tool-not-allowed/i.test(child.stopReason ?? '')
    || ['cancelled', 'interrupted', 'timed_out'].includes(child.terminalStatus)) return fail('native stop/quiescence proof is missing or unsafe');
  const hard = run.failureClass === 'TOOL_BUDGET_EXHAUSTED'
    && (child.terminalStatus === 'tool_budget_exhausted' || child.stopReason === 'guard-tool-call-limit');
  if (!run.structured || ((!run.ok || run.abort || child.terminalStatus !== 'completed' || child.stopReason) && !hard))
    return fail('only a clean partial handoff or confirmed tool-limit stop may continue');
  if (hard && (!run.partialHandoff || run.partialHandoff.status !== 'unaccepted')) return fail('hard stop lacks saved unaccepted output');
  if (run.partialHandoff && run.partialHandoff.claimedStatus !== 'partial') return fail('hard-stop completed/unknown claim is not a partial handoff');
  if (!Number.isSafeInteger(child.turns) || child.turns <= 0
    || !Number.isSafeInteger(child.toolCalls) || child.toolCalls <= 0) return fail('measured invocation usage is missing');
  let report;
  try { report = parseProgressReport(run.result?.progressReport); }
  catch (e) { return fail(e.message); }
  if (report.task_id !== task.id) return fail('progress task_id mismatch');
  const known = new Set(task.acceptanceIds ?? []);
  if (report.completed_acceptance.some(c => !known.has(c.acceptance_id))
    || report.remaining_work.some(w => w.acceptance_ids.some(id => !known.has(id)))) return fail('unknown acceptance id in handoff');
  if ([...(run.result?.verification ?? []), ...report.tests_run].some(v => ['fail', 'failed', 'error', 'POLICY_BLOCK'].includes(v.result)))
    return fail('failed verification requires parent intervention');
  if (report.blocked_work.length || report.environment_constraints.length || run.result?.decisions?.length)
    return fail('blocked work or a decision requires parent intervention');
  // Claims alone never satisfy acceptance. Require concrete evidence references
  // and a new progress marker rather than buying the same exploration again.
  const evidence = run.result?.evidence ?? [];
  if (!report.artifacts.length && !evidence.some(e => e && typeof e === 'object'
    && ['file_reference', 'command_result'].includes(e.type) && typeof e.source === 'string' && e.source.trim()))
    return fail('handoff lacks concrete evidence or artifact references');
  const markers = [...report.completed_steps, ...report.artifacts.map(a => `${a.type}:${a.location}`)];
  const previous = task.rulesContinuation?.progressMarkers ?? [];
  if (!markers.some(m => !previous.includes(m))) return fail('no new progress marker');
  const usedTurns = (task.rulesContinuation?.turnsUsed ?? 0) + child.turns;
  const usedTools = (task.rulesContinuation?.toolCallsUsed ?? 0) + child.toolCalls;
  const maxTurns = task.rulesContinuation?.maxTurns ?? runtime.absolute_max_turns ?? runtime.max_turns;
  const maxTools = task.rulesContinuation?.maxTools ?? runtime.absolute_max_tool_calls ?? runtime.max_tool_calls;
  if (usedTurns >= maxTurns || usedTools >= maxTools || (task.totalModelAttempts ?? 0) >= maxAttempts)
    return fail('cumulative investigation budget exhausted');
  const residual = buildContinuationTask({ task, report, ledger,
    terminationReason: hard ? 'tool_limit' : 'unknown', progressRef: task.id,
    workspaceRef: { paths: task.ownedPaths ?? [], dirty: false } });
  if (!residual.ok) return fail(residual.errors.join('; '));
  return { ok: true, report, task: { ...residual.task,
    // rules acceptance has no ledger ids; do not silently drop its criteria.
    acceptance: [...task.acceptance], expected_outcome: task.expected_outcome,
    rulesContinuation: { turnsUsed: usedTurns, toolCallsUsed: usedTools, maxTurns, maxTools,
      progressMarkers: [...new Set([...previous, ...markers])] },
    continuationContext: { originalTaskPurpose: task.title, originalAcceptance: task.acceptance,
      previousTaskSummary: run.result.summary, previousProgressReport: report,
      remainingWork: report.remaining_work, evidenceStatus: 'unaccepted' },
  } };
}
