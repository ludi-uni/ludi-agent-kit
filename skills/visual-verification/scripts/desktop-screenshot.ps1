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
    [string]$OutputPath,
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
    if ([string]::IsNullOrWhiteSpace($OutputPath)) { $OutputPath = Join-Path $run.RunDirectory 'screenshot.png' }
    $resolvedOutputPath = [IO.Path]::GetFullPath($OutputPath)
    $metadataOutputPath = Join-Path $run.RunDirectory 'screenshot.json'
    Assert-OutputAvailable -Path $resolvedOutputPath
    Assert-OutputAvailable -Path $metadataOutputPath
    $target = Get-WinAppWindowTarget -Executable $version.executable -App $App -ProcessName $ProcessName -WindowTitle $WindowTitle -ClassName $ClassName -ProcessId $ProcessId -Hwnd $Hwnd -Width $Width -Height $Height
    $arguments = New-WinAppScreenshotArguments -Hwnd $target.hwnd -OutputPath $resolvedOutputPath
    $response = Invoke-WinAppJson -Executable $version.executable -Arguments $arguments -Operation screenshot
    $dimensions = Get-PngDimensions -Path $resolvedOutputPath
    $reportedPath = [string](Get-WinAppPropertyValue $response.data 'filePath')
    if (-not [string]::IsNullOrWhiteSpace($reportedPath) -and [IO.Path]::GetFullPath($reportedPath) -ne $resolvedOutputPath) {
        throw (New-WinAppException -Code 'CAPTURE_FAILED' -Message 'WinApp CLI reported a different screenshot output path.')
    }
    $associated = @(Get-WinAppPropertyValue $response.data 'windows' @())
    $commandResult = [pscustomobject]@{ exit_code = $response.process.exit_code; arguments = @($arguments) }
    $metadata = New-WinAppOperationMetadata -Operation 'screenshot' -Version $version.actual -VersionClassification $version.classification -Target $target -ArtifactPath $resolvedOutputPath -Width $dimensions.width -Height $dimensions.height -AssociatedWindows $associated -CommandResult $commandResult
    $targetPath = Write-WinAppTargetDocument -Path (Join-Path $run.RunDirectory 'desktop-window.json') -Target $target -VersionInfo $version
    $metadataPath = Write-WinAppJsonFile -Value $metadata -Path $metadataOutputPath
    $warnings = @()
    if ($version.classification -eq 'UNTESTED_NEWER') { $warnings += 'WINAPP_VERSION_UNTESTED' }
    $resultJson = Write-ResultJson -Result ([pscustomobject]@{
            schema_version = 'agent-verification-lab.result.v1'
            status         = 'ok'
            kind           = $run.Kind
            run_id         = $run.RunId
            run_directory  = $run.RunDirectory
            artifacts      = @(
                [pscustomobject]@{ role = 'capture'; path = $resolvedOutputPath; mime = 'image/png' },
                [pscustomobject]@{ role = 'desktop-window'; path = $targetPath; mime = 'application/json' },
                [pscustomobject]@{ role = 'screenshot-metadata'; path = $metadataPath; mime = 'application/json' }
            )
            backend        = $metadata.backend
            target         = $target
            capture        = [pscustomobject]@{ status = 'PASS'; semantic_verification = 'REQUIRES_VISUAL_INSPECTION'; mode = 'default_window_capture'; capture_screen = $false }
            warnings       = $warnings
        })
    Write-VisualResult -RunDirectory $run.RunDirectory -OutputPath $resolvedOutputPath -Kind 'desktop-screenshot' -ResultJsonPath $resultJson
}
catch {
    Write-WinAppFailure -ErrorRecord $_ -Operation screenshot
    exit 1
}
