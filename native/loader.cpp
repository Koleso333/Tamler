#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <tlhelp32.h>
#include <delayimp.h>
#include <node.h>
#include <uv.h>
#include <v8.h>
#include <MinHook.h>
#include <atomic>
#include <fstream>
#include <string>
#include <filesystem>

static HMODULE selfModule;
static std::filesystem::path directory;
static std::atomic<bool> queued{false};
static DWORD mainThreadId;
static std::string bootstrap;
static v8::Isolate* targetIsolate;
static v8::Global<v8::Context> targetContext;
static uv_async_t asyncHandle;
using Call = v8::MaybeLocal<v8::Value>(*)(v8::Function*, v8::Isolate*, v8::Local<v8::Context>, v8::Local<v8::Value>, int, v8::Local<v8::Value>*);
using LegacyCall = v8::MaybeLocal<v8::Value>(*)(v8::Function*, v8::Local<v8::Context>, v8::Local<v8::Value>, int, v8::Local<v8::Value>*);
static Call originalCall;
static LegacyCall originalLegacyCall;

static void Log(const std::string& message) {
  std::ofstream stream(directory / L"native.log", std::ios::app);
  stream << GetCurrentProcessId() << " " << message << "\n";
}

static FARPROC WINAPI DelayHook(unsigned event, PDelayLoadInfo info) {
  if (event == dliNotePreLoadLibrary && std::string(info->szDll) == "node.exe") {
    return reinterpret_cast<FARPROC>(GetModuleHandleW(nullptr));
  }
  return nullptr;
}

extern "C" const PfnDliHook __pfnDliNotifyHook2 = DelayHook;

static DWORD FindMainThread() {
  DWORD result = 0;
  ULONGLONG oldest = ~0ULL;
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
  if (snapshot == INVALID_HANDLE_VALUE) return 0;
  THREADENTRY32 entry{sizeof(entry)};
  if (Thread32First(snapshot, &entry)) {
    do {
      if (entry.th32OwnerProcessID != GetCurrentProcessId()) continue;
      HANDLE thread = OpenThread(THREAD_QUERY_LIMITED_INFORMATION, FALSE, entry.th32ThreadID);
      FILETIME creation, exit, kernel, user;
      if (thread && GetThreadTimes(thread, &creation, &exit, &kernel, &user)) {
        ULARGE_INTEGER time;
        time.LowPart = creation.dwLowDateTime;
        time.HighPart = creation.dwHighDateTime;
        if (time.QuadPart < oldest) { oldest = time.QuadPart; result = entry.th32ThreadID; }
      }
      if (thread) CloseHandle(thread);
    } while (Thread32Next(snapshot, &entry));
  }
  CloseHandle(snapshot);
  return result;
}

static void RunBootstrap(uv_async_t* handle) {
  v8::Isolate::Scope isolateScope(targetIsolate);
  v8::HandleScope handles(targetIsolate);
  auto context = targetContext.Get(targetIsolate);
  v8::Context::Scope contextScope(context);
  v8::TryCatch catcher(targetIsolate);
  auto environment = node::GetCurrentEnvironment(context);
  if (!environment) {
    Log("bootstrap-error: Node environment disappeared");
  } else {
    node::CallbackScope callbackScope(environment, context->Global(), {0, 0});
    v8::Local<v8::String> source;
    v8::Local<v8::Script> script;
    v8::Local<v8::Value> result;
    if (v8::String::NewFromUtf8(targetIsolate, bootstrap.c_str()).ToLocal(&source) &&
        v8::Script::Compile(context, source).ToLocal(&script) && script->Run(context).ToLocal(&result)) {
      Log("bootstrap-ready");
    } else {
      v8::String::Utf8Value error(targetIsolate, catcher.Exception());
      Log(std::string("bootstrap-error: ") + (*error ? *error : "unknown exception"));
    }
  }
  targetContext.Reset();
  uv_close(reinterpret_cast<uv_handle_t*>(handle), nullptr);
}

static void QueueBootstrap(v8::Isolate* isolate, v8::Local<v8::Context> context) {
  if (GetCurrentThreadId() != mainThreadId || queued.load() || context.IsEmpty()) return;
  if (!node::GetCurrentEnvironment(context)) return;
  auto loop = node::GetCurrentEventLoop(isolate);
  if (!loop || queued.exchange(true)) return;
  targetIsolate = isolate;
  targetContext.Reset(isolate, context);
  int status = uv_async_init(loop, &asyncHandle, RunBootstrap);
  if (status != 0) {
    targetContext.Reset();
    Log("async-init-error: " + std::to_string(status));
    return;
  }
  uv_unref(reinterpret_cast<uv_handle_t*>(&asyncHandle));
  status = uv_async_send(&asyncHandle);
  Log("bootstrap-queued: " + std::to_string(status));
}

static v8::MaybeLocal<v8::Value> HookCall(v8::Function* function, v8::Isolate* isolate,
    v8::Local<v8::Context> context, v8::Local<v8::Value> receiver, int argc, v8::Local<v8::Value>* argv) {
  QueueBootstrap(isolate, context);
  return originalCall(function, isolate, context, receiver, argc, argv);
}

static v8::MaybeLocal<v8::Value> HookLegacyCall(v8::Function* function,
    v8::Local<v8::Context> context, v8::Local<v8::Value> receiver, int argc, v8::Local<v8::Value>* argv) {
  QueueBootstrap(v8::Isolate::GetCurrent(), context);
  return originalLegacyCall(function, context, receiver, argc, argv);
}

static DWORD WINAPI Initialize(void*) {
  wchar_t filename[32768];
  if (!GetModuleFileNameW(selfModule, filename, 32768)) return 1;
  directory = std::filesystem::path(filename).parent_path();
  std::ifstream source(directory / L"bootstrap.js", std::ios::binary);
  bootstrap.assign(std::istreambuf_iterator<char>(source), {});
  if (bootstrap.empty()) { Log("bootstrap.js missing or empty"); return 1; }
  mainThreadId = FindMainThread();
  if (!mainThreadId) { Log("main thread not found"); return 1; }
  auto module = GetModuleHandleW(nullptr);
  auto modern = GetProcAddress(module, "?Call@Function@v8@@QEAA?AV?$MaybeLocal@VValue@v8@@@2@PEAVIsolate@2@V?$Local@VContext@v8@@@2@V?$Local@VValue@v8@@@2@HQEAV62@@Z");
  auto legacy = GetProcAddress(module, "?Call@Function@v8@@QEAA?AV?$MaybeLocal@VValue@v8@@@2@V?$Local@VContext@v8@@@2@V?$Local@VValue@v8@@@2@HQEAV52@@Z");
  if (!modern && !legacy) { Log("unsupported V8 Call exports"); return 1; }
  if (MH_Initialize() != MH_OK) { Log("hook initialization failed"); return 1; }
  if (modern && MH_CreateHook(reinterpret_cast<void*>(modern), reinterpret_cast<void*>(HookCall), reinterpret_cast<void**>(&originalCall)) != MH_OK) {
    Log("modern hook creation failed"); return 1;
  }
  if (legacy && MH_CreateHook(reinterpret_cast<void*>(legacy), reinterpret_cast<void*>(HookLegacyCall), reinterpret_cast<void**>(&originalLegacyCall)) != MH_OK) {
    Log("legacy hook creation failed"); return 1;
  }
  auto status = MH_EnableHook(MH_ALL_HOOKS);
  Log("hooks-ready: " + std::to_string(status) + " main-thread=" + std::to_string(mainThreadId));
  return status == MH_OK ? 0 : 1;
}

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID) {
  if (reason == DLL_PROCESS_ATTACH) {
    selfModule = instance;
    DisableThreadLibraryCalls(instance);
    HANDLE thread = CreateThread(nullptr, 0, Initialize, nullptr, 0, nullptr);
    if (thread) CloseHandle(thread);
  }
  return TRUE;
}
