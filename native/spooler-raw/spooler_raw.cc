// Win32 spooler RAW N-API addon (ADR-4). Surface:
//   printerExists(name) -> boolean        (OpenPrinterW probe: false only for a
//                                         genuinely unknown printer; any other
//                                         OpenPrinterW failure throws)
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
    // Mid-job failure deletes the spooler job (SetJob JOB_CONTROL_DELETE) — a
    // partial document never reaches the port. Downstream driver buffering
    // remains the R-VAL-4 risk. StartDocPrinterW's return value IS the job id,
    // captured so AbortJob can remove a half-written job from the queue
    // (EndDocPrinter would instead FINALIZE and dispatch the truncated job).
    const DWORD job_id = StartDocPrinterW(printer, 1, reinterpret_cast<LPBYTE>(&doc));
    if (job_id == 0) {
      // No document is open — closing the handle is the whole teardown.
      ClosePrinter(printer);
      SetError(LastWinError("StartDocPrinterW"));
      return;
    }
    size_t offset = 0;
    while (offset < bytes_.size()) {
      const size_t remaining = bytes_.size() - offset;
      const DWORD chunk = static_cast<DWORD>(remaining < kChunkBytes ? remaining : kChunkBytes);
      DWORD written = 0;
      if (!WritePrinter(printer, bytes_.data() + offset, chunk, &written)) {
        AbortJob(printer, job_id, LastWinError("WritePrinter"));
        return;
      }
      if (written == 0) {
        // TRUE + 0 bytes would otherwise spin forever on `offset += 0`.
        AbortJob(printer, job_id, "WritePrinter wrote 0 bytes");
        return;
      }
      offset += written;
    }
    if (!EndDocPrinter(printer)) {
      AbortJob(printer, job_id, LastWinError("EndDocPrinter"));
      return;
    }
    ClosePrinter(printer);
  }

  void OnOK() override { deferred_.Resolve(Env().Undefined()); }
  void OnError(const Napi::Error& error) override { deferred_.Reject(error.Value()); }

 private:
  // Best-effort abort after a mid-job failure; the original error wins. The
  // delete removes the partial job from the queue — never call EndDocPrinter
  // here, it would finalize (and dispatch) the truncated document.
  void AbortJob(HANDLE printer, DWORD job_id, const std::string& message) {
    SetJob(printer, job_id, 0, nullptr, JOB_CONTROL_DELETE);
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
    const DWORD err = GetLastError();
    // false means "genuinely no such printer" (downstream maps it to
    // printer_not_found). Anything else — access denied, spooler stopped — is
    // NOT a missing printer, so surface it as a JS error instead.
    if (err == ERROR_FILE_NOT_FOUND || err == ERROR_INVALID_PRINTER_NAME) {
      return Napi::Boolean::New(env, false);
    }
    Napi::Error::New(env, LastWinError("OpenPrinterW")).ThrowAsJavaScriptException();
    return env.Null();
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
  if (needed == 0) {
    // Sizing call reported nothing to enumerate — a second call with cbBuf 0
    // is pointless (and on some spooler states fails spuriously).
    return Napi::Array::New(env, 0);
  }
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
