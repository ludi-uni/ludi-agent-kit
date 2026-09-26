[CmdletBinding()]
param(
    [string]$App,
    [string]$ProcessName,
    [string]$WindowTitle,
    [string]$ClassName,
    [Nullable[int]]$ProcessId,
    [Nullable[long]]$Hwnd,
    [Nullable[int]]$Width,
    [Nullable[int]]$Height,
    [string]$RunDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
. (Join-Path $PSScriptRoot 'winapp-common.ps1')

try {
    $version = Get-WinAppVersionInfo
    Assert-WinAppCaptureReady -VersionInfo $version
    $run = New-VisualRun -RunDirectory $RunDirectory -Kind 'visual'
    $target = Get-WinAppWindowTarget -Executable $version.executable -App $App -ProcessName $ProcessName -WindowTitle $WindowTitle -ClassName $ClassName -ProcessId $ProcessId -Hwnd $Hwnd -Width $Width -Height $Height
    $outputPath = Join-Path $run.RunDirectory 'desktop-window.json'
    $metadata = New-WinAppOperationMetadata -Operation 'discover' -Version $version.actual -VersionClassification $version.classification -Target $target -Width $target.width -Height $target.height
    Write-WinAppTargetDocument -Path $outputPath -Target $target -VersionInfo $version | Out-Null
    $warnings = @()
    if ($version.classification -eq 'UNTESTED_NEWER') { $warnings += 'WINAPP_VERSION_UNTESTED' }
    $resultJson = Write-ResultJson -Result ([pscustomobject]@{
            schema_version = 'agent-verification-lab.result.v1'
            status         = 'ok'
            kind           = $run.Kind
            run_id         = $run.RunId
            run_directory  = $run.RunDirectory
            artifacts      = @([pscustomobject]@{ role = 'desktop-window'; path = $outputPath; mime = 'application/json' })
            backend        = $metadata.backend
            target         = $target
            warnings       = $warnings
        })
    Write-VisualResult -RunDirectory $run.RunDirectory -OutputPath $outputPath -Kind 'desktop-window' -ResultJsonPath $resultJson
}
catch {
    Write-WinAppFailure -ErrorRecord $_ -Operation discover
    exit 1
}
