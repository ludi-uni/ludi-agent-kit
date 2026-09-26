// Tool access is separate from routing capability. `tools:` on an agent remains the pi tool-name
// list; `access` says what the orchestrator may actually grant.
export const EXECUTION_MODES = ['oneshot', 'subagent', 'pipeline'];
const FILESYSTEM = new Set(['read', 'read-write']);
const SHELL = new Set(['false', 'limited', 'true']);
const GIT = new Set(['none', 'read']);

export function accessOf(agent) {
  const raw = agent?.meta?.access;
  if (raw && typeof raw === 'object') {
    return {
      filesystem: FILESYSTEM.has(raw.filesystem) ? raw.filesystem : 'read',
      shell: SHELL.has(String(raw.shell)) ? String(raw.shell) : 'false',
      git: GIT.has(raw.git) ? raw.git : 'none',
      network: raw.network === true,
    };
  }
  const names = String(agent?.meta?.tools ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const write = names.some(n => n === 'edit' || n === 'write');
  const shell = names.some(n => n === 'powershell' || n === 'bash');
  return { filesystem: write ? 'read-write' : 'read', shell: shell ? 'limited' : 'false', git: 'read', network: false };
}

export function validateAccess(access, name) {
  const errors = [];
  if (!access || typeof access !== 'object') return errors;
  if (access.filesystem !== undefined && !FILESYSTEM.has(access.filesystem)) errors.push(`agent ${name}: access.filesystem must be read|read-write`);
  if (access.shell !== undefined && !SHELL.has(String(access.shell))) errors.push(`agent ${name}: access.shell must be false|limited|true`);
  if (access.git !== undefined && !GIT.has(access.git)) errors.push(`agent ${name}: access.git must be none|read`);
  if (access.network !== undefined && typeof access.network !== 'boolean') errors.push(`agent ${name}: access.network must be boolean`);
  return errors;
}

/** pi --tools allowlist. Raw bash/powershell are never granted; shell goes through ludi_exec. */
export function piToolsForAccess(access) {
  const tools = ['read', 'grep', 'find', 'ls'];
  if (access.filesystem === 'read-write') tools.push('edit', 'write');
  if (access.shell !== 'false') tools.push('ludi_exec');
  return tools;
}

/** Mode named by the task or the agent file, before runner availability is applied. */
export function declaredMode(agent, task, { pipelineAgents = [] } = {}) {
  if (pipelineAgents.includes(agent?.meta?.name) || task?.executionMode === 'pipeline') return 'pipeline';
  const requested = task?.executionMode ?? agent?.meta?.execution?.preferred_mode ?? agent?.meta?.execution;
  if (EXECUTION_MODES.includes(requested)) return requested;
  if (['coder', 'tester'].includes(agent?.meta?.name)) return 'subagent';
  return 'oneshot';
}

export function resolveExecutionMode(agent, task, { pipelineAgents = [], hasSubagent = false } = {}) {
  if (pipelineAgents.includes(agent?.meta?.name)) return 'pipeline';
  const requested = task?.executionMode ?? agent?.meta?.execution?.preferred_mode ?? agent?.meta?.execution;
  if (requested === 'pipeline') return 'pipeline';
  if (requested === 'oneshot') return 'oneshot';
  if (requested === 'subagent') return hasSubagent ? 'subagent' : 'oneshot';
  if (hasSubagent && ['coder', 'tester'].includes(agent?.meta?.name)) return 'subagent';
  return 'oneshot';
}

export function workspaceOf(task, repoRoot) {
  const path = task?.workspace?.path ?? repoRoot ?? null;
  return { path, repository: task?.workspace?.repository ?? repoRoot ?? path };
}
