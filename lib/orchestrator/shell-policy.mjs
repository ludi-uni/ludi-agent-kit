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

// Accept only a single literal command, not PowerShell expressions or shell control flow.
// Quoted path/pattern arguments remain usable; expansion is intentionally not supported.
function literalCommand(text) {
  const tokens = [];
  let quote = null, token = '', started = false;
  for (const ch of text) {
    if (/[\r\n$`]/.test(ch)) return null;
    if (quote) {
      if (ch === quote) quote = null;
      else token += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch; started = true;
    } else if (/[;|&<>(){}@#]/.test(ch)) {
      return null;
    } else if (/\s/.test(ch)) {
      if (started) { tokens.push(token); token = ''; started = false; }
    } else { token += ch; started = true; }
  }
  if (quote) return null;
  if (started) tokens.push(token);
  return tokens;
}

// Global path options must not hide the actual Git verb from the deny rules.
function gitVerb(tokens) {
  if (tokens[0] !== 'git') return null;
  let i = 1;
  for (; i < tokens.length && tokens[i].startsWith('-'); i++) {
    if (/^(?:-C|--git-dir|--work-tree)$/.test(tokens[i])) i++;
    else if (/^--(?:git-dir|work-tree)=/.test(tokens[i])) continue;
    else if (!['--no-pager', '--paginate', '--bare', '--no-optional-locks'].includes(tokens[i])) return '';
  }
  return tokens.slice(i).join(' ');
}

// Normalize native executable paths/shims before inspecting their actual verb.
function classifyLiteral(tokens) {
  const executable = tokens[0].split(/[\\/]/).at(-1).replace(/\.(?:exe|cmd|bat)$/i, '').toLowerCase();
  const normalized = [executable, ...tokens.slice(1)];
  const git = gitVerb(normalized);
  if (git === '') return { error: 'unsupported git global option' };
  if (git != null) return { text: `git ${git}` };
  if (['npm', 'pnpm', 'yarn'].includes(executable)) {
    const values = new Set(['--prefix', '--workspace', '-w', '--userconfig', '--cache', '--registry', '--cwd', '--dir', '-C', '--filter']);
    const flags = new Set(['--silent', '-s', '--global', '-g', '--offline', '--ignore-scripts', '--color', '--no-color']);
    let i = 1;
    for (; i < normalized.length && normalized[i].startsWith('-'); i++) {
      const option = normalized[i];
      const equal = option.indexOf('=');
      if (values.has(option)) {
        if (!normalized[i + 1] || normalized[i + 1].startsWith('-')) return { error: `missing ${executable} option value` };
        i++;
      } else if (equal > 0 && values.has(option.slice(0, equal)) && option.slice(equal + 1)) continue;
      else if (!flags.has(option)) return { error: `unsupported ${executable} global option` };
    }
    return { text: [executable, ...normalized.slice(i)].join(' ') };
  }
  if (['gh', 'terraform', 'kubectl', 'serverless', 'wrangler', 'flyctl', 'reg', 'net'].includes(executable) && normalized[1]?.startsWith('-')) {
    return { error: `unsupported ${executable} global option` };
  }
  if (['remove-item', 'ri', 'rm', 'del', 'erase', 'rmdir', 'rd'].includes(executable)
    && normalized.slice(1).some(arg => /^(?:-(?:r|re|rec|recu|recur|recurs|recurse)(?::.*)?|-rf|-fr|\/s|\/q)$/i.test(arg))) {
    return { error: 'recursive delete', flags: ['destructive_action'] };
  }
  return { text: normalized.join(' ') };
}

const LIMITED = [
  /^(git(\.exe)?)\s+(status|diff|log|show|rev-parse)\b/i,
  // Permit only current-branch inspection, not the mutating branch subcommands.
  /^git\s+branch\s+--show-current$/i,
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
  const tokens = literalCommand(text);
  if (!tokens?.length) return { allow: false, reason: 'only one literal command is allowed; shell expressions and compound commands are refused' };
  const classification = classifyLiteral(tokens);
  if (classification.error) return { allow: false, reason: classification.error, ...(classification.flags ? { flags: classification.flags } : {}) };
  const classified = classification.text;
  for (const rule of DENY) {
    if (!rule.re.test(classified)) continue;
    if (rule.reason === 'network transfer' && network) continue;
    return { allow: false, reason: rule.reason, flags: flagsFor(rule.reason) };
  }
  if (String(shell) === 'limited' && !LIMITED.some(re => re.test(classified))) {
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
