param([switch]$SkipBuild, [switch]$NoPlugins)
$ErrorActionPreference = 'Stop'
$tamlerRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $tamlerRoot
if (-not $SkipBuild) {
  & (Join-Path $PSScriptRoot 'build.ps1')
}
foreach ($tamlerFile in 'tamler.exe', 'tamler.dll', 'compat.txt') {
  if (-not (Test-Path -LiteralPath "build\$tamlerFile")) { throw "build\$tamlerFile missing; run without -SkipBuild" }
}
$tamlerIscc = foreach ($tamlerBase in "$env:LOCALAPPDATA\Programs", ${env:ProgramFiles(x86)}, $env:ProgramFiles) { foreach ($tamlerInno in 'Inno Setup 7', 'Inno Setup 6') { "$tamlerBase\$tamlerInno\ISCC.exe" } }
$tamlerIscc = $tamlerIscc | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $tamlerIscc) { throw 'Inno Setup not found: https://jrsoftware.org/isdl.php' }
$tamlerStage = Join-Path $tamlerRoot 'dist\win'
if (Test-Path -LiteralPath $tamlerStage) { Remove-Item -LiteralPath $tamlerStage -Recurse -Force }
New-Item -ItemType Directory -Force -Path "$tamlerStage\app\runtime", "$tamlerStage\plugins" | Out-Null
Copy-Item -LiteralPath 'build\tamler.exe', 'build\tamler.dll', 'build\compat.txt' -Destination "$tamlerStage\app"
Copy-Item -Path 'runtime\main.cjs', 'runtime\renderer.cjs', 'runtime\manager.cjs', 'runtime\store.cjs' -Destination "$tamlerStage\app\runtime"
if (-not $NoPlugins) { Get-ChildItem -LiteralPath 'plugins' -Directory | Where-Object Name -notlike 'zz-*' | Copy-Item -Destination "$tamlerStage\plugins" -Recurse }
$tamlerVersion = (Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json).version
$tamlerName = if ($NoPlugins) { "TamlerSetup-$tamlerVersion-noplugins" } else { "TamlerSetup-$tamlerVersion" }
& $tamlerIscc /Qp "/DAppVersion=$tamlerVersion" "/DSource=$tamlerStage" "/O$tamlerRoot\dist" "/F$tamlerName" 'installer\tamler.iss'
if ($LASTEXITCODE -ne 0) { throw 'Installer build failed' }
Write-Output "Built dist\$tamlerName.exe"
