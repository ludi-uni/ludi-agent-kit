[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$InputVideo,
    [double]$Interval = 0.5,
    [int]$MaxFrames = 20,
    [string]$OutputDirectory,
    [string]$RunDirectory,
    [switch]$Overwrite
)

$common = Join-Path $PSScriptRoot 'common.ps1'
. $common

if (-not (Test-Path -LiteralPath $InputVideo -PathType Leaf)) {
    throw "Input video does not exist or is not a file: $InputVideo"
}

if ([double]::IsNaN($Interval) -or [double]::IsInfinity($Interval) -or $Interval -le 0) {
    throw 'Interval must be positive.'
}

if ($MaxFrames -lt 1 -or $MaxFrames -gt 100) {
    throw 'MaxFrames must be between 1 and 100.'
}

$resolvedInputVideo = [IO.Path]::GetFullPath($InputVideo)
$run = New-VisualRun -RunDirectory $RunDirectory -Kind 'visual'
$resolvedRunDirectory = $run.RunDirectory
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $resolvedRunDirectory 'frames'
}

$resolvedOutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $resolvedOutputDirectory) {
    $outputItem = Get-Item -LiteralPath $resolvedOutputDirectory -Force
    if (-not $outputItem.PSIsContainer) {
        throw "Output directory path is a file: $resolvedOutputDirectory"
    }

    $existingItems = @(Get-ChildItem -LiteralPath $resolvedOutputDirectory -Force)
    if ($existingItems.Count -gt 0 -and -not $Overwrite) {
        throw "Output directory is not empty; specify -Overwrite to replace frame outputs: $resolvedOutputDirectory"
    }

    if ($Overwrite) {
        Get-ChildItem -LiteralPath $resolvedOutputDirectory -Filter 'frame-*.png' -File -Force | Remove-Item -Force
    }
}
else {
    New-Item -ItemType Directory -Path $resolvedOutputDirectory -ErrorAction Stop | Out-Null
}

$invariantCulture = [Globalization.CultureInfo]::InvariantCulture
$intervalText = $Interval.ToString('G17', $invariantCulture)
$ffmpegArguments = [string[]]@(
    '-i', $resolvedInputVideo,
    '-vf', "fps=1/$intervalText",
    '-frames:v', $MaxFrames.ToString($invariantCulture),
    '-start_number', '1'
)
if ($Overwrite) {
    $ffmpegArguments += '-y'
}
$ffmpegArguments += (Join-Path $resolvedOutputDirectory 'frame-%03d.png')

Invoke-Ffmpeg -FfmpegPath (Get-FfmpegPath) -Arguments $ffmpegArguments -Operation "frame extraction from $resolvedInputVideo"
$resultJson = Write-ResultJson -Result ([pscustomobject]@{
        schema_version = 'agent-verification-lab.result.v1'
        status         = 'ok'
        kind           = $run.Kind
        run_id         = $run.RunId
        run_directory  = $resolvedRunDirectory
        artifacts      = @([pscustomobject]@{ role = 'frames'; path = $resolvedOutputDirectory; mime = 'application/x-directory' })
        backend        = [pscustomobject]@{ name = 'ffmpeg'; version = $null }
        warnings       = @()
    })
Write-VisualResult -RunDirectory $resolvedRunDirectory -OutputPath $resolvedOutputDirectory -Kind 'frames' -ResultJsonPath $resultJson
