$ErrorActionPreference = 'Stop'
$tamlerRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $tamlerRoot
$tamlerElectron = Join-Path $tamlerRoot '.cache\electron\runtime\electron.exe'
if (-not (Test-Path -LiteralPath $tamlerElectron)) { throw 'Extract stock Electron 44.4.3 x64 into .cache\electron\runtime first' }
foreach ($tamlerName in @('fixture-pid.txt','fixture-await-second.txt','fixture-result.json','fixture-error.txt')) {
  $tamlerFile = Join-Path $tamlerRoot "build\$tamlerName"
  if (Test-Path -LiteralPath $tamlerFile) { Remove-Item -LiteralPath $tamlerFile }
}
& node scripts/bootstrap.cjs
Copy-Item -LiteralPath 'build\tamler.dll' -Destination 'build\tamler-fixture-refresh.dll' -Force
$tamlerProcess = Start-Process -FilePath $tamlerElectron -ArgumentList "$tamlerRoot\tests\electron-fixture.cjs","--user-data-dir=$tamlerRoot\build\fixture-profile",'--double-inject' -WindowStyle Hidden -PassThru -RedirectStandardOutput "$tamlerRoot\build\fixture-stdout.log" -RedirectStandardError "$tamlerRoot\build\fixture-stderr.log"
$tamlerProcess.Handle | Out-Null
function Wait-TamlerFile($Name) {
  $tamlerDeadline = (Get-Date).AddSeconds(10)
  $tamlerFile = Join-Path $tamlerRoot "build\$Name"
  while (-not (Test-Path -LiteralPath $tamlerFile)) {
    if ((Get-Date) -gt $tamlerDeadline -or $tamlerProcess.HasExited) { throw "Fixture failed waiting for $Name; check fixture-stderr.log" }
    Start-Sleep -Milliseconds 100
    $tamlerProcess.Refresh()
  }
  return Get-Content -LiteralPath $tamlerFile -Raw
}
try {
  $tamlerTargetId = (Wait-TamlerFile 'fixture-pid.txt').Trim()
  & .\build\tamler-inject.exe $tamlerTargetId "$tamlerRoot\build\tamler.dll"
  if ($LASTEXITCODE -ne 0) { throw 'First injection failed' }
  Wait-TamlerFile 'fixture-await-second.txt' | Out-Null
  & .\build\tamler-inject.exe $tamlerTargetId "$tamlerRoot\build\tamler-fixture-refresh.dll"
  if ($LASTEXITCODE -ne 0) { throw 'Refresh injection failed' }
  $tamlerResult = (Wait-TamlerFile 'fixture-result.json') | ConvertFrom-Json
  if (-not $tamlerResult.upgraded.active -or -not $tamlerResult.upgraded.indicator -or $tamlerResult.upgraded.styles -ne 1 -or -not $tamlerResult.controlled) { throw 'Runtime upgrade assertions failed' }
  if (-not $tamlerResult.initial.active -or -not $tamlerResult.initial.indicator -or $tamlerResult.initial.styles -ne 1 -or -not $tamlerResult.reloaded.active -or -not $tamlerResult.reloaded.indicator -or $tamlerResult.reloaded.styles -ne 1 -or $tamlerResult.disposed.active -or $tamlerResult.disposed.indicator -or $tamlerResult.disposed.styles -ne 0) { throw 'DOM lifecycle assertions failed' }
  if (-not $tamlerProcess.WaitForExit(5000) -or $tamlerProcess.ExitCode -ne 0) { throw 'Fixture did not exit successfully' }
  $tamlerResult | ConvertTo-Json -Depth 5
} finally {
  $tamlerProcess.Refresh()
  if (-not $tamlerProcess.HasExited) { Stop-Process -Id $tamlerProcess.Id }
}
