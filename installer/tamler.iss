; Установщик Tamler для Windows. Собирается через scripts/package.ps1.
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef Source
  #define Source "..\dist\win"
#endif

[Setup]
AppId={{6F2C7A3E-3B8D-4E1F-9C55-7A1D2B4E8F10}
AppName=Tamler
AppVersion={#AppVersion}
AppPublisher=Tamler
DefaultDirName={localappdata}\Programs\Tamler
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputBaseFilename=TamlerSetup-{#AppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
; tamler.dll загружена в Claude: Restart Manager предложит закрыть Claude перед обновлением.
CloseApplications=yes
RestartApplications=no
UninstallDisplayName=Tamler
UninstallDisplayIcon={app}\tamler.exe

[Languages]
Name: "ru"; MessagesFile: "compiler:Languages\Russian.isl"
Name: "en"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "{#Source}\app\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs
; Примеры плагинов кладутся один раз и не перезаписывают изменения пользователя.
Source: "{#Source}\plugins\*"; DestDir: "{userappdata}\Tamler\plugins"; Flags: onlyifdoesntexist recursesubdirs uninsneveruninstall skipifsourcedoesntexist

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "Tamler"; ValueData: """{app}\tamler.exe"""; Flags: uninsdeletevalue

[Run]
Filename: "{app}\tamler.exe"; Flags: nowait

[UninstallRun]
Filename: "{app}\tamler.exe"; Parameters: "--quit"; Flags: runhidden waituntilterminated; RunOnceId: "StopWatcher"

[UninstallDelete]
Type: files; Name: "{app}\bootstrap.js"
Type: files; Name: "{app}\native.log"

[Code]
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  if FileExists(ExpandConstant('{app}\tamler.exe')) then
    Exec(ExpandConstant('{app}\tamler.exe'), '--quit', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := '';
end;

// Загруженную в Claude DLL нельзя удалить: просим закрыть Claude.
function InitializeUninstall(): Boolean;
var
  Dll: String;
begin
  Result := True;
  Dll := ExpandConstant('{app}\tamler.dll');
  while FileExists(Dll) and not RenameFile(Dll, Dll + '.check') do
    if MsgBox('Закройте Claude Desktop полностью (включая значок в трее) и нажмите OK.', mbInformation, MB_OKCANCEL) = IDCANCEL then
    begin
      Result := False;
      Exit;
    end;
  if FileExists(Dll + '.check') then RenameFile(Dll + '.check', Dll);
end;
