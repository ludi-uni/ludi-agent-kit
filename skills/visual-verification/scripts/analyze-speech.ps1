[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$Input,
    [string]$Language,
    [string]$Model = 'base',
    [string]$Backend = 'whisperx',
    [string]$Device = 'cuda',
    [string]$OutputJson,
    [string]$WhisperXVenvPath = (Join-Path $env:USERPROFILE '.cache/agent-verification-lab/whisperx-venv'),
    [string]$ModelCachePath = (Join-Path $env:USERPROFILE '.cache/agent-verification-lab/whisperx-models')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function New-BackendResult {
    param(
        [Parameter(Mandatory)][string]$Status,
        [Parameter(Mandatory)][string]$Message,
        [Parameter(Mandatory)][string]$BackendName,
        [Parameter(Mandatory)][string]$RequestedDevice,
        [Parameter(Mandatory)][string]$RequestedModel
    )

    return [pscustomobject]@{
        schema_version = 'agent-verification-lab.speech.v1'
        status         = $Status
        language       = $null
        backend        = [pscustomobject]@{
            name    = $BackendName
            version = $null
            device  = $RequestedDevice
            model   = $RequestedModel
        }
        segments       = @()
        words          = @()
        error          = $Message
    }
}

function Write-BackendUnavailable {
    param([Parameter(Mandatory)][string]$Message)

    $result = New-BackendResult -Status 'REQUIRES_BACKEND' -Message $Message -BackendName $Backend -RequestedDevice $Device -RequestedModel $Model
    Write-Output ($result | ConvertTo-Json -Depth 6 -Compress)
    exit 3
}

function Get-RequiredStringProperty {
    param([Parameter(Mandatory)][object]$Object, [Parameter(Mandatory)][string]$Name)

    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property -or [string]::IsNullOrWhiteSpace([string]$property.Value)) {
        throw "Speech backend result is missing required '$Name'."
    }
    return [string]$property.Value
}

function Test-FiniteNumber {
    param([AllowNull()][object]$Value)

    if ($null -eq $Value) {
        return $false
    }
    try {
        $number = [double]$Value
        return -not [double]::IsNaN($number) -and -not [double]::IsInfinity($number)
    }
    catch {
        return $false
    }
}

function Assert-NormalizedSpeechResult {
    param([Parameter(Mandatory)][object]$Result)

    if ((Get-RequiredStringProperty -Object $Result -Name 'schema_version') -ne 'agent-verification-lab.speech.v1') {
        throw "Speech backend result does not use schema_version 'agent-verification-lab.speech.v1'."
    }
    if ((Get-RequiredStringProperty -Object $Result -Name 'status') -ne 'ok') {
        throw "Speech backend result has non-success status '$($Result.status)'."
    }
    [void](Get-RequiredStringProperty -Object $Result -Name 'language')
    $backendResult = $Result.PSObject.Properties['backend']
    if ($null -eq $backendResult -or $null -eq $backendResult.Value) {
        throw 'Speech backend result is missing backend provenance.'
    }
    foreach ($field in @('name', 'version', 'device', 'model')) {
        [void](Get-RequiredStringProperty -Object $backendResult.Value -Name $field)
    }
    foreach ($collectionName in @('segments', 'words')) {
        $collection = $Result.PSObject.Properties[$collectionName]
        if ($null -eq $collection) {
            throw "Speech backend result is missing '$collectionName'."
        }
        if (@($collection.Value).Count -lt 1) {
            throw "Speech backend result has no normalized $collectionName."
        }
        foreach ($item in @($collection.Value)) {
            if ($null -eq $item) {
                throw "Speech backend result contains a null $collectionName item."
            }
            [void](Get-RequiredStringProperty -Object $item -Name 'text')
            if (-not (Test-FiniteNumber -Value $item.start) -or -not (Test-FiniteNumber -Value $item.end)) {
                throw "Speech backend result contains a $collectionName item without finite numeric start/end timestamps."
            }
            if ([double]$item.end -lt [double]$item.start) {
                throw "Speech backend result contains a $collectionName item whose end precedes start."
            }
        }
    }
    $alignment = $backendResult.Value.PSObject.Properties['alignment']
    if ($null -eq $alignment -or $null -eq $alignment.Value -or $alignment.Value.status -ne 'aligned') {
        throw 'Speech backend result is not word-aligned.'
    }
}

function Test-PathWithin {
    param(
        [Parameter(Mandatory)][string]$Child,
        [Parameter(Mandatory)][string]$Parent
    )

    $childPath = [IO.Path]::GetFullPath($Child).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    $parentPath = [IO.Path]::GetFullPath($Parent).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    return $childPath.Equals($parentPath, [StringComparison]::OrdinalIgnoreCase) -or $childPath.StartsWith($parentPath + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

function Resolve-PhysicalExistingPath {
    param([Parameter(Mandatory)][string]$ExistingPath)

    $logicalPath = [IO.Path]::GetFullPath($ExistingPath)
    $providerPath = (Resolve-Path -LiteralPath $logicalPath -ErrorAction Stop).ProviderPath
    $item = Get-Item -LiteralPath $logicalPath -Force -ErrorAction Stop
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        try {
            $target = $item.ResolveLinkTarget($true)
        }
        catch {
            throw "Could not resolve reparse-point target for '$logicalPath': $($_.Exception.Message)"
        }
        if ($null -eq $target) {
            throw "Could not resolve reparse-point target for '$logicalPath'."
        }
        return [IO.Path]::GetFullPath($target.FullName)
    }

    $parent = Split-Path -Parent $logicalPath
    $leaf = Split-Path -Leaf $logicalPath
    if ([string]::IsNullOrWhiteSpace($parent) -or [string]::IsNullOrWhiteSpace($leaf) -or $parent -eq $logicalPath) {
        return [IO.Path]::GetFullPath($providerPath)
    }
    return (Join-Path (Resolve-PhysicalExistingPath -ExistingPath $parent) $leaf)
}

function Resolve-PhysicalPath {
    param([Parameter(Mandatory)][string]$Path)

    $logicalPath = [IO.Path]::GetFullPath($Path)
    $unresolvedTail = [System.Collections.Generic.List[string]]::new()
    $existingAncestor = $logicalPath
    while (-not (Test-Path -LiteralPath $existingAncestor)) {
        $leaf = Split-Path -Leaf $existingAncestor
        $parent = Split-Path -Parent $existingAncestor
        if ([string]::IsNullOrWhiteSpace($leaf) -or [string]::IsNullOrWhiteSpace($parent) -or $parent -eq $existingAncestor) {
            throw "No existing ancestor is available for physical path resolution: $logicalPath"
        }
        [void]$unresolvedTail.Add($leaf)
        $existingAncestor = $parent
    }

    $physicalPath = Resolve-PhysicalExistingPath -ExistingPath $existingAncestor
    for ($index = $unresolvedTail.Count - 1; $index -ge 0; $index--) {
        $physicalPath = Join-Path $physicalPath $unresolvedTail[$index]
    }
    return [IO.Path]::GetFullPath($physicalPath)
}

function Write-NewSpeechOutputJson {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Json
    )

    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($Json)
    $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    }
    finally {
        $stream.Dispose()
    }
}

function Set-ScopedModelCacheEnvironment {
    param([Parameter(Mandatory)][string]$CachePath)

    $resolvedCachePath = [IO.Path]::GetFullPath($CachePath)
    $values = [ordered]@{
        HF_HOME            = $resolvedCachePath
        HF_HUB_CACHE       = Join-Path $resolvedCachePath 'hub'
        TRANSFORMERS_CACHE = Join-Path $resolvedCachePath 'transformers'
    }
    $previous = @{}
    foreach ($name in $values.Keys) {
        $existing = Get-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
        $previous[$name] = [pscustomobject]@{ exists = $null -ne $existing; value = if ($null -ne $existing) { $existing.Value } else { $null } }
        Set-Item -LiteralPath "Env:$name" -Value $values[$name]
    }
    return [pscustomobject]@{ cache_path = $resolvedCachePath; previous = $previous; names = @($values.Keys) }
}

function Restore-ScopedModelCacheEnvironment {
    param([Parameter(Mandatory)][pscustomobject]$Scope)

    foreach ($name in $Scope.names) {
        if ($Scope.previous[$name].exists) {
            Set-Item -LiteralPath "Env:$name" -Value $Scope.previous[$name].value
        }
        else {
            Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
        }
    }
}

$inputPath = $PSBoundParameters['Input']
if (-not (Test-Path -LiteralPath $inputPath -PathType Leaf)) {
    throw "Input media file does not exist or is not a file: $inputPath"
}
$resolvedInputPath = [IO.Path]::GetFullPath($inputPath)
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))

if ($Backend -cne 'whisperx') {
    Write-BackendUnavailable -Message "Unsupported speech backend '$Backend'."
}

$resolvedVenvPath = [IO.Path]::GetFullPath($WhisperXVenvPath)
$resolvedModelCachePath = [IO.Path]::GetFullPath($ModelCachePath)
try {
    $physicalRepoRoot = Resolve-PhysicalPath -Path $repoRoot
    $physicalVenvPath = Resolve-PhysicalPath -Path $resolvedVenvPath
    $physicalModelCachePath = Resolve-PhysicalPath -Path $resolvedModelCachePath
}
catch {
    Write-BackendUnavailable -Message "ISOLATION_PATH_RESOLUTION_FAILED: $($_.Exception.Message)"
}
if (Test-PathWithin -Child $physicalVenvPath -Parent $physicalRepoRoot) {
    Write-BackendUnavailable -Message "VENV_PATH_INSIDE_REPOSITORY: $physicalVenvPath"
}
if (Test-PathWithin -Child $physicalModelCachePath -Parent $physicalRepoRoot) {
    Write-BackendUnavailable -Message "MODEL_CACHE_PATH_INSIDE_REPOSITORY: $physicalModelCachePath"
}
$pythonPath = Join-Path $resolvedVenvPath 'Scripts\python.exe'
if (-not (Test-Path -LiteralPath $pythonPath -PathType Leaf)) {
    Write-BackendUnavailable -Message "Dedicated WhisperX interpreter is unavailable: $pythonPath"
}

$adapterPath = Join-Path $PSScriptRoot 'backends\whisperx_backend.py'
if (-not (Test-Path -LiteralPath $adapterPath -PathType Leaf)) {
    Write-BackendUnavailable -Message "WhisperX backend adapter is unavailable: $adapterPath"
}

$resolvedOutputJson = $null
if (-not [string]::IsNullOrWhiteSpace($OutputJson)) {
    $resolvedOutputJson = [IO.Path]::GetFullPath($OutputJson)
    $outputDirectory = Split-Path -Parent $resolvedOutputJson
    if (-not (Test-Path -LiteralPath $outputDirectory -PathType Container)) {
        throw "OutputJson directory does not exist: $outputDirectory"
    }
}

try {
    $ffmpeg = Get-Command ffmpeg -CommandType Application -ErrorAction Stop
}
catch {
    throw 'ffmpeg was not found on PATH.'
}

$temporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) 'agent-verification-lab\speech'
New-Item -ItemType Directory -Path $temporaryDirectory -Force | Out-Null
$temporaryWav = Join-Path $temporaryDirectory ('speech-' + [Guid]::NewGuid().ToString('N') + '.wav')
$cacheScope = $null

try {
    $ffmpegOutput = & $ffmpeg.Source '-hide_banner' '-loglevel' 'error' '-nostdin' '-y' '-i' $resolvedInputPath '-map' '0:a:0' '-vn' '-ac' '1' '-ar' '16000' '-c:a' 'pcm_s16le' $temporaryWav 2>&1
    $ffmpegExitCode = $LASTEXITCODE
    if ($ffmpegExitCode -ne 0 -or -not (Test-Path -LiteralPath $temporaryWav -PathType Leaf)) {
        $diagnostics = ($ffmpegOutput | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine
        throw "FFmpeg audio extraction failed with exit code $ffmpegExitCode for '$resolvedInputPath'.$([Environment]::NewLine)$diagnostics"
    }

    $cacheScope = Set-ScopedModelCacheEnvironment -CachePath $ModelCachePath
    $adapterArguments = @(
        $adapterPath,
        '--input-wav', $temporaryWav,
        '--model', $Model,
        '--device', $Device,
        '--model-cache-path', $cacheScope.cache_path
    )
    if (-not [string]::IsNullOrWhiteSpace($Language)) {
        $adapterArguments += @('--language', $Language)
    }
    $adapterOutput = & $pythonPath @adapterArguments 2>&1
    $adapterExitCode = $LASTEXITCODE
    $jsonLine = @($adapterOutput | Where-Object { $_.ToString().TrimStart().StartsWith('{') } | Select-Object -Last 1)
    if ($jsonLine.Count -ne 1) {
        $diagnostics = ($adapterOutput | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine
        throw "WhisperX adapter did not return normalized JSON (exit $adapterExitCode).$([Environment]::NewLine)$diagnostics"
    }
    try {
        $result = $jsonLine[0].ToString() | ConvertFrom-Json -ErrorAction Stop
    }
    catch {
        throw "WhisperX adapter returned invalid JSON: $($_.Exception.Message)"
    }

    if ($adapterExitCode -ne 0 -or $result.status -eq 'REQUIRES_BACKEND') {
        if ($result.schema_version -ne 'agent-verification-lab.speech.v1' -or $result.status -ne 'REQUIRES_BACKEND') {
            throw "WhisperX adapter failed with exit code $adapterExitCode without a normalized REQUIRES_BACKEND result."
        }
        Write-Output ($result | ConvertTo-Json -Depth 8 -Compress)
        exit 3
    }

    Assert-NormalizedSpeechResult -Result $result
    $normalizedJson = $result | ConvertTo-Json -Depth 8
    if ($null -ne $resolvedOutputJson) {
        Write-NewSpeechOutputJson -Path $resolvedOutputJson -Json $normalizedJson
    }
    Write-Output $normalizedJson
}
finally {
    try {
        if ($null -ne $cacheScope) {
            Restore-ScopedModelCacheEnvironment -Scope $cacheScope
        }
    }
    finally {
        if (Test-Path -LiteralPath $temporaryWav -PathType Leaf) {
            Remove-Item -LiteralPath $temporaryWav -Force -ErrorAction SilentlyContinue
        }
    }
}
