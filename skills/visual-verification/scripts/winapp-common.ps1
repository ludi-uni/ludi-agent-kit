Set-StrictMode -Version Latest

$script:WinAppTestedVersion = '0.6.1'

function New-WinAppException {
    [OutputType([System.InvalidOperationException])]
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Code,
        [Parameter(Mandatory)][string]$Message,
        [string]$UpstreamCode,
        [string]$UpstreamType,
        [Nullable[int]]$ExitCode
    )

    $exception = [System.InvalidOperationException]::new($Message)
    $exception.Data['WinAppErrorCode'] = $Code
    if (-not [string]::IsNullOrWhiteSpace($UpstreamCode)) { $exception.Data['WinAppUpstreamCode'] = $UpstreamCode }
    if (-not [string]::IsNullOrWhiteSpace($UpstreamType)) { $exception.Data['WinAppUpstreamType'] = $UpstreamType }
    if ($null -ne $ExitCode) { $exception.Data['WinAppExitCode'] = [int]$ExitCode }
    return $exception
}

function Get-WinAppVersionClassification {
    [OutputType([string])]
    [CmdletBinding()]
    param([string]$ActualVersion)

    if ([string]::IsNullOrWhiteSpace($ActualVersion)) { return 'NOT_INSTALLED' }

    try {
        $actual = [Version]::Parse($ActualVersion)
        $tested = [Version]::Parse($script:WinAppTestedVersion)
    }
    catch {
        return 'UNTESTED_NEWER'
    }

    if ($actual -eq $tested) { return 'SUPPORTED_TESTED' }
    if ($actual -gt $tested) { return 'UNTESTED_NEWER' }
    return 'UNSUPPORTED_OLDER'
}

function Invoke-WinAppProcess {
    [OutputType([pscustomobject])]
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Executable,
        [Parameter(Mandatory)][string[]]$Arguments
    )

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $Executable
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.CreateNoWindow = $true
    $startInfo.Environment['WINAPP_CLI_TELEMETRY_OPTOUT'] = '1'
    foreach ($argument in $Arguments) { [void]$startInfo.ArgumentList.Add($argument) }

    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) { throw 'Process start returned false.' }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        $process.WaitForExit()
        $stdout = $stdoutTask.GetAwaiter().GetResult()
        $stderr = $stderrTask.GetAwaiter().GetResult()
        return [pscustomobject]@{
            exit_code = $process.ExitCode
            stdout    = $stdout
            stderr    = $stderr
            arguments = @($Arguments)
        }
    }
    catch {
        throw (New-WinAppException -Code 'WINAPP_NOT_INSTALLED' -Message "WinApp CLI could not be started: $($_.Exception.Message)")
    }
    finally {
        $process.Dispose()
    }
}

function Get-WinAppVersionInfo {
    [OutputType([pscustomobject])]
    [CmdletBinding()]
    param([string]$Executable)

    if ([string]::IsNullOrWhiteSpace($Executable)) {
        $command = Get-Command winapp -ErrorAction SilentlyContinue
        if ($null -eq $command -or $command.CommandType -ne [Management.Automation.CommandTypes]::Application) {
            return [pscustomobject]@{ executable = $null; actual = $null; tested = $script:WinAppTestedVersion; classification = 'NOT_INSTALLED' }
        }
        $Executable = $command.Source
    }

    $resolvedExecutable = [IO.Path]::GetFullPath($Executable)
    $result = Invoke-WinAppProcess -Executable $resolvedExecutable -Arguments @('--version')
    $combined = "$($result.stdout)`n$($result.stderr)"
    $match = [regex]::Match($combined, '(?m)(?<version>\d+\.\d+\.\d+(?:\.\d+)?)')
    if ($result.exit_code -ne 0 -or -not $match.Success) {
        throw (New-WinAppException -Code 'WINAPP_COMMAND_FAILED' -Message 'WinApp CLI version could not be determined.' -ExitCode $result.exit_code)
    }

    $actual = $match.Groups['version'].Value
    return [pscustomobject]@{
        executable     = $resolvedExecutable
        actual         = $actual
        tested         = $script:WinAppTestedVersion
        classification = Get-WinAppVersionClassification -ActualVersion $actual
    }
}

function Assert-WinAppCaptureReady {
    [CmdletBinding()]
    param([Parameter(Mandatory)][pscustomobject]$VersionInfo)

    switch ($VersionInfo.classification) {
        'NOT_INSTALLED' { throw (New-WinAppException -Code 'WINAPP_NOT_INSTALLED' -Message 'WinApp CLI is not installed or is not available on PATH.') }
        'UNSUPPORTED_OLDER' { throw (New-WinAppException -Code 'WINAPP_VERSION_UNTESTED' -Message "WinApp CLI $($VersionInfo.actual) is older than the tested $($VersionInfo.tested) contract.") }
    }
}

function Get-WinAppPropertyValue {
    param($InputObject, [Parameter(Mandatory)][string]$Name, $Default = $null)
    if ($null -eq $InputObject) { return $Default }
    $property = $InputObject.PSObject.Properties[$Name]
    if ($null -eq $property) { return $Default }
    return $property.Value
}

function ConvertTo-WinAppError {
    [OutputType([pscustomobject])]
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][int]$ExitCode,
        [string]$StdOut,
        [string]$StdErr,
        [Parameter(Mandatory)][ValidateSet('discover', 'screenshot', 'record', 'inspect')][string]$Operation
    )

    $raw = @($StdOut, $StdErr) -join "`n"
    $upstreamCode = $null
    $upstreamType = $null
    $message = $raw.Trim()
    foreach ($candidate in @($StdOut, $StdErr)) {
        if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
        try {
            $parsed = $candidate | ConvertFrom-Json -ErrorAction Stop
            $errorObject = Get-WinAppPropertyValue -InputObject $parsed -Name 'error'
            if ($null -ne $errorObject) {
                $upstreamCode = [string](Get-WinAppPropertyValue -InputObject $errorObject -Name 'code')
                $upstreamType = [string](Get-WinAppPropertyValue -InputObject $errorObject -Name 'details')
                $parsedMessage = [string](Get-WinAppPropertyValue -InputObject $errorObject -Name 'message')
                if (-not [string]::IsNullOrWhiteSpace($parsedMessage)) { $message = $parsedMessage }
                break
            }
        }
        catch { }
    }

    $evidence = "$upstreamCode`n$upstreamType`n$message"
    $code = if ($evidence -match '(?i)ambiguous|matched\s+\d+\s+(?:windows|elements)|UiAmbiguousSelectorException') {
        'WINDOW_TARGET_AMBIGUOUS'
    }
    elseif ($evidence -match '(?i)missing_app|no_target|not found|no visible window|element_not_found') {
        'WINDOW_NOT_FOUND'
    }
    elseif ($Operation -eq 'screenshot') { 'CAPTURE_FAILED' }
    elseif ($Operation -eq 'record') { 'RECORD_FAILED' }
    else { 'WINAPP_COMMAND_FAILED' }

    return [pscustomobject]@{
        code          = $code
        message       = if ([string]::IsNullOrWhiteSpace($message)) { "WinApp CLI $Operation failed." } else { $message }
        operation     = $Operation
        exit_code     = $ExitCode
        upstream_code = $upstreamCode
        upstream_type = $upstreamType
    }
}

function Invoke-WinAppJson {
    [OutputType([pscustomobject])]
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Executable,
        [Parameter(Mandatory)][string[]]$Arguments,
        [Parameter(Mandatory)][ValidateSet('discover', 'screenshot', 'record', 'inspect')][string]$Operation
    )

    $result = Invoke-WinAppProcess -Executable $Executable -Arguments $Arguments
    if ($result.exit_code -ne 0) {
        $failure = ConvertTo-WinAppError -ExitCode $result.exit_code -StdOut $result.stdout -StdErr $result.stderr -Operation $Operation
        throw (New-WinAppException -Code $failure.code -Message $failure.message -UpstreamCode $failure.upstream_code -UpstreamType $failure.upstream_type -ExitCode $failure.exit_code)
    }

    try { $data = $result.stdout | ConvertFrom-Json -ErrorAction Stop }
    catch {
        throw (New-WinAppException -Code 'WINAPP_COMMAND_FAILED' -Message "WinApp CLI $Operation returned invalid JSON." -ExitCode $result.exit_code)
    }
    return [pscustomobject]@{ data = $data; process = $result }
}

function Select-WinAppWindowCandidate {
    [OutputType([pscustomobject])]
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Candidates,
        [string]$ProcessName,
        [string]$WindowTitle,
        [string]$ClassName,
        [Nullable[int]]$ProcessId,
        [Nullable[long]]$Hwnd,
        [Nullable[int]]$Width,
        [Nullable[int]]$Height
    )

    $matches = @($Candidates)
    if (-not [string]::IsNullOrWhiteSpace($ProcessName)) { $matches = @($matches | Where-Object { [string](Get-WinAppPropertyValue $_ 'processName') -ieq $ProcessName }) }
    if (-not [string]::IsNullOrWhiteSpace($WindowTitle)) { $matches = @($matches | Where-Object { [string](Get-WinAppPropertyValue $_ 'title') -ceq $WindowTitle }) }
    if (-not [string]::IsNullOrWhiteSpace($ClassName)) { $matches = @($matches | Where-Object { [string](Get-WinAppPropertyValue $_ 'className') -ceq $ClassName }) }
    if ($null -ne $ProcessId) { $matches = @($matches | Where-Object { [int](Get-WinAppPropertyValue $_ 'processId' -1) -eq [int]$ProcessId }) }
    if ($null -ne $Hwnd) { $matches = @($matches | Where-Object { [long](Get-WinAppPropertyValue $_ 'hwnd' -1) -eq [long]$Hwnd }) }
    if ($null -ne $Width) { $matches = @($matches | Where-Object { [int](Get-WinAppPropertyValue $_ 'width' -1) -eq [int]$Width }) }
    if ($null -ne $Height) { $matches = @($matches | Where-Object { [int](Get-WinAppPropertyValue $_ 'height' -1) -eq [int]$Height }) }

    if ($matches.Count -eq 0) { throw (New-WinAppException -Code 'WINDOW_NOT_FOUND' -Message 'No window matched the requested identity and filters.') }
    if ($matches.Count -gt 1) { throw (New-WinAppException -Code 'WINDOW_TARGET_AMBIGUOUS' -Message "$($matches.Count) windows matched; add an exact title, class, PID, HWND, or size filter.") }

    $window = $matches[0]
    return [pscustomobject]@{
        process_name  = [string](Get-WinAppPropertyValue $window 'processName')
        window_title  = [string](Get-WinAppPropertyValue $window 'title')
        class_name    = [string](Get-WinAppPropertyValue $window 'className')
        process_id    = [int](Get-WinAppPropertyValue $window 'processId' 0)
        hwnd          = [long](Get-WinAppPropertyValue $window 'hwnd' 0)
        width         = [int](Get-WinAppPropertyValue $window 'width' 0)
        height        = [int](Get-WinAppPropertyValue $window 'height' 0)
        owner_hwnd    = [long](Get-WinAppPropertyValue $window 'ownerHwnd' 0)
        is_foreground = [bool](Get-WinAppPropertyValue $window 'isForeground' $false)
    }
}

function Get-WinAppWindowTarget {
    [OutputType([pscustomobject])]
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Executable,
        [string]$App,
        [string]$ProcessName,
        [string]$WindowTitle,
        [string]$ClassName,
        [Nullable[int]]$ProcessId,
        [Nullable[long]]$Hwnd,
        [Nullable[int]]$Width,
        [Nullable[int]]$Height
    )

    if ($null -ne $Hwnd) {
        $status = Invoke-WinAppJson -Executable $Executable -Arguments @('ui', 'status', '-w', ([long]$Hwnd).ToString([Globalization.CultureInfo]::InvariantCulture), '--json') -Operation discover
        $statusPid = [int](Get-WinAppPropertyValue $status.data 'processId' 0)
        if ($statusPid -le 0) { throw (New-WinAppException -Code 'WINDOW_NOT_FOUND' -Message "HWND $Hwnd did not resolve to a process.") }
        $query = $statusPid.ToString([Globalization.CultureInfo]::InvariantCulture)
    }
    else {
        $query = if (-not [string]::IsNullOrWhiteSpace($App)) { $App }
        elseif ($null -ne $ProcessId) { ([int]$ProcessId).ToString([Globalization.CultureInfo]::InvariantCulture) }
        elseif (-not [string]::IsNullOrWhiteSpace($ProcessName)) { $ProcessName }
        elseif (-not [string]::IsNullOrWhiteSpace($WindowTitle)) { $WindowTitle }
        else { throw (New-WinAppException -Code 'WINDOW_NOT_FOUND' -Message 'Specify App, ProcessName, WindowTitle, PID, or HWND for bounded discovery.') }
    }

    $listed = Invoke-WinAppJson -Executable $Executable -Arguments @('ui', 'list-windows', '-a', $query, '--json') -Operation discover
    return Select-WinAppWindowCandidate -Candidates $listed.data -ProcessName $ProcessName -WindowTitle $WindowTitle -ClassName $ClassName -ProcessId $ProcessId -Hwnd $Hwnd -Width $Width -Height $Height
}

function New-WinAppScreenshotArguments {
    [OutputType([string[]])]
    [CmdletBinding()]
    param([Parameter(Mandatory)][long]$Hwnd, [Parameter(Mandatory)][string]$OutputPath)
    return [string[]]@('ui', 'screenshot', '-w', $Hwnd.ToString([Globalization.CultureInfo]::InvariantCulture), '--output', [IO.Path]::GetFullPath($OutputPath), '--json')
}

function New-WinAppRecordArguments {
    [OutputType([string[]])]
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][long]$Hwnd,
        [Parameter(Mandatory)][string]$OutputPath,
        [double]$Duration = 5,
        [int]$Fps = 5,
        [switch]$Frames,
        [int]$MaxEdge = 1280
    )

    if ([double]::IsNaN($Duration) -or [double]::IsInfinity($Duration) -or $Duration -lt 1 -or $Duration -gt 60) { throw 'Duration must be between 1 and 60 seconds.' }
    if ($Fps -lt 1 -or $Fps -gt 60) { throw 'Fps must be between 1 and 60.' }
    if ($Frames -and $Fps -gt 30) { throw 'Fps must be between 1 and 30 when frame artifacts are enabled.' }
    if ($Frames -and ($MaxEdge -lt 64 -or $MaxEdge -gt 4096)) { throw 'MaxEdge must be between 64 and 4096 when frame artifacts are enabled.' }

    $culture = [Globalization.CultureInfo]::InvariantCulture
    $arguments = [Collections.Generic.List[string]]::new()
    foreach ($value in @('ui', 'record', '-w', $Hwnd.ToString($culture), '--duration-sec', $Duration.ToString('G17', $culture), '--fps', $Fps.ToString($culture), '--output', [IO.Path]::GetFullPath($OutputPath))) { [void]$arguments.Add($value) }
    if ($Frames) {
        [void]$arguments.Add('--frames')
        [void]$arguments.Add('--max-edge')
        [void]$arguments.Add($MaxEdge.ToString($culture))
    }
    [void]$arguments.Add('--json')
    return [string[]]$arguments.ToArray()
}

function New-WinAppInspectArguments {
    [OutputType([string[]])]
    [CmdletBinding()]
    param([Parameter(Mandatory)][long]$Hwnd, [ValidateRange(1, 20)][int]$Depth = 6, [switch]$Interactive)
    $arguments = [Collections.Generic.List[string]]::new()
    foreach ($value in @('ui', 'inspect', '-w', $Hwnd.ToString([Globalization.CultureInfo]::InvariantCulture), '--depth', $Depth.ToString([Globalization.CultureInfo]::InvariantCulture))) { [void]$arguments.Add($value) }
    if ($Interactive) { [void]$arguments.Add('--interactive') }
    [void]$arguments.Add('--json')
    return [string[]]$arguments.ToArray()
}

function Get-PngDimensions {
    [OutputType([pscustomobject])]
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw (New-WinAppException -Code 'CAPTURE_FAILED' -Message "Screenshot output is missing: $Path") }
    $bytes = [byte[]]::new(24)
    $stream = [IO.File]::OpenRead($Path)
    try { $read = $stream.Read($bytes, 0, $bytes.Length) }
    finally { $stream.Dispose() }
    $signature = [byte[]](137, 80, 78, 71, 13, 10, 26, 10)
    if ($read -lt 24) { throw (New-WinAppException -Code 'CAPTURE_FAILED' -Message 'Screenshot output is not a valid PNG.') }
    for ($index = 0; $index -lt $signature.Length; $index++) { if ($bytes[$index] -ne $signature[$index]) { throw (New-WinAppException -Code 'CAPTURE_FAILED' -Message 'Screenshot output is not a valid PNG.') } }
    $width = [int]($bytes[16] * 16777216 + $bytes[17] * 65536 + $bytes[18] * 256 + $bytes[19])
    $height = [int]($bytes[20] * 16777216 + $bytes[21] * 65536 + $bytes[22] * 256 + $bytes[23])
    if ($width -le 0 -or $height -le 0) { throw (New-WinAppException -Code 'CAPTURE_FAILED' -Message 'Screenshot PNG has zero dimensions.') }
    return [pscustomobject]@{ width = $width; height = $height }
}

function Assert-WinAppMp4 {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw (New-WinAppException -Code 'RECORD_FAILED' -Message "Recording output is missing: $Path") }
    $bytes = [byte[]]::new(12)
    $stream = [IO.File]::OpenRead($Path)
    try { $read = $stream.Read($bytes, 0, $bytes.Length) }
    finally { $stream.Dispose() }
    if ($read -lt 12 -or [Text.Encoding]::ASCII.GetString($bytes, 4, 4) -ne 'ftyp') { throw (New-WinAppException -Code 'RECORD_FAILED' -Message 'Recording output is not a valid MP4 container.') }
}

function Select-WinAppRepresentativeFrames {
    [OutputType([pscustomobject[]])]
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Samples, [Parameter(Mandatory)][string]$FramesRoot)
    $items = @($Samples)
    if ($items.Count -eq 0) { return @() }
    $indices = [Collections.Generic.SortedSet[int]]::new()
    [void]$indices.Add(0)
    [void]$indices.Add([Math]::Floor(($items.Count - 1) / 2))
    [void]$indices.Add($items.Count - 1)
    $results = foreach ($index in $indices) {
        $sample = $items[$index]
        $relative = ([string](Get-WinAppPropertyValue $sample 'file')).Replace('/', [IO.Path]::DirectorySeparatorChar)
        [pscustomobject]@{
            role          = if ($index -eq 0) { 'first' } elseif ($index -eq ($items.Count - 1)) { 'last' } else { 'middle' }
            sample_index  = [int](Get-WinAppPropertyValue $sample 'sampleIndex' $index)
            elapsed_ms    = [long](Get-WinAppPropertyValue $sample 'elapsedMs' 0)
            media_time_ms = [long](Get-WinAppPropertyValue $sample 'mediaTimeMs' 0)
            changed       = [bool](Get-WinAppPropertyValue $sample 'changed' $false)
            path          = [IO.Path]::GetFullPath((Join-Path $FramesRoot $relative))
        }
    }
    return @($results)
}

function New-WinAppOperationMetadata {
    [OutputType([pscustomobject])]
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Operation,
        [Parameter(Mandatory)][string]$Version,
        [Parameter(Mandatory)][string]$VersionClassification,
        [Parameter(Mandatory)][pscustomobject]$Target,
        [string]$ArtifactPath,
        [int]$Width,
        [int]$Height,
        $AssociatedWindows = @(),
        $CommandResult
    )
    return [pscustomobject]@{
        operation    = $Operation
        timestamp_utc = [DateTime]::UtcNow.ToString('o')
        backend      = [pscustomobject]@{ name = 'winapp-cli'; version = $Version; tested_version = $script:WinAppTestedVersion; version_classification = $VersionClassification }
        target       = $Target
        artifact     = if ([string]::IsNullOrWhiteSpace($ArtifactPath)) { $null } else { [pscustomobject]@{ path = [IO.Path]::GetFullPath($ArtifactPath); width = $Width; height = $Height } }
        command      = $CommandResult
        capture      = [pscustomobject]@{ mode = 'default_window_capture'; capture_screen = $false; associated_windows = @($AssociatedWindows) }
        window_state = [pscustomobject]@{ visible = 'SUPPORTED'; occluded = 'SUPPORTED'; minimized = 'UNVERIFIED' }
    }
}

function Write-WinAppJsonFile {
    [OutputType([string])]
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Value, [Parameter(Mandatory)][string]$Path)
    $resolved = [IO.Path]::GetFullPath($Path)
    [IO.File]::WriteAllText($resolved, ($Value | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
    return $resolved
}

function Write-WinAppTargetDocument {
    [OutputType([string])]
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][pscustomobject]$Target,
        [Parameter(Mandatory)][pscustomobject]$VersionInfo
    )
    $resolved = [IO.Path]::GetFullPath($Path)
    if (Test-Path -LiteralPath $resolved -PathType Leaf) {
        try { $existing = Get-Content -LiteralPath $resolved -Raw | ConvertFrom-Json -ErrorAction Stop }
        catch { throw (New-WinAppException -Code 'WINAPP_COMMAND_FAILED' -Message "Existing desktop-window.json cannot be read safely: $resolved") }
        $existingTarget = Get-WinAppPropertyValue $existing 'target'
        if ($null -eq $existingTarget -or [long](Get-WinAppPropertyValue $existingTarget 'hwnd' -1) -ne $Target.hwnd -or [int](Get-WinAppPropertyValue $existingTarget 'process_id' -1) -ne $Target.process_id) {
            throw (New-WinAppException -Code 'WINDOW_TARGET_AMBIGUOUS' -Message 'The explicit run directory already belongs to a different desktop window target.')
        }
        return $resolved
    }

    $document = [pscustomobject]@{
        schema_version = 'agent-verification-lab.desktop-window.v1'
        timestamp_utc  = [DateTime]::UtcNow.ToString('o')
        backend        = [pscustomobject]@{ name = 'winapp-cli'; version = $VersionInfo.actual; tested_version = $VersionInfo.tested; version_classification = $VersionInfo.classification }
        target         = $Target
        window_state   = [pscustomobject]@{ visible = 'SUPPORTED'; occluded = 'SUPPORTED'; minimized = 'UNVERIFIED' }
    }
    return Write-WinAppJsonFile -Value $document -Path $resolved
}

function ConvertFrom-WinAppException {
    [OutputType([pscustomobject])]
    [CmdletBinding()]
    param([Parameter(Mandatory)][Management.Automation.ErrorRecord]$ErrorRecord, [Parameter(Mandatory)][string]$Operation)
    $exception = $ErrorRecord.Exception
    return [pscustomobject]@{
        status        = 'error'
        code          = if ($exception.Data.Contains('WinAppErrorCode')) { [string]$exception.Data['WinAppErrorCode'] } else { 'WINAPP_COMMAND_FAILED' }
        message       = $exception.Message
        operation     = $Operation
        exit_code     = if ($exception.Data.Contains('WinAppExitCode')) { [int]$exception.Data['WinAppExitCode'] } else { $null }
        upstream_code = if ($exception.Data.Contains('WinAppUpstreamCode')) { [string]$exception.Data['WinAppUpstreamCode'] } else { $null }
        upstream_type = if ($exception.Data.Contains('WinAppUpstreamType')) { [string]$exception.Data['WinAppUpstreamType'] } else { $null }
    }
}

function Write-WinAppFailure {
    [CmdletBinding()]
    param([Parameter(Mandatory)][Management.Automation.ErrorRecord]$ErrorRecord, [Parameter(Mandatory)][string]$Operation)
    $failure = ConvertFrom-WinAppException -ErrorRecord $ErrorRecord -Operation $Operation
    [Console]::Error.WriteLine(($failure | ConvertTo-Json -Compress -Depth 5))
}
