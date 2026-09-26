[CmdletBinding()]
param(
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

$run = New-VisualRun -RunDirectory $RunDirectory -Kind 'visual'
$resolvedRunDirectory = $run.RunDirectory
if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path $resolvedRunDirectory 'screenshot.png'
}
$resolvedOutputPath = [IO.Path]::GetFullPath($OutputPath)
Assert-OutputAvailable -Path $resolvedOutputPath -Overwrite:$Overwrite
$target = Resolve-CaptureTarget -Mode $Mode -X $X -Y $Y -Width $Width -Height $Height -WindowTitle $WindowTitle -Hwnd $Hwnd
$ffmpegArguments = [string[]]@('-f', 'gdigrab', '-framerate', '1', '-draw_mouse', '1') + $target.InputOptions + @('-frames:v', '1', '-c:v', 'png')
if ($Overwrite) {
    $ffmpegArguments += '-y'
}
$ffmpegArguments += $resolvedOutputPath

Invoke-Ffmpeg -FfmpegPath (Get-FfmpegPath) -Arguments $ffmpegArguments -Operation "static $($target.TargetDescription) capture"
$resultJson = Write-ResultJson -Result ([pscustomobject]@{
        schema_version = 'agent-verification-lab.result.v1'
        status         = 'ok'
        kind           = $run.Kind
        run_id         = $run.RunId
        run_directory  = $resolvedRunDirectory
        artifacts      = @([pscustomobject]@{ role = 'capture'; path = $resolvedOutputPath; mime = 'image/png' })
        backend        = [pscustomobject]@{ name = 'ffmpeg'; version = $null }
        warnings       = @()
    })
Write-VisualResult -RunDirectory $resolvedRunDirectory -OutputPath $resolvedOutputPath -Kind 'screenshot' -ResultJsonPath $resultJson
