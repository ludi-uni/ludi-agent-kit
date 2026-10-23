// Deterministic local child fixture for invoke-async tests. No model calls.
// The invoker passes its request as `node <fixture> -p ... -- @<promptfile>`,
// so the MODE is read from the prompt file contents, not argv.
//
// Modes (first whitespace-separated token of the prompt file):
//   barrier <dir...> <name> — atomic-start barrier: each instance creates
//     <name>.start (O_EXCL), then polls <name>.go which the parent writes once
//     ALL expected .start files exist. Two children can only both succeed if
//     they were genuinely alive at the same time. Echoes the raw prompt back.
//   crash — exit 2 with a stderr message.
//   silent — exit 0 with no stdout.
//   utf8 — exit 0 after emitting a multibyte string split across chunk boundaries.
//   hang — stay alive forever (exercise timeout/abort kill paths).
import { openSync, closeSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const promptArg = process.argv.at(-1);
const promptPath = promptArg.startsWith('@') ? promptArg.slice(1) : promptArg;
const prompt = readFileSync(promptPath, 'utf8').trim();
const tokens = prompt.split(/\s+/);
const mode = tokens[0];

if (mode === 'barrier') {
  const name = tokens.at(-1);
  const dir = tokens.slice(1, -1).join(' '); // dir may itself contain spaces
  let fd;
  try { fd = openSync(join(dir, `${name}.start`), 'wx'); }
  catch { console.error(`barrier: ${name}.start already exists`); process.exit(3); }
  closeSync(fd);
  const go = join(dir, `${name}.go`);
  const poll = setInterval(() => {
    if (!existsSync(go)) return;
    clearInterval(poll);
    // The prompt file must still exist while the child is alive.
    process.stdout.write(existsSync(promptPath) ? prompt : 'PROMPT-MISSING');
    process.exit(0);
  }, 10);
  setInterval(() => {}, 60000); // keep alive until go or kill
} else if (mode === 'crash') {
  process.stderr.write('child crashed on purpose');
  process.exit(2);
} else if (mode === 'silent') {
  process.exit(0);
} else if (mode === 'utf8') {
  const text = '日本語テキスト🌸'.repeat(10);
  const buf = Buffer.from(text, 'utf8');
  process.stdout.write(buf.subarray(0, 1), () => {
    process.stdout.write(buf.subarray(1), () => process.exit(0));
  });
} else if (mode === 'hang') {
  setInterval(() => {}, 60000);
} else {
  console.error(`unknown mode ${mode}`);
  process.exit(64);
}
