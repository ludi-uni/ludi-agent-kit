// pi extension loaded only by the orchestrator's tool-capable child.
// Replaces raw shell: every command is classified before it runs, and a refusal stays inside the child
// so the model returns a decision instead of asking the user directly.
//
// Two load paths share this file:
//   - subprocess children (`pi -e shell-gate`): default export reads the access policy from
//     LUDI_SHELL_MODE / LUDI_SHELL_NETWORK captured at load time (the child env, never shared).
//   - native in-process children: the generated wrapper calls createShellGate({ shell, network })
//     with the launch's immutable access; no environment is consulted.
import { Type } from 'typebox';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { runCommand } from './run-command.mjs';

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

let _decideShellPromise = null;

function _ensureDecideShell() {
  if (!_decideShellPromise) {
    _decideShellPromise = _load();
  }
  return _decideShellPromise;
}

/**
 * Shell gate extension factory bound to one immutable access policy.
 * `policy.shell` is 'false' | 'limited' | 'true'; `policy.network` is boolean.
 * The policy is captured once; the tool never re-reads ambient state.
 */
export function createShellGate(policy = {}) {
  const requireConfirmedExit = policy.requireConfirmedExit === true;
  const access = Object.freeze({
    shell: ['false', 'limited', 'true'].includes(String(policy.shell)) ? String(policy.shell) : 'false',
    network: policy.network === true,
  });
  return function shellGate(pi) {
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
      async execute(_id, params, signal, _onUpdate, ctx) {
        const decideShell = await _ensureDecideShell();
        const decision = decideShell(params.command, access);
        if (!decision.allow) {
          return { content: [{ type: 'text', text: `POLICY_BLOCK ${decision.reason}. Do not run this command. Return status "needs_decision" with the command in decisions.` }], isError: true };
        }
        const ran = await runCommand(params.command, ctx?.cwd, signal, { requireConfirmedExit });
        const body = [`exit ${ran.code}`, ran.stdout.slice(-4000), ran.stderr.slice(-2000)].filter(Boolean).join('\n');
        // A command killed on abort/timeout is a failure; an unconfirmed kill
        // is too — never report either as a success.
        return { content: [{ type: 'text', text: body }], isError: ran.code !== 0 || ran.unconfirmed === true,
          details: { command: params.command, exitCode: ran.code, unconfirmed: ran.unconfirmed === true || undefined } };
      },
    });
  };
}

// Subprocess children get their access from the child env (set on spawn, not shared).
export default createShellGate({
  shell: process.env.LUDI_SHELL_MODE ?? 'limited',
  network: process.env.LUDI_SHELL_NETWORK === '1',
});
