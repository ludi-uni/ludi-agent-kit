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
    [double]$Duration = 5,
    [int]$Fps = 5,
    [switch]$Frames,
    [int]$MaxEdge = 1280,
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
    if ([string]::IsNullOrWhiteSpace($OutputPath)) { $OutputPath = Join-Path $run.RunDirectory 'recording.mp4' }
    $resolvedOutputPath = [IO.Path]::GetFullPath($OutputPath)
    $metadataOutputPath = Join-Path $run.RunDirectory 'recording.json'
    $representativeOutputPath = Join-Path $run.RunDirectory 'representative-frames.json'
    Assert-OutputAvailable -Path $resolvedOutputPath
    Assert-OutputAvailable -Path $metadataOutputPath
    if ($Frames) { Assert-OutputAvailable -Path $representativeOutputPath }
    $expectedFramesDirectory = Join-Path (Split-Path -Parent $resolvedOutputPath) (([IO.Path]::GetFileNameWithoutExtension($resolvedOutputPath)) + '.frames')
    if ($Frames -and (Test-Path -LiteralPath $expectedFramesDirectory)) { throw (New-WinAppException -Code 'RECORD_FAILED' -Message "Frame output already exists: $expectedFramesDirectory") }
    $target = Get-WinAppWindowTarget -Executable $version.executable -App $App -ProcessName $ProcessName -WindowTitle $WindowTitle -ClassName $ClassName -ProcessId $ProcessId -Hwnd $Hwnd -Width $Width -Height $Height
    $arguments = New-WinAppRecordArguments -Hwnd $target.hwnd -OutputPath $resolvedOutputPath -Duration $Duration -Fps $Fps -Frames:$Frames -MaxEdge $MaxEdge
    $response = Invoke-WinAppJson -Executable $version.executable -Arguments $arguments -Operation record
    Assert-WinAppMp4 -Path $resolvedOutputPath
    $recordWidth = [int](Get-WinAppPropertyValue $response.data 'width' 0)
    $recordHeight = [int](Get-WinAppPropertyValue $response.data 'height' 0)
    if ($recordWidth -le 0 -or $recordHeight -le 0) { throw (New-WinAppException -Code 'RECORD_FAILED' -Message 'WinApp CLI returned zero recording dimensions.') }
    if ([string](Get-WinAppPropertyValue $response.data 'codec') -ne 'h264') { throw (New-WinAppException -Code 'RECORD_FAILED' -Message 'WinApp CLI did not report an H.264 recording.') }

    $artifacts = [Collections.Generic.List[object]]::new()
    [void]$artifacts.Add([pscustomobject]@{ role = 'capture'; path = $resolvedOutputPath; mime = 'video/mp4' })
    $representative = @()
    $frameArtifacts = Get-WinAppPropertyValue $response.data 'frameArtifacts'
    if ($Frames) {
        if ($null -eq $frameArtifacts) { throw (New-WinAppException -Code 'RECORD_FAILED' -Message 'Frame artifacts were requested but not reported.') }
        $framesDirectory = [IO.Path]::GetFullPath([string](Get-WinAppPropertyValue $frameArtifacts 'directory'))
        $manifestPath = [IO.Path]::GetFullPath([string](Get-WinAppPropertyValue $frameArtifacts 'manifest'))
        $indexPath = [IO.Path]::GetFullPath([string](Get-WinAppPropertyValue $frameArtifacts 'index'))
        if (-not (Test-Path -LiteralPath $framesDirectory -PathType Container) -or -not (Test-Path -LiteralPath $manifestPath -PathType Leaf) -or -not (Test-Path -LiteralPath $indexPath -PathType Leaf)) { throw (New-WinAppException -Code 'RECORD_FAILED' -Message 'One or more requested frame artifacts are missing.') }
        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json -ErrorAction Stop
        if ([string](Get-WinAppPropertyValue $manifest 'status') -ne 'complete') { throw (New-WinAppException -Code 'RECORD_FAILED' -Message 'Frame manifest is not complete.') }
        $samples = @(Get-Content -LiteralPath $indexPath | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | ForEach-Object { $_ | ConvertFrom-Json -ErrorAction Stop })
        if ($samples.Count -eq 0) { throw (New-WinAppException -Code 'RECORD_FAILED' -Message 'frames.ndjson contains no samples.') }
        $representative = @(Select-WinAppRepresentativeFrames -Samples $samples -FramesRoot $framesDirectory)
        foreach ($frame in $representative) { if (-not (Test-Path -LiteralPath $frame.path -PathType Leaf)) { throw (New-WinAppException -Code 'RECORD_FAILED' -Message "Representative frame is missing: $($frame.path)") } }
        $representativePath = Write-WinAppJsonFile -Value ([pscustomobject]@{ strategy = 'first_middle_last'; samples = $representative }) -Path $representativeOutputPath
        [void]$artifacts.Add([pscustomobject]@{ role = 'frame-directory'; path = $framesDirectory; mime = 'application/x-directory' })
        [void]$artifacts.Add([pscustomobject]@{ role = 'frame-manifest'; path = $manifestPath; mime = 'application/json' })
        [void]$artifacts.Add([pscustomobject]@{ role = 'frame-index'; path = $indexPath; mime = 'application/x-ndjson' })
        [void]$artifacts.Add([pscustomobject]@{ role = 'representative-frames'; path = $representativePath; mime = 'application/json' })
    }

    $commandResult = [pscustomobject]@{ exit_code = $response.process.exit_code; arguments = @($arguments) }
    $metadata = New-WinAppOperationMetadata -Operation 'record' -Version $version.actual -VersionClassification $version.classification -Target $target -ArtifactPath $resolvedOutputPath -Width $recordWidth -Height $recordHeight -CommandResult $commandResult
    $metadata | Add-Member -NotePropertyName recording -NotePropertyValue ([pscustomobject]@{
            codec = 'h264'; duration_sec = [double](Get-WinAppPropertyValue $response.data 'durationSec' 0); fps = [double](Get-WinAppPropertyValue $response.data 'fps' 0); capture_mode = [string](Get-WinAppPropertyValue $response.data 'mode'); frames_enabled = [bool]$Frames; representative_frames = $representative
        })
    $targetPath = Write-WinAppTargetDocument -Path (Join-Path $run.RunDirectory 'desktop-window.json') -Target $target -VersionInfo $version
    $metadataPath = Write-WinAppJsonFile -Value $metadata -Path $metadataOutputPath
    [void]$artifacts.Add([pscustomobject]@{ role = 'desktop-window'; path = $targetPath; mime = 'application/json' })
    [void]$artifacts.Add([pscustomobject]@{ role = 'recording-metadata'; path = $metadataPath; mime = 'application/json' })
    $warnings = @()
    if ($version.classification -eq 'UNTESTED_NEWER') { $warnings += 'WINAPP_VERSION_UNTESTED' }
    $resultJson = Write-ResultJson -Result ([pscustomobject]@{
            schema_version = 'agent-verification-lab.result.v1'
            status         = 'ok'
            kind           = $run.Kind
            run_id         = $run.RunId
            run_directory  = $run.RunDirectory
            artifacts      = @($artifacts)
            backend        = $metadata.backend
            target         = $target
            recording      = $metadata.recording
            warnings       = $warnings
        })
    Write-VisualResult -RunDirectory $run.RunDirectory -OutputPath $resolvedOutputPath -Kind 'desktop-recording' -ResultJsonPath $resultJson
}
catch {
    Write-WinAppFailure -ErrorRecord $_ -Operation record
    exit 1
}
