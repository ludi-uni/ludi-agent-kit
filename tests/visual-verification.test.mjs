// Visual-verification skill safety contract.
// Static checks read the PowerShell sources and assert the documented
// non-destructive and bounded-wait contracts. The Invoke-WinAppProcess
// behavior test additionally runs pwsh when it is on PATH (skipped
// otherwise); it spawns synthetic child processes only — never a real winapp
// CLI, ffmpeg, capture device, or audio backend.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, openSync, closeSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scripts = join(kit, 'skills', 'visual-verification', 'scripts');
const read = (name) => readFileSync(join(scripts, name), 'utf8');
const skill = readFileSync(join(kit, 'skills', 'visual-verification', 'SKILL.md'), 'utf8');

// ---------- (1) waveform.ps1: one shared bounded analysis window ----------

test('waveform: image, PCM, and silence detection share the same bounded window', () => {
  const w = read('waveform.ps1');
  // A bounded -t input limit is placed before -i so ffmpeg honours it as an
  // input duration cap; the previous '-i' then '-t' order was an output
  // option and never limited the analysis window. All three argument blocks
  // must build: (empty) -> bounded -t -> -i -> remaining args.
  assert.equal(w.match(/'-t', \$maximumAnalysisSeconds\.ToString\(\$invariantCulture\)/g)?.length ?? 0, 3,
    'waveform, PCM, and silencedetect must all apply the same -t limit');
  const blocks = ['waveform', 'pcm', 'silence'].map(name => {
    const start = w.indexOf(`$${name}Arguments = [string[]]@()`);
    const input = `$${name}Arguments += [string[]]@('-i', $resolvedInput)`;
    const end = w.indexOf(input, start);
    assert.ok(start >= 0 && end > start, `${name} must append its input after initializing arguments`);
    return w.slice(start, end + input.length);
  });
  for (const block of blocks) {
    // Match the actual argument tokens, not prose: comments explaining the
    // ordering contain '-t'/'-i' too and must not satisfy this check.
    const tIndex = block.indexOf("'-t', $maximumAnalysisSeconds");
    const iIndex = block.indexOf("'-i', $resolvedInput");
    assert.ok(tIndex !== -1, `bounded -t missing in:\n${block}`);
    assert.ok(iIndex !== -1, `-i $resolvedInput missing in:\n${block}`);
    assert.ok(tIndex < iIndex, `-t must precede -i in:\n${block}`);
    assert.ok(!/Arguments\s*=\s*\[string\[\]\]@\('-i', \$resolvedInput\)/.test(block), '-i must not be the initial empty-args element');
  }
  assert.match(w, /MaxAnalysisSeconds/, 'bounded window must be a parameter');
});

test('waveform: events JSON carries honest analysis provenance', () => {
  const w = read('waveform.ps1');
  assert.match(w, /analyzed_duration_sec/, 'analyzed duration is reported');
  assert.match(w, /max_seconds/, 'the configured limit is reported');
  assert.match(w, /truncation_limit_reached/, 'truncation is exposed');
  assert.match(w, /does not prove the source duration/, 'truncation must not be asserted as source duration');
});

test('waveform: SKILL documents the bounded analysis window', () => {
  assert.match(skill, /MaxAnalysisSeconds/, 'SKILL must document the limit');
  assert.match(skill, /analyzed_duration_sec/, 'SKILL must document honest duration provenance');
  assert.match(skill, /cannot distinguish an exactly-limit-length source/, 'SKILL must not overclaim source duration');
});

// ---------- (2) no-Overwrite scripts must not demand -Overwrite ----------

test('Assert-OutputAvailable only advertises an overwrite flag when one exists', () => {
  const common = read('common.ps1');
  assert.match(common, /\[string\]\$OverwriteHint/, 'OverwriteHint parameter exists');
  assert.match(common, /choose a different output path or a fresh run directory/, 'non-overwriteable outputs get a usable hint');
});

test('scripts without -Overwrite do not emit the -Overwrite hint', () => {
  for (const name of ['desktop-screenshot.ps1', 'desktop-record.ps1', 'desktop-inspect.ps1']) {
    const src = read(name);
    assert.ok(!src.includes('[switch]$Overwrite'), `${name} must not grow an overwrite flag`);
    for (const call of src.matchAll(/Assert-OutputAvailable[^\r\n]*/g)) {
      assert.ok(!call[0].includes('OverwriteHint'), `${name} must not pass an overwrite hint: ${call[0]}`);
    }
  }
  for (const name of ['screenshot.ps1', 'record.ps1', 'record-av.ps1', 'contact-sheet.ps1']) {
    const src = read(name);
    assert.ok(src.includes('[switch]$Overwrite'), `${name} keeps its overwrite flag`);
    assert.ok(src.includes("-OverwriteHint '-Overwrite'"), `${name} advertises its real flag`);
  }
});

// ---------- (3) analyze-speech.ps1: unified backend-unavailable path ----------

test('analyze-speech: missing ffmpeg reports REQUIRES_BACKEND, not an unhandled throw', () => {
  const src = read('analyze-speech.ps1');
  assert.match(src, /Write-BackendUnavailable -Message 'ffmpeg was not found on PATH\.'/, 'ffmpeg absence uses the unified path');
  assert.ok(!src.includes("throw 'ffmpeg was not found on PATH.'"), 'raw throw for missing ffmpeg is gone');
  assert.match(src, /function Write-BackendUnavailable[\s\S]*?exit 3/, 'unified path still exits 3 with a normalized result');
});

// ---------- (4) winapp-common.ps1: bounded waits ----------

test('Invoke-WinAppProcess uses a bounded wait and kills the child on timeout', () => {
  const src = read('winapp-common.ps1');
  assert.ok(!/\$process\.WaitForExit\(\)/.test(src), 'unbounded WaitForExit() must not remain');
  assert.match(src, /\$process\.WaitForExit\(\$effectiveTimeoutMs\)/, 'bounded WaitForExit is used');
  assert.match(src, /\$process\.Kill\(\$true\)/, 'timed-out child process tree is killed');
  assert.match(src, /WINAPP_TIMEOUT/, 'timeout is a classified failure, not a success');
  assert.match(src, /could not be terminated/, 'a surviving child is never reported as success');
});

test('record operations derive their timeout from the requested duration', () => {
  const src = read('winapp-common.ps1');
  assert.match(src, /--duration-sec/, 'record timeout parses --duration-sec');
  assert.match(src, /WinAppRecordMarginMs/, 'record timeout adds a fixed margin');
  assert.match(src, /Duration -gt 60/, 'the <= 60 s duration bound is still enforced');
});

test('stdout/stderr reads are bounded on the exit path and on the timeout-reap path', () => {
  const src = read('winapp-common.ps1');
  assert.match(src, /\$stdoutTask\.Wait\(/, 'stdout read is bounded');
  assert.match(src, /\$stderrTask\.Wait\(/, 'stderr read is bounded');
  // GetAwaiter().GetResult() is an unbounded wait and must not remain anywhere.
  assert.ok(!src.includes('.GetAwaiter().GetResult()'), 'no unbounded task wait may remain');
  // A bounded read on the normal-exit path that still cannot reap the pipes is
  // a classified failure, not silently empty success output.
  assert.match(src, /could not be reaped within/, 'unreaped output is a classified WINAPP_COMMAND_FAILED');
  assert.match(src, /WINAPP_COMMAND_FAILED' -Message "WinApp CLI exited within/, 'read failure is classified, not a success');
});

test('SKILL documents WINAPP_TIMEOUT', () => {
  assert.match(skill, /WINAPP_TIMEOUT/, 'SKILL lists the timeout classification');
});

// ---------- (5) inspect-media.ps1: exclusive output creation ----------

test('inspect-media reserves OutputJson with FileMode.CreateNew', () => {
  const src = read('inspect-media.ps1');
  assert.match(src, /\[IO\.FileMode\]::CreateNew/, 'exclusive create is used');
  assert.ok(!src.includes('Set-Content -LiteralPath $resolvedOutputJson'), 'no unguarded Set-Content overwrite remains');
  assert.match(src, /refusing to overwrite/, 'existing output still fails closed');
});

test('inspect-media failure cleanup never deletes by path', () => {
  const src = read('inspect-media.ps1');
  const finallyBlock = src.slice(src.lastIndexOf('finally'));
  assert.ok(!/Remove-Item|RemoveItem|\bri\b|\bdel\b|rmdir|\.Delete\(/.test(finallyBlock),
    'the failure finally must not delete the output path — a replacement file could occupy it');
  assert.match(finallyBlock, /Write-Warning/, 'a failed run must warn with the leftover partial-output location');
  assert.match(finallyBlock, /Dispose\(\)/, 'the reserved stream is still disposed on failure');
});

// ---------- repository regression guard ----------

test('visual-verification scripts still refuse to overwrite by default', () => {
  // Desktop scripts are checked by their exact shared-guard calls below.
  for (const name of ['inspect-media.ps1', 'waveform.ps1', 'analyze-speech.ps1']) {
    const src = read(name);
    assert.match(src, /refusing to overwrite|FileMode\]::CreateNew|CreateNew|already exists/i, `${name} keeps a non-destructive output contract`);
  }
});

// A script that emits result artifacts must guard every fixed output path
// through the shared Assert-OutputAvailable contract — not just contain the
// text of a guard somewhere. Match call sites by name so a stray mention
// (comment, unrelated guard) cannot false-pass this test.
test('desktop scripts guard every output path through Assert-OutputAvailable', () => {
  const expectations = {
    'desktop-screenshot.ps1': ['$resolvedOutputPath', '$metadataOutputPath'],
    'desktop-record.ps1': ['$resolvedOutputPath', '$metadataOutputPath', '$representativeOutputPath'],
    'desktop-inspect.ps1': ['$outputPath'],
  };
  for (const [name, paths] of Object.entries(expectations)) {
    const src = read(name);
    const calls = [...src.matchAll(/Assert-OutputAvailable\s+-Path\s+(\$[A-Za-z_][A-Za-z0-9_]*)/g)].map(m => m[1]);
    for (const path of paths) {
      assert.ok(calls.includes(path), `${name} must call Assert-OutputAvailable -Path ${path} (calls: ${calls.join(', ') || 'none'})`);
    }
  }
});

// ---------- Invoke-WinAppProcess bounded-read behavior (pwsh, optional) ----------

// Behavior test for winapp-common.ps1: exercises real process spawn/timeout/
// read-bound code paths against synthetic pwsh children — no winapp CLI, no
// capture device, no desktop interaction. Skipped when pwsh is unavailable.
const pwshProbe = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8', timeout: 15000 });
const pwshAvailable = !pwshProbe.error && pwshProbe.status === 0;

test('Invoke-WinAppProcess bounds waits, kills timeouts, and classifies failures', { skip: !pwshAvailable }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ludi-winapp-'));
  try {
    const commonPath = join(scripts, 'winapp-common.ps1').replace(/\\/g, '/');
    const fixture = join(dir, 'probe.ps1');
    writeFileSync(fixture, [
      `$ErrorActionPreference = 'Continue'`,
      `. '${commonPath}'`,
      // Normal exit: bounded reads return captured stdout/stderr, no throw.
      `$normal = Invoke-WinAppProcess -Executable 'pwsh' -Arguments @('-NoProfile','-Command','Write-Output normal-out; [Console]::Error.WriteLine("normal-err")') -TimeoutMs 20000`,
      `Write-Output ('NORMAL=' + ($normal | ConvertTo-Json -Compress))`,
      // Nonzero exit is returned, not thrown — classification is the caller's job.
      `$nonzero = Invoke-WinAppProcess -Executable 'pwsh' -Arguments @('-NoProfile','-Command','exit 3') -TimeoutMs 20000`,
      `Write-Output ('NONZERO=' + ($nonzero | ConvertTo-Json -Compress))`,
      // Hung child: bounded wait -> kill -> classified WINAPP_TIMEOUT throw.
      `try {`,
      `  Invoke-WinAppProcess -Executable 'pwsh' -Arguments @('-NoProfile','-Command','Start-Sleep -Seconds 60') -TimeoutMs 1500 | Out-Null`,
      `  Write-Output 'TIMEOUT=no-throw'`,
      `} catch {`,
      `  Write-Output ('TIMEOUT=' + [string]$_.Exception.Data['WinAppErrorCode'])`,
      `}`,
      '',
    ].join('\r\n'));
    const run = spawnSync('pwsh', ['-NoProfile', '-File', fixture], { encoding: 'utf8', timeout: 90000 });
    assert.equal(run.error, undefined, `pwsh spawn failed: ${run.error?.message}`);
    assert.equal(run.status, 0, `probe exited ${run.status}: ${run.stderr}\n${run.stdout}`);
    const normal = JSON.parse(run.stdout.match(/^NORMAL=(.*)$/m)[1]);
    assert.equal(normal.exit_code, 0);
    assert.match(normal.stdout, /normal-out/);
    assert.match(normal.stderr, /normal-err/);
    assert.equal(normal.timed_out, false);
    const nonzero = JSON.parse(run.stdout.match(/^NONZERO=(.*)$/m)[1]);
    assert.equal(nonzero.exit_code, 3);
    assert.ok(!run.stdout.includes('TIMEOUT=no-throw'), 'timeout path threw no classified error');
    assert.match(run.stdout, /^TIMEOUT=WINAPP_TIMEOUT$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- inspect-media.ps1 failure-cleanup behavior (pwsh, optional) ----------

// Replace the reserved stream with a disposal hook at the missing-dependency
// boundary. The hook closes the real handle and plants another owner's file
// before finally continues: a deterministic reproduction, without timing loops.
test('inspect-media failure cleanup never deletes a replacement file and never reports partial output as success', { skip: !pwshAvailable }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ludi-inspect-'));
  try {
    const quote = value => value.replace(/'/g, "''");
    const inputPath = join(dir, 'in.mp4');
    const outputPath = join(dir, 'out.json');
    const fixturePath = join(dir, 'failure.ps1');
    writeFileSync(inputPath, 'dummy');
    writeFileSync(fixturePath, [
      '$ErrorActionPreference = "Stop"',
      `$script:fixtureOutput = '${quote(outputPath)}'`,
      '$script:replaced = $false',
      'function Get-Command {',
      '  [CmdletBinding()] param([Parameter(Position=0)][string]$Name)',
      '  if ($Name -ne "ffprobe") { throw "Unexpected dependency lookup" }',
      '  $script:reserved = $script:outputJsonStream',
      '  $proxy = [pscustomobject]@{}',
      '  $proxy | Add-Member -MemberType ScriptMethod -Name Dispose -Value {',
      '    $script:reserved.Dispose()',
      '    [IO.File]::Delete($script:fixtureOutput)',
      '    [IO.File]::WriteAllText($script:fixtureOutput, "sentinel")',
      '    $script:replaced = $true',
      '  }',
      '  $script:outputJsonStream = $proxy',
      '  throw "Fixture: ffprobe unavailable"',
      '}',
      '$failed = $false',
      'try {',
      `  . '${quote(join(scripts, 'inspect-media.ps1'))}' -Input '${quote(inputPath)}' -OutputJson $script:fixtureOutput 3>&1`,
      '} catch { $failed = $true; Write-Output ("EXPECTED_FAILURE=" + $_.Exception.Message) }',
      'Write-Output ("PROBE=" + (@{ failed=$failed; replaced=$script:replaced } | ConvertTo-Json -Compress))',
    ].join('\n'));
    const run = spawnSync('pwsh', ['-NoProfile', '-File', fixturePath], { encoding: 'utf8', timeout: 30000 });
    assert.equal(run.status, 0, `${run.error ?? ''}\n${run.stderr}\n${run.stdout}`);
    const probe = JSON.parse(run.stdout.match(/^PROBE=(.*)$/m)[1]);
    assert.equal(probe.failed, true, 'dependency failure must remain a failure');
    assert.equal(probe.replaced, true, 'disposal hook must release the reservation');
    assert.ok(existsSync(outputPath), 'replacement file was deleted by failure cleanup');
    assert.equal(readFileSync(outputPath, 'utf8'), 'sentinel');
    assert.match(run.stdout, /partial output/i, 'redirected warning reports the leftover file');
    assert.ok(run.stdout.includes('out.json'));
    assert.ok(!run.stdout.includes('schema_version'), 'failure must not emit successful media JSON');
    const fd = openSync(outputPath, 'r+');
    closeSync(fd);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
