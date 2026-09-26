Set-StrictMode -Version Latest

function Get-FfmpegPath {
    [OutputType([string])]
    [CmdletBinding()]
    param()

    try {
        $command = Get-Command ffmpeg -ErrorAction Stop
    }
    catch {
        throw 'ffmpeg was not found on PATH.'
    }

    if ($command.CommandType -ne [System.Management.Automation.CommandTypes]::Application) {
        throw "ffmpeg resolved to '$($command.CommandType)', not an executable application."
    }

    return [IO.Path]::GetFullPath($command.Source)
}

function New-VisualRun {
    [OutputType([pscustomobject])]
    [CmdletBinding()]
    param(
        [string]$RunDirectory,
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Kind
    )

    if (-not [string]::IsNullOrWhiteSpace($RunDirectory)) {
        if (-not (Test-Path -LiteralPath $RunDirectory -PathType Container)) {
            throw "The explicit run directory does not exist: $RunDirectory"
        }

        $resolvedRunDirectory = [IO.Path]::GetFullPath($RunDirectory)
        return [pscustomobject]@{
            RunId        = Split-Path -Leaf $resolvedRunDirectory
            RunDirectory = $resolvedRunDirectory
            Kind         = $Kind
        }
    }

    $evidenceRoot = Join-Path ([IO.Path]::GetTempPath()) 'agent-verification-lab'
    New-Item -ItemType Directory -Path $evidenceRoot -Force | Out-Null

    do {
        $candidate = Join-Path $evidenceRoot ([Guid]::NewGuid().ToString('N'))
    } while (Test-Path -LiteralPath $candidate)

    New-Item -ItemType Directory -Path $candidate -ErrorAction Stop | Out-Null
    return [pscustomobject]@{
        RunId        = Split-Path -Leaf $candidate
        RunDirectory = [IO.Path]::GetFullPath($candidate)
        Kind         = $Kind
    }
}

function New-VisualEvidenceRun {
    [OutputType([string])]
    [CmdletBinding()]
    param(
        [string]$RunDirectory
    )

    return (New-VisualRun -RunDirectory $RunDirectory -Kind 'visual').RunDirectory
}

function Assert-OutputAvailable {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Path,
        [switch]$Overwrite
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }

    $item = Get-Item -LiteralPath $Path -Force
    if ($item.PSIsContainer) {
        throw "Output path is a directory: $Path"
    }

    if (-not $Overwrite) {
        throw "Output already exists; specify -Overwrite to replace it: $Path"
    }
}

function Get-VisualVerificationNativeMethods {
    [OutputType([type])]
    [CmdletBinding()]
    param()

    $nativeMethods = 'VisualVerification.NativeMethods' -as [type]
    if ($null -eq $nativeMethods) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace VisualVerification
{
    public static class NativeMethods
    {
        [StructLayout(LayoutKind.Sequential)]
        public struct RECT
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }

        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll")]
        public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

        [DllImport("user32.dll")]
        public static extern bool IsWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern int GetWindowTextLength(IntPtr hWnd);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

        [DllImport("user32.dll")]
        public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    }
}
'@
        $nativeMethods = 'VisualVerification.NativeMethods' -as [type]
    }

    return $nativeMethods
}

function Resolve-CaptureTarget {
    [OutputType([pscustomobject])]
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateSet('desktop', 'region', 'window')]
        [string]$Mode,
        [Nullable[int]]$X,
        [Nullable[int]]$Y,
        [Nullable[int]]$Width,
        [Nullable[int]]$Height,
        [string]$WindowTitle,
        [IntPtr]$Hwnd = [IntPtr]::Zero
    )

    $hasRegionArgument = $null -ne $X -or $null -ne $Y -or $null -ne $Width -or $null -ne $Height
    $hasTitle = -not [string]::IsNullOrWhiteSpace($WindowTitle)
    $hasHwnd = $Hwnd -ne [IntPtr]::Zero

    switch ($Mode) {
        'desktop' {
            if ($hasRegionArgument -or $hasTitle -or $hasHwnd) {
                throw 'Desktop capture cannot include region or window target arguments.'
            }

            return [pscustomobject]@{
                InputName        = 'desktop'
                InputOptions     = [string[]]@('-i', 'desktop')
                Bounds           = $null
                TargetDescription = 'desktop'
            }
        }

        'region' {
            if ($hasTitle -or $hasHwnd) {
                throw 'Region capture cannot include window target arguments.'
            }

            if ($null -eq $X -or $null -eq $Y -or $null -eq $Width -or $null -eq $Height) {
                throw 'Region capture requires X, Y, Width, and Height.'
            }

            if ($Width -le 0 -or $Height -le 0) {
                throw 'Region capture Width and Height must be positive.'
            }

            $bounds = [pscustomobject]@{
                X      = [int]$X
                Y      = [int]$Y
                Width  = [int]$Width
                Height = [int]$Height
            }

            return [pscustomobject]@{
                InputName        = 'desktop'
                InputOptions     = [string[]]@(
                    '-video_size', "$($bounds.Width)x$($bounds.Height)",
                    '-offset_x', [string]$bounds.X,
                    '-offset_y', [string]$bounds.Y,
                    '-i', 'desktop'
                )
                Bounds           = $bounds
                TargetDescription = "region x=$($bounds.X) y=$($bounds.Y) width=$($bounds.Width) height=$($bounds.Height)"
            }
        }

        'window' {
            if ($hasRegionArgument) {
                throw 'Window capture cannot include region target arguments.'
            }

            if ($hasTitle -eq $hasHwnd) {
                throw 'Window capture requires exactly one of WindowTitle or Hwnd.'
            }

            $nativeMethods = Get-VisualVerificationNativeMethods
            if ($hasTitle) {
                $matches = [System.Collections.Generic.List[IntPtr]]::new()
                $callback = [VisualVerification.NativeMethods+EnumWindowsProc]{
                    param([IntPtr]$candidate, [IntPtr]$unused)

                    if (-not [VisualVerification.NativeMethods]::IsWindowVisible($candidate)) {
                        return $true
                    }

                    $titleLength = [VisualVerification.NativeMethods]::GetWindowTextLength($candidate)
                    if ($titleLength -le 0) {
                        return $true
                    }

                    $titleBuilder = [System.Text.StringBuilder]::new($titleLength + 1)
                    [void][VisualVerification.NativeMethods]::GetWindowText($candidate, $titleBuilder, $titleBuilder.Capacity)
                    if ($titleBuilder.ToString() -ceq $WindowTitle) {
                        [void]$matches.Add($candidate)
                    }

                    return $true
                }
                [void][VisualVerification.NativeMethods]::EnumWindows($callback, [IntPtr]::Zero)

                if ($matches.Count -eq 0) {
                    throw "No visible window exactly matches title '$WindowTitle'."
                }

                if ($matches.Count -ne 1) {
                    throw "Window title '$WindowTitle' is ambiguous; $($matches.Count) visible windows match exactly."
                }

                $Hwnd = $matches[0]
            }

            if (-not [VisualVerification.NativeMethods]::IsWindow($Hwnd)) {
                throw "Hwnd '$Hwnd' is not a valid window."
            }

            if (-not [VisualVerification.NativeMethods]::IsWindowVisible($Hwnd)) {
                throw "Hwnd '$Hwnd' is not visible."
            }

            $rect = [VisualVerification.NativeMethods+RECT]::new()
            if (-not [VisualVerification.NativeMethods]::GetWindowRect($Hwnd, [ref]$rect)) {
                throw "GetWindowRect failed for Hwnd '$Hwnd'."
            }

            $windowWidth = $rect.Right - $rect.Left
            $windowHeight = $rect.Bottom - $rect.Top
            if ($windowWidth -le 0 -or $windowHeight -le 0) {
                throw "Hwnd '$Hwnd' has invalid bounds."
            }

            $bounds = [pscustomobject]@{
                X      = $rect.Left
                Y      = $rect.Top
                Width  = $windowWidth
                Height = $windowHeight
            }
            $handleText = "0x$($Hwnd.ToInt64().ToString('X'))"

            return [pscustomobject]@{
                InputName        = 'desktop'
                InputOptions     = [string[]]@(
                    '-video_size', "$($bounds.Width)x$($bounds.Height)",
                    '-offset_x', [string]$bounds.X,
                    '-offset_y', [string]$bounds.Y,
                    '-i', 'desktop'
                )
                Bounds           = $bounds
                TargetDescription = "window $handleText x=$($bounds.X) y=$($bounds.Y) width=$($bounds.Width) height=$($bounds.Height)"
            }
        }
    }
}

function Invoke-Ffmpeg {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$FfmpegPath,
        [Parameter(Mandatory)]
        [string[]]$Arguments,
        [Parameter(Mandatory)]
        [string]$Operation
    )

    $ffmpegArguments = [string[]]@('-hide_banner', '-loglevel', 'error', '-nostdin') + $Arguments
    $diagnostics = & $FfmpegPath @ffmpegArguments 2>&1
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        $diagnosticText = ($diagnostics | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine
        throw "FFmpeg $Operation failed with exit code $exitCode.$([Environment]::NewLine)$diagnosticText"
    }
}

function Write-ResultJson {
    [OutputType([string])]
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [pscustomobject]$Result
    )

    if ([string]::IsNullOrWhiteSpace($Result.run_directory)) {
        throw 'Result.run_directory is required.'
    }

    $runDirectory = [IO.Path]::GetFullPath($Result.run_directory)
    if (-not (Test-Path -LiteralPath $runDirectory -PathType Container)) {
        throw "Result run directory does not exist: $runDirectory"
    }

    $Result.run_directory = $runDirectory
    $resultPath = Join-Path $runDirectory 'result.json'
    if (Test-Path -LiteralPath $resultPath -PathType Leaf) {
        try {
            $previous = Get-Content -LiteralPath $resultPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
        }
        catch {
            throw "Existing result.json cannot be read safely: $resultPath"
        }

        if ($previous.run_directory -ne $runDirectory) {
            throw "Existing result.json belongs to a different run directory: $resultPath"
        }

        $artifactKeys = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        $artifacts = [System.Collections.Generic.List[object]]::new()
        foreach ($artifact in @($previous.artifacts) + @($Result.artifacts)) {
            if ($null -eq $artifact) {
                continue
            }

            $key = "$($artifact.role)`0$($artifact.path)"
            if ($artifactKeys.Add($key)) {
                [void]$artifacts.Add($artifact)
            }
        }
        $Result.artifacts = @($artifacts)
    }

    $json = $Result | ConvertTo-Json -Depth 8
    Set-Content -LiteralPath $resultPath -Value $json -Encoding utf8NoBOM -NoNewline -ErrorAction Stop
    return [IO.Path]::GetFullPath($resultPath)
}

function Write-VisualResult {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$RunDirectory,
        [Parameter(Mandatory)]
        [string]$OutputPath,
        [Parameter(Mandatory)]
        [string]$Kind,
        [string]$ResultJsonPath
    )

    Write-Output "RUN_DIRECTORY=$([IO.Path]::GetFullPath($RunDirectory))"
    Write-Output "OUTPUT_PATH=$([IO.Path]::GetFullPath($OutputPath))"
    Write-Output "KIND=$Kind"
    if (-not [string]::IsNullOrWhiteSpace($ResultJsonPath)) {
        Write-Output "RESULT_JSON=$([IO.Path]::GetFullPath($ResultJsonPath))"
    }
}
