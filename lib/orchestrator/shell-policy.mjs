// Shell gate used by the pi extension and by result evaluation. Safe inspection and tests may run.
// Publish, push, production mutation, and destructive deletes do not.
const DENY = [
  { re: /\bgit(\.exe)?\s+push\b/i, reason: 'git push is an external publish' },
  { re: /\b(npm|pnpm|yarn)(\.cmd)?\s+publish\b/i, reason: 'package publish is an external publish' },
  { re: /\bgh\s+(release|repo\s+create|pr\s+merge)\b/i, reason: 'external publish' },
  { re: /\b(terraform\s+apply|kubectl\s+delete|serverless\s+deploy|wrangler\s+deploy|flyctl\s+deploy)\b/i, reason: 'deployment' },
  { re: /\b(deploy|production)\b/i, reason: 'production or deploy command' },
  { re: /\bgit(\.exe)?\s+(reset|clean|stash|checkout\s+--)\b/i, reason: 'would discard or hide working tree changes' },
  { re: /\b(curl|wget|invoke-webrequest|invoke-restmethod|\biwr\b)\b/i, reason: 'network transfer' },
  { re: /\b(setx|reg(\.exe)?\s+add|net\s+user)\b/i, reason: 'credential or account change' },
  { re: /\b(remove-item|rm|del|erase|rmdir|rd)\b[^\n]*(-recurse|-r\b|\/s|\/q|-rf|-fr)/i, reason: 'recursive delete' },
  { re: /\brm\s+-rf?\b/i, reason: 'recursive delete' },
];

const SAFE_DELETE = /\b(node_modules|dist|build|coverage|\.orchestrate-out)(\\|\/|\s|$)/i;

const LIMITED = [
  /^(git(\.exe)?)\s+(status|diff|log|show|rev-parse)\b/i,
  /^(npm(\.cmd)?)\s+(test|run\s+test|run\s+lint|run\s+build)\b/i,
  /^(pnpm(\.cmd)?)\s+(test|lint|build)\b/i,
  /^node(\.exe)?\s+--test\b/i,
  /^npx(\.cmd)?\s+(vitest|eslint)\b/i,
  /^(Get-ChildItem|Get-Content|Select-String)\b/i,
];

export function decideShell(command, { shell = 'limited', network = false } = {}) {
  const text = String(command ?? '').trim();
  if (!text) return { allow: false, reason: 'empty command' };
  if (shell === 'false' || shell === false) return { allow: false, reason: 'this agent has no shell access' };
  for (const rule of DENY) {
    if (!rule.re.test(text)) continue;
    if (rule.reason === 'recursive delete' && SAFE_DELETE.test(text)) continue;
    if (rule.reason === 'network transfer' && network) continue;
    return { allow: false, reason: rule.reason, flags: flagsFor(rule.reason) };
  }
  if (String(shell) === 'limited' && !LIMITED.some(re => re.test(text))) {
    return { allow: false, reason: 'command is outside the limited shell allowlist' };
  }
  return { allow: true, reason: 'safe command' };
}

function flagsFor(reason) {
  if (/publish|push/.test(reason)) return ['external_publish'];
  if (/production|deploy/.test(reason)) return ['production_risk'];
  if (/credential/.test(reason)) return ['destructive_action'];
  return ['destructive_action'];
}

export function dangerousCommands(commands, access) {
  return (commands ?? []).map(String).map(command => ({ command, ...decideShell(command, access) })).filter(d => !d.allow);
}
