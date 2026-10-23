#!/usr/bin/env node
// Offline isolated pi startup/RPC registration check.
//
//   node scripts/check-pi.mjs [--json] [--keep-temp] [--timeout-ms=<ms>]
//
// Creates a temporary pi agent dir, populates it via `sync-pi.ps1 -Apply` (never
// -ApplySettings), boots the installed pi offline in RPC mode and verifies the
// kit's orchestrate command + three skill registrations, zero activity/usage, the
// single loop-guard extension entry and the kit agent definitions.
//
// Boundaries: this verifies structural installation and public RPC registrations
// only. It never sends model prompts or writes real user configuration. The owned
// temp root is deleted unless --keep-temp; sync also refreshes gitignored adapter
// previews in the kit. Native Windows + pwsh required.
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCheckArgs, runStartupCheck } from '../adapters/pi/lib/startup-check.mjs';

const USAGE = `使い方: node scripts/check-pi.mjs [--json] [--keep-temp] [--timeout-ms=<ms>]
  --json          JSON レポートを stdout に出力 (診断は stderr)
  --keep-temp     隔離テンポラリディレクトリを削除せず残す
  --timeout-ms    RPC 全体の制限時間 (既定 60000)
  -h, --help      このヘルプを表示
ネイティブ Windows + pwsh + インストール済み pi (LUDI_PI_ENTRY または PATH) が必要です。`;

async function main() {
  let opts;
  try {
    opts = parseCheckArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  const kitRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const report = await runStartupCheck({
    kitRoot,
    timeoutMs: opts.timeoutMs,
    keepTemp: opts.keepTemp,
  });
  const passed = report.checks.filter(c => c.status === 'pass').length;
  const failed = report.checks.length - passed;
  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    console.error(`pi スタートアップチェック: ${report.ok ? 'PASS' : 'FAIL'} (${passed} pass, ${failed} fail)`);
    for (const c of report.checks) {
      console.error(`  [${c.status === 'pass' ? 'PASS' : 'FAIL'}] ${c.name}: ${c.message}`);
    }
    if (report.paths.tempRoot) {
      console.error(report.cleanup.kept
        ? `  temp root kept: ${report.paths.tempRoot}`
        : `  temp root ${report.cleanup.tempRootRemoved ? 'removed' : `NOT removed: ${report.cleanup.error ?? 'unknown'}`}`);
    }
    for (const l of report.limitations) console.error(`  注: ${l}`);
    process.stdout.write(JSON.stringify({ ok: report.ok, passed, failed, errors: report.errors }) + '\n');
  }
  process.exitCode = report.ok ? 0 : 1;
}

main().catch(e => {
  console.error(`pi スタートアップチェックの実行に失敗しました: ${e.message}`);
  process.exit(1);
});
