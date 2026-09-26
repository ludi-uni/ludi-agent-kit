[CmdletBinding()]
param(
    [double]$Duration = 5,
    [int]$Fps = 20,
    [ValidateSet('desktop', 'region', 'window')]
    [string]$Mode = 'desktop',
    [Nullable[int]]$X,
    [Nullable[int]]$Y,
    [Nullable[int]]$Width,
    [Nullable[int]]$Height,
    [string]$WindowTitle,
    [IntPtr]$Hwnd = [IntPtr]::Zero,
    [string]$OutputPath,
    [string]$RunDirectory,
    [switch]$Overwrite
)

$common = Join-Path $PSScriptRoot 'common.ps1'
. $common

if ([double]::IsNaN($Duration) -or [double]::IsInfinity($Duration) -or $Duration -lt 1 -or $Duration -gt 60) {
    throw 'Duration must be between 1 and 60 seconds.'
}

if ($Fps -lt 1 -or $Fps -gt 60) {
    throw 'Fps must be between 1 and 60.'
}

$run = New-VisualRun -RunDirectory $RunDirectory -Kind 'visual'
$resolvedRunDirectory = $run.RunDirectory
if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path $resolvedRunDirectory 'recording.mp4'
}

$resolvedOutputPath = [IO.Path]::GetFullPath($OutputPath)
Assert-OutputAvailable -Path $resolvedOutputPath -Overwrite:$Overwrite
$target = Resolve-CaptureTarget -Mode $Mode -X $X -Y $Y -Width $Width -Height $Height -WindowTitle $WindowTitle -Hwnd $Hwnd
$invariantCulture = [Globalization.CultureInfo]::InvariantCulture
$durationText = $Duration.ToString('G17', $invariantCulture)
$fpsText = $Fps.ToString($invariantCulture)
$ffmpegArguments = [string[]]@(
    '-f', 'gdigrab',
    '-draw_mouse', '1',
    '-framerate', $fpsText
) + $target.InputOptions + @(
    '-t', $durationText,
    '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2:0:0:color=black',
    '-an',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-r', $fpsText
)
if ($Overwrite) {
    $ffmpegArguments += '-y'
}
$ffmpegArguments += $resolvedOutputPath

Invoke-Ffmpeg -FfmpegPath (Get-FfmpegPath) -Arguments $ffmpegArguments -Operation "recording $($target.TargetDescription)"
$resultJson = Write-ResultJson -Result ([pscustomobject]@{
        schema_version = 'agent-verification-lab.result.v1'
        status         = 'ok'
        kind           = $run.Kind
        run_id         = $run.RunId
        run_directory  = $resolvedRunDirectory
        artifacts      = @([pscustomobject]@{ role = 'capture'; path = $resolvedOutputPath; mime = 'video/mp4' })
        backend        = [pscustomobject]@{ name = 'ffmpeg'; version = $null }
        warnings       = @()
    })
Write-VisualResult -RunDirectory $resolvedRunDirectory -OutputPath $resolvedOutputPath -Kind 'recording' -ResultJsonPath $resultJson
