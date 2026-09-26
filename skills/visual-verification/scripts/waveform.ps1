[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$Input,
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$OutputPng,
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$OutputEventsJson,
    [int]$Width = 1280,
    [int]$Height = 240,
    [double]$SilenceDb = -35,
    [double]$MinSilenceSeconds = 0.2
)

Set-StrictMode -Version Latest

$common = Join-Path $PSScriptRoot 'common.ps1'
. $common
$inputPath = $PSBoundParameters['Input']

function Resolve-NewOutputPath {
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [string]$Path,
        [Parameter(Mandatory)]
        [string]$ExpectedExtension,
        [Parameter(Mandatory)]
        [string]$ParameterName
    )

    $resolvedPath = [IO.Path]::GetFullPath($Path)
    if ([IO.Path]::GetExtension($resolvedPath) -ine $ExpectedExtension) {
        throw "$ParameterName must use the '$ExpectedExtension' extension: $resolvedPath"
    }

    $directory = Split-Path -Parent $resolvedPath
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
        throw "$ParameterName directory does not exist: $directory"
    }

    if (Test-Path -LiteralPath $resolvedPath) {
        throw "$ParameterName already exists; refusing to overwrite: $resolvedPath"
    }

    return $resolvedPath
}

function ConvertTo-InvariantDouble {
    [OutputType([double])]
    param([Parameter(Mandatory)][string]$Text)

    return [double]::Parse($Text, [Globalization.CultureInfo]::InvariantCulture)
}

function Get-WaveformNativeMethods {
    [OutputType([type])]
    param()

    $nativeMethods = 'AgentVerificationLab.WaveformNativeMethods' -as [type]
    if ($null -eq $nativeMethods) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace AgentVerificationLab
{
    public static class WaveformNativeMethods
    {
        public const uint GenericWrite = 0x40000000;
        public const uint Delete = 0x00010000;
        public const uint CreateNew = 1;
        public const uint OpenExisting = 3;
        public const uint FileAttributeNormal = 0x00000080;
        public const int FileDispositionInfo = 4;

        [StructLayout(LayoutKind.Sequential, Pack = 1)]
        public struct FILE_DISPOSITION_INFO
        {
            [MarshalAs(UnmanagedType.U1)]
            public bool DeleteFile;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern SafeFileHandle CreateFile(
            string lpFileName,
            uint dwDesiredAccess,
            uint dwShareMode,
            IntPtr lpSecurityAttributes,
            uint dwCreationDisposition,
            uint dwFlagsAndAttributes,
            IntPtr hTemplateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool SetFileInformationByHandle(
            SafeFileHandle hFile,
            int FileInformationClass,
            ref FILE_DISPOSITION_INFO lpFileInformation,
            uint dwBufferSize);
    }
}
'@
        $nativeMethods = 'AgentVerificationLab.WaveformNativeMethods' -as [type]
    }

    return $nativeMethods
}

function Open-NewOutputStream {
    [OutputType([IO.FileStream])]
    param(
        [Parameter(Mandatory)]
        [string]$Path,
        [Parameter(Mandatory)]
        [string]$ParameterName
    )

    $nativeMethods = Get-WaveformNativeMethods
    $handle = $nativeMethods::CreateFile(
        $Path,
        ($nativeMethods::GenericWrite -bor $nativeMethods::Delete),
        0,
        [IntPtr]::Zero,
        $nativeMethods::CreateNew,
        $nativeMethods::FileAttributeNormal,
        [IntPtr]::Zero
    )
    if ($handle.IsInvalid) {
        $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        $handle.Dispose()
        throw "$ParameterName could not be exclusively created; refusing to overwrite: $Path (Win32 error $errorCode)"
    }

    try {
        return [IO.FileStream]::new($handle, [IO.FileAccess]::Write)
    }
    catch {
        $handle.Dispose()
        throw
    }
}

function Set-DeletePendingForOpenStream {
    [OutputType([bool])]
    param([Parameter(Mandatory)][IO.FileStream]$Stream)

    $nativeMethods = Get-WaveformNativeMethods
    $disposition = [AgentVerificationLab.WaveformNativeMethods+FILE_DISPOSITION_INFO]::new()
    $disposition.DeleteFile = $true
    return $nativeMethods::SetFileInformationByHandle(
        $Stream.SafeFileHandle,
        $nativeMethods::FileDispositionInfo,
        [ref]$disposition,
        [uint32][Runtime.InteropServices.Marshal]::SizeOf($disposition)
    )
}

function Get-MergedSilenceIntervals {
    [OutputType([object[]])]
    param(
        [Parameter(Mandatory)]
        [string[]]$Diagnostics,
        [Parameter(Mandatory)]
        [double]$AnalysisDurationSeconds,
        [Parameter(Mandatory)]
        [double]$MergeGapSeconds
    )

    $rawIntervals = [System.Collections.Generic.List[object]]::new()
    $openStart = $null
    foreach ($line in $Diagnostics) {
        $text = $line.ToString()
        $startMatch = [regex]::Match($text, 'silence_start:\s*(?<time>-?[0-9]+(?:\.[0-9]+)?)')
        if ($startMatch.Success) {
            $openStart = ConvertTo-InvariantDouble -Text $startMatch.Groups['time'].Value
            continue
        }

        $endMatch = [regex]::Match($text, 'silence_end:\s*(?<time>-?[0-9]+(?:\.[0-9]+)?)')
        if ($endMatch.Success -and $null -ne $openStart) {
            $end = ConvertTo-InvariantDouble -Text $endMatch.Groups['time'].Value
            if ($end -ge $openStart) {
                [void]$rawIntervals.Add([pscustomobject]@{ start = [double]$openStart; end = $end })
            }
            $openStart = $null
        }
    }

    if ($null -ne $openStart -and $AnalysisDurationSeconds -ge $openStart) {
        [void]$rawIntervals.Add([pscustomobject]@{ start = [double]$openStart; end = $AnalysisDurationSeconds })
    }

    $merged = [System.Collections.Generic.List[object]]::new()
    foreach ($interval in @($rawIntervals | Sort-Object start, end)) {
        if ($merged.Count -eq 0) {
            [void]$merged.Add([pscustomobject]@{ start = $interval.start; end = $interval.end })
            continue
        }

        $last = $merged[$merged.Count - 1]
        if ($interval.start -le ($last.end + $MergeGapSeconds)) {
            if ($interval.end -gt $last.end) {
                $last.end = $interval.end
            }
            continue
        }

        [void]$merged.Add([pscustomobject]@{ start = $interval.start; end = $interval.end })
    }

    return @($merged)
}

if (-not (Test-Path -LiteralPath $inputPath -PathType Leaf)) {
    throw "Input media file does not exist or is not a file: $inputPath"
}
if ($Width -lt 64 -or $Width -gt 4096) {
    throw 'Width must be between 64 and 4096.'
}
if ($Height -lt 64 -or $Height -gt 2160) {
    throw 'Height must be between 64 and 2160.'
}
if ([double]::IsNaN($SilenceDb) -or [double]::IsInfinity($SilenceDb) -or $SilenceDb -lt -100 -or $SilenceDb -gt 0) {
    throw 'SilenceDb must be between -100 and 0 dB.'
}
if ([double]::IsNaN($MinSilenceSeconds) -or [double]::IsInfinity($MinSilenceSeconds) -or $MinSilenceSeconds -lt 0.02 -or $MinSilenceSeconds -gt 30) {
    throw 'MinSilenceSeconds must be between 0.02 and 30 seconds.'
}

$resolvedInput = [IO.Path]::GetFullPath($inputPath)
$resolvedOutputPng = Resolve-NewOutputPath -Path $OutputPng -ExpectedExtension '.png' -ParameterName 'OutputPng'
$resolvedOutputEventsJson = Resolve-NewOutputPath -Path $OutputEventsJson -ExpectedExtension '.json' -ParameterName 'OutputEventsJson'
if ($resolvedOutputPng -ieq $resolvedOutputEventsJson) {
    throw 'OutputPng and OutputEventsJson must be different paths.'
}
if ($resolvedInput -ieq $resolvedOutputPng -or $resolvedInput -ieq $resolvedOutputEventsJson) {
    throw 'Output paths must not replace the input media file.'
}

$ffmpegPath = Get-FfmpegPath
$invariantCulture = [Globalization.CultureInfo]::InvariantCulture
$sampleRate = 16000
$windowMilliseconds = 20
$windowSamples = [int]($sampleRate * $windowMilliseconds / 1000)
$maximumAnalysisSeconds = 300
$widthText = $Width.ToString($invariantCulture)
$heightText = $Height.ToString($invariantCulture)
$silenceDbText = $SilenceDb.ToString('G17', $invariantCulture)
$minSilenceText = $MinSilenceSeconds.ToString('G17', $invariantCulture)

$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) 'agent-verification-lab'
New-Item -ItemType Directory -Path $temporaryRoot -Force -ErrorAction Stop | Out-Null
$stagingPng = Join-Path $temporaryRoot ('waveform-' + [Guid]::NewGuid().ToString('N') + '.png')
$outputPngStream = $null
$eventsStream = $null
$stagingReadStream = $null
$pngReserved = $false
$eventsReserved = $false
$completed = $false
$temporaryPcm = $null
try {
    $outputPngStream = Open-NewOutputStream -Path $resolvedOutputPng -ParameterName 'OutputPng'
    $pngReserved = $true
    $eventsStream = Open-NewOutputStream -Path $resolvedOutputEventsJson -ParameterName 'OutputEventsJson'
    $eventsReserved = $true

    $waveformArguments = [string[]]@(
        '-i', $resolvedInput,
        '-filter_complex', "[0:a:0]aformat=channel_layouts=mono,showwavespic=s=${widthText}x${heightText}:colors=0x40c4ff[wave]",
        '-map', '[wave]',
        '-frames:v', '1',
        '-c:v', 'png',
        $stagingPng
    )
    try {
        Invoke-Ffmpeg -FfmpegPath $ffmpegPath -Arguments $waveformArguments -Operation "waveform rendering for $resolvedInput"
    }
    catch {
        Write-Warning "Waveform rendering failed; staging path was not acquired and was left untouched: $stagingPng"
        throw
    }
    try {
        $stagingReadStream = [IO.File]::Open($stagingPng, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    }
    catch {
        Write-Warning "Could not open the retained staging PNG for reading; leaving it in TEMP: $stagingPng"
        throw
    }

    $temporaryPcm = Join-Path $temporaryRoot ('waveform-' + [Guid]::NewGuid().ToString('N') + '.pcm')

    $pcmArguments = [string[]]@(
        '-i', $resolvedInput,
        '-map', '0:a:0',
        '-t', $maximumAnalysisSeconds.ToString($invariantCulture),
        '-ac', '1',
        '-ar', $sampleRate.ToString($invariantCulture),
        '-f', 's16le',
        '-y', $temporaryPcm
    )
    Invoke-Ffmpeg -FfmpegPath $ffmpegPath -Arguments $pcmArguments -Operation "bounded mono PCM decoding for $resolvedInput"
    $pcmBytes = [IO.File]::ReadAllBytes($temporaryPcm)
    if ($pcmBytes.Length -eq 0 -or ($pcmBytes.Length % 2) -ne 0) {
        throw "Decoded PCM is empty or malformed: $temporaryPcm"
    }

    $sampleCount = [int]($pcmBytes.Length / 2)
    $analysisDurationSeconds = $sampleCount / [double]$sampleRate
    $events = [System.Collections.Generic.List[object]]::new()
    $active = $false
    $peakAmplitude = 0.0
    $peakTime = 0.0

    for ($windowStartSample = 0; $windowStartSample -lt $sampleCount; $windowStartSample += $windowSamples) {
        $windowEndSample = [Math]::Min($windowStartSample + $windowSamples, $sampleCount)
        $sumSquares = 0.0
        $windowPeak = 0.0
        $windowPeakSample = $windowStartSample
        for ($sampleIndex = $windowStartSample; $sampleIndex -lt $windowEndSample; $sampleIndex++) {
            $sample = [BitConverter]::ToInt16($pcmBytes, $sampleIndex * 2) / 32768.0
            $absoluteSample = [Math]::Abs($sample)
            $sumSquares += $sample * $sample
            if ($absoluteSample -gt $windowPeak) {
                $windowPeak = $absoluteSample
                $windowPeakSample = $sampleIndex
            }
        }

        $windowLength = $windowEndSample - $windowStartSample
        $rms = [Math]::Sqrt($sumSquares / $windowLength)
        $rmsDb = if ($rms -gt 0) { 20 * [Math]::Log10($rms) } else { -120.0 }
        $windowIsActive = $rmsDb -ge $SilenceDb
        $windowTime = $windowStartSample / [double]$sampleRate

        if ($windowIsActive) {
            if (-not $active) {
                [void]$events.Add([pscustomobject]@{
                        type      = 'onset'
                        time      = [Math]::Round($windowTime, 6)
                        amplitude = [Math]::Round($rms, 6)
                    })
                $active = $true
                $peakAmplitude = $windowPeak
                $peakTime = $windowPeakSample / [double]$sampleRate
            }
            elseif ($windowPeak -gt $peakAmplitude) {
                $peakAmplitude = $windowPeak
                $peakTime = $windowPeakSample / [double]$sampleRate
            }
        }
        elseif ($active) {
            [void]$events.Add([pscustomobject]@{
                    type      = 'peak'
                    time      = [Math]::Round($peakTime, 6)
                    amplitude = [Math]::Round($peakAmplitude, 6)
                })
            $active = $false
        }
    }
    if ($active) {
        [void]$events.Add([pscustomobject]@{
                type      = 'peak'
                time      = [Math]::Round($peakTime, 6)
                amplitude = [Math]::Round($peakAmplitude, 6)
            })
    }

    $silenceArguments = [string[]]@(
        '-i', $resolvedInput,
        '-map', '0:a:0',
        '-t', $maximumAnalysisSeconds.ToString($invariantCulture),
        '-af', "aformat=channel_layouts=mono,silencedetect=n=${silenceDbText}dB:d=${minSilenceText}",
        '-f', 'null', '-'
    )
    $silenceOutput = & $ffmpegPath '-hide_banner' '-loglevel' 'info' '-nostdin' @silenceArguments 2>&1
    $silenceExitCode = $LASTEXITCODE
    if ($silenceExitCode -ne 0) {
        $diagnostics = ($silenceOutput | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine
        throw "FFmpeg silence detection failed with exit code $silenceExitCode.$([Environment]::NewLine)$diagnostics"
    }

    foreach ($interval in Get-MergedSilenceIntervals -Diagnostics @($silenceOutput | ForEach-Object { $_.ToString() }) -AnalysisDurationSeconds $analysisDurationSeconds -MergeGapSeconds ($windowMilliseconds / 1000.0)) {
        [void]$events.Add([pscustomobject]@{ type = 'silence_start'; time = [Math]::Round([double]$interval.start, 6) })
        [void]$events.Add([pscustomobject]@{ type = 'silence_end'; time = [Math]::Round([double]$interval.end, 6) })
    }

    $sortedEvents = @($events | Sort-Object @{ Expression = { [double]$_.time }; Ascending = $true }, @{ Expression = { $_.type }; Ascending = $true })
    $document = [pscustomobject]@{
        schema_version = 'agent-verification-lab.audio-events.v1'
        sample_rate    = $sampleRate
        events         = $sortedEvents
    }
    $stagingReadStream.CopyTo($outputPngStream)
    $outputPngStream.Flush($true)
    $jsonBytes = [Text.UTF8Encoding]::new($false).GetBytes(($document | ConvertTo-Json -Depth 5))
    $eventsStream.Write($jsonBytes, 0, $jsonBytes.Length)
    $eventsStream.Flush($true)
    $completed = $true
}
finally {
    try {
        if (-not $completed) {
            if ($pngReserved -and $null -ne $outputPngStream) {
                if (-not (Set-DeletePendingForOpenStream -Stream $outputPngStream)) {
                    Write-Warning "Could not mark the tool-owned OutputPng reservation for deletion; leaving partial file: $resolvedOutputPng"
                }
            }
            if ($eventsReserved -and $null -ne $eventsStream) {
                if (-not (Set-DeletePendingForOpenStream -Stream $eventsStream)) {
                    Write-Warning "Could not mark the tool-owned OutputEventsJson reservation for deletion; leaving partial file: $resolvedOutputEventsJson"
                }
            }
        }
    }
    finally {
        try {
            if ($null -ne $stagingReadStream) {
                $stagingReadStream.Dispose()
            }
        }
        finally {
            try {
                if ($null -ne $outputPngStream) {
                    $outputPngStream.Dispose()
                }
            }
            finally {
                try {
                    if ($null -ne $eventsStream) {
                        $eventsStream.Dispose()
                    }
                }
                finally {
                    if ($null -ne $temporaryPcm -and (Test-Path -LiteralPath $temporaryPcm -PathType Leaf)) {
                        Remove-Item -LiteralPath $temporaryPcm -Force -ErrorAction SilentlyContinue
                    }
                }
            }
        }
    }
}

Write-Output "WAVEFORM_PNG=$resolvedOutputPng"
Write-Output "EVENTS_JSON=$resolvedOutputEventsJson"
Write-Output "STAGING_PNG=$stagingPng"
