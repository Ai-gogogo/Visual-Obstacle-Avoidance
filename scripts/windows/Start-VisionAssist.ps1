param(
    [ValidateRange(1024, 65535)][int]$Port = 8775,
    [ValidateRange(1, 32)][int]$CvCpuThreads = 4,
    [string]$CvDevice = 'auto',
    [switch]$NoRoadAlerts,
    # Calibration JSON for the 480 x 640 WebRTC rig, from cv/calibrate_stereo.py.
    [string]$RtcLowConfig,
    # Stereo calibration the crossing predictor and measured road edges read their camera geometry from.
    [string]$StereoConfig,
    [string]$CvPython,
    [string]$AgentPython,
    [string]$Models,
    [string]$Certificate,
    [string]$PrivateKey,
    [string]$DashboardHost,
    [string]$CvCA,
    [switch]$Stop
)

# Starts the web server and the CV worker in the background, waits until both are ready,
# and records their process ids so a later -Stop ends exactly these processes.
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$state = Join-Path $repo '.visionassist'
New-Item -ItemType Directory -Path $state -Force | Out-Null
$processFile = Join-Path $state "processes-$Port.json"
$webLog = Join-Path $state "web-$Port.log"
$cvLog = Join-Path $state "cv-$Port.log"

function Get-OwnedProcess($record) {
    $running = Get-Process -Id $record.id -ErrorAction SilentlyContinue
    if ($running -and $running.StartTime.ToUniversalTime().Ticks -eq [long]$record.started) {
        return $running
    }
}

function Stop-OwnedProcess($running) {
    if (!$running -or $running.HasExited) { return }
    # The Windows venv launcher can start a child Python process.
    taskkill.exe /PID $running.Id /T /F | Out-Null
}

$saved = if (Test-Path -LiteralPath $processFile) { Get-Content -LiteralPath $processFile -Raw | ConvertFrom-Json }
$previous = if ($saved) { @($saved.processes | ForEach-Object { Get-OwnedProcess $_ }) }
if ($Stop) {
    $previous | ForEach-Object { Stop-OwnedProcess $_ }
    if (Test-Path -LiteralPath $processFile) { Remove-Item -LiteralPath $processFile }
    Write-Output 'VisionAssist processes stopped.'
    exit 0
}
if (@($previous | Where-Object { $_ }).Count -eq 2) {
    Write-Output "VisionAssist is already running at $($saved.url)/#assist"
    exit 0
}

if ([bool]$Certificate -ne [bool]$PrivateKey) {
    throw 'Supply both -Certificate and -PrivateKey for HTTPS.'
}
if ($DashboardHost -and !$Certificate) { throw '-DashboardHost requires HTTPS.' }

# Explicit parameters win, then existing VISIONASSIST_* variables, then the README defaults.
function Pick($explicit, $fromEnv, $default) {
    if ($explicit) { return $explicit }
    if ($fromEnv) { return $fromEnv }
    return $default
}
$cvPython = Pick $CvPython $env:VISIONASSIST_CV_PYTHON (Join-Path $repo 'cv/.venv/Scripts/python.exe')
$agentPython = Pick $AgentPython $env:VISIONASSIST_PYTHON (Join-Path $repo 'llm/.venv/Scripts/python.exe')
$models = Pick $Models $env:VISIONASSIST_MODELS (Join-Path $repo 'llm/models')
$node = (Get-Command node).Source
$env:VISIONASSIST_CV_PYTHON = $cvPython
$env:VISIONASSIST_PYTHON = $agentPython
# aiortc for the WebRTC receiver is installed in the agent environment (llm/agent-requirements.txt).
if (!$env:VISIONASSIST_RTC_PYTHON) { $env:VISIONASSIST_RTC_PYTHON = $agentPython }
$env:VISIONASSIST_MODELS = $models
if (!$env:VISIONASSIST_DB) { $env:VISIONASSIST_DB = Join-Path $state 'memory.sqlite' }
$env:VISIONASSIST_PORT = [string]$Port
$env:YOLO_CONFIG_DIR = Join-Path $state 'ultralytics'
$required = @($agentPython, $cvPython, (Join-Path $repo 'cv/models/yolo11n.pt'), (Join-Path $repo 'web/.next/BUILD_ID'))
if (!$NoRoadAlerts) { $required += Join-Path $repo 'cv/models/road-segformer-b0.onnx' }
if ($RtcLowConfig) { $required += $RtcLowConfig }
if ($StereoConfig) { $required += $StereoConfig }
foreach ($file in $required) {
    if (!(Test-Path -LiteralPath $file)) { throw "Missing local dependency: $file (see scripts/windows/README.md)" }
}

$nodeArgs = @('web/server.cjs')
$url = "http://localhost:$Port"
$workerUrl = "http://127.0.0.1:$Port"
if ($Certificate) {
    $certFile = (Resolve-Path -LiteralPath $Certificate).Path
    $keyFile = (Resolve-Path -LiteralPath $PrivateKey).Path
    $nodeArgs += @(('"' + $certFile + '"'), ('"' + $keyFile + '"'))
    $hostname = if ($DashboardHost) { $DashboardHost } else { 'localhost' }
    $env:VISIONASSIST_DASHBOARD_HOST = $hostname
    $url = "https://${hostname}:$Port"
    $workerUrl = "https://localhost:$Port"
    if ($CvCA) { $env:REQUESTS_CA_BUNDLE = (Resolve-Path -LiteralPath $CvCA).Path }
}

New-Item -ItemType Directory -Path $env:YOLO_CONFIG_DIR -Force | Out-Null
try {
    Invoke-RestMethod 'http://127.0.0.1:11434/api/version' -TimeoutSec 2 | Out-Null
} catch {
    $env:OLLAMA_NO_CLOUD = '1'
    Start-Process -FilePath (Get-Command ollama).Source -ArgumentList 'serve' -WindowStyle Hidden
}

$previous | ForEach-Object { Stop-OwnedProcess $_ }
$web = $null
$cv = $null
try {
    $web = Start-Process -FilePath $node -ArgumentList $nodeArgs -WorkingDirectory $repo -WindowStyle Hidden -PassThru -RedirectStandardOutput $webLog -RedirectStandardError (Join-Path $state "web-$Port.err")
    $ready = $false
    for ($i=0; $i -lt 30 -and !$web.HasExited; $i++) {
        try {
            $response = Invoke-RestMethod "$workerUrl/api/cv/sources" -TimeoutSec 2
            if ($null -ne $response.sources) { $ready = $true; break }
        } catch {}
        Start-Sleep -Milliseconds 300
    }
    if (!$ready) { throw "Web server did not start. Check $state/web-$Port.err." }

    $cvArgs = @('-u','cv/live_camera.py','--device',$CvDevice,'--cpu-threads',$CvCpuThreads,'--server',$workerUrl)
    if (!$NoRoadAlerts) { $cvArgs += '--road-alerts' }
    if ($RtcLowConfig) { $cvArgs += @('--rtc-low-config', ('"' + (Resolve-Path -LiteralPath $RtcLowConfig).Path + '"')) }
    if ($StereoConfig) { $cvArgs += @('--stereo-config', ('"' + (Resolve-Path -LiteralPath $StereoConfig).Path + '"')) }
    $cv = Start-Process -FilePath $cvPython -ArgumentList $cvArgs -WorkingDirectory $repo -WindowStyle Hidden -PassThru -RedirectStandardOutput $cvLog -RedirectStandardError (Join-Path $state "cv-$Port.err")
    $ready = $false
    for ($i=0; $i -lt 80 -and !$cv.HasExited; $i++) {
        if (Select-String -LiteralPath $cvLog -Pattern 'YOLO loaded' -Quiet -ErrorAction SilentlyContinue) {
            $ready = $true
            break
        }
        Start-Sleep -Milliseconds 500
    }
    if (!$ready) { throw "CV worker did not load YOLO. Check $state/cv-$Port.err." }

    $processes = @($web,$cv) | ForEach-Object { @{id=$_.Id; started=$_.StartTime.ToUniversalTime().Ticks} }
    @{url=$url;processes=@($processes)} | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $processFile -Encoding utf8
    Write-Output "Dashboard: $url/#assist"
    Write-Output "Judge view: $url/#monitor"
    Write-Output "Pairing page: $url/camera"
    Write-Output "Web and YOLO worker (device $CvDevice) are running. Logs: $state"
} catch {
    Stop-OwnedProcess $cv
    Stop-OwnedProcess $web
    throw
}
