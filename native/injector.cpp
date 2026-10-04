#include "inject.h"
#include <iostream>

int wmain(int argc, wchar_t** argv) {
  if (argc != 3) { std::wcerr << L"Usage: tamler-inject.exe PID DLL\n"; return 1; }
  wchar_t* end;
  DWORD pid = wcstoul(argv[1], &end, 10);
  if (!pid || *end) { std::wcerr << L"Invalid PID\n"; return 1; }
  auto error = InjectDll(pid, argv[2]);
  if (!error.empty()) { std::wcerr << error << L"\n"; return 1; }
  std::wcout << L"DLL loaded in PID " << pid << L"; check native.log and runtime.jsonl for bootstrap status\n";
  return 0;
}
