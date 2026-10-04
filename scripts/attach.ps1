param([int]$TargetPid)
$ErrorActionPreference = 'Stop'
$tamlerRoot = Split-Path -Parent $PSScriptRoot
$tamlerInjector = Join-Path $tamlerRoot 'build\tamler-inject.exe'
$tamlerDll = Join-Path $tamlerRoot 'build\tamler.dll'
if (-not (Test-Path -LiteralPath $tamlerInjector)) { throw 'Build Tamler first' }
$tamlerProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'Claude.exe'" | Where-Object { $_.ExecutablePath -like '*\WindowsApps\*\app\Claude.exe' -and $_.CommandLine -notmatch '--type=' })
if ($TargetPid) {
  $tamlerTarget = $tamlerProcesses | Where-Object { $_.ProcessId -eq $TargetPid }
} elseif ($tamlerProcesses.Count -eq 1) {
  $tamlerTarget = $tamlerProcesses[0]
} else {
  $tamlerProcesses | Select-Object ProcessId,ExecutablePath | Format-Table
  throw 'Pass -TargetPid to select exactly one Claude Desktop main process'
}
if (-not $tamlerTarget) { throw 'Claude Desktop main process not found' }
$tamlerVersion = (Get-Content -LiteralPath (Join-Path (Split-Path $tamlerTarget.ExecutablePath) 'version') -Raw).Trim()
& node (Join-Path $PSScriptRoot 'compatibility.cjs') $tamlerTarget.ExecutablePath
if ($LASTEXITCODE -ne 0) { throw "Claude Desktop is incompatible with this Tamler loader" }
$tamlerLoaded = (Get-Process -Id $tamlerTarget.ProcessId).Modules | Where-Object { $_.FileName -like "$tamlerRoot\build\tamler*.dll" }
if ($tamlerLoaded) { throw 'Tamler already loaded; use control.cjs reload or upgrade' }
& $tamlerInjector $tamlerTarget.ProcessId $tamlerDll
if ($LASTEXITCODE -ne 0) { throw 'DLL injection failed' }
$tamlerDeadline = (Get-Date).AddSeconds(20)
do {
  $tamlerLog = Join-Path $tamlerRoot 'build\runtime.jsonl'
  if (Test-Path -LiteralPath $tamlerLog) {
    $tamlerReady = Get-Content -LiteralPath $tamlerLog | ForEach-Object { try { $_ | ConvertFrom-Json } catch {} } | Where-Object { $_.event -eq 'main-ready' -and $_.pid -eq $tamlerTarget.ProcessId }
    if ($tamlerReady) { Write-Output "Tamler main runtime ready in PID $($tamlerTarget.ProcessId)"; exit 0 }
  }
  Start-Sleep -Milliseconds 250
} while ((Get-Date) -lt $tamlerDeadline)
throw 'DLL loaded, but JS bootstrap was not confirmed. Check build\native.log; do not reinject into the same process.'
