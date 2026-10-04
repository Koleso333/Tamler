param([ValidateSet('enable','disable','status')][string]$Action = 'enable')
$ErrorActionPreference = 'Stop'
$tamlerRoot = Split-Path -Parent $PSScriptRoot
$tamlerKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$tamlerData = Join-Path $tamlerRoot 'data'
$tamlerStatusPath = Join-Path $tamlerData 'watcher-status.json'
if ($Action -eq 'status') {
  Get-ItemPropertyValue -LiteralPath $tamlerKey -Name Tamler -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $tamlerStatusPath) { Get-Content -LiteralPath $tamlerStatusPath }
  exit 0
}
if ($Action -eq 'disable') {
  Remove-ItemProperty -LiteralPath $tamlerKey -Name Tamler -ErrorAction SilentlyContinue
  $tamlerWatchers = Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" | Where-Object { $_.CommandLine -like "*$tamlerRoot\scripts\watch.ps1*" }
  foreach ($tamlerWatcher in $tamlerWatchers) { Stop-Process -Id $tamlerWatcher.ProcessId }
  Write-Output 'Tamler autostart disabled'
  exit 0
}
New-Item -ItemType Directory -Path $tamlerData -Force | Out-Null
@{ node = (Get-Command node.exe).Source } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $tamlerData 'autostart.json') -Encoding UTF8
$tamlerPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$tamlerArguments = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$tamlerRoot\scripts\watch.ps1`""
New-Item -Path $tamlerKey -Force | Out-Null
Set-ItemProperty -LiteralPath $tamlerKey -Name Tamler -Value "`"$tamlerPowerShell`" $tamlerArguments"
Start-Process -FilePath $tamlerPowerShell -ArgumentList $tamlerArguments -WindowStyle Hidden
Write-Output 'Tamler autostart enabled'
