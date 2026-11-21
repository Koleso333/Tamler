$ErrorActionPreference = 'Stop'
$tamlerRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $tamlerRoot
$tamlerTargetFile = Join-Path $tamlerRoot 'build\target.json'
if (-not (Test-Path -LiteralPath $tamlerTargetFile)) { throw 'Build Tamler first' }
$tamlerVersion = (Get-Content -LiteralPath $tamlerTargetFile -Raw | ConvertFrom-Json).electron
$tamlerFixtureCache = ".cache\electron\$tamlerVersion\runtime"
$tamlerElectron = foreach ($tamlerCandidate in $tamlerFixtureCache, '.cache\electron\runtime') {
  $tamlerExecutable = Join-Path $tamlerCandidate 'electron.exe'
  $tamlerVersionFile = Join-Path $tamlerCandidate 'version'
  if ((Test-Path -LiteralPath $tamlerExecutable) -and (Test-Path -LiteralPath $tamlerVersionFile) -and (Get-Content -LiteralPath $tamlerVersionFile -Raw).Trim() -eq $tamlerVersion) {
    (Resolve-Path -LiteralPath $tamlerExecutable).Path
    break
  }
}
if (-not $tamlerElectron) { throw "Extract stock Electron $tamlerVersion x64 into $tamlerFixtureCache first" }
$tamlerFixtureRoot = Join-Path $tamlerRoot 'build\native-fixture'
$tamlerFixtureBuild = Join-Path $tamlerFixtureRoot 'build'
$tamlerFixturePlugin = Join-Path $tamlerFixtureRoot 'plugins\native-fixture'
New-Item -ItemType Directory -Force -Path $tamlerFixtureBuild,$tamlerFixturePlugin | Out-Null
foreach ($tamlerName in @('fixture-pid.txt','fixture-await-second.txt','fixture-result.json','fixture-error.txt')) {
  $tamlerFile = Join-Path $tamlerFixtureBuild $tamlerName
  if (Test-Path -LiteralPath $tamlerFile) { Remove-Item -LiteralPath $tamlerFile }
}
Set-Content -LiteralPath (Join-Path $tamlerFixturePlugin 'plugin.json') -Encoding ASCII -Value '{"id":"native-fixture","css":"fixture.css"}'
Set-Content -LiteralPath (Join-Path $tamlerFixturePlugin 'fixture.css') -Encoding ASCII -Value ':root { --tamler-native-fixture: active; }'
& node scripts/bootstrap.cjs $tamlerFixtureRoot
if ($LASTEXITCODE -ne 0) { throw 'Fixture bootstrap generation failed' }
$tamlerFixtureDll = Join-Path $tamlerFixtureBuild 'tamler.dll'
$tamlerRefreshDll = Join-Path $tamlerFixtureBuild 'tamler-refresh.dll'
Copy-Item -LiteralPath 'build\tamler.dll' -Destination $tamlerFixtureDll -Force
Copy-Item -LiteralPath 'build\tamler.dll' -Destination $tamlerRefreshDll -Force
$tamlerArguments = ('"{0}\tests\electron-fixture.cjs" "--user-data-dir={1}\profile" "--tamler-fixture-root={1}" --double-inject' -f $tamlerRoot,$tamlerFixtureRoot)
$tamlerProcess = Start-Process -FilePath $tamlerElectron -ArgumentList $tamlerArguments -WindowStyle Hidden -PassThru -RedirectStandardOutput "$tamlerFixtureBuild\fixture-stdout.log" -RedirectStandardError "$tamlerFixtureBuild\fixture-stderr.log"
$tamlerProcess.Handle | Out-Null
function Wait-TamlerFile($Name) {
  $tamlerDeadline = (Get-Date).AddSeconds(10)
  $tamlerFile = Join-Path $tamlerFixtureBuild $Name
  while (-not (Test-Path -LiteralPath $tamlerFile)) {
    if ((Get-Date) -gt $tamlerDeadline -or $tamlerProcess.HasExited) { throw "Fixture failed waiting for $Name; check fixture-stderr.log" }
    Start-Sleep -Milliseconds 100
    $tamlerProcess.Refresh()
  }
  return Get-Content -LiteralPath $tamlerFile -Raw
}
try {
  $tamlerTargetId = (Wait-TamlerFile 'fixture-pid.txt').Trim()
  & .\build\tamler-inject.exe $tamlerTargetId $tamlerFixtureDll
  if ($LASTEXITCODE -ne 0) { throw 'First injection failed' }
  Wait-TamlerFile 'fixture-await-second.txt' | Out-Null
  & .\build\tamler-inject.exe $tamlerTargetId $tamlerRefreshDll
  if ($LASTEXITCODE -ne 0) { throw 'Refresh injection failed' }
  $tamlerResult = (Wait-TamlerFile 'fixture-result.json') | ConvertFrom-Json
  if (-not $tamlerResult.controlled) { throw 'Control pipe unavailable after upgrade' }
  foreach ($tamlerStage in 'initial','upgraded','reloaded') {
    $tamlerState = $tamlerResult.$tamlerStage
    if (-not $tamlerState.active -or -not $tamlerState.cssApplied -or $tamlerState.styles -ne 1) { throw "Runtime or plugin CSS missing at stage $tamlerStage" }
  }
  if ($tamlerResult.disposed.active -or $tamlerResult.disposed.cssApplied -or $tamlerResult.disposed.styles -ne 0) { throw 'Runtime or plugin CSS remained after disposal' }
  if (-not $tamlerProcess.WaitForExit(5000) -or $tamlerProcess.ExitCode -ne 0) { throw 'Fixture did not exit successfully' }
  $tamlerResult | ConvertTo-Json -Depth 5
} finally {
  $tamlerProcess.Refresh()
  if (-not $tamlerProcess.HasExited) { Stop-Process -Id $tamlerProcess.Id }
}
