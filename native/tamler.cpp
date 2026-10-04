// Фоновый помощник установленного Tamler: находит главный процесс Claude Desktop и подключает к нему tamler.dll.
// Программа лежит в папке установки, плагины и данные — в %APPDATA%\Tamler.
#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include "inject.h"
#include <shellapi.h>
#include <shlobj.h>
#include <winternl.h>
#include <fstream>
#include <map>
#include <set>
#include <sstream>
#include <vector>

namespace fs = std::filesystem;

static fs::path appDirectory;
static fs::path homeDirectory;

struct Compatibility {
  std::string electron;
  std::vector<std::string> callExports;
  std::vector<std::string> required;
};

struct Target {
  DWORD pid;
  ULONGLONG created;
  fs::path executable;
};

static std::string Utf8(const std::wstring& value) {
  if (value.empty()) return {};
  int size = WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  std::string result(size, '\0');
  WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), result.data(), size, nullptr, nullptr);
  return result;
}

static std::string Json(const std::string& value) {
  std::string result = "\"";
  for (unsigned char c : value) {
    if (c == '"' || c == '\\') { result += '\\'; result += static_cast<char>(c); }
    else if (c < 0x20) { char buffer[8]; sprintf_s(buffer, "\\u%04x", c); result += buffer; }
    else result += static_cast<char>(c);
  }
  return result + "\"";
}

static std::string Json(const fs::path& value) { return Json(Utf8(value.wstring())); }

static std::string Now() {
  SYSTEMTIME time;
  GetSystemTime(&time);
  char buffer[32];
  sprintf_s(buffer, "%04u-%02u-%02uT%02u:%02u:%02u.%03uZ", time.wYear, time.wMonth, time.wDay, time.wHour, time.wMinute, time.wSecond, time.wMilliseconds);
  return buffer;
}

static void WriteStatus(const std::string& state, const std::string& fields = {}) {
  auto target = homeDirectory / L"data" / L"watcher-status.json";
  auto temporary = target;
  temporary += L".tmp";
  {
    std::ofstream stream(temporary, std::ios::binary | std::ios::trunc);
    stream << "{\"state\":" << Json(state) << fields << ",\"watcherPid\":" << GetCurrentProcessId() << ",\"time\":" << Json(Now()) << "}\n";
  }
  MoveFileExW(temporary.c_str(), target.c_str(), MOVEFILE_REPLACE_EXISTING);
}

// Тот же код, что генерирует scripts/bootstrap.cjs, но с путями установки.
static bool WriteBootstrap() {
  auto entry = appDirectory / L"runtime" / L"main.cjs";
  std::ofstream stream(appDirectory / L"bootstrap.js", std::ios::binary | std::ios::trunc);
  stream << "(async () => {\n"
            "  if (process.type !== 'browser') throw new Error('Tamler requires the Electron main process');\n"
            "  const module = process.getBuiltinModule('module');\n"
            "  const require = module.createRequire(process.execPath);\n"
            "  await globalThis.__tamlerMain?.dispose();\n"
            "  delete require.cache[require.resolve(" << Json(entry) << ")];\n"
            "  require(" << Json(entry) << ").start(require('electron'), " << Json(homeDirectory) << ");\n"
            "})().catch(error => {\n"
            "  process.getBuiltinModule('fs').appendFileSync(" << Json(appDirectory / L"native.log") << ", process.pid + ' async-bootstrap-error: ' + error.stack + '\\n');\n"
            "})";
  return stream.good();
}

// compat.txt пишет scripts/compat.cjs при сборке: версия Electron, экспорты V8 Function::Call и все импорты DLL из node.exe.
static bool LoadCompatibility(Compatibility& compatibility) {
  std::ifstream stream(appDirectory / L"compat.txt");
  std::string line;
  while (std::getline(stream, line)) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    auto space = line.find(' ');
    if (space == std::string::npos) continue;
    auto key = line.substr(0, space), value = line.substr(space + 1);
    if (key == "electron") compatibility.electron = value;
    else if (key == "call") compatibility.callExports.push_back(value);
    else if (key == "need") compatibility.required.push_back(value);
  }
  return !compatibility.electron.empty() && !compatibility.required.empty();
}

static bool ReadExports(const fs::path& executable, WORD& machine, std::set<std::string>& exports) {
  HANDLE file = CreateFileW(executable.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, 0, nullptr);
  if (file == INVALID_HANDLE_VALUE) return false;
  HANDLE mapping = CreateFileMappingW(file, nullptr, PAGE_READONLY | SEC_IMAGE_NO_EXECUTE, 0, 0, nullptr);
  CloseHandle(file);
  if (!mapping) return false;
  auto base = static_cast<const BYTE*>(MapViewOfFile(mapping, FILE_MAP_READ, 0, 0, 0));
  CloseHandle(mapping);
  if (!base) return false;
  bool ok = false;
  auto dos = reinterpret_cast<const IMAGE_DOS_HEADER*>(base);
  if (dos->e_magic == IMAGE_DOS_SIGNATURE) {
    auto nt = reinterpret_cast<const IMAGE_NT_HEADERS64*>(base + dos->e_lfanew);
    machine = nt->FileHeader.Machine;
    if (nt->Signature == IMAGE_NT_SIGNATURE && nt->OptionalHeader.Magic == IMAGE_NT_OPTIONAL_HDR64_MAGIC) {
      auto directory = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_EXPORT];
      if (directory.VirtualAddress) {
        auto table = reinterpret_cast<const IMAGE_EXPORT_DIRECTORY*>(base + directory.VirtualAddress);
        auto names = reinterpret_cast<const DWORD*>(base + table->AddressOfNames);
        for (DWORD i = 0; i < table->NumberOfNames; i++) exports.insert(reinterpret_cast<const char*>(base + names[i]));
      }
      ok = true;
    }
  }
  UnmapViewOfFile(base);
  return ok;
}

// Пустая строка — совместим, иначе причина отказа.
static std::string CheckCompatibility(const Compatibility& compatibility, const fs::path& executable) {
  std::ifstream versionFile(executable.parent_path() / L"version");
  std::string version;
  std::getline(versionFile, version);
  while (!version.empty() && isspace(static_cast<unsigned char>(version.back()))) version.pop_back();
  if (version != compatibility.electron) return "Unsupported Electron " + version + "; tested " + compatibility.electron;
  WORD machine = 0;
  std::set<std::string> exports;
  if (!ReadExports(executable, machine, exports)) return "Cannot read Claude.exe exports";
  if (machine != IMAGE_FILE_MACHINE_AMD64) return "Windows x64 required";
  bool call = compatibility.callExports.empty();
  for (auto& name : compatibility.callExports) call = call || exports.count(name);
  if (!call) return "No supported V8 Function::Call export";
  size_t missing = 0;
  for (auto& name : compatibility.required) missing += !exports.count(name);
  if (missing) return "Missing " + std::to_string(missing) + " native exports";
  return {};
}

static std::wstring CommandLineOf(HANDLE process) {
  using Query = NTSTATUS(NTAPI*)(HANDLE, PROCESSINFOCLASS, PVOID, ULONG, PULONG);
  static auto query = reinterpret_cast<Query>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryInformationProcess"));
  if (!query) return {};
  ULONG size = 0;
  query(process, static_cast<PROCESSINFOCLASS>(60), nullptr, 0, &size);
  if (!size) return {};
  std::vector<BYTE> buffer(size);
  if (query(process, static_cast<PROCESSINFOCLASS>(60), buffer.data(), size, &size) < 0) return {};
  auto text = reinterpret_cast<UNICODE_STRING*>(buffer.data());
  return std::wstring(text->Buffer, text->Length / sizeof(wchar_t));
}

static bool EndsWith(const std::wstring& value, const std::wstring& suffix) {
  return value.size() >= suffix.size() && _wcsicmp(value.c_str() + value.size() - suffix.size(), suffix.c_str()) == 0;
}

static bool Contains(std::wstring value, std::wstring part) {
  CharLowerBuffW(value.data(), static_cast<DWORD>(value.size()));
  CharLowerBuffW(part.data(), static_cast<DWORD>(part.size()));
  return value.find(part) != std::wstring::npos;
}

// Главный процесс MSIX-версии Claude Desktop, без дочерних renderer/gpu (у них есть --type=).
static std::vector<Target> FindClaude() {
  std::vector<Target> result;
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE) return result;
  PROCESSENTRY32W entry{sizeof(entry)};
  if (Process32FirstW(snapshot, &entry)) {
    do {
      if (_wcsicmp(entry.szExeFile, L"Claude.exe")) continue;
      HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, entry.th32ProcessID);
      if (!process) continue;
      wchar_t path[32768];
      DWORD length = 32768;
      FILETIME creation, exit, kernel, user;
      if (QueryFullProcessImageNameW(process, 0, path, &length) && Contains(path, L"\\WindowsApps\\") && EndsWith(path, L"\\app\\Claude.exe") &&
          GetProcessTimes(process, &creation, &exit, &kernel, &user)) {
        auto command = CommandLineOf(process);
        if (!command.empty() && command.find(L"--type=") == std::wstring::npos) {
          result.push_back({entry.th32ProcessID, (static_cast<ULONGLONG>(creation.dwHighDateTime) << 32) | creation.dwLowDateTime, path});
        }
      }
      CloseHandle(process);
    } while (Process32NextW(snapshot, &entry));
  }
  CloseHandle(snapshot);
  return result;
}

static bool PipeExists(DWORD pid) {
  auto name = L"\\\\.\\pipe\\tamler-" + std::to_wstring(pid);
  return WaitNamedPipeW(name.c_str(), 1) || GetLastError() == ERROR_SEM_TIMEOUT;
}

static void Attach(const Compatibility& compatibility, std::map<std::wstring, std::string>& compatible, const Target& target) {
  auto pidField = ",\"pid\":" + std::to_string(target.pid);
  auto key = target.executable.wstring();
  if (!compatible.count(key)) compatible[key] = CheckCompatibility(compatibility, target.executable);
  if (!compatible[key].empty()) { WriteStatus("incompatible", pidField + ",\"reason\":" + Json(compatible[key])); return; }
  if (!PipeExists(target.pid)) {
    if (FindModule(target.pid, L"tamler.dll")) { WriteStatus("error", pidField + ",\"reason\":\"Tamler loader already present without a control pipe; restart Claude to reconnect\""); return; }
    auto error = InjectDll(target.pid, appDirectory / L"tamler.dll");
    if (!error.empty()) { WriteStatus("error", pidField + ",\"reason\":" + Json(Utf8(error))); return; }
    bool ready = false;
    for (int i = 0; i < 60 && !ready; i++) { Sleep(250); ready = PipeExists(target.pid); }
    if (!ready) { WriteStatus("error", pidField + ",\"reason\":\"DLL loaded, but JS bootstrap was not confirmed; see native.log\""); return; }
  }
  WriteStatus("attached", pidField + ",\"executable\":" + Json(target.executable));
}

static int Watch() {
  HANDLE mutex = CreateMutexW(nullptr, TRUE, L"Local\\Tamler-Watcher");
  if (!mutex || GetLastError() == ERROR_ALREADY_EXISTS) return 0;
  HANDLE quit = CreateEventW(nullptr, TRUE, FALSE, L"Local\\Tamler-Quit");
  ResetEvent(quit);
  fs::create_directories(homeDirectory / L"plugins");
  fs::create_directories(homeDirectory / L"data");
  Compatibility compatibility;
  if (!LoadCompatibility(compatibility)) { WriteStatus("error", ",\"reason\":\"compat.txt missing or invalid\""); return 1; }
  if (!WriteBootstrap()) { WriteStatus("error", ",\"reason\":\"Cannot write bootstrap.js\""); return 1; }
  WriteStatus("watching");
  std::set<std::pair<DWORD, ULONGLONG>> seen;
  std::map<std::wstring, std::string> compatible;
  bool hadTargets = false;
  do {
    auto targets = FindClaude();
    if (hadTargets && targets.empty()) WriteStatus("watching");
    hadTargets = !targets.empty();
    std::set<std::pair<DWORD, ULONGLONG>> current;
    for (auto& target : targets) {
      current.insert({target.pid, target.created});
      if (seen.insert({target.pid, target.created}).second) Attach(compatibility, compatible, target);
    }
    for (auto it = seen.begin(); it != seen.end();) it = current.count(*it) ? std::next(it) : seen.erase(it);
  } while (WaitForSingleObject(quit, 3000) == WAIT_TIMEOUT);
  ReleaseMutex(mutex);
  return 0;
}

// Останавливает запущенный помощник и ждёт его выхода: нужно установщику перед заменой файлов.
static int Quit() {
  HANDLE quit = OpenEventW(EVENT_MODIFY_STATE, FALSE, L"Local\\Tamler-Quit");
  if (!quit) return 0;
  SetEvent(quit);
  CloseHandle(quit);
  for (int i = 0; i < 100; i++) {
    HANDLE mutex = OpenMutexW(SYNCHRONIZE, FALSE, L"Local\\Tamler-Watcher");
    if (!mutex) return 0;
    CloseHandle(mutex);
    Sleep(100);
  }
  return 1;
}

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
  int argc;
  auto argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  wchar_t self[32768];
  GetModuleFileNameW(nullptr, self, 32768);
  appDirectory = fs::path(self).parent_path();
  PWSTR roaming;
  if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_RoamingAppData, 0, nullptr, &roaming))) { homeDirectory = fs::path(roaming) / L"Tamler"; CoTaskMemFree(roaming); }
  bool quit = false;
  for (int i = 1; i < argc; i++) {
    if (!wcscmp(argv[i], L"--quit")) quit = true;
    else if (!wcscmp(argv[i], L"--home") && i + 1 < argc) homeDirectory = argv[++i];
  }
  LocalFree(argv);
  if (quit) return Quit();
  if (homeDirectory.empty()) return 1;
  return Watch();
}
