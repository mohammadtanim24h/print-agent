// Win32 spooler RAW N-API addon (ADR-4). Surface:
//   printerExists(name) -> boolean        (OpenPrinterW/ClosePrinter probe)
//   writeRaw(name, buffer) -> Promise     (ONE RAW-datatype spooler job; AsyncWorker)
//   enumeratePrinters() -> string[]       (EnumPrintersW level 4, capped)
// Success of writeRaw = Windows accepted (spooled) the job — never "printed"
// (api-contract §3.1 wording is normative; driver buffering = R-VAL-4).
#include <napi.h>

#if defined(_WIN32)

#include <windows.h>
#include <winspool.h>

#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

namespace {

constexpr DWORD kMaxEnumerate = 128;
constexpr DWORD kChunkBytes = 64 * 1024;

std::string Utf8FromWide(const std::wstring& wide) {
  if (wide.empty()) return {};
  const int size = WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), static_cast<int>(wide.size()),
                                       nullptr, 0, nullptr, nullptr);
  std::string out(static_cast<size_t>(size), '\0');
  WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), static_cast<int>(wide.size()), out.data(), size,
                      nullptr, nullptr);
  return out;
}

std::wstring WideFromUtf8(const std::string& utf8) {
  if (utf8.empty()) return {};
  const int size =
      MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), static_cast<int>(utf8.size()), nullptr, 0);
  std::wstring out(static_cast<size_t>(size), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), static_cast<int>(utf8.size()), out.data(), size);
  return out;
}

std::string LastWinError(const char* api) {
  const DWORD err = GetLastError();
  char buf[160];
  std::snprintf(buf, sizeof(buf), "%s failed (Windows error %lu)", api,
                static_cast<unsigned long>(err));
  return std::string(buf);
}

// Spools one RAW job off the main thread. Any winspool failure surfaces as a
// rejected promise carrying the Windows error text.
class WriteRawWorker : public Napi::AsyncWorker {
 public:
  WriteRawWorker(Napi::Env env, std::wstring printer, std::vector<uint8_t> bytes)
      : Napi::AsyncWorker(env),
        printer_(std::move(printer)),
        bytes_(std::move(bytes)),
        deferred_(Napi::Promise::Deferred::New(env)) {}

  Napi::Promise Promise() { return deferred_.Promise(); }

  void Execute() override {
    HANDLE printer = nullptr;
    if (!OpenPrinterW(const_cast<LPWSTR>(printer_.c_str()), &printer, nullptr)) {
      SetError(LastWinError("OpenPrinterW"));
      return;
    }
    DOC_INFO_1W doc = {};
    doc.pDocName = const_cast<LPWSTR>(L"Print Agent job");
    doc.pDatatype = const_cast<LPWSTR>(L"RAW");
    doc.pOutputFile = nullptr;
    if (!StartDocPrinterW(printer, 1, reinterpret_cast<LPBYTE>(&doc))) {
      FailWith(LastWinError("StartDocPrinterW"), printer);
      return;
    }
    size_t offset = 0;
    while (offset < bytes_.size()) {
      const size_t remaining = bytes_.size() - offset;
      const DWORD chunk = static_cast<DWORD>(remaining < kChunkBytes ? remaining : kChunkBytes);
      DWORD written = 0;
      if (!WritePrinter(printer, bytes_.data() + offset, chunk, &written)) {
        FailWith(LastWinError("WritePrinter"), printer);
        return;
      }
      offset += written;
    }
    if (!EndDocPrinter(printer)) {
      FailWith(LastWinError("EndDocPrinter"), printer);
      return;
    }
    ClosePrinter(printer);
  }

  void OnOK() override { deferred_.Resolve(Env().Undefined()); }
  void OnError(const Napi::Error& error) override { deferred_.Reject(error.Value()); }

 private:
  // Best-effort job teardown after a mid-job failure; the original error wins.
  void FailWith(const std::string& message, HANDLE printer) {
    EndDocPrinter(printer);
    ClosePrinter(printer);
    SetError(message);
  }

  std::wstring printer_;
  std::vector<uint8_t> bytes_;
  Napi::Promise::Deferred deferred_;
};

Napi::Value PrinterExists(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "printerExists(name: string)").ThrowAsJavaScriptException();
    return env.Null();
  }
  const std::wstring name = WideFromUtf8(info[0].As<Napi::String>().Utf8Value());
  HANDLE handle = nullptr;
  if (!OpenPrinterW(const_cast<LPWSTR>(name.c_str()), &handle, nullptr)) {
    return Napi::Boolean::New(env, false);  // not installed / not accessible by name
  }
  ClosePrinter(handle);
  return Napi::Boolean::New(env, true);
}

Napi::Value WriteRaw(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsString() || !info[1].IsBuffer()) {
    Napi::TypeError::New(env, "writeRaw(name: string, bytes: Buffer)")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  const Napi::Buffer<uint8_t> buffer = info[1].As<Napi::Buffer<uint8_t>>();
  auto* worker = new WriteRawWorker(
      env, WideFromUtf8(info[0].As<Napi::String>().Utf8Value()),
      std::vector<uint8_t>(buffer.Data(), buffer.Data() + buffer.Length()));
  worker->Queue();
  return worker->Promise();
}

Napi::Value EnumeratePrinters(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  // Level 4 = names only (no driver query): lightweight, safe mid-print.
  DWORD needed = 0;
  DWORD count = 0;
  const DWORD flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
  EnumPrintersW(flags, nullptr, 4, nullptr, 0, &needed, &count);
  std::vector<BYTE> buffer(needed);
  if (!EnumPrintersW(flags, nullptr, 4, buffer.data(), needed, &needed, &count)) {
    Napi::Error::New(env, LastWinError("EnumPrintersW")).ThrowAsJavaScriptException();
    return env.Null();
  }
  const auto* printers = reinterpret_cast<const PRINTER_INFO_4W*>(buffer.data());
  const DWORD bounded = count < kMaxEnumerate ? count : kMaxEnumerate;
  Napi::Array out = Napi::Array::New(env, bounded);
  for (DWORD i = 0; i < bounded; i++) {
    out.Set(i, Napi::String::New(env, Utf8FromWide(printers[i].pPrinterName == nullptr
                                                       ? L""
                                                       : printers[i].pPrinterName)));
  }
  return out;
}

// NODE_API_MODULE's RegisterModule overload requires the exact Napi::Object
// return type (function-pointer return types don't implicitly convert).
Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("printerExists", Napi::Function::New(env, PrinterExists));
  exports.Set("writeRaw", Napi::Function::New(env, WriteRaw));
  exports.Set("enumeratePrinters", Napi::Function::New(env, EnumeratePrinters));
  return exports;
}

}  // namespace

NODE_API_MODULE(spooler_raw, Init)

#else  // non-Windows: the agent is Windows-only; fail loudly instead of linking.

namespace {
Napi::Value Unsupported(const Napi::CallbackInfo& info) {
  Napi::Error::New(info.Env(), "print-agent-spooler-raw requires Windows")
      .ThrowAsJavaScriptException();
  return info.Env().Null();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("printerExists", Napi::Function::New(env, Unsupported));
  exports.Set("writeRaw", Napi::Function::New(env, Unsupported));
  exports.Set("enumeratePrinters", Napi::Function::New(env, Unsupported));
  return exports;
}
}  // namespace

NODE_API_MODULE(spooler_raw, Init)

#endif
