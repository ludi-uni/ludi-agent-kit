#requires -Version 7.0
# Regenerate the repository-level AGENTS.md from rules/. Repo-internal only; touches no user files.
$ErrorActionPreference = 'Stop'
$kit = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$common = (Get-Content (Join-Path $kit 'rules/common.md') -Raw).Trim()
$loop = (Get-Content (Join-Path $kit 'rules/loop-prevention.md') -Raw).Trim()
$tail = (Get-Content (Join-Path $kit 'rules/repo-local.md') -Raw).Trim()
$text = "<!-- ludi-agent-kit repository instructions. Composed from rules/common.md, rules/loop-prevention.md and rules/repo-local.md by scripts/sync-agents-md.ps1; do not edit directly. -->`n$common`n`n$loop`n`n$tail`n"
[IO.File]::WriteAllText((Join-Path $kit 'AGENTS.md'), $text, [Text.UTF8Encoding]::new($false))
Write-Output "wrote $kit\AGENTS.md"
