[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$InputDirectory,
    [int]$Columns = 4,
    [double]$Interval = 0.5,
    [int]$CellWidth = 640,
    [string]$OutputPath,
    [string]$RunDirectory,
    [switch]$Overwrite
)

$common = Join-Path $PSScriptRoot 'common.ps1'
. $common

if (-not (Test-Path -LiteralPath $InputDirectory -PathType Container)) {
    throw "Input directory does not exist or is not a directory: $InputDirectory"
}

if ($Columns -lt 1 -or $Columns -gt 10) {
    throw 'Columns must be between 1 and 10.'
}

if ([double]::IsNaN($Interval) -or [double]::IsInfinity($Interval) -or $Interval -le 0) {
    throw 'Interval must be positive.'
}

if ($CellWidth -lt 64 -or $CellWidth -gt 1920) {
    throw 'CellWidth must be between 64 and 1920.'
}

$resolvedInputDirectory = [IO.Path]::GetFullPath($InputDirectory)
$frames = @(
    Get-ChildItem -LiteralPath $resolvedInputDirectory -Filter 'frame-*.png' -File |
        ForEach-Object {
            if ($_.Name -match '^frame-(\d+)\.png$') {
                [pscustomobject]@{
                    Path  = $_.FullName
                    Index = [long]$Matches[1]
                    Name  = $_.Name
                }
            }
        } |
        Sort-Object -Property Index, Name
)

if ($frames.Count -eq 0) {
    throw "No frame-*.png files were found in: $resolvedInputDirectory"
}

if ($frames.Count -gt 100) {
    throw 'Contact sheets support at most 100 frames.'
}

$run = New-VisualRun -RunDirectory $RunDirectory -Kind 'visual'
$resolvedRunDirectory = $run.RunDirectory
if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path $resolvedRunDirectory 'contact-sheet.png'
}

$resolvedOutputPath = [IO.Path]::GetFullPath($OutputPath)
Assert-OutputAvailable -Path $resolvedOutputPath -Overwrite:$Overwrite

$invariantCulture = [Globalization.CultureInfo]::InvariantCulture
$intervalText = $Interval.ToString('G17', $invariantCulture)
$frameRateText = (1 / $Interval).ToString('G17', $invariantCulture)
$columnsText = $Columns.ToString($invariantCulture)
$rows = [int][Math]::Ceiling($frames.Count / [double]$Columns)
$rowsText = $rows.ToString($invariantCulture)
$cellWidthText = $CellWidth.ToString($invariantCulture)
$cellHeight = [int][Math]::Ceiling(($CellWidth * 9.0) / 32.0) * 2
$cellHeightText = $cellHeight.ToString($invariantCulture)
$fontPath = Join-Path $env:WINDIR 'Fonts\arial.ttf'
if (-not (Test-Path -LiteralPath $fontPath -PathType Leaf)) {
    throw "Required label font does not exist: $fontPath"
}

$fontForFilter = [IO.Path]::GetFullPath($fontPath).Replace('\', '/').Replace(':', '\:')

$ffmpegArguments = [System.Collections.Generic.List[string]]::new()
foreach ($frame in $frames) {
    $ffmpegArguments.Add('-framerate')
    $ffmpegArguments.Add($frameRateText)
    $ffmpegArguments.Add('-i')
    $ffmpegArguments.Add($frame.Path)
}

$branchFilters = [System.Collections.Generic.List[string]]::new()
$normalizedLabels = [System.Collections.Generic.List[string]]::new()
foreach ($index in 0..($frames.Count - 1)) {
    $normalizedLabel = "frame$index"
    $branchFilters.Add("[$index`:v]scale=${cellWidthText}:${cellHeightText}:force_original_aspect_ratio=decrease,pad=${cellWidthText}:${cellHeightText}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,setpts=PTS-STARTPTS[$normalizedLabel]")
    $normalizedLabels.Add("[$normalizedLabel]")
}

$filter = ($branchFilters -join ';') + ';' + ($normalizedLabels -join '') + "concat=n=$($frames.Count):v=1:a=0,settb=AVTB,setpts=N*$intervalText/TB,fps=$frameRateText,drawtext=fontfile='$fontForFilter':text='t=%{pts\:hms}':x=12:y=12:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.75:boxborderw=8,tile=${columnsText}x${rowsText}:padding=8:margin=8:color=black"

$ffmpegArguments.Add('-filter_complex')
$ffmpegArguments.Add($filter)
$ffmpegArguments.Add('-frames:v')
$ffmpegArguments.Add('1')
$ffmpegArguments.Add('-c:v')
$ffmpegArguments.Add('png')
if ($Overwrite) {
    $ffmpegArguments.Add('-y')
}
$ffmpegArguments.Add($resolvedOutputPath)

Invoke-Ffmpeg -FfmpegPath (Get-FfmpegPath) -Arguments $ffmpegArguments.ToArray() -Operation "contact sheet from $resolvedInputDirectory"
$resultJson = Write-ResultJson -Result ([pscustomobject]@{
        schema_version = 'agent-verification-lab.result.v1'
        status         = 'ok'
        kind           = $run.Kind
        run_id         = $run.RunId
        run_directory  = $resolvedRunDirectory
        artifacts      = @([pscustomobject]@{ role = 'contact-sheet'; path = $resolvedOutputPath; mime = 'image/png' })
        backend        = [pscustomobject]@{ name = 'ffmpeg'; version = $null }
        warnings       = @()
    })
Write-VisualResult -RunDirectory $resolvedRunDirectory -OutputPath $resolvedOutputPath -Kind 'contact-sheet' -ResultJsonPath $resultJson
