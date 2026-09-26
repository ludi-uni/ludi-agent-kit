[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$AudioEventsJson,
    [Parameter(Mandatory)]
    [double]$VisualEventSeconds,
    [string]$SpeechJson,
    [Nullable[double]]$GestureSeconds,
    [ValidateRange(1, 1000)]
    [double]$ToleranceMilliseconds = 60,
    [string]$OutputJson
)

Set-StrictMode -Version Latest

$toleranceMillisecondsWasExplicit = $PSBoundParameters.ContainsKey('ToleranceMilliseconds')
$signConvention = 'audio-minus-visual; audio-late is positive and audio-early is negative'

function Get-PropertyOrNull {
    [OutputType([object])]
    param(
        [AllowNull()][object]$Object,
        [Parameter(Mandatory)][string]$Name
    )

    if ($null -eq $Object) {
        return $null
    }

    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return $null
    }

    return $property.Value
}

function ConvertTo-FiniteSeconds {
    [OutputType([double])]
    param(
        [Parameter(Mandatory)][AllowNull()][object]$Value,
        [Parameter(Mandatory)][string]$Description
    )

    try {
        $seconds = [Convert]::ToDouble($Value, [Globalization.CultureInfo]::InvariantCulture)
    }
    catch {
        throw "$Description must be a numeric timestamp in seconds."
    }

    if ([double]::IsNaN($seconds) -or [double]::IsInfinity($seconds)) {
        throw "$Description must be a finite timestamp in seconds."
    }

    return $seconds
}

function Read-JsonDocument {
    [OutputType([object])]
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Description
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Description does not exist or is not a file: $Path"
    }

    try {
        return (Get-Content -LiteralPath $Path -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop)
    }
    catch {
        throw "$Description is not valid JSON: $Path. $($_.Exception.Message)"
    }
}

function New-TimestampMeasurement {
    [OutputType([pscustomobject])]
    param([AllowNull()][object]$Seconds)

    if ($null -eq $Seconds) {
        return $null
    }

    return [pscustomobject]@{
        seconds      = [Math]::Round([double]$Seconds, 6)
        milliseconds = [Math]::Round(([double]$Seconds) * 1000, 3)
    }
}

function New-OffsetMeasurement {
    [OutputType([pscustomobject])]
    param(
        [AllowNull()][object]$MeasuredSeconds,
        [Parameter(Mandatory)][double]$VisualSeconds
    )

    if ($null -eq $MeasuredSeconds) {
        return $null
    }

    $offsetSeconds = ([double]$MeasuredSeconds) - $VisualSeconds
    return [pscustomobject]@{
        seconds      = [Math]::Round($offsetSeconds, 6)
        milliseconds = [Math]::Round($offsetSeconds * 1000, 3)
    }
}

function Write-NewOutputJson {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Json
    )

    $stream = $null
    try {
        # CreateNew is the final authority: it also rejects a file created after validation.
        $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    }
    catch [IO.IOException] {
        throw "OutputJson already exists or could not be exclusively created: $Path"
    }

    try {
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes($Json)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    }
    finally {
        $stream.Dispose()
    }
}

$audioEventsPath = [IO.Path]::GetFullPath($AudioEventsJson)
$visualSeconds = ConvertTo-FiniteSeconds -Value $VisualEventSeconds -Description 'VisualEventSeconds'
$resolvedOutputJson = $null
if (-not [string]::IsNullOrWhiteSpace($OutputJson)) {
    $resolvedOutputJson = [IO.Path]::GetFullPath($OutputJson)
    $outputDirectory = Split-Path -Parent $resolvedOutputJson
    if (-not (Test-Path -LiteralPath $outputDirectory -PathType Container)) {
        throw "OutputJson directory does not exist: $outputDirectory"
    }
}

$audioDocument = Read-JsonDocument -Path $audioEventsPath -Description 'AudioEventsJson'
if ((Get-PropertyOrNull -Object $audioDocument -Name 'schema_version') -ne 'agent-verification-lab.audio-events.v1') {
    throw "AudioEventsJson must use schema_version 'agent-verification-lab.audio-events.v1': $audioEventsPath"
}

$onsets = [System.Collections.Generic.List[double]]::new()
foreach ($event in @(Get-PropertyOrNull -Object $audioDocument -Name 'events')) {
    if ($null -eq $event -or (Get-PropertyOrNull -Object $event -Name 'type') -ne 'onset') {
        continue
    }

    $eventTime = Get-PropertyOrNull -Object $event -Name 'time'
    if ($null -eq $eventTime) {
        throw "Audio onset in AudioEventsJson has no time: $audioEventsPath"
    }
    [void]$onsets.Add((ConvertTo-FiniteSeconds -Value $eventTime -Description 'Audio onset time'))
}

[Nullable[double]]$audioOnsetSeconds = $null
if ($onsets.Count -gt 0) {
    $audioOnsetSeconds = @($onsets | Sort-Object)[0]
}

[Nullable[double]]$speechFirstWordSeconds = $null
$speechStatus = 'NOT_SUPPLIED'
if (-not [string]::IsNullOrWhiteSpace($SpeechJson)) {
    $speechPath = [IO.Path]::GetFullPath($SpeechJson)
    $speechDocument = Read-JsonDocument -Path $speechPath -Description 'SpeechJson'
    if ((Get-PropertyOrNull -Object $speechDocument -Name 'schema_version') -ne 'agent-verification-lab.speech.v1') {
        throw "SpeechJson must use schema_version 'agent-verification-lab.speech.v1': $speechPath"
    }

    $wordStarts = [System.Collections.Generic.List[double]]::new()
    foreach ($word in @(Get-PropertyOrNull -Object $speechDocument -Name 'words')) {
        if ($null -eq $word) {
            continue
        }

        $wordStart = Get-PropertyOrNull -Object $word -Name 'start'
        if ($null -eq $wordStart) {
            throw "SpeechJson word has no start timestamp: $speechPath"
        }
        [void]$wordStarts.Add((ConvertTo-FiniteSeconds -Value $wordStart -Description 'Speech word start'))
    }

    if ($wordStarts.Count -gt 0) {
        $speechFirstWordSeconds = @($wordStarts | Sort-Object)[0]
        $speechStatus = 'MEASURED'
    }
    else {
        $speechStatus = 'NO_WORDS'
    }
}

[Nullable[double]]$gestureTimestamp = $null
if ($null -ne $GestureSeconds) {
    $gestureTimestamp = ConvertTo-FiniteSeconds -Value $GestureSeconds -Description 'GestureSeconds'
}

$audioOffset = New-OffsetMeasurement -MeasuredSeconds $audioOnsetSeconds -VisualSeconds $visualSeconds
$status = if ($null -eq $audioOffset) {
    'NO_AUDIO_ONSET'
}
elseif ([Math]::Abs([double]$audioOffset.milliseconds) -le $ToleranceMilliseconds) {
    'IN_TOLERANCE'
}
else {
    'OUT_OF_TOLERANCE'
}
$toleranceText = $ToleranceMilliseconds.ToString('0.###', [Globalization.CultureInfo]::InvariantCulture)
$toleranceBasis = if (-not $toleranceMillisecondsWasExplicit -and $ToleranceMilliseconds -eq 60) {
    '60 ms default: 20 ms audio analysis window plus conservative timestamp quantization allowance.'
}
else {
    "Caller-selected tolerance: ${toleranceText} ms."
}

$result = [pscustomobject]@{
    schema_version                    = 'agent-verification-lab.sync.v1'
    status                            = $status
    sign_convention                   = $signConvention
    tolerance                         = [pscustomobject]@{
        seconds      = [Math]::Round($ToleranceMilliseconds / 1000.0, 6)
        milliseconds = [Math]::Round($ToleranceMilliseconds, 3)
        basis        = $toleranceBasis
    }
    visual_event                      = New-TimestampMeasurement -Seconds $visualSeconds
    audio_onset                       = New-TimestampMeasurement -Seconds $audioOnsetSeconds
    audio_minus_visual                = $audioOffset
    speech_status                     = $speechStatus
    speech_first_word                 = New-TimestampMeasurement -Seconds $speechFirstWordSeconds
    speech_first_word_minus_visual    = New-OffsetMeasurement -MeasuredSeconds $speechFirstWordSeconds -VisualSeconds $visualSeconds
    gesture                           = New-TimestampMeasurement -Seconds $gestureTimestamp
    gesture_minus_visual              = New-OffsetMeasurement -MeasuredSeconds $gestureTimestamp -VisualSeconds $visualSeconds
}

$json = $result | ConvertTo-Json -Depth 6
if ($null -ne $resolvedOutputJson) {
    Write-NewOutputJson -Path $resolvedOutputJson -Json $json
}

Write-Output $json
