// Task contract handed to a worker. The result block stays compatible with the Phase 1 evaluator.
import { accessOf } from './permissions.mjs';

export const RESULT_STATUSES = ['completed', 'failed', 'blocked', 'needs_decision'];

export function forbiddenActions() {
  return [
    'git push', 'npm publish or any package publish', 'deployment or production mutation',
    'git reset, git checkout --, git clean, or git stash', 'deleting files outside dist/build/coverage/node_modules',
    'changing credentials or user configuration', 'network calls',
  ];
}

export function buildTaskContract(task, { dependencyResults = [], survey = null, access = null, workspace = null } = {}) {
  const rights = access ?? { filesystem: 'read', shell: 'false', git: 'none', network: false };
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
  lines.push('', 'ACCEPTANCE_CRITERIA');
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
  lines.push('', 'EXPECTED_RESULT_FORMAT',
    'Your reply MUST end with exactly one fenced ```json result block. A reply without it is rejected as malformed regardless of how good the prose is.',
    'Do not ask the user anything. If you need a choice, return status "needs_decision" or "blocked" and a decisions array.',
    'Required block (the LAST thing in your reply):',
    '```json',
    '{"status":"completed|failed|blocked|needs_decision","summary":"...","filesChanged":[],"commandsRun":[],',
    ' "verification":[{"command":"...","result":"pass|fail|skipped"}],',
    ' "acceptance":[{"id":"A1","met":true,"evidence":"..."}],',
    ' "remainingIssues":[{"summary":"...","blocking":false}],"decisions":[],"newTasks":[]}',
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
