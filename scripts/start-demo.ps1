#requires -Version 5.1
<#
  One-click local demo launcher for FinSphere (used by start-demo.bat).

  Starts, in order: Docker Desktop, the isolated development Postgres container, the analytics container, the API (port 5000)
  and the web app (port 5174); loads the sample "Faculty Demo" account; checks the AI assistant; opens Chrome.
  Nothing is deleted or reset. It only touches this project's own containers and processes.
#>
param([switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$ApiPort = 5000
$WebPort = 5174
$DbContainer = 'finsphere-isolated-dev-db'
$MlContainer = 'finsphere-local-analytics'
$DemoEmail = 'faculty.demo@finsphere.test'
$DemoPassword = if ($env:FACULTY_DEMO_PASSWORD) { $env:FACULTY_DEMO_PASSWORD } else { 'FacultyDemo@2026!' }
$stateDir = Join-Path $env:LOCALAPPDATA 'FinSphereDemo'
$apiLog = Join-Path $stateDir 'api.log'
$webLog = Join-Path $stateDir 'web.log'
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null

function Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "    OK  $text" -ForegroundColor Green }
function Warn($text) { Write-Host "    !!  $text" -ForegroundColor Yellow }
function Stop-Launcher($text) { Write-Host "`nSTOPPED: $text" -ForegroundColor Red; exit 1 }

function Test-Docker { cmd /c 'docker info >nul 2>&1'; return ($LASTEXITCODE -eq 0) }
function Get-Container($name) { (docker ps -a --filter "name=^$name$" --format '{{.Names}}') -eq $name }

# Any HTTP answer (even 404/401) means the server is up.
function Wait-Http($url, $seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    try { Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 4 | Out-Null; return $true }
    catch { if ($_.Exception.Response) { return $true } }
    Start-Sleep -Milliseconds 700
  }
  return $false
}

# Stops an earlier copy of THIS project's API / dev server on a port; refuses to touch anything else.
function Clear-Port($port, $pattern, $label) {
  foreach ($processId in @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)) {
    $command = (Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue).CommandLine
    if ($command -match $pattern) { Stop-Process -Id $processId -Force; Ok "stopped the previous $label (pid $processId)" }
    else { Stop-Launcher "Port $port is used by another program ($command). Close it and run this again." }
  }
  Start-Sleep -Milliseconds 800
}

Write-Host '============================================' -ForegroundColor White
Write-Host '   FinSphere - local demo launcher' -ForegroundColor White
Write-Host '============================================' -ForegroundColor White

# 1. Docker -----------------------------------------------------------------------------------------------------------
Step 'Docker'
if (-not (Test-Docker)) {
  $desktop = @("$env:ProgramFiles\Docker\Docker\Docker Desktop.exe", "${env:ProgramFiles(x86)}\Docker\Docker\Docker Desktop.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $desktop) { Stop-Launcher 'Docker Desktop is not installed or not found. Install it, start it, then run this again.' }
  Warn 'Docker is not running. Starting Docker Desktop (this can take a minute)...'
  Start-Process $desktop
  $deadline = (Get-Date).AddMinutes(3)
  while (-not (Test-Docker) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 3 }
  if (-not (Test-Docker)) { Stop-Launcher 'Docker did not become ready in 3 minutes. Start Docker Desktop manually and run this again.' }
}
Ok 'Docker is running'

# 2. Database ---------------------------------------------------------------------------------------------------------
Step 'Database (isolated development PostgreSQL)'
if (Get-Container $DbContainer) {
  docker start $DbContainer | Out-Null
} else {
  Warn 'The database container does not exist yet; creating a fresh one (the sample data is loaded below).'
  $generated = -join ((1..24) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })
  docker run -d --name $DbContainer -e POSTGRES_USER=finsphere_dev -e "POSTGRES_PASSWORD=$generated" -e POSTGRES_DB=finsphere_dev `
    -p 127.0.0.1:15432:5432 -v finsphere-dev-data:/var/lib/postgresql/data postgres:16-alpine | Out-Null
}
$ready = $false
for ($i = 0; $i -lt 40 -and -not $ready; $i++) {
  cmd /c "docker exec $DbContainer pg_isready -U finsphere_dev >nul 2>&1"
  $ready = ($LASTEXITCODE -eq 0)
  if (-not $ready) { Start-Sleep -Seconds 1 }
}
if (-not $ready) { Stop-Launcher 'The database did not become ready. Run "docker logs finsphere-isolated-dev-db" to see why.' }
$passwordEntry = docker inspect $DbContainer --format '{{range .Config.Env}}{{println .}}{{end}}' | Where-Object { $_ -like 'POSTGRES_PASSWORD=*' } | Select-Object -First 1
if (-not $passwordEntry) { Stop-Launcher 'Could not read the database settings from the container.' }
$dbPassword = $passwordEntry.Substring('POSTGRES_PASSWORD='.Length)
Ok 'database is ready'

# 3. Analytics service ------------------------------------------------------------------------------------------------
Step 'Financial Intelligence (analytics service)'
if (Get-Container $MlContainer) {
  docker start $MlContainer | Out-Null
  if (Wait-Http 'http://127.0.0.1:8000/' 40) { Ok 'analytics service is ready' } else { Warn 'analytics service did not answer; the Financial Intelligence page may be empty.' }
} else {
  Warn "Container '$MlContainer' was not found; the Financial Intelligence page will say analysis is unavailable. Everything else works."
}

# 4. API --------------------------------------------------------------------------------------------------------------
Step "API (port $ApiPort)"
Clear-Port $ApiPort 'server\.js' 'API'
$secretFile = Join-Path $stateDir 'jwt-secret.txt'   # kept between runs so you stay signed in after a restart
if (-not (Test-Path $secretFile)) { Set-Content -Path $secretFile -Value (-join ((1..96) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })) -Encoding ASCII }
$env:DATABASE_URL = "postgres://finsphere_dev:$dbPassword@127.0.0.1:15432/finsphere_dev"
$env:JWT_SECRET = (Get-Content $secretFile -Raw).Trim()
$env:NODE_ENV = 'development'
$env:HOST = '127.0.0.1'
$env:PORT = "$ApiPort"
$env:IMPORT_LEGACY_JSON = 'false'
$env:FINSPHERE_AA_SANDBOX = 'true'
$env:ML_SERVICE_URL = 'http://127.0.0.1:8000'
Remove-Item Env:GROQ_API_KEY -ErrorAction SilentlyContinue   # an empty value here would hide the key in server\.env
Remove-Item $apiLog -ErrorAction SilentlyContinue
Start-Process cmd.exe -ArgumentList "/c `"title FinSphere API && npm.cmd --prefix server start > `"$apiLog`" 2>&1`"" -WorkingDirectory $root -WindowStyle Minimized | Out-Null
if (-not (Wait-Http "http://127.0.0.1:$ApiPort/api/health" 60)) {
  $tail = if (Test-Path $apiLog) { (Get-Content $apiLog -Tail 8) -join "`n" } else { '(no log)' }
  Stop-Launcher "The API did not start. Last log lines:`n$tail"
}
Ok "API is ready  (log: $apiLog)"

# 5. Web app ----------------------------------------------------------------------------------------------------------
Step "Web app (port $WebPort)"
Clear-Port $WebPort 'vite' 'web app'
Remove-Item $webLog -ErrorAction SilentlyContinue
Start-Process cmd.exe -ArgumentList "/c `"title FinSphere Web && npm.cmd run dev:$WebPort > `"$webLog`" 2>&1`"" -WorkingDirectory $root -WindowStyle Minimized | Out-Null
if (-not (Wait-Http "http://localhost:$WebPort/" 90)) { Stop-Launcher "The web app did not start. See $webLog" }
Ok "web app is ready  (log: $webLog)"

# 6. Sample data ------------------------------------------------------------------------------------------------------
Step 'Sample demo account'
$seed = & node scripts\seedFacultyDemo.mjs 2>&1 | Out-String
if ($LASTEXITCODE -eq 0) { Ok 'sample account is ready' } else { Warn "Could not load the sample account: $($seed.Trim())" }

# 7. AI check ---------------------------------------------------------------------------------------------------------
Step 'AI assistant check'
try {
  $headers = @{ 'Content-Type' = 'application/json' }
  Invoke-RestMethod "http://127.0.0.1:$ApiPort/api/auth/login" -Method Post -ContentType 'application/json' -SessionVariable session `
    -Body (@{ email = $DemoEmail; password = $DemoPassword } | ConvertTo-Json) | Out-Null
  $body = @{ localDate = (Get-Date -Format 'yyyy-MM-dd'); messages = @(@{ role = 'user'; content = 'In one sentence, what is an emergency fund?' }) } | ConvertTo-Json -Depth 4
  $timer = [Diagnostics.Stopwatch]::StartNew()
  $reply = Invoke-RestMethod "http://127.0.0.1:$ApiPort/api/chat" -Method Post -WebSession $session -ContentType 'application/json' -Body $body -TimeoutSec 40
  $timer.Stop()
  $log = if (Test-Path $apiLog) { Get-Content $apiLog -Raw } else { '' }
  if ($log -match 'Groq API Error|Using fallback chatbot|Error calling Groq|NOT configured') {
    Warn 'The cloud AI is NOT answering (missing, invalid or rate-limited GROQ_API_KEY in server\.env). The assistant still works with built-in answers.'
  } else { Ok ("cloud AI answered in {0} ms" -f $timer.ElapsedMilliseconds) }
} catch { Warn "Could not run the AI check: $($_.Exception.Message)" }

# 8. Open the app -----------------------------------------------------------------------------------------------------
if (-not $NoBrowser) {
  Step 'Opening the app'
  $chrome = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe") |
    Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($chrome) { Start-Process $chrome "http://localhost:$WebPort/" } else { Start-Process "http://localhost:$WebPort/"; Warn 'Chrome was not found; voice works best in Chrome.' }
}

Write-Host "`n============================================" -ForegroundColor Green
Write-Host '  FinSphere is running' -ForegroundColor Green
Write-Host "  App:        http://localhost:$WebPort/" -ForegroundColor Green
Write-Host "  Demo login: $DemoEmail" -ForegroundColor Green
Write-Host "  Password:   $DemoPassword" -ForegroundColor Green
Write-Host '============================================' -ForegroundColor Green
Write-Host '  Voice: use Chrome and allow the microphone.  Circle to ask: double-click anywhere.' -ForegroundColor Gray
Write-Host '  To stop everything: run stop-demo.bat' -ForegroundColor Gray
