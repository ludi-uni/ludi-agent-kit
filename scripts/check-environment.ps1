#requires -Version 7.0
# Read-only environment check: which runtimes/tools this machine actually has. Never contacts a model.
[CmdletBinding()] param()
$ErrorActionPreference = 'Continue'
function Probe([string]$Name, [scriptblock]$Cmd) {
    $v = $null
    try { $v = (& $Cmd 2>$null | Select-Object -First 1); if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { $v = $null } } catch { $v = $null }
    [pscustomobject]@{ tool = $Name; present = [bool]$v; version = "$v".Trim() }
}
$rows = @(
    Probe 'pwsh'    { pwsh --version }
    Probe 'node'    { node --version }
    Probe 'git'     { git --version }
    Probe 'pi'      { pi --version }
    Probe 'codex'   { codex --version }
    Probe 'ffmpeg'  { ffmpeg -version }
    Probe 'ffprobe' { ffprobe -version }
    Probe 'winapp'  { winapp --version }
)
$agentDir = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $env:USERPROFILE '.pi/agent' }
$rows += [pscustomobject]@{ tool = 'pi agent dir'; present = (Test-Path $agentDir); version = $agentDir }
$rows | Format-Table -AutoSize
