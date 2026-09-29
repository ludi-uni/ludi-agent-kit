// Task contract handed to a worker. The result block stays compatible with the Phase 1 evaluator.
import { accessOf } from './permissions.mjs';

export const RESULT_STATUSES = ['completed', 'partial', 'failed', 'blocked', 'needs_decision'];

export function forbiddenActions() {
  return [
    'git push', 'npm publish or any package publish', 'deployment or production mutation',
    'git reset, git checkout --, git clean, or git stash', 'deleting files outside dist/build/coverage/node_modules',
    'changing credentials or user configuration', 'network calls',
  ];
}

export function buildTaskContract(task, { dependencyResults = [], survey = null, access = null, workspace = null } = {}) {
  const rights = access ?? { filesystem: 'read', shell: 'false', git: 'none', network: false };
  if (task.kind === 'design-plan') {
    return [
      'DESIGN-ONLY PLANNING TASK. Do not edit files or implement. Inspect the workspace read-only.',
      'CANONICAL CONTEXT (immutable goal, acceptance ledger, workspace, constraints, decisions, dirty worktree):',
      JSON.stringify(task.planningContext),
      `WORKSPACE: ${workspace?.path ?? '(unspecified)'}`,
      survey ? `REPOSITORY SURVEY (bounded): ${JSON.stringify(survey)}` : 'Inspect repository files with read-only tools; if unavailable, report the limitation rather than guessing.',
      'Preserve every ledger criterion. Findings must explicitly classify environment_limitation separately from project_defect.',
      task.replanContext ? `REPLAN_CONTEXT: ${JSON.stringify(task.replanContext)}. Preserve verified completed work; do not regenerate satisfied scope unless a finding reopened its criterion. Emit only residual small/medium work and valid dependencies.` : '',
      'Return exactly one fenced JSON result block (not a prose report). The envelope is:',
      '```json',
      '{"status":"completed","summary":"design complete","planningReport":{"goal_summary":"...","current_state":"...","acceptance_criteria":[{"id":"AC1","description":"...","source":"user_request","status":"pending"}],"work_items":[{"id":"w1","title":"...","description":"...","depends_on":[],"acceptance_ids":["AC1"],"estimated_complexity":"small","recommended_role":"investigator","artifact_type":"investigation","likely_files":[]}],"risks":[],"environment_constraints":[],"unknowns":[]}}',
      '```',
      'Use small/medium work items; never submit an unresolved large execution item as a normal task.',
    ].join('\n');
  }
  const lines = [
    'TASK', task.title, '',
    'GOAL', task.goal, '',
    'CONTEXT',
  ];
  if (dependencyResults.length) {
    for (const d of dependencyResults) {
      lines.push(`- ${d.id} (${d.agent}): ${d.title}`, String(d.summary ?? '').slice(0, 2000));
      if (d.filesChanged?.length) lines.push(`  files: ${d.filesChanged.join(', ')}`);
    }
  } else lines.push('No completed dependencies.');
  if (task.attemptsLog?.length) {
    lines.push('', 'PREVIOUS_ATTEMPTS');
    for (const a of task.attemptsLog) {
      lines.push(`- attempt ${a.attempt} [${a.failureClass}]: ${(a.reasons ?? []).join('; ') || a.summary || ''}`);
      if (a.filesChanged?.length) lines.push(`  changed: ${a.filesChanged.join(', ')}`);
      if (a.verification?.length) lines.push(`  verification: ${JSON.stringify(a.verification).slice(0, 800)}`);
    }
  }
  lines.push('', 'WORKSPACE', `path: ${workspace?.path ?? '(unspecified)'}`, `repository: ${workspace?.repository ?? '(unspecified)'}`, 'Change files only inside this workspace. Do not reset, checkout, or stash existing changes.');
  lines.push('', 'OUTCOME_CONTRACT', `artifact_type: ${task.artifact_type ?? '(legacy)'}`, `expected_outcome: ${task.expected_outcome ?? '(legacy)'}`,
    'For evidence-based outcomes, supply evidence [{type,source,result,related_acceptance,command?,location?,tool_reference?}]. A passing command must also appear in verification; report current failed tool results truthfully. A prior POLICY_BLOCK mentioned in prose is not a current failure.',
    '', 'ACCEPTANCE_CRITERIA');
  (task.acceptance?.length ? task.acceptance : ['the goal is achieved and verified']).forEach((a, i) => lines.push(`- A${i + 1}: ${a}`));
  if (task.outputs?.length) lines.push('', 'REQUIRED_OUTPUTS', ...task.outputs.map(o => `- ${o}`));
  lines.push('', 'ALLOWED_ACTIONS', `filesystem: ${rights.filesystem}`, `shell: ${rights.shell}`, `git: ${rights.git}`, `network: ${rights.network}`);
  if (rights.shell !== 'false') lines.push('Run commands only through ludi_exec. Tests, lint, build, git status, and git diff are allowed when your shell access says so.');
  lines.push('', 'FORBIDDEN_ACTIONS', ...forbiddenActions().map(f => `- ${f}`));
  if (task.decisions?.length) lines.push('', 'DECISIONS_ALREADY_MADE', ...task.decisions.map(d => `- ${d.question} -> ${d.choice} (${d.reason})`));
  if (task.feedback?.length) lines.push('', 'RETRY_FEEDBACK', ...task.feedback.map(f => `- ${f}`));
  if (survey) {
    lines.push('', 'REPOSITORY_FILES', ...survey.files.map(f => `- ${f.path} (${f.size} B)`));
    lines.push('', 'FILE_CONTENTS', ...survey.inline.map(f => `### \`${f.path}\`\n\`\`\`\n${f.content}\n\`\`\``));
  }
  if (task.kind === 'review' || task.kind === 'verify' || task.kind === 'reverify') {
    lines.push('', 'REVIEW_COVERAGE', JSON.stringify(task.reviewContext ?? {}),
      'Prioritize pending/reopened acceptance criteria, recent repair findings and unverified evidence. Do not repeat unaffected verified scope.',
      '', 'REVIEW_FINDING_CONTRACT',
      'Return reviewFindings: [] in the final JSON result. Every finding must have id, source_task_id (this task id), severity, classification, title, description, evidence (nonempty structured objects), affected_acceptance_ids, affected_files, suggested_scope {summary, affected_acceptance_ids, affected_files, subsystems, estimated_complexity}, confidence (0..1).',
      'Classify environment_limitation, insufficient_evidence, external_blocker and requirement_ambiguity separately from project_defect/test_failure. Shell/tool/provider limits are NEVER code defects. A blocking severity does NOT imply project repair.',
      'When re-verifying a repair, report verification for each sourceFindingId with concrete passing evidence; absence of evidence cannot resolve a finding.',
      `sourceFindingIds: ${JSON.stringify(task.sourceFindingIds ?? [])}`);
  }
  if (task.parentTaskId) {
    lines.push('', 'CONTINUATION_HANDOFF',
      'Previous work may already exist; inspect the current workspace before editing. Continue ONLY remaining scope. Never reset, clean, stash or revert existing changes.',
      'Priority: canonical goal, relevant acceptance criteria, original task purpose, previous progress report, remaining work, current workspace state.',
      JSON.stringify(task.continuationContext ?? task.handoff ?? {}));
  }
  if (task.planningRef || task.parentTaskId) {
    lines.push('', 'PROGRESS_CONTRACT',
      'Include progressReport in the LAST JSON result block, including when partial, interrupted or blocked. Do not claim ledger satisfaction: attach concrete evidence for parent review.',
      'Required progressReport keys: task_id, status (completed|partial|blocked|failed|unknown), completed_acceptance [{acceptance_id,evidence:[...]}], completed_steps [], remaining_work [{id,description,acceptance_ids,estimated_complexity}], blocked_work [{description,reason,classification}], files_touched [], tests_run [{command,result}], artifacts [{type,location,description}], environment_constraints [], handoff_notes [].',
      'If interrupted, return status "partial" with only outstanding work in remaining_work. Never repeat already completed scope. Include termination_reason separately where known.');
  }
  lines.push('', 'EXPECTED_RESULT_FORMAT',
    'Your reply MUST end with exactly one fenced ```json result block. A reply without it is rejected as malformed regardless of how good the prose is.',
    'Do not ask the user anything. If you need a choice, return status "needs_decision" or "blocked" and a decisions array.',
    'Required block (the LAST thing in your reply):',
    '```json',
    '{"status":"completed|partial|failed|blocked|needs_decision","summary":"...","filesChanged":[],"commandsRun":[],',
    ' "verification":[{"command":"...","result":"pass|fail|skipped"}],"evidence":[{"type":"command_result","source":"verification","result":"pass","related_acceptance":"A1","command":"..."}],',
    ' "acceptance":[{"id":"A1","met":true,"evidence":"..."}],',
    ' "remainingIssues":[{"summary":"...","blocking":false}],"reviewFindings":[],"decisions":[],"newTasks":[],"progressReport":null}',
    '```',
    'status "completed" requires evidence for every acceptance id. A claim without a command, diff, or file reference is not evidence.',
    '',
    'LANGUAGE',
    'Write natural-language values (summary, evidence, remainingIssues, decisions, newTasks) in Japanese unless the user requested another language.',
    'Keep all JSON keys, enum values (completed/failed/blocked/needs_decision/pass/fail/skipped), file paths, commands and identifiers in English/exact form — never translate them.');
  return lines.join('\n');
}

export function accessForPrompt(agent) {
  return accessOf(agent);
}
