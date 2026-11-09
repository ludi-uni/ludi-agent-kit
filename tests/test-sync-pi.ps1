#requires -Version 7.0
# Exercises adapters/pi/sync-pi.ps1 against an isolated temporary agent dir.
# Dry-run must write nothing to the target; -Apply creates only the planned link/AGENTS entries
# and never touches settings/auth; -ApplySettings (explicit opt-in) merges only the four kit roles'
# model/thinking into settings.json with backup + concurrency refusal. All fixtures are synthetic
# bindings/settings under temp dirs — no real user settings, auth or machine-local models.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$kit = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$root = Join-Path ([IO.Path]::GetTempPath()) ('ludi-kit-sync-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$agent = Join-Path $root 'agent'
New-Item -ItemType Directory -Path $agent | Out-Null
$settings = '{"defaultProvider":"fixture","defaultModel":"fixture-model","defaultTools":["read"]}'
[IO.File]::WriteAllText((Join-Path $agent 'settings.json'), $settings)
[IO.File]::WriteAllText((Join-Path $agent 'auth.json'), '{"fixture":"not-a-real-secret"}')
[IO.File]::WriteAllText((Join-Path $agent 'AGENTS.md'), '# user instructions')
$sync = Join-Path $kit 'adapters/pi/sync-pi.ps1'

# 1. dry-run: nothing changes in target
$before = Get-ChildItem $agent -Recurse -Force | Select-Object -ExpandProperty FullName | Sort-Object
& pwsh -NoProfile -File $sync -AgentDir $agent | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'dry-run failed' }
$after = Get-ChildItem $agent -Recurse -Force | Select-Object -ExpandProperty FullName | Sort-Object
if (($before -join '|') -cne ($after -join '|')) { throw 'dry-run modified the agent directory' }
$plan = Get-Content (Join-Path $kit 'adapters/pi/out/plan.json') -Raw | ConvertFrom-Json
if ($plan.mode -ne 'dry-run') { throw 'plan mode should be dry-run' }
if (-not ($plan.plan | Where-Object { $_.entry -eq 'AGENTS.md' -and $_.state -eq 'conflict-existing' })) { throw 'existing AGENTS.md should be reported as conflict' }
if (-not ($plan.plan | Where-Object { $_.entry -eq 'skills/visual-verification' -and $_.state -eq 'create' })) { throw 'skill link should be planned' }
$agentsPlan = $plan.plan | Where-Object { $_.entry -eq 'agents/ludi-agent-kit' }
if (-not $agentsPlan) { throw 'agents link missing from plan' }
$expectedProfiles = [IO.Path]::GetFullPath((Join-Path $kit 'adapters/pi/out/agent-profiles'))
if ([IO.Path]::GetFullPath($agentsPlan.target) -cne $expectedProfiles) { throw "agents junction must target out/agent-profiles, got $($agentsPlan.target)" }
if (-not (Test-Path (Join-Path $kit 'adapters/pi/out/AGENTS.md'))) { throw 'generated AGENTS.md missing' }
# derived pi-subagents profiles: generated, strict tools allowlist, gated provider
foreach ($role in 'coder', 'tester') {
    $profilePath = Join-Path $expectedProfiles "$role.md"
    if (-not (Test-Path $profilePath)) { throw "derived profile missing: $role.md" }
    $profileText = Get-Content $profilePath -Raw
    if ($profileText -notmatch '(?m)^tools: .+ludi_exec') { throw "$role profile must allowlist ludi_exec" }
    if ($profileText -match '(?m)^tools: .*(powershell|bash)') { throw "$role profile must not allowlist raw shell" }
    if ($profileText -notmatch '(?m)^subagentOnlyExtensions: \./extensions/') { throw "$role profile must load the generated shell-gate provider" }
    $providerPath = Join-Path $expectedProfiles "extensions/$role-shell-gate.mjs"
    if (-not (Test-Path $providerPath)) { throw "generated provider missing: $role-shell-gate.mjs" }
    $providerText = Get-Content $providerPath -Raw
    if ($providerText -notmatch 'createShellGate' -or $providerText -notmatch "`"agent`":`"$role`"") { throw "$role provider must embed the role policy via createShellGate" }
}
# Non-adapted roles pass their source tools/frontmatter through verbatim and
# gain no provider. Approved scope is coder/tester only.
foreach ($role in 'scout', 'browser') {
    $profileText = Get-Content (Join-Path $expectedProfiles "$role.md") -Raw
    $sourceText = Get-Content (Join-Path $kit "agents/$role.md") -Raw
    $profileTools = [regex]::Match($profileText, '(?m)^tools: (.*)$').Groups[1].Value.Trim()
    $sourceTools = [regex]::Match($sourceText, '(?m)^tools: (.*)$').Groups[1].Value.Trim()
    if ($profileTools -cne $sourceTools) { throw "$role profile tools must pass through verbatim: derived [$profileTools] source [$sourceTools]" }
    if ($profileTools -match 'ludi_exec') { throw "$role profile must not gain ludi_exec" }
    if ($profileText -match '(?m)^subagentOnlyExtensions:') { throw "$role profile must not gain a provider" }
    if (Test-Path (Join-Path $expectedProfiles "extensions/$role-shell-gate.mjs")) { throw "$role shell-gate provider must not be generated" }
}
# browser's body requires powershell for the agent-browser wrapper: it is
# preserved verbatim, never stripped or rewritten.
$browserText = Get-Content (Join-Path $expectedProfiles 'browser.md') -Raw
if ($browserText -notmatch '(?m)^tools: .*powershell') { throw 'browser profile must keep its authored powershell tool' }
$orchText = Get-Content (Join-Path $expectedProfiles 'orchestrator.md') -Raw
if ($orchText -match '(?m)^tools: .*ludi_exec') { throw 'orchestrator profile must not gain ludi_exec' }
if ($orchText -match '(?m)^subagentOnlyExtensions:') { throw 'orchestrator profile must not load a shell provider' }

# 2. apply without -BackupConflicts must refuse and change nothing
$failed = $false
try { & pwsh -NoProfile -File $sync -AgentDir $agent -Apply 2>$null | Out-Null; if ($LASTEXITCODE -ne 0) { $failed = $true } } catch { $failed = $true }
if (-not $failed) { throw 'apply with conflicts should fail' }
if ((Get-Content (Join-Path $agent 'AGENTS.md') -Raw) -cne '# user instructions') { throw 'conflicting AGENTS.md was modified' }

# 3. apply with -BackupConflicts: junctions + AGENTS, backup retained, settings/auth untouched
& pwsh -NoProfile -File $sync -AgentDir $agent -Apply -BackupConflicts | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'apply failed' }
foreach ($rel in 'skills/visual-verification', 'skills/project-management', 'skills/pi-workflow', 'agents/ludi-agent-kit', 'extensions/ludi-agent-kit', 'extensions/ludi-orchestrator') {
    $item = Get-Item -LiteralPath (Join-Path $agent $rel) -Force
    if ($item.LinkType -ne 'Junction') { throw "$rel is not a Junction" }
}
# Junction entity must resolve to the derived profiles, not the raw common agents dir.
$agentLink = Get-Item -LiteralPath (Join-Path $agent 'agents/ludi-agent-kit') -Force
if ([IO.Path]::GetFullPath($agentLink.Target) -cne $expectedProfiles) { throw "agents junction resolves to $($agentLink.Target), expected $expectedProfiles" }
if (-not (Test-Path (Join-Path $agent 'agents/ludi-agent-kit/coder.md'))) { throw 'derived coder profile not visible through the junction' }
if ((Get-Content (Join-Path $agent 'AGENTS.md') -Raw) -notmatch '^<!-- Generated by ludi-agent-kit') { throw 'AGENTS.md not generated' }
$backups = @(Get-ChildItem (Join-Path $agent 'ludi-agent-kit') -Directory -Filter 'backup-*')
if ($backups.Count -ne 1 -or -not (Test-Path (Join-Path $backups[0].FullName 'AGENTS.md'))) { throw 'AGENTS.md backup missing' }
if ([IO.File]::ReadAllText((Join-Path $agent 'settings.json')) -cne $settings) { throw 'settings.json modified' }
if ([IO.File]::ReadAllText((Join-Path $agent 'auth.json')) -cne '{"fixture":"not-a-real-secret"}') { throw 'auth.json modified' }

# 4. repeat apply is a no-op
& pwsh -NoProfile -File $sync -AgentDir $agent -Apply | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'repeat apply failed' }
$plan = Get-Content (Join-Path $kit 'adapters/pi/out/plan.json') -Raw | ConvertFrom-Json
if ($plan.plan | Where-Object { $_.state -ne 'ok' }) { throw 'repeat apply should report all ok' }

# 5. -ApplySettings: deterministic synthetic user bindings under a temp agent dir.
$agent2 = Join-Path $root 'agent2'
$bindingDir = Join-Path $agent2 'ludi-agent-kit'
New-Item -ItemType Directory -Path $bindingDir -Force | Out-Null
$bindings = '{"version":1,"backends":{"qoder":{"provider":"pq","model":"mq"},"devin":{"provider":"pd","model":"md"},"astra":{"provider":"pa","model":"ma"},"sol":{"provider":"ps","model":"ms"}}}'
[IO.File]::WriteAllText((Join-Path $bindingDir 'models.local.json'), $bindings)
$liveSettings = '{"defaultProvider":"pfix","subagents":{"agentOverrides":{"scout":{"model":"old/x","tools":["read"]},"custom":{"model":"keep/k"}}}}'
[IO.File]::WriteAllText((Join-Path $agent2 'settings.json'), $liveSettings)

# 5a. dry-run must not touch settings even though a proposal exists
& pwsh -NoProfile -File $sync -AgentDir $agent2 | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'agent2 dry-run failed' }
if ([IO.File]::ReadAllText((Join-Path $agent2 'settings.json')) -cne $liveSettings) { throw 'dry-run modified settings.json' }
$plan = Get-Content (Join-Path $kit 'adapters/pi/out/plan.json') -Raw | ConvertFrom-Json
if (-not $plan.neverTouched.Contains('settings.json')) { throw 'dry-run plan must list settings.json as neverTouched' }

# 5b. -ApplySettings alone: merges the four roles, preserves everything else, backs up
& pwsh -NoProfile -File $sync -AgentDir $agent2 -ApplySettings | Out-Null
if ($LASTEXITCODE -ne 0) { throw '-ApplySettings failed' }
$merged = Get-Content (Join-Path $agent2 'settings.json') -Raw | ConvertFrom-Json -AsHashtable
if ($merged.defaultProvider -ne 'pfix') { throw 'defaultProvider lost' }
foreach ($role in 'scout','coder','visual','reviewer') {
    if (-not $merged.subagents.agentOverrides.Contains($role)) { throw "role $role missing" }
}
if ($merged.subagents.agentOverrides.scout.model -ne 'pq/mq' -or $merged.subagents.agentOverrides.scout.thinking -ne 'low' -or $merged.subagents.agentOverrides.scout.tools[0] -ne 'read') { throw 'scout merge wrong' }
if ($merged.subagents.agentOverrides.coder.model -ne 'pd/md') { throw 'coder model wrong' }
if ($merged.subagents.agentOverrides.visual.model -ne 'pa/ma') { throw 'visual model wrong' }
if ($merged.subagents.agentOverrides.reviewer.model -ne 'pd/md') { throw 'reviewer model wrong' }
if ($merged.subagents.agentOverrides.custom.model -ne 'keep/k') { throw 'unrelated role clobbered' }
$sBackups = @(Get-ChildItem $bindingDir -Directory -Filter 'backup-*' | Where-Object { Test-Path (Join-Path $_.FullName 'settings.json') })
if ($sBackups.Count -ne 1 -or [IO.File]::ReadAllText((Join-Path $sBackups[0].FullName 'settings.json')) -cne $liveSettings) { throw 'settings backup missing or not byte-for-byte' }
if (Get-ChildItem $agent2 -Force -Filter '*.ludi-apply.lock') { throw 'lock file left behind' }
if (Get-ChildItem $agent2 -Force -Filter '*.ludi-staging-*') { throw 'staging file left behind' }
# links must NOT have been created by -ApplySettings alone
if (Test-Path (Join-Path $agent2 'skills')) { throw '-ApplySettings created links' }

# 5c. repeat -ApplySettings is a byte-identical no-op with no extra backup
$bytes = [IO.File]::ReadAllText((Join-Path $agent2 'settings.json'))
& pwsh -NoProfile -File $sync -AgentDir $agent2 -ApplySettings | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'repeat -ApplySettings failed' }
if ([IO.File]::ReadAllText((Join-Path $agent2 'settings.json')) -cne $bytes) { throw 'repeat -ApplySettings changed bytes' }
$sBackups2 = @(Get-ChildItem $bindingDir -Directory -Filter 'backup-*' | Where-Object { Test-Path (Join-Path $_.FullName 'settings.json') })
if ($sBackups2.Count -ne 1) { throw 'repeat -ApplySettings wrote an extra backup' }

# 5d. -Apply -ApplySettings together: settings merge + links, no link conflicts on fresh dir
& pwsh -NoProfile -File $sync -AgentDir $agent2 -Apply -ApplySettings | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'combined -Apply -ApplySettings failed' }
$item = Get-Item -LiteralPath (Join-Path $agent2 'skills/pi-workflow') -Force
if ($item.LinkType -ne 'Junction') { throw 'combined run did not create links' }
$merged = Get-Content (Join-Path $agent2 'settings.json') -Raw | ConvertFrom-Json -AsHashtable
if ($merged.subagents.agentOverrides.coder.model -ne 'pd/md') { throw 'combined run lost settings merge' }
$plan = Get-Content (Join-Path $kit 'adapters/pi/out/plan.json') -Raw | ConvertFrom-Json
if ($plan.neverTouched.Contains('settings.json')) { throw 'apply plan should not claim settings.json neverTouched' }

# 5e. -Apply -ApplySettings with a link conflict refuses BEFORE touching settings
$agent3 = Join-Path $root 'agent3'
$bd3 = Join-Path $agent3 'ludi-agent-kit'
New-Item -ItemType Directory -Path $bd3 -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $bd3 'models.local.json'), $bindings)
[IO.File]::WriteAllText((Join-Path $agent3 'settings.json'), '{"defaultProvider":"pfix"}')
[IO.File]::WriteAllText((Join-Path $agent3 'AGENTS.md'), '# user instructions')
$failed = $false
try { & pwsh -NoProfile -File $sync -AgentDir $agent3 -Apply -ApplySettings 2>$null | Out-Null; if ($LASTEXITCODE -ne 0) { $failed = $true } } catch { $failed = $true }
if (-not $failed) { throw 'combined apply with conflicts should fail' }
if ([IO.File]::ReadAllText((Join-Path $agent3 'settings.json')) -cne '{"defaultProvider":"pfix"}') { throw 'settings mutated despite link-conflict refusal' }

# 5f. -ApplySettings on missing settings creates only the minimal subagents object
$agent4 = Join-Path $root 'agent4'
$bd4 = Join-Path $agent4 'ludi-agent-kit'
New-Item -ItemType Directory -Path $bd4 -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $bd4 'models.local.json'), $bindings)
& pwsh -NoProfile -File $sync -AgentDir $agent4 -ApplySettings | Out-Null
if ($LASTEXITCODE -ne 0) { throw '-ApplySettings on missing settings failed' }
$merged = Get-Content (Join-Path $agent4 'settings.json') -Raw | ConvertFrom-Json -AsHashtable
if ($merged.Keys.Count -ne 1 -or -not $merged.Contains('subagents')) { throw 'missing-file merge created extra top-level keys' }
if ($merged.subagents.Keys.Count -ne 1 -or -not $merged.subagents.Contains('agentOverrides')) { throw 'missing-file merge created extra subagents keys' }
if (Get-ChildItem $bd4 -Directory -Filter 'backup-*' -ErrorAction SilentlyContinue | Where-Object { Test-Path (Join-Path $_.FullName 'settings.json') }) { throw 'backup invented for a previously-missing file' }

# 5g. -Apply alone still never touches settings (agent3 has links in conflict state)
$failed = $false
try { & pwsh -NoProfile -File $sync -AgentDir $agent3 -Apply 2>$null | Out-Null; if ($LASTEXITCODE -ne 0) { $failed = $true } } catch { $failed = $true }
if (-not $failed) { throw '-Apply with conflicts should fail' }
if ([IO.File]::ReadAllText((Join-Path $agent3 'settings.json')) -cne '{"defaultProvider":"pfix"}') { throw '-Apply touched settings.json' }

# 5h. Two concurrent target directories must use their own resolver result, not shared out/.
$processes = @()
foreach ($suffix in 'five', 'six') {
    $concurrentAgent = Join-Path $root "agent-$suffix"
    $concurrentBindingDir = Join-Path $concurrentAgent 'ludi-agent-kit'
    New-Item -ItemType Directory -Path $concurrentBindingDir -Force | Out-Null
    $ownBindings = $bindings.Replace('"mq"', "`"mq-$suffix`"").Replace('"md"', "`"md-$suffix`"")
    [IO.File]::WriteAllText((Join-Path $concurrentBindingDir 'models.local.json'), $ownBindings)
    [IO.File]::WriteAllText((Join-Path $concurrentAgent 'settings.json'), '{"preserved":true}')
    $process = Start-Process pwsh -ArgumentList @('-NoProfile', '-File', "`"$sync`"", '-AgentDir', "`"$concurrentAgent`"", '-ApplySettings') -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $root "$suffix.stdout") -RedirectStandardError (Join-Path $root "$suffix.stderr")
    $processes += [pscustomobject]@{ process = $process; agent = $concurrentAgent; suffix = $suffix }
}
foreach ($entry in $processes) {
    if (-not $entry.process.WaitForExit(60000)) {
        foreach ($running in $processes) { if (-not $running.process.HasExited) { $running.process.Kill($true) } }
        throw 'concurrent settings apply timed out'
    }
    if ($entry.process.ExitCode -ne 0) { throw "concurrent settings apply failed for $($entry.suffix): $(Get-Content (Join-Path $root "$($entry.suffix).stderr") -Raw)" }
    $actual = Get-Content (Join-Path $entry.agent 'settings.json') -Raw | ConvertFrom-Json -AsHashtable
    if (-not $actual.preserved -or $actual.subagents.agentOverrides.scout.model -ne "pq/mq-$($entry.suffix)" -or $actual.subagents.agentOverrides.coder.model -ne "pd/md-$($entry.suffix)") { throw 'concurrent sync adopted another target proposal' }
}

# 5i. In-process invocation restores every environment variable it temporarily uses.
$sentinels = @{
    PI_CODING_AGENT_DIR = 'fixture-original-agent-dir'
    LUDI_SETTINGS_SNAP = 'fixture-original-snapshot'
    LUDI_SETTINGS_PROPOSAL_JSON = 'fixture-original-proposal'
    LUDI_SETTINGS_HELPER = 'fixture-original-helper'
}
$savedEnv = @{}
try {
    foreach ($key in $sentinels.Keys) {
        $savedEnv[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
        [Environment]::SetEnvironmentVariable($key, $sentinels[$key], 'Process')
    }
    & $sync -AgentDir $agent2 -ApplySettings | Out-Null
    foreach ($key in $sentinels.Keys) {
        if ([Environment]::GetEnvironmentVariable($key, 'Process') -cne $sentinels[$key]) { throw "sync did not restore $key" }
    }
} finally {
    foreach ($key in $savedEnv.Keys) { [Environment]::SetEnvironmentVariable($key, $savedEnv[$key], 'Process') }
}

# 5j. Shared-preview lock is released on early returns and refused applies too.
if (Test-Path (Join-Path $kit 'adapters/pi/out/.sync-pi.lock')) { throw 'sync leaked the shared-preview OS lock sidecar' }

# cleanup: remove junctions (links only) then fixture
foreach ($j in Get-ChildItem $root -Recurse -Force -Attributes ReparsePoint) { $j.Delete() }
Remove-Item $root -Recurse -Force
Write-Output 'PASS: sync-pi dry-run writes nothing; apply is bounded, backed up and idempotent; -ApplySettings merges role models only, preserves/backs up settings; auth untouched'
