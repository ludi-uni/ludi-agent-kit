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
    [ValidateRange(1, 20)][int]$Depth = 6,
    [switch]$Interactive,
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
    $outputPath = Join-Path $run.RunDirectory 'desktop-ui.json'
    Assert-OutputAvailable -Path $outputPath
    $arguments = New-WinAppInspectArguments -Hwnd $target.hwnd -Depth $Depth -Interactive:$Interactive
    $response = Invoke-WinAppJson -Executable $version.executable -Arguments $arguments -Operation inspect
    $elementCount = 0
    foreach ($window in @(Get-WinAppPropertyValue $response.data 'windows' @())) { $elementCount += [int](Get-WinAppPropertyValue $window 'elementCount' 0) }
    $capability = if ($elementCount -eq 0) { 'UIA_UNAVAILABLE' } elseif ($elementCount -le 1) { 'UIA_LIMITED' } else { 'UIA_RICH' }
    $document = [pscustomobject]@{
        schema_version = 'agent-verification-lab.desktop-ui.v1'
        backend        = [pscustomobject]@{ name = 'winapp-cli'; version = $version.actual; tested_version = $version.tested; version_classification = $version.classification }
        target         = $target
        capability     = $capability
        element_count  = $elementCount
        upstream_tree  = $response.data
        interaction    = [pscustomobject]@{ automatic = $false; background_guaranteed = $false; may_foreground_target = $true }
    }
    $targetPath = Write-WinAppTargetDocument -Path (Join-Path $run.RunDirectory 'desktop-window.json') -Target $target -VersionInfo $version
    Write-WinAppJsonFile -Value $document -Path $outputPath | Out-Null
    $warnings = @()
    if ($version.classification -eq 'UNTESTED_NEWER') { $warnings += 'WINAPP_VERSION_UNTESTED' }
    if ($capability -ne 'UIA_RICH') { $warnings += $capability }
    $resultJson = Write-ResultJson -Result ([pscustomobject]@{
            schema_version = 'agent-verification-lab.result.v1'
            status         = 'ok'
            kind           = $run.Kind
            run_id         = $run.RunId
            run_directory  = $run.RunDirectory
            artifacts      = @(
                [pscustomobject]@{ role = 'desktop-window'; path = $targetPath; mime = 'application/json' },
                [pscustomobject]@{ role = 'desktop-ui'; path = $outputPath; mime = 'application/json' }
            )
            backend        = $document.backend
            target         = $target
            uia            = [pscustomobject]@{ capability = $capability; element_count = $elementCount; optional = $true }
            warnings       = $warnings
        })
    Write-VisualResult -RunDirectory $run.RunDirectory -OutputPath $outputPath -Kind 'desktop-ui' -ResultJsonPath $resultJson
}
catch {
    Write-WinAppFailure -ErrorRecord $_ -Operation inspect
    exit 1
}
