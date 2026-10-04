$ErrorActionPreference = 'Stop'
$tamlerRoot = Split-Path -Parent $PSScriptRoot
$tamlerSettings = Get-Content -LiteralPath (Join-Path $tamlerRoot 'data\autostart.json') -Raw | ConvertFrom-Json
$tamlerNode = $tamlerSettings.node
$tamlerHash = [System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes($tamlerRoot))).Replace('-', '').Substring(0, 16)
$tamlerMutex = New-Object System.Threading.Mutex($false, "Local\Tamler-$tamlerHash")
try { $tamlerAcquired = $tamlerMutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $tamlerAcquired = $true }
if (-not $tamlerAcquired) { $tamlerMutex.Dispose(); exit 0 }
$tamlerSeen = @{}
$tamlerHadProcesses = $false
function Write-TamlerStatus($Value) {
  $Value | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $tamlerRoot 'data\watcher-status.json') -Encoding UTF8
}
try {
  Write-TamlerStatus @{ state = 'watching'; watcherPid = $PID; time = (Get-Date).ToString('o') }
  while ($true) {
    try {
      $tamlerProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'Claude.exe'" | Where-Object { $_.ExecutablePath -like '*\WindowsApps\*\app\Claude.exe' -and $_.CommandLine -notmatch '--type=' })
    } catch {
      Write-TamlerStatus @{ state = 'error'; reason = $_.Exception.Message; watcherPid = $PID; time = (Get-Date).ToString('o') }
      Start-Sleep -Seconds 3
      continue
    }
    if ($tamlerHadProcesses -and $tamlerProcesses.Count -eq 0) { Write-TamlerStatus @{ state = 'watching'; watcherPid = $PID; time = (Get-Date).ToString('o') } }
    $tamlerHadProcesses = $tamlerProcesses.Count -gt 0
    foreach ($tamlerTarget in $tamlerProcesses) {
      $tamlerKey = "$($tamlerTarget.ProcessId):$($tamlerTarget.CreationDate)"
      if ($tamlerSeen.ContainsKey($tamlerKey)) { continue }
      $tamlerSeen[$tamlerKey] = $true
      try {
        $tamlerCompatibility = & $tamlerNode (Join-Path $PSScriptRoot 'compatibility.cjs') $tamlerTarget.ExecutablePath
        if ($LASTEXITCODE -ne 0) {
          Write-TamlerStatus @{ state = 'incompatible'; pid = $tamlerTarget.ProcessId; detail = $tamlerCompatibility; watcherPid = $PID; time = (Get-Date).ToString('o') }
          continue
        }
        $tamlerPipe = New-Object System.IO.Pipes.NamedPipeClientStream('.', "tamler-$($tamlerTarget.ProcessId)", [System.IO.Pipes.PipeDirection]::InOut)
        try { $tamlerPipe.Connect(300); $tamlerAttached = $true } catch { $tamlerAttached = $false } finally { $tamlerPipe.Dispose() }
        if (-not $tamlerAttached) {
          $tamlerModules = (Get-Process -Id $tamlerTarget.ProcessId).Modules | Where-Object { $_.FileName -like "$tamlerRoot\build\tamler*.dll" }
          if ($tamlerModules) { throw 'Tamler loader already present without a control pipe; restart Claude to reconnect' }
          & (Join-Path $tamlerRoot 'build\tamler-inject.exe') $tamlerTarget.ProcessId (Join-Path $tamlerRoot 'build\tamler.dll') | Out-Null
          if ($LASTEXITCODE -ne 0) { throw 'Native injection failed' }
          $tamlerPipe = New-Object System.IO.Pipes.NamedPipeClientStream('.', "tamler-$($tamlerTarget.ProcessId)", [System.IO.Pipes.PipeDirection]::InOut)
          try { $tamlerPipe.Connect(15000) } finally { $tamlerPipe.Dispose() }
        }
        Write-TamlerStatus @{ state = 'attached'; pid = $tamlerTarget.ProcessId; executable = $tamlerTarget.ExecutablePath; watcherPid = $PID; time = (Get-Date).ToString('o') }
      } catch {
        Write-TamlerStatus @{ state = 'error'; pid = $tamlerTarget.ProcessId; reason = $_.Exception.Message; watcherPid = $PID; time = (Get-Date).ToString('o') }
      }
    }
    foreach ($tamlerKey in @($tamlerSeen.Keys)) {
      if (-not ($tamlerProcesses | Where-Object { "$($_.ProcessId):$($_.CreationDate)" -eq $tamlerKey })) { $tamlerSeen.Remove($tamlerKey) }
    }
    Start-Sleep -Seconds 3
  }
} finally {
  $tamlerMutex.ReleaseMutex()
  $tamlerMutex.Dispose()
}
