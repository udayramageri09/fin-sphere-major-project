#requires -Version 5.1
<#
  Stops the FinSphere demo (used by stop-demo.bat): the API on port 5000 and the web app on port 5174.
  With -All it also stops the database and analytics containers. Nothing is deleted.
#>
param([switch]$All)

$ErrorActionPreference = 'Continue'
foreach ($target in @(@{ Port = 5000; Pattern = 'server\.js'; Label = 'API' }, @{ Port = 5174; Pattern = 'vite'; Label = 'web app' })) {
  foreach ($processId in @(Get-NetTCPConnection -LocalPort $target.Port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)) {
    $command = (Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue).CommandLine
    if ($command -match $target.Pattern) { Stop-Process -Id $processId -Force; Write-Host "Stopped the $($target.Label) (pid $processId)." -ForegroundColor Green }
    else { Write-Host "Port $($target.Port) is used by another program; left alone." -ForegroundColor Yellow }
  }
}
if ($All) {
  docker stop finsphere-local-analytics finsphere-isolated-dev-db 2>$null | Out-Null
  Write-Host 'Stopped the database and analytics containers (data is kept).' -ForegroundColor Green
}
Write-Host 'Done.'
