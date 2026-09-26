// Pure slash-command routing; read-only verbs must never become a new request.
export function parseOrchestrateCommand(args) {
  const parts = String(args ?? '').trim().split(/\s+/).filter(Boolean);
  const cmd = parts[0] || 'list';
  if (['list', 'status', 'children', 'result', 'decisions'].includes(cmd)) {
    return { action: cmd, params: { runId: parts[1] } };
  }
  if (cmd === 'resume') return { action: cmd, params: { runId: parts[1] } };
  if (cmd === 'answer') return { action: cmd, params: { runId: parts[1], decisionId: parts[2], answer: parts.slice(3).join(' ') } };
  if (cmd === 'prune') return { action: cmd, params: { olderThan: parts[1] } };
  if (cmd === 'delete') return { action: cmd, params: { runId: parts[1], force: parts.includes('--force') } };
  if (cmd === 'clear') return { action: cmd, params: { force: parts.includes('--force'), includeActive: parts.includes('--include-active') } };
  return { action: 'start', params: { request: parts.join(' ') } };
}
