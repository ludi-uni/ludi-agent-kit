// pi extension loaded only by the orchestrator's tool-capable child.
// Replaces raw shell: every command is classified before it runs, and a refusal stays inside the child
// so the model returns a decision instead of asking the user directly.
import { spawn } from 'node:child_process';
import { Type } from 'typebox';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { realpathSync } from 'node:fs';

// Resolve junctions so that __dir is the physical location under the kit tree.
const __file = realpathSync(fileURLToPath(import.meta.url));
const __dir = dirname(__file);
const kitRoot = resolve(__dir, '../../../');

// Lazy-import for the shell-policy module.
let _decideShell = null;
async function _load() {
  if (!_decideShell) {
    const m = await import(pathToFileURL(resolve(kitRoot, 'lib/orchestrator/shell-policy.mjs')).href);
    _decideShell = m.decideShell;
  }
  return _decideShell;
}

function runCommand(command, cwd) {
  return new Promise(resolve => {
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { proc.kill(); resolve({ code: 124, stdout, stderr: `${stderr}\ntimeout` }); }, 120000);
    proc.stdout.on('data', chunk => { stdout += chunk; });
    proc.stderr.on('data', chunk => { stderr += chunk; });
    proc.on('error', error => { clearTimeout(timer); resolve({ code: 1, stdout, stderr: error.message }); });
    proc.on('close', code => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
  });
}

let _decideShellPromise = null;

function _ensureDecideShell() {
  if (!_decideShellPromise) {
    _decideShellPromise = _load();
  }
  return _decideShellPromise;
}

export default function shellGate(pi) {
  // Tool registration is synchronous, but decideShell is loaded via dynamic import.
  // The execute callback awaits the promise on first use.
  pi.registerTool({
    name: 'ludi_exec',
    label: 'Ludi exec',
    description: 'Run one workspace command. Tests, lint, build, and read-only git are allowed. Push, publish, deploy, reset, and recursive delete are refused.',
    promptSnippet: 'ludi_exec: run an allowed shell command in the task workspace.',
    promptGuidelines: ['Use ludi_exec instead of powershell or bash. If it returns POLICY_BLOCK, do not retry the command; report status needs_decision.'],
    parameters: Type.Object({
      command: Type.String({ description: 'One shell command. No user prompts.' }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const decideShell = await _ensureDecideShell();
      const decision = decideShell(params.command, { shell: process.env.LUDI_SHELL_MODE ?? 'limited', network: process.env.LUDI_SHELL_NETWORK === '1' });
      if (!decision.allow) {
        return { content: [{ type: 'text', text: `POLICY_BLOCK ${decision.reason}. Do not run this command. Return status "needs_decision" with the command in decisions.` }], isError: true };
      }
      const ran = await runCommand(params.command, ctx?.cwd);
      const body = [`exit ${ran.code}`, ran.stdout.slice(-4000), ran.stderr.slice(-2000)].filter(Boolean).join('\n');
      return { content: [{ type: 'text', text: body }], isError: ran.code !== 0, details: { command: params.command, exitCode: ran.code } };
    },
  });
}
