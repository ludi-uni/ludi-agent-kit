[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$AudioSource,
    [double]$Duration = 5,
    [int]$Fps = 20,
    [ValidateSet('desktop', 'region', 'window')]
    [string]$VideoMode = 'desktop',
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

Set-StrictMode -Version Latest

function Get-DirectShowAudioDeviceNames {
    [OutputType([string[]])]
    param([Parameter(Mandatory)][string]$FfmpegPath)

    $output = & $FfmpegPath '-hide_banner' '-list_devices' 'true' '-f' 'dshow' '-i' 'dummy' 2>&1
    $audioSources = [System.Collections.Generic.List[string]]::new()
    foreach ($line in $output) {
        $match = [regex]::Match($line.ToString(), '"(?<name>.+)" \(audio\)')
        if ($match.Success) {
            [void]$audioSources.Add($match.Groups['name'].Value)
        }
    }
    return @($audioSources)
}

$common = Join-Path $PSScriptRoot 'common.ps1'
. $common

if ([double]::IsNaN($Duration) -or [double]::IsInfinity($Duration) -or $Duration -lt 1 -or $Duration -gt 60) {
    throw 'Duration must be between 1 and 60 seconds.'
}
if ($Fps -lt 1 -or $Fps -gt 60) {
    throw 'Fps must be between 1 and 60.'
}

$ffmpegPath = Get-FfmpegPath
$availableAudioSources = Get-DirectShowAudioDeviceNames -FfmpegPath $ffmpegPath
if ($availableAudioSources -notcontains $AudioSource) {
    throw "AudioSource is not an enumerated DirectShow audio device: $AudioSource"
}

$run = New-VisualRun -RunDirectory $RunDirectory -Kind 'av'
$resolvedRunDirectory = $run.RunDirectory
if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path $resolvedRunDirectory 'capture.mp4'
}
$resolvedOutputPath = [IO.Path]::GetFullPath($OutputPath)
Assert-OutputAvailable -Path $resolvedOutputPath -Overwrite:$Overwrite

$target = Resolve-CaptureTarget -Mode $VideoMode -X $X -Y $Y -Width $Width -Height $Height -WindowTitle $WindowTitle -Hwnd $Hwnd
$invariantCulture = [Globalization.CultureInfo]::InvariantCulture
$durationText = $Duration.ToString('G17', $invariantCulture)
$fpsText = $Fps.ToString($invariantCulture)
$ffmpegArguments = [string[]]@(
    '-f', 'gdigrab',
    '-draw_mouse', '1',
    '-framerate', $fpsText
) + $target.InputOptions + @(
    '-f', 'dshow',
    '-i', "audio=$AudioSource",
    '-t', $durationText,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2:0:0:color=black',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    '-r', $fpsText
)
if ($Overwrite) {
    $ffmpegArguments += '-y'
}
$ffmpegArguments += $resolvedOutputPath

Invoke-Ffmpeg -FfmpegPath $ffmpegPath -Arguments $ffmpegArguments -Operation "same-session A/V recording $($target.TargetDescription)"
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
Write-VisualResult -RunDirectory $resolvedRunDirectory -OutputPath $resolvedOutputPath -Kind 'av' -ResultJsonPath $resultJson
