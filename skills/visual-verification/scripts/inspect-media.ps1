[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$Input,
    [string]$OutputJson
)

Set-StrictMode -Version Latest

$inputPath = $PSBoundParameters['Input']

function Get-PropertyOrNull {
    [OutputType([object])]
    param(
        [AllowNull()]
        [object]$Object,
        [Parameter(Mandatory)]
        [string]$Name
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

function Get-FirstStreamOfType {
    [OutputType([object])]
    param(
        [AllowNull()]
        [object[]]$Streams,
        [Parameter(Mandatory)]
        [string]$CodecType
    )

    $matches = @($Streams | Where-Object { (Get-PropertyOrNull -Object $_ -Name 'codec_type') -eq $CodecType })
    if ($matches.Count -eq 0) {
        return $null
    }

    return $matches[0]
}

function New-StreamSummary {
    [OutputType([pscustomobject])]
    param(
        [AllowNull()]
        [object]$Stream
    )

    return [pscustomobject]@{
        start_time = Get-PropertyOrNull -Object $Stream -Name 'start_time'
        duration   = Get-PropertyOrNull -Object $Stream -Name 'duration'
        time_base  = Get-PropertyOrNull -Object $Stream -Name 'time_base'
        codec      = Get-PropertyOrNull -Object $Stream -Name 'codec_name'
    }
}

if (-not (Test-Path -LiteralPath $inputPath -PathType Leaf)) {
    throw "Input media file does not exist or is not a file: $inputPath"
}

$resolvedInput = [IO.Path]::GetFullPath($inputPath)
$resolvedOutputJson = $null
$outputJsonStream = $null
if (-not [string]::IsNullOrWhiteSpace($OutputJson)) {
    $resolvedOutputJson = [IO.Path]::GetFullPath($OutputJson)
    $outputDirectory = Split-Path -Parent $resolvedOutputJson
    if (-not (Test-Path -LiteralPath $outputDirectory -PathType Container)) {
        throw "OutputJson directory does not exist: $outputDirectory"
    }
    if (Test-Path -LiteralPath $resolvedOutputJson) {
        throw "OutputJson already exists; refusing to overwrite: $resolvedOutputJson"
    }
    # Reserve the output path with an exclusive create so a concurrently
    # appearing file is never overwritten.
    try {
        $outputJsonStream = [IO.File]::Open($resolvedOutputJson, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    }
    catch {
        throw "OutputJson could not be exclusively created; refusing to overwrite: $resolvedOutputJson ($($_.Exception.Message))"
    }
}

# Keep the reserved stream inside a try/finally so a failure below cannot
# leak the handle or be mistaken for a successful write. The finally must
# never delete by path: another process could create a different file at
# $resolvedOutputJson after this reservation is released. A failed run
# leaves the zero-byte reservation in place and warns with its location;
# that file is not a successful output.
try {
    try {
        $ffprobeCommand = Get-Command ffprobe -ErrorAction Stop
    }
    catch {
        throw 'ffprobe was not found on PATH.'
    }

if ($ffprobeCommand.CommandType -ne [System.Management.Automation.CommandTypes]::Application) {
    throw "ffprobe resolved to '$($ffprobeCommand.CommandType)', not an executable application."
}

$ffprobeArguments = @(
    '-v', 'error',
    '-show_entries', 'format=start_time,duration,size:stream=codec_type,codec_name,start_time,duration,time_base,avg_frame_rate,width,height,sample_rate',
    '-of', 'json',
    $resolvedInput
)
$ffprobeOutput = & $ffprobeCommand.Source @ffprobeArguments 2>&1
$ffprobeExitCode = $LASTEXITCODE
if ($ffprobeExitCode -ne 0) {
    $diagnostics = ($ffprobeOutput | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine
    throw "ffprobe inspection failed with exit code $ffprobeExitCode for '$resolvedInput'.$([Environment]::NewLine)$diagnostics"
}

try {
    $probe = (($ffprobeOutput | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine | ConvertFrom-Json -ErrorAction Stop)
}
catch {
    throw "ffprobe returned invalid JSON for '$resolvedInput': $($_.Exception.Message)"
}

$videoStream = Get-FirstStreamOfType -Streams @($probe.streams) -CodecType 'video'
$audioStream = Get-FirstStreamOfType -Streams @($probe.streams) -CodecType 'audio'
$video = New-StreamSummary -Stream $videoStream
$video | Add-Member -NotePropertyName frame_rate -NotePropertyValue (Get-PropertyOrNull -Object $videoStream -Name 'avg_frame_rate')
$video | Add-Member -NotePropertyName width -NotePropertyValue (Get-PropertyOrNull -Object $videoStream -Name 'width')
$video | Add-Member -NotePropertyName height -NotePropertyValue (Get-PropertyOrNull -Object $videoStream -Name 'height')
$audio = New-StreamSummary -Stream $audioStream
$audio | Add-Member -NotePropertyName sample_rate -NotePropertyValue (Get-PropertyOrNull -Object $audioStream -Name 'sample_rate')

$result = [pscustomobject]@{
    schema_version = 'agent-verification-lab.media.v1'
    format         = [pscustomobject]@{
        start_time = Get-PropertyOrNull -Object $probe.format -Name 'start_time'
        duration   = Get-PropertyOrNull -Object $probe.format -Name 'duration'
        size       = Get-PropertyOrNull -Object $probe.format -Name 'size'
    }
    video          = $video
    audio          = $audio
}

    $json = $result | ConvertTo-Json -Depth 4
    if ($null -ne $outputJsonStream) {
        $jsonBytes = [Text.UTF8Encoding]::new($false).GetBytes($json)
        $outputJsonStream.Write($jsonBytes, 0, $jsonBytes.Length)
        $outputJsonStream.Flush($true)
        $outputJsonStream.Dispose()
        $outputJsonStream = $null
    }

    Write-Output $json
}
finally {
    if ($null -ne $outputJsonStream) {
        $outputJsonStream.Dispose()
        $outputJsonStream = $null
        # Only the stream handle is released here. Deleting by path would
        # race a concurrently created replacement file, so the zero-byte
        # reservation is left in place and reported as a non-successful
        # partial output instead.
        Write-Warning "inspect-media failed before writing OutputJson; a non-successful partial output remains at: $resolvedOutputJson"
    }
}
