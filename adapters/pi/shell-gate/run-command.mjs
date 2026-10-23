// One owned shell command. Native children require confirmed process termination:
// a kill request or elapsed grace is NOT proof, and cannot release a writer lease.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
export const SHELL_COMMAND_TIMEOUT_MS = 120000;
export const KILL_GRACE_MS = 5000;

export function runCommand(command, cwd, signal, {
  spawnImpl = spawn, killGraceMs = KILL_GRACE_MS,
  commandTimeoutMs = SHELL_COMMAND_TIMEOUT_MS, requireConfirmedExit = false,
  platform = process.platform,
} = {}) {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve({ code: 130, stdout: '', stderr: 'cancelled before spawn' });
    let proc;
    try { proc = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { cwd, windowsHide: true }); }
    catch (error) { return resolve({ code: 1, stdout: '', stderr: error.message }); }
    let stdout = '', stderr = '', settled = false, stopped = false, stopCode = 130;
    let closed = false, exitCode = null, treeConfirmed = true;
    let timer = null, killTimer = null;
    const done = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(killTimer);
      signal?.removeEventListener?.('abort', onAbort);
      resolve(value);
    };
    const finishClosed = () => {
      if (closed && treeConfirmed) done({ code: stopped ? stopCode : exitCode ?? 1, stdout, stderr });
    };
    const kill = (why, code) => {
      if (settled || stopped) return;
      stopped = true; stopCode = code;
      stderr += `\nludi_exec: ${why}`; // record before a synchronous mocked close
      if (platform === 'win32' && Number.isSafeInteger(proc.pid) && proc.pid > 0) {
        // A direct child's close does not prove its command descendants stopped.
        // taskkill targets only this invocation's owned PID/tree.
        treeConfirmed = false;
        try {
          const killer = spawnImpl(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.on('close', status => { treeConfirmed = status === 0; finishClosed(); });
          killer.on('error', () => { try { proc.kill(); } catch { /* unconfirmed */ } });
        } catch { try { proc.kill(); } catch { /* unconfirmed */ } }
      } else {
        try { proc.kill(); } catch { /* never interpret this as a confirmed close */ }
      }
      if (settled) return;
      killTimer = setTimeout(() => {
        stderr += `\nludi_exec: shell termination unconfirmed after ${killGraceMs}ms`;
        // Foreground owner may hard-finish an aborted child; its guard still
        // records this pending tool until it actually returns. Keep waiting in
        // native mode; the parent's bounded grace reports a retained-workspace blocker.
        if (!requireConfirmedExit) done({ code: stopCode, stdout, stderr, unconfirmed: true });
      }, killGraceMs);
    };
    const onAbort = () => kill('cancelled by caller signal', 130);
    proc.stdout?.on?.('data', chunk => { stdout = (stdout + chunk).slice(-8000); });
    proc.stderr?.on?.('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
    proc.on('error', error => {
      stderr += `\n${error.message}`;
      if (!proc.pid) done({ code: 1, stdout, stderr });
      else kill('shell process error', 1);
    });
    proc.on('close', code => { closed = true; exitCode = code; finishClosed(); });
    timer = setTimeout(() => kill(`command timed out after ${commandTimeoutMs}ms`, 124), commandTimeoutMs);
    signal?.addEventListener?.('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
