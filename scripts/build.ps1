param([string]$Executable)
$ErrorActionPreference = 'Stop'
$tamlerRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $tamlerRoot
if (-not $Executable) {
  $tamlerInstall = Get-AppxPackage -Name Claude | Select-Object -First 1 -ExpandProperty InstallLocation
  if (-not $tamlerInstall) { throw 'Claude MSIX installation not found' }
  $Executable = Join-Path $tamlerInstall 'app\Claude.exe'
}
$Executable = (Resolve-Path -LiteralPath $Executable).Path
$tamlerVersion = (Get-Content -LiteralPath (Join-Path (Split-Path $Executable) 'version') -Raw).Trim()
if ($tamlerVersion -ne '44.4.3') { throw "This prototype only supports Electron 44.4.3; found $tamlerVersion" }
New-Item -ItemType Directory -Force -Path 'build','.cache\electron','.cache\minhook' | Out-Null
function Get-TamlerDownload($Url, $Target) {
  & curl.exe --fail --silent --show-error --location --max-time 60 $Url -o $Target
  if ($LASTEXITCODE -ne 0) { throw "Download failed: $Url" }
}
if (-not (Test-Path -LiteralPath '.cache\electron\node_headers\include\node\v8.h')) {
  Get-TamlerDownload "https://artifacts.electronjs.org/headers/dist/v$tamlerVersion/node-v$tamlerVersion-headers.tar.gz" '.cache\electron\headers.tar.gz'
  & tar -xzf '.cache\electron\headers.tar.gz' -C '.cache\electron'
  if ($LASTEXITCODE -ne 0) { throw 'Header extraction failed' }
}
if (-not (Test-Path -LiteralPath '.cache\minhook\include\MinHook.h')) {
  Get-TamlerDownload 'https://api.github.com/repos/TsudaKageyu/minhook/tarball/v1.3.4' '.cache\minhook\source.tar.gz'
  & tar -xzf '.cache\minhook\source.tar.gz' -C '.cache\minhook' --strip-components=1
  if ($LASTEXITCODE -ne 0) { throw 'MinHook extraction failed' }
}
$tamlerVsWhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$tamlerVs = & $tamlerVsWhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $tamlerVs) { throw 'Visual Studio C++ x64 build tools not found' }
$tamlerVcVars = Join-Path $tamlerVs 'VC\Auxiliary\Build\vcvars64.bat'
$tamlerReport = (& node scripts/inspect.cjs $Executable --def | Out-String) | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $tamlerReport.canBuildProbe) { throw 'Executable exports do not support this probe' }
& node scripts/bootstrap.cjs
if ($LASTEXITCODE -ne 0) { throw 'Bootstrap generation failed' }
$tamlerCommands = @"
@echo off
call "$tamlerVcVars" >nul
if errorlevel 1 exit /b 1
cd /d "$tamlerRoot\build"
lib /nologo /machine:x64 /def:node.def /out:node.lib
if errorlevel 1 exit /b 1
cl /nologo /O2 /MT /c /I"$tamlerRoot\.cache\minhook\include" "$tamlerRoot\.cache\minhook\src\buffer.c" "$tamlerRoot\.cache\minhook\src\hook.c" "$tamlerRoot\.cache\minhook\src\trampoline.c" "$tamlerRoot\.cache\minhook\src\hde\hde64.c"
if errorlevel 1 exit /b 1
cl /nologo /std:c++20 /Zc:__cplusplus /EHsc /O2 /MT /LD /DV8_COMPRESS_POINTERS /DV8_ENABLE_SANDBOX /DV8_31BIT_SMIS_ON_64BIT_ARCH /I"$tamlerRoot\.cache\electron\node_headers\include\node" /I"$tamlerRoot\.cache\minhook\include" "$tamlerRoot\native\loader.cpp" buffer.obj hook.obj trampoline.obj hde64.obj node.lib delayimp.lib /link /DELAYLOAD:node.exe /OUT:tamler.dll
if errorlevel 1 exit /b 1
cl /nologo /std:c++20 /EHsc /O2 /MT "$tamlerRoot\native\injector.cpp" /link /OUT:tamler-inject.exe
if errorlevel 1 exit /b 1
cl /nologo /std:c++20 /EHsc /O2 /MT "$tamlerRoot\native\tamler.cpp" user32.lib shell32.lib ole32.lib /link /SUBSYSTEM:WINDOWS /OUT:tamler.exe
if errorlevel 1 exit /b 1
"@
[IO.File]::WriteAllText((Join-Path $tamlerRoot 'build\compile.cmd'), $tamlerCommands, [Text.UTF8Encoding]::new($false))
& cmd.exe /d /c (Join-Path $tamlerRoot 'build\compile.cmd')
if ($LASTEXITCODE -ne 0) { throw 'Native build failed' }
$tamlerReport | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath 'build\target.json' -Encoding UTF8
& node scripts/compat.cjs
if ($LASTEXITCODE -ne 0) { throw 'Compatibility list generation failed' }
Write-Output 'Built build\tamler.dll, build\tamler-inject.exe and build\tamler.exe'
