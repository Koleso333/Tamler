#pragma once
#include <windows.h>
#include <tlhelp32.h>
#include <filesystem>
#include <string>

inline uintptr_t FindModule(DWORD pid, const wchar_t* name) {
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid);
  if (snapshot == INVALID_HANDLE_VALUE) return 0;
  MODULEENTRY32W entry{sizeof(entry)};
  uintptr_t result = 0;
  if (Module32FirstW(snapshot, &entry)) {
    do {
      if (_wcsicmp(entry.szModule, name) == 0) { result = reinterpret_cast<uintptr_t>(entry.modBaseAddr); break; }
    } while (Module32NextW(snapshot, &entry));
  }
  CloseHandle(snapshot);
  return result;
}

inline std::wstring InjectFailure(const wchar_t* message) {
  return std::wstring(message) + L" (Windows error " + std::to_wstring(GetLastError()) + L")";
}

// Пустая строка — DLL загружена в целевой процесс; иначе текст ошибки.
inline std::wstring InjectDll(DWORD pid, std::filesystem::path dll) {
  dll = std::filesystem::absolute(dll);
  if (!std::filesystem::is_regular_file(dll)) return L"DLL not found";
  HANDLE process = OpenProcess(PROCESS_CREATE_THREAD | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_OPERATION | PROCESS_VM_WRITE | PROCESS_VM_READ, FALSE, pid);
  if (!process) return InjectFailure(L"Cannot open process");
  wchar_t executable[32768];
  DWORD length = 32768;
  if (!QueryFullProcessImageNameW(process, 0, executable, &length)) { auto error = InjectFailure(L"Cannot identify target"); CloseHandle(process); return error; }
  auto name = std::filesystem::path(executable).filename().wstring();
  if (_wcsicmp(name.c_str(), L"Claude.exe") && _wcsicmp(name.c_str(), L"electron.exe")) { CloseHandle(process); return L"Target must be Claude.exe or electron.exe"; }
  USHORT machine, nativeMachine;
  if (!IsWow64Process2(process, &machine, &nativeMachine) || machine != IMAGE_FILE_MACHINE_UNKNOWN || nativeMachine != IMAGE_FILE_MACHINE_AMD64) {
    CloseHandle(process); return L"Only native x64 targets are supported";
  }
  if (FindModule(pid, dll.filename().c_str())) { CloseHandle(process); return L"Tamler is already loaded; restart the target to rebuild its native loader"; }
  auto loadLibrary = GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "LoadLibraryW");
  HMODULE owner;
  wchar_t ownerPath[32768];
  if (!loadLibrary || !GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT, reinterpret_cast<LPCWSTR>(loadLibrary), &owner) || !GetModuleFileNameW(owner, ownerPath, 32768)) {
    auto error = InjectFailure(L"Cannot locate loader"); CloseHandle(process); return error;
  }
  auto remoteBase = FindModule(pid, std::filesystem::path(ownerPath).filename().c_str());
  if (!remoteBase) { auto error = InjectFailure(L"Cannot locate target loader module"); CloseHandle(process); return error; }
  auto remoteLoader = remoteBase + reinterpret_cast<uintptr_t>(loadLibrary) - reinterpret_cast<uintptr_t>(owner);
  auto size = (dll.wstring().size() + 1) * sizeof(wchar_t);
  void* memory = VirtualAllocEx(process, nullptr, size, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
  if (!memory) { auto error = InjectFailure(L"Cannot allocate DLL path"); CloseHandle(process); return error; }
  SIZE_T written;
  if (!WriteProcessMemory(process, memory, dll.c_str(), size, &written) || written != size) {
    auto error = InjectFailure(L"Cannot write DLL path"); VirtualFreeEx(process, memory, 0, MEM_RELEASE); CloseHandle(process); return error;
  }
  HANDLE thread = CreateRemoteThread(process, nullptr, 0, reinterpret_cast<LPTHREAD_START_ROUTINE>(remoteLoader), memory, 0, nullptr);
  if (!thread) { auto error = InjectFailure(L"Cannot start DLL loader"); VirtualFreeEx(process, memory, 0, MEM_RELEASE); CloseHandle(process); return error; }
  DWORD wait = WaitForSingleObject(thread, 10000);
  if (wait == WAIT_OBJECT_0) VirtualFreeEx(process, memory, 0, MEM_RELEASE);
  CloseHandle(thread);
  CloseHandle(process);
  if (wait != WAIT_OBJECT_0) return L"DLL load timed out; remote path retained while thread may still use it";
  if (!FindModule(pid, dll.filename().c_str())) return InjectFailure(L"DLL was not loaded");
  return L"";
}
