# A2 — Spooler RAW Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `spooler_raw` transport (ADR-4/P7): an own N-API Win32 spooler shim, a `PrinterTransport` adapter over it, schema/registry/config-apply support, local UI support, file-port capture evidence, and doc updates.

**Architecture:** A new local npm package `native/spooler-raw/` (C++ via node-addon-api, node-gyp) exposes `printerExists` / `writeRaw` (AsyncWorker, one RAW spooler job per call) / `enumeratePrinters`. A thin TS adapter maps it to the injected `SpoolerBridge` interface; `createSpoolerRawTransport` implements `PrinterTransport` over the bridge. The registry, profile schema, config-apply mapper, runtime (`systemPrinters()`), IPC channel, and Printers screen all widen to the second endpoint kind.

**Tech Stack:** node-addon-api + node-gyp (N-API, ABI-stable), TypeScript strict, zod strict schemas, vitest, electron-vite/rolldown (externals), electron-builder (asarUnpack), PowerShell (capture-printer setup).

**Spec:** `docs/superpowers/specs/2026-10-29-spooler-transport-design.md`

**Reference behavior:** `src/main/transport/tcp-raw.ts` is the model transport — serialized writes, idempotent open/close, `TransportError` classification. Mirror its conventions.

**Conventions to respect (CLAUDE.md):** strict TS, no `any` at boundaries, injected dependencies (no ambient singletons), typed errors with stable machine codes, docs updated in the same change, comments only where non-obvious. Commit after every task (atomic commits are the norm here — no need to ask).

---

### Task 1: Native addon package `native/spooler-raw/`

**Files:**
- Create: `native/spooler-raw/package.json`
- Create: `native/spooler-raw/binding.gyp`
- Create: `native/spooler-raw/spooler_raw.cc`
- Create: `native/spooler-raw/index.js`
- Create: `native/spooler-raw/index.d.ts`

This task is plain C++/JS node glue with no unit test (same convention as `settings-fs.ts` / `socket.ts` production adapters). It is verified by build + smoke in Task 2.

- [ ] **Step 1: Create `native/spooler-raw/package.json`**

```json
{
  "name": "print-agent-spooler-raw",
  "version": "0.1.0",
  "private": true,
  "license": "MIT",
  "description": "Win32 spooler RAW N-API addon (ADR-4) — internal to print-agent.",
  "main": "./index.js",
  "types": "./index.d.ts",
  "scripts": {
    "install": "node-gyp rebuild"
  },
  "dependencies": {
    "node-addon-api": "8.5.0"
  },
  "devDependencies": {
    "node-gyp": "11.3.0"
  }
}
```

- [ ] **Step 2: Create `native/spooler-raw/binding.gyp`**

```json
{
  "targets": [
    {
      "target_name": "spooler_raw",
      "sources": ["spooler_raw.cc"],
      "include_dirs": ["<!(node -p \"require('node-addon-api').include_dir\")"],
      "conditions": [
        [
          "OS=='win'",
          {
            "libraries": ["winspool.lib"],
            "msvs_settings": {
              "VCCLCompilerTool": { "ExceptionHandling": 1 }
            }
          }
        ]
      ]
    }
  ]
}
```

(`ExceptionHandling: 1` = `/EHsc`, required by node-addon-api's default C++-exception mode.)

- [ ] **Step 3: Create `native/spooler-raw/spooler_raw.cc`**

```cpp
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

Napi::Value Init(Napi::Env env, Napi::Object exports) {
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

Napi::Value Init(Napi::Env env, Napi::Object exports) {
  exports.Set("printerExists", Napi::Function::New(env, Unsupported));
  exports.Set("writeRaw", Napi::Function::New(env, Unsupported));
  exports.Set("enumeratePrinters", Napi::Function::New(env, Unsupported));
  return exports;
}
}  // namespace

NODE_API_MODULE(spooler_raw, Init)

#endif
```

- [ ] **Step 4: Create `native/spooler-raw/index.js`**

```js
'use strict';
// Lazy native loader: requiring this package does NOT dlopen the binary —
// the first bridge call does. tcp_raw-only installs never load it.
const { existsSync } = require('node:fs');
const path = require('node:path');

let binding = null;
function load() {
  if (binding !== null) return binding;
  const binaryPath = path.join(__dirname, 'build', 'Release', 'spooler_raw.node');
  if (!existsSync(binaryPath)) {
    throw new Error('print-agent-spooler-raw native addon is not built (run: pnpm install)');
  }
  binding = require(binaryPath);
  return binding;
}

module.exports = {
  printerExists: (name) => load().printerExists(name),
  writeRaw: (name, buffer) => load().writeRaw(name, buffer),
  enumeratePrinters: () => load().enumeratePrinters(),
};
```

- [ ] **Step 5: Create `native/spooler-raw/index.d.ts`**

```ts
/** Native addon surface (spooler_raw.cc). writeRaw rejects with a plain Error
 *  carrying the Windows failure text; classification happens in the TS adapter. */
export default interface NativeSpooler {
  printerExists(name: string): boolean;
  writeRaw(name: string, buffer: Uint8Array): Promise<void>;
  enumeratePrinters(): string[];
}
```

- [ ] **Step 6: Verify the files exist**

Run: `ls native/spooler-raw/`
Expected: `binding.gyp  index.d.ts  index.js  package.json  spooler_raw.cc`

(No commit yet — the package is committed together with the build wiring in Task 2 so the tree never holds an uninstallable `file:` dependency.)

---

### Task 2: Wire the addon into the workspace and build it

**Files:**
- Modify: `package.json` (dependencies + pnpm.onlyBuiltDependencies)
- Modify: `scripts/check-deps.mjs` (build allowlist + file: exact-pin carve-out)
- Modify: `tests/check-deps.test.ts`
- Modify: `eslint.config.js` (ignore `native/`)
- Modify: `.prettierignore` (ignore `native/`)
- Modify: `electron.vite.config.ts` (external)
- Modify: `electron-builder.yml` (asarUnpack)

- [ ] **Step 1: Update the dependency-admission gate tests first (TDD)**

In `tests/check-deps.test.ts`, update the build-allowlist test (currently expects exactly `['electron','esbuild']`) and add a file:-pin case. Replace the existing `buildAllowlistViolations` test block and add to the exact-pin describe (adapt names to what's there; the point is the assertions below):

```ts
  it('accepts the build allowlist including the local spooler addon', () => {
    expect(
      buildAllowlistViolations({
        onlyBuiltDependencies: ['electron', 'esbuild', 'print-agent-spooler-raw'],
      }),
    ).toEqual([]);
  });

  it('rejects better-sqlite3 in the build allowlist (tarball prebuilds make node-gyp unnecessary)', () => {
    expect(
      buildAllowlistViolations({
        onlyBuiltDependencies: ['electron', 'esbuild', 'print-agent-spooler-raw', 'better-sqlite3'],
      }),
    ).toHaveLength(1);
  });

  it('exempts file: workspace specs from the exact-pin rule', () => {
    const violations = exactPinViolations({
      dependencies: { 'print-agent-spooler-raw': 'file:./native/spooler-raw' },
    });
    expect(violations).toEqual([]);
  });
```

(Adjust imports at the top of the file to include `exactPinViolations` if not already imported. If the existing tests use a fixture `pkg` shape, keep it.)

Run: `pnpm test -- tests/check-deps.test.ts`
Expected: FAIL — the allowlist expectation in `check-deps.mjs` still lists two entries, and `exactPinViolations` flags the `file:` spec.

- [ ] **Step 2: Update `scripts/check-deps.mjs`**

```js
// The local spooler addon is built from source by design (ADR-4): its
// "install" script runs node-gyp. better-sqlite3 is still deliberately NOT
// here: its tarball ships prebuilds/ — allowing it would run node-gyp for
// nothing.
const BUILD_SCRIPT_ALLOWLIST = ['electron', 'esbuild', 'print-agent-spooler-raw'];
```

and in `exactPinViolations`, skip workspace links:

```js
      if (spec.startsWith('file:')) continue; // in-repo package, pinned by the lockfile
```

- [ ] **Step 3: Root `package.json`** — add the dependency and allowlist entry:

```json
  "dependencies": {
    "@napi-rs/canvas": "1.0.13",
    "better-sqlite3": "13.0.3",
    "electron-log": "5.4.4",
    "node-thermal-printer": "4.6.1",
    "print-agent-spooler-raw": "file:./native/spooler-raw",
    "react": "19.3.1",
    "react-dom": "19.3.1",
    "ws": "8.22.0",
    "zod": "4.6.7"
  },
```

```json
  "pnpm": {
    "onlyBuiltDependencies": [
      "electron",
      "esbuild",
      "print-agent-spooler-raw"
    ]
  }
```

- [ ] **Step 4: Ignore `native/` in ESLint and Prettier**

`eslint.config.js` ignores line becomes:

```js
  { ignores: ['out/', 'node_modules/', 'dist/', 'coverage/', 'native/', 'eslint.config.js', 'scripts/'] },
```

Append to `.prettierignore`:

```
native/
```

- [ ] **Step 5: Bundle/packaging wiring**

`electron.vite.config.ts` main externals:

```ts
      rolldownOptions: { external: ['electron', 'electron-log', 'better-sqlite3', 'print-agent-spooler-raw'] },
```

`electron-builder.yml` asarUnpack (add a second entry):

```yaml
asarUnpack:
  - '**/node_modules/better-sqlite3/**/*.node' # native module must live on disk
  - '**/node_modules/print-agent-spooler-raw/**/*.node' # same (ADR-4 spooler shim)
```

- [ ] **Step 6: Install and build the addon**

Run: `pnpm install`
Expected: pnpm runs the `print-agent-spooler-raw` install script (node-gyp rebuild) and succeeds. Requires the VS Build Tools (MSVC) and Python on the dev machine — both preinstalled on GitHub `windows-latest` runners.

- [ ] **Step 7: Smoke-test the addon directly**

Run: `node -e "const a=require('./native/spooler-raw'); console.log('printers:', a.enumeratePrinters().length); console.log('exists:', a.printerExists('NoSuchPrinter-xyz'));"`
Expected: prints `printers: <N ≥ 0>` (the count of printers installed on this machine) and `exists: false`, then exits 0.

- [ ] **Step 8: Run the full gate**

Run: `pnpm test && pnpm lint && pnpm typecheck`
Expected: all green (check-deps tests now pass).

- [ ] **Step 9: Commit**

```bash
git add native/ package.json pnpm-lock.yaml scripts/check-deps.mjs tests/check-deps.test.ts eslint.config.js .prettierignore electron.vite.config.ts electron-builder.yml
git commit -m "feat(native): spooler RAW N-API addon (ADR-4) + workspace/packaging wiring"
```

Note: `native/spooler-raw/build/` must NOT be committed — check whether a root `.gitignore` covers it (`git status` after the commit). If `build/` shows as untracked noise, add `native/spooler-raw/build/` to `.gitignore` in the same commit.

---

### Task 3: Error code + bridge interface + native adapter

**Files:**
- Modify: `src/main/transport/errors.ts` (add `printer_not_found`)
- Create: `src/main/transport/spooler-native.ts` (production bridge; node glue)
- Test: `tests/spooler-native.test.ts`

- [ ] **Step 1: Add the new machine code to `errors.ts`**

```ts
export type TransportErrorCode =
  | 'connect_refused'
  | 'connect_timeout'
  | 'host_unreachable'
  | 'dns_unsupported'
  | /** spooler_raw only: OpenPrinterW found no such printer on this machine. */ 'printer_not_found'
  | 'write_timeout'
  | 'write_failed'
  | 'disconnected'
  | 'not_open';
```

This is a documented, contract-visible addition per `docs/transport-adapters.md` checklist step 2 (the doc itself is updated in Task 12).

- [ ] **Step 2: Write the failing adapter test `tests/spooler-native.test.ts`**

```ts
import { describe, expect, it, vi } from 'vitest';
import { createNativeSpoolerBridge } from '../src/main/transport/spooler-native';

function stubNative(overrides: Record<string, unknown> = {}) {
  return {
    printerExists: vi.fn(() => true),
    writeRaw: vi.fn(() => Promise.resolve()),
    enumeratePrinters: vi.fn(() => ['EPSON TM-T20']),
    ...overrides,
  } as never; // narrow native surface; the adapter sees only these three
}

describe('native spooler bridge adapter', () => {
  it('passes enumerate through', async () => {
    const bridge = createNativeSpoolerBridge(() => stubNative());
    await expect(bridge.enumerate()).resolves.toEqual(['EPSON TM-T20']);
  });

  it('passes a successful writeRaw through', async () => {
    const native = stubNative();
    const bridge = createNativeSpoolerBridge(() => native);
    const bytes = new Uint8Array([0x1b, 0x40]);
    await expect(bridge.writeRaw('EPSON TM-T20', bytes)).resolves.toBeUndefined();
    expect(native.writeRaw).toHaveBeenCalledWith('EPSON TM-T20', bytes);
  });

  it('maps a native write failure to write_failed with the Windows message', async () => {
    const native = stubNative({
      writeRaw: vi.fn(() => Promise.reject(new Error('StartDocPrinterW failed (Windows error 1802)'))),
    });
    const bridge = createNativeSpoolerBridge(() => native);
    await expect(bridge.writeRaw('EPSON TM-T20', new Uint8Array([0x0a]))).rejects.toMatchObject({
      code: 'write_failed',
      message: expect.stringContaining('Windows error 1802'),
    });
  });

  it('wraps a loader failure as write_failed (addon missing/broken)', async () => {
    const bridge = createNativeSpoolerBridge(() => {
      throw new Error('not built');
    });
    await expect(bridge.writeRaw('P', new Uint8Array([0x0a]))).rejects.toMatchObject({
      code: 'write_failed',
    });
  });
});
```

Run: `pnpm test -- tests/spooler-native.test.ts`
Expected: FAIL — `spooler-native.ts` does not exist.

- [ ] **Step 3: Implement `src/main/transport/spooler-native.ts`**

```ts
import native from 'print-agent-spooler-raw';
import { TransportError } from './errors';

/**
 * Production SpoolerBridge over the `print-agent-spooler-raw` N-API addon
 * (ADR-4). Thin node glue (like socket.ts's factory): translates native
 * failures into TransportError codes — classification table per
 * docs/transport-adapters.md. The addon is dlopen'd lazily on first call, so
 * tcp_raw-only installs never load it. Unit tests inject a loader stub; the
 * real binary is exercised by tests/spooler-raw-capture.test.ts (opt-in).
 */
export interface NativeSpooler {
  printerExists(name: string): boolean;
  writeRaw(name: string, buffer: Uint8Array): Promise<void>;
  enumeratePrinters(): string[];
}

export interface SpoolerBridge {
  printerExists(name: string): Promise<boolean>;
  writeRaw(name: string, bytes: Uint8Array): Promise<void>;
  enumerate(): Promise<readonly string[]>;
}

export function createNativeSpoolerBridge(load: () => NativeSpooler = () => native): SpoolerBridge {
  const writeRaw = async (name: string, bytes: Uint8Array): Promise<void> => {
    try {
      await load().writeRaw(name, bytes);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new TransportError('write_failed', `spooler:${name}: ${message}`);
    }
  };
  return {
    printerExists: (name) => Promise.resolve(load().printerExists(name)),
    writeRaw,
    enumerate: () => Promise.resolve(load().enumeratePrinters()),
  };
}
```

Run: `pnpm test -- tests/spooler-native.test.ts`
Expected: PASS.

- [ ] **Step 4: Gate check + commit**

Run: `pnpm typecheck && pnpm lint`
Expected: green (the `print-agent-spooler-raw` types resolve via its `types` field; `esModuleInterop` is on in both tsconfigs).

```bash
git add src/main/transport/errors.ts src/main/transport/spooler-native.ts tests/spooler-native.test.ts
git commit -m "feat(transport): printer_not_found code + native spooler bridge adapter"
```

---

### Task 4: `createSpoolerRawTransport` (fake-bridge unit tests)

**Files:**
- Create: `src/main/transport/spooler-raw.ts`
- Test: `tests/spooler-raw.test.ts`

- [ ] **Step 1: Write the failing test `tests/spooler-raw.test.ts`**

```ts
import { describe, expect, it, vi } from 'vitest';
import { createSpoolerRawTransport } from '../src/main/transport/spooler-raw';
import type { SpoolerBridge } from '../src/main/transport/spooler-native';

function makeBridge(overrides: Partial<SpoolerBridge> = {}): SpoolerBridge & {
  writes: Array<{ name: string; bytes: Uint8Array }>;
} {
  const bridge = {
    writes: [] as Array<{ name: string; bytes: Uint8Array }>,
    printerExists: vi.fn(async (name: string) => name === 'EPSON TM-T20'),
    writeRaw: vi.fn(async (name: string, bytes: Uint8Array) => {
      bridge.writes.push({ name, bytes });
    }),
    enumerate: vi.fn(async () => ['EPSON TM-T20']),
    ...overrides,
  };
  return bridge as SpoolerBridge & { writes: Array<{ name: string; bytes: Uint8Array }> };
}

function makeTransport(bridge: SpoolerBridge) {
  return createSpoolerRawTransport({ printerName: 'EPSON TM-T20', bridge });
}

describe('spooler-raw transport — happy path', () => {
  it('probes existence on open, spools one job per write, closes idempotently', async () => {
    const bridge = makeBridge();
    const transport = makeTransport(bridge);
    await expect(transport.open()).resolves.toBeUndefined();
    await transport.write(new Uint8Array([0x1b, 0x40]));
    await transport.write(new Uint8Array([0x1d, 0x56, 0x01]));
    expect(bridge.writeRaw).toHaveBeenCalledTimes(2);
    expect(bridge.writes.map((w) => Array.from(w.bytes))).toEqual([
      [0x1b, 0x40],
      [0x1d, 0x56, 0x01],
    ]);
    await expect(transport.close()).resolves.toBeUndefined();
  });

  it('open() is idempotent (one probe)', async () => {
    const bridge = makeBridge();
    const transport = makeTransport(bridge);
    await transport.open();
    await transport.open();
    expect(bridge.printerExists).toHaveBeenCalledTimes(1);
  });

  it('healthCheck probes without requiring open()', async () => {
    const bridge = makeBridge();
    await expect(makeTransport(bridge).healthCheck()).resolves.toBeUndefined();
    expect(bridge.printerExists).toHaveBeenCalledWith('EPSON TM-T20');
    expect(bridge.writeRaw).not.toHaveBeenCalled();
  });
});

describe('spooler-raw transport — failures', () => {
  it('rejects open() with printer_not_found when the printer is not installed', async () => {
    const bridge = makeBridge({ printerExists: vi.fn(async () => false) });
    const transport = makeTransport(bridge);
    await expect(transport.open()).rejects.toMatchObject({ code: 'printer_not_found' });
  });

  it('write() before open() fails with not_open and never touches the spooler', async () => {
    const bridge = makeBridge();
    const transport = makeTransport(bridge);
    await expect(transport.write(new Uint8Array([0x0a]))).rejects.toMatchObject({
      code: 'not_open',
    });
    expect(bridge.writeRaw).not.toHaveBeenCalled();
  });

  it('propagates a spooler write failure as write_failed', async () => {
    const bridge = makeBridge({
      writeRaw: vi.fn(async () => {
        throw Object.assign(new Error('WritePrinter failed (Windows error 1168)'), { code: 'write_failed' });
      }),
    });
    const transport = makeTransport(bridge);
    await transport.open();
    await expect(transport.write(new Uint8Array([0x0a]))).rejects.toMatchObject({
      code: 'write_failed',
    });
  });

  it('serializes concurrent writes — jobs spool in call order', async () => {
    const order: number[] = [];
    const bridge = makeBridge({
      writeRaw: vi.fn(async (_name: string, bytes: Uint8Array) => {
        await new Promise((r) => setTimeout(r, 5));
        order.push(bytes[0] ?? 0);
      }),
    });
    const transport = makeTransport(bridge);
    await transport.open();
    await Promise.all([
      transport.write(new Uint8Array([0x01])),
      transport.write(new Uint8Array([0x02])),
      transport.write(new Uint8Array([0x03])),
    ]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('write() after close() fails with not_open', async () => {
    const bridge = makeBridge();
    const transport = makeTransport(bridge);
    await transport.open();
    await transport.close();
    await expect(transport.write(new Uint8Array([0x0a]))).rejects.toMatchObject({
      code: 'not_open',
    });
  });

  it('close() then open() re-probes the printer', async () => {
    const bridge = makeBridge();
    const transport = makeTransport(bridge);
    await transport.open();
    await transport.close();
    await transport.open();
    expect(bridge.printerExists).toHaveBeenCalledTimes(2);
  });
});
```

Run: `pnpm test -- tests/spooler-raw.test.ts`
Expected: FAIL — `spooler-raw.ts` does not exist.

- [ ] **Step 2: Implement `src/main/transport/spooler-raw.ts`**

```ts
import { TransportError } from './errors';
import type { SpoolerBridge } from './spooler-native';
import type { PrinterTransport } from './types';

export interface SpoolerRawTransportOptions {
  /** Windows printer name (approved destination from the printer store). */
  printerName: string;
  /** Injected winspool access — unit tests run against fakes (ADR-10). */
  bridge: SpoolerBridge;
}

/**
 * Win32 spooler RAW transport (ADR-4, architecture §3.4): one RAW-datatype
 * spooler job per `write()`, spooled through the injected bridge. Fire-and-
 * forget like tcp-raw, but "resolved" means **Windows accepted the job** —
 * the vendor driver may still buffer or fail downstream (R-VAL-4 duplicate
 * risk; feeds the ambiguity/duplicate-policy flow). Writes are serialized in
 * call order; `close()` is a stateless flag reset (no persistent handle).
 */
export function createSpoolerRawTransport(options: SpoolerRawTransportOptions): PrinterTransport {
  const { printerName, bridge } = options;
  const target = `spooler:${printerName}`;

  let open = false;
  let writeTail: Promise<void> = Promise.resolve();

  const probe = async (): Promise<void> => {
    if (!(await bridge.printerExists(printerName))) {
      throw new TransportError(
        'printer_not_found',
        `${target}: printer is not installed on this machine`,
      );
    }
  };

  const openTransport = async (): Promise<void> => {
    if (open) return; // idempotent
    await probe();
    open = true;
  };

  const write = (bytes: Uint8Array): Promise<void> => {
    const attempt = async (): Promise<void> => {
      if (!open) {
        throw new TransportError('not_open', `${target}: transport is not open`);
      }
      await bridge.writeRaw(printerName, bytes);
    };
    // Serialize: each job starts only after the previous one settles (same
    // tail-promise discipline as tcp-raw) — one in-flight spooler job.
    const result = writeTail.then(attempt);
    writeTail = result.then(
      () => {},
      () => {},
    );
    return result;
  };

  const close = async (): Promise<void> => {
    open = false;
  };

  const healthCheck = (): Promise<void> => probe();

  return { open: openTransport, write, close, healthCheck };
}
```

Run: `pnpm test -- tests/spooler-raw.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/main/transport/spooler-raw.ts tests/spooler-raw.test.ts
git commit -m "feat(transport): spooler_raw PrinterTransport over injected SpoolerBridge"
```

---

### Task 5: Profile schema union + registry wiring

**Files:**
- Modify: `src/main/printers/profile.ts` (spooler endpoint variant)
- Modify: `src/main/transport/registry.ts` (new case, drop the eslint-disable)
- Test: `tests/printer-profile.test.ts`
- Test: `tests/transport-registry.test.ts`

Note: these two changes must land together — widening the union makes the registry's exhaustive switch a compile error until the new case exists.

- [ ] **Step 1: Write the failing schema tests** (append to `tests/printer-profile.test.ts`, inside the `printer profile schema` describe):

```ts
  it('accepts a spooler_raw endpoint', () => {
    const draft = makeDraft({ transport: { kind: 'spooler_raw', windowsPrinterName: 'EPSON TM-T20' } });
    const parsed = PrinterProfileSchema.parse(makeProfile({ transport: draft.transport }));
    expect(parsed.transport).toEqual({ kind: 'spooler_raw', windowsPrinterName: 'EPSON TM-T20' });
  });

  it('rejects a spooler endpoint with an empty or over-long printer name (strict bounds)', () => {
    expect(
      PrinterProfileSchema.safeParse(
        makeProfile({ transport: { kind: 'spooler_raw', windowsPrinterName: '' } }),
      ).success,
    ).toBe(false);
    expect(
      PrinterProfileSchema.safeParse(
        makeProfile({ transport: { kind: 'spooler_raw', windowsPrinterName: 'x'.repeat(129) } }),
      ).success,
    ).toBe(false);
  });

  it('rejects spooler endpoints with unknown fields (strict)', () => {
    expect(
      PrinterProfileSchema.safeParse(
        makeProfile({
          transport: { kind: 'spooler_raw', windowsPrinterName: 'P', host: '1.2.3.4' } as never,
        }),
      ).success,
    ).toBe(false);
  });
```

Run: `pnpm test -- tests/printer-profile.test.ts`
Expected: FAIL — `spooler_raw` is not a valid kind yet.

- [ ] **Step 2: Widen the schema in `profile.ts`** — add after `EndpointTcpRawSchema`:

```ts
/** Windows printer name — the approved destination for spooler delivery.
 *  Existence is validated at open time by the spooler shim (the printer can
 *  be installed/uninstalled after pairing), not by the schema. */
const EndpointSpoolerRawSchema = z.strictObject({
  kind: z.literal('spooler_raw'),
  windowsPrinterName: z.string().min(1).max(128),
});
```

and change the profile's `transport` field:

```ts
  transport: z.union([EndpointTcpRawSchema, EndpointSpoolerRawSchema]),
```

- [ ] **Step 3: Write the failing registry test** (append to `tests/transport-registry.test.ts`):

```ts
describe('transport registry — spooler_raw', () => {
  it('builds a spooler transport from the approved profile endpoint', async () => {
    const bridge = {
      printerExists: async () => true,
      writeRaw: async () => {},
      enumerate: async () => ['EPSON TM-T20'],
    };
    const registry = createTransportRegistry({ spoolerBridge: bridge });
    const transport = registry.forPrinter(
      makeProfile({ transport: { kind: 'spooler_raw', windowsPrinterName: 'EPSON TM-T20' } }),
    );
    await expect(transport.healthCheck()).resolves.toBeUndefined();
  });

  it('routes writes to the profiled printer name', async () => {
    const writes: Array<{ name: string; bytes: Uint8Array }> = [];
    const bridge = {
      printerExists: async () => true,
      writeRaw: async (name: string, bytes: Uint8Array) => {
        writes.push({ name, bytes });
      },
      enumerate: async () => ['EPSON TM-T20'],
    };
    const registry = createTransportRegistry({ spoolerBridge: bridge });
    const transport = registry.forPrinter(
      makeProfile({ transport: { kind: 'spooler_raw', windowsPrinterName: 'EPSON TM-T20' } }),
    );
    await transport.open();
    await transport.write(new Uint8Array([0x1b, 0x40]));
    expect(writes).toEqual([{ name: 'EPSON TM-T20', bytes: Buffer.from([0x1b, 0x40]) }]);
  });
});
```

(The registry test goes through `createTransportRegistry` only — no direct import of the transport factory here.)

Run: `pnpm test -- tests/transport-registry.test.ts`
Expected: FAIL — `spoolerBridge` option does not exist; `typecheck` would also fail because the switch does not handle `spooler_raw`.

- [ ] **Step 4: Wire the registry (`registry.ts`)**

```ts
import type { PrinterProfile } from '../printers/profile';
import { createNetSocketFactory, type SocketFactory } from './socket';
import { createSpoolerRawTransport } from './spooler-raw';
import { createNativeSpoolerBridge, type SpoolerBridge } from './spooler-native';
import { createTcpRawTransport, type TcpRawTransportOptions } from './tcp-raw';
import type { PrinterTransport } from './types';

export interface TransportRegistryOptions {
  /** Defaults to the production node:net factory. */
  socketFactory?: SocketFactory;
  /** Defaults to the native winspool bridge (lazy dlopen). */
  spoolerBridge?: SpoolerBridge;
  connectTimeoutMs?: number;
  writeTimeoutMs?: number;
}

export function createTransportRegistry(options: TransportRegistryOptions = {}): TransportRegistry {
  return {
    forPrinter(profile) {
      const endpoint = profile.transport;
      switch (endpoint.kind) {
        case 'tcp_raw': {
          const tcpOptions: TcpRawTransportOptions = {
            host: endpoint.host,
            port: endpoint.port,
            socketFactory: options.socketFactory ?? createNetSocketFactory(),
          };
          if (options.connectTimeoutMs !== undefined) {
            tcpOptions.connectTimeoutMs = options.connectTimeoutMs;
          }
          if (options.writeTimeoutMs !== undefined) {
            tcpOptions.writeTimeoutMs = options.writeTimeoutMs;
          }
          return createTcpRawTransport(tcpOptions);
        }
        case 'spooler_raw':
          return createSpoolerRawTransport({
            printerName: endpoint.windowsPrinterName,
            bridge: options.spoolerBridge ?? createNativeSpoolerBridge(),
          });
      }
    },
  };
}
```

(The exhaustive switch needs no default and no eslint-disable anymore — delete the old `// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition` line and the single-variant comment.)

- [ ] **Step 5: Run both test files + gate**

Run: `pnpm test -- tests/printer-profile.test.ts tests/transport-registry.test.ts && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/printers/profile.ts src/main/transport/registry.ts tests/printer-profile.test.ts tests/transport-registry.test.ts
git commit -m "feat(printers,transport): spooler_raw endpoint union + registry wiring"
```

---

### Task 6: Config-apply accepts `spooler_raw`

**Files:**
- Modify: `src/main/printers/config-apply.ts`
- Test: `tests/config-apply.test.ts`

- [ ] **Step 1: Update the tests first** — replace the rejection test in `tests/config-apply.test.ts`:

```ts
  it('maps spooler_raw entries (windows_printer_name → windowsPrinterName)', () => {
    const result = mapCloudPrinters(
      makeConfigUpdate([
        makePrinterConfig({ transport: { kind: 'spooler_raw', windows_printer_name: 'EPSON TM-T20' } }),
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.printers[0]?.transport).toEqual({
      kind: 'spooler_raw',
      windowsPrinterName: 'EPSON TM-T20',
    });
    expect(result.printers[0]?.source).toBe('cloud');
  });

  it('accepts a mixed tcp_raw + spooler_raw config', () => {
    const result = mapCloudPrinters(
      makeConfigUpdate([
        makePrinterConfig(),
        makePrinterConfig({
          printer_id: '018f0000-0000-7000-8000-0000000000c2',
          transport: { kind: 'spooler_raw', windows_printer_name: 'Star TSP143' },
        }),
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.printers.map((p) => p.transport.kind)).toEqual(['tcp_raw', 'spooler_raw']);
  });

  it('rejects an empty windows_printer_name', () => {
    const result = mapCloudPrinters(
      makeConfigUpdate([
        makePrinterConfig({ transport: { kind: 'spooler_raw', windows_printer_name: '' } }),
      ]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('windows_printer_name');
  });

  it('still rejects usb transports (not applicable in v1)', () => {
    const usb = mapCloudPrinters(
      makeConfigUpdate([makePrinterConfig({ transport: { kind: 'usb', vid: '04b8', pid: '0202' } })]),
    );
    expect(usb.ok).toBe(false);
  });
```

(Delete the old `rejects spooler_raw and usb transports (not applicable in v1)` test — it is superseded. Keep the reject-all test but change its bad entry's transport from `usb` — that still works; leave as-is since usb is still the canonical bad entry.)

Run: `pnpm test -- tests/config-apply.test.ts`
Expected: FAIL — spooler entries are still rejected by `toProfile`.

- [ ] **Step 2: Implement in `config-apply.ts`**

Update the doc comment (first ~15 lines):

```ts
 * v1 applies tcp_raw (IP-literal hosts only — no DNS surface) and
 * spooler_raw (ADR-4 shim). usb remains v1.1 and rejects the whole config.
```

Replace the transport handling in `toProfile`:

```ts
function toProfile(pc: PrinterConfig): PrinterProfile | { readonly error: string } {
  if (pc.name === '') return { error: `printer ${pc.printer_id}: empty name` };
  if (pc.transport.kind === 'usb') {
    return {
      error: `printer ${pc.printer_id}: transport usb not applicable in v1 (tcp_raw/spooler_raw only)`,
    };
  }
  let transport: PrinterProfile['transport'];
  if (pc.transport.kind === 'tcp_raw') {
    if (isIP(pc.transport.host) === 0) {
      return { error: `printer ${pc.printer_id}: host must be an IP literal (no DNS in v1)` };
    }
    if (!isApprovedEndpointHost(pc.transport.host)) {
      return {
        error: `printer ${pc.printer_id}: host is loopback, multicast or otherwise not approved`,
      };
    }
    transport = { kind: 'tcp_raw', host: pc.transport.host, port: pc.transport.port };
  } else {
    if (pc.transport.windows_printer_name === '') {
      return { error: `printer ${pc.printer_id}: empty windows_printer_name` };
    }
    transport = {
      kind: 'spooler_raw',
      windowsPrinterName: pc.transport.windows_printer_name,
    };
  }
  return {
    printerId: pc.printer_id,
    // …rest unchanged from the existing return (name/role/paperWidthMm/…),
    transport,
    station: pc.station,
    copiesDefault: pc.copies_default,
    codepage: pc.codepage,
    cutDefault: pc.cut_default,
    duplicatePolicy: pc.duplicate_policy,
    statusPolling: pc.status_polling,
    source: 'cloud',
  };
}
```

Keep every other field of the existing return object exactly as it is.

- [ ] **Step 3: Run tests + gate**

Run: `pnpm test -- tests/config-apply.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/main/printers/config-apply.ts tests/config-apply.test.ts
git commit -m "feat(printers): config-apply maps spooler_raw endpoints (A2)"
```

---

### Task 7: Runtime `systemPrinters()` + bridge seam

**Files:**
- Modify: `src/main/agent-runtime.ts`
- Test: `tests/agent-runtime.test.ts`

- [ ] **Step 1: Write the failing runtime test** — extend `makeRuntime`'s overrides and env in `tests/agent-runtime.test.ts`:

Add `spoolerBridge?: SpoolerBridge;` to the `overrides` parameter type (line ~294), and in the `env` object (line ~329):

```ts
    ...(overrides.spoolerBridge !== undefined
      ? { spoolerBridgeOverride: overrides.spoolerBridge }
      : {}),
```

(Extend the existing `RuntimeDeps` import to also import `SpoolerBridge` from `../src/main/transport/spooler-native`.)

Append the test (in the describe covering runtime APIs):

```ts
describe('AgentRuntime system printers (A2)', () => {
  it('exposes Windows printer names via the injected spooler bridge', async () => {
    const spoolerBridge = {
      printerExists: async () => true,
      writeRaw: async () => {},
      enumerate: async () => ['EPSON TM-T20', 'Star TSP143'],
    };
    const { runtime } = await makeRuntime({ spoolerBridge });
    await expect(runtime.printers.systemPrinters()).resolves.toEqual([
      'EPSON TM-T20',
      'Star TSP143',
    ]);
  });
});
```

Run: `pnpm test -- tests/agent-runtime.test.ts`
Expected: FAIL — `systemPrinters` is not on the runtime.

- [ ] **Step 2: Implement in `agent-runtime.ts`**

1. Imports:

```ts
import { createNativeSpoolerBridge, type SpoolerBridge } from './transport/spooler-native';
```

2. `RuntimeDeps['env']` gains:

```ts
    /** Test seam: replaces the native spooler bridge (default: winspool addon). */
    readonly spoolerBridgeOverride?: SpoolerBridge;
```

3. `AgentRuntime` interface gains:

```ts
  /** Windows printer names installed on this machine (UI dropdown). */
  systemPrinters(): Promise<readonly string[]>;
```

4. In `createAgentRuntime`, before the registry line (line ~170):

```ts
  const spoolerBridge: SpoolerBridge =
    deps.env?.spoolerBridgeOverride ?? createNativeSpoolerBridge();
```

and change:

```ts
  const registry: TransportRegistry =
    deps.env?.transportsOverride ?? createTransportRegistry({ spoolerBridge });
```

5. In `printersApi` (line ~497) add:

```ts
    systemPrinters(): Promise<readonly string[]> {
      return spoolerBridge.enumerate();
    },
```

and add `systemPrinters` to the runtime's returned object and to the `printers` section of the `AgentRuntime` interface (line ~106):

```ts
  readonly printers: {
    list(): readonly PrinterInfo[];
    add(draft: unknown): Promise<PrinterInfo>;
    update(printerId: string, patch: unknown): Promise<PrinterInfo>;
    remove(printerId: string): Promise<boolean>;
    testPrint(printerId: string): Promise<TestPrintResult>;
    systemPrinters(): Promise<readonly string[]>;
  };
```

(Keep `systemPrinters` under `printers` in both interface and return; adjust the test call accordingly: `runtime.printers.systemPrinters()`.)

Run: `pnpm test -- tests/agent-runtime.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/main/agent-runtime.ts tests/agent-runtime.test.ts
git commit -m "feat(runtime): systemPrinters() enumeration via spooler bridge (A2)"
```

---

### Task 8: IPC channel `printers:list-system`

**Files:**
- Modify: `src/shared/ipc-contract.ts`
- Modify: `src/main/main.ts` (handler map)
- Modify: `src/preload/index.ts`
- Test: `tests/ipc-contract.test.ts`

- [ ] **Step 1: Write the failing contract tests** — extend `tests/ipc-contract.test.ts`:

In `wiring-phase channels`, channel-string test:

```ts
    expect(Channel.PrintersListSystem).toBe('printers:list-system');
```

and a no-payload validation test:

```ts
  it('printers:list-system is a no-payload channel', () => {
    expect(RequestSchemas[Channel.PrintersListSystem].safeParse(undefined).success).toBe(true);
    expect(RequestSchemas[Channel.PrintersListSystem].safeParse({}).success).toBe(false);
  });
```

Run: `pnpm test -- tests/ipc-contract.test.ts`
Expected: FAIL — channel does not exist.

- [ ] **Step 2: Add the channel (`ipc-contract.ts`)**

```ts
  PrintersListSystem: 'printers:list-system',
```

in `Channel`, and in `RequestSchemas`:

```ts
  [Channel.PrintersListSystem]: noPayload,
```

- [ ] **Step 3: Main handler (`main.ts`)** — the `handlers: Record<Channel, …>` map (the compiler forces this line once the channel exists):

```ts
    [Channel.PrintersListSystem]: () => runtime.printers.systemPrinters(),
```

- [ ] **Step 4: Preload (`preload/index.ts`)** — add to `api`:

```ts
  listSystemPrinters: (): Promise<readonly string[]> =>
    ipcRenderer.invoke(Channel.PrintersListSystem),
```

- [ ] **Step 5: Run tests + gate**

Run: `pnpm test -- tests/ipc-contract.test.ts && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/shared/ipc-contract.ts src/main/main.ts src/preload/index.ts tests/ipc-contract.test.ts
git commit -m "feat(ipc): printers:list-system channel for Windows printer enumeration"
```

---

### Task 9: Renderer service surface

**Files:**
- Modify: `src/renderer/src/services/agent-service.ts`
- Modify: `src/renderer/src/services/production-service.ts`
- Modify: `tests/ui/helpers.tsx` (FakeAgentService)

- [ ] **Step 1: `agent-service.ts`** — add under the printer methods:

```ts
  /** Windows printer names installed on this machine (add-printer dropdown). */
  listSystemPrinters(): Promise<readonly string[]>;
```

- [ ] **Step 2: `production-service.ts`** — add to the returned object:

```ts
    listSystemPrinters: () => bridge.listSystemPrinters(),
```

- [ ] **Step 3: `tests/ui/helpers.tsx`** — add to `FakeAgentService`:

```ts
  listSystemPrinters(): Promise<readonly string[]> {
    return Promise.resolve(['EPSON TM-T20 (Copy 1)', 'Star TSP143 (STR-001)']);
  }
```

- [ ] **Step 4: Gate**

Run: `pnpm typecheck && pnpm test -- tests/ui`
Expected: PASS (existing UI tests are unaffected; the fake satisfies the new interface member).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/services/agent-service.ts src/renderer/src/services/production-service.ts tests/ui/helpers.tsx
git commit -m "feat(renderer): listSystemPrinters service surface"
```

---

### Task 10: PrintersScreen — transport selector + Windows-printer dropdown

**Files:**
- Modify: `src/renderer/src/ui/screens/PrintersScreen.tsx`
- Test: `tests/ui/printers.test.tsx`

- [ ] **Step 1: Write the failing UI tests** — append to `tests/ui/printers.test.tsx` (follow the existing userEvent patterns):

```tsx
  it('adds a spooler printer via the Windows-printer dropdown', async () => {
    const user = userEvent.setup();
    const service = makeService();
    renderWithService(<PrintersScreen />, service);
    await user.click(screen.getAllByRole('button', { name: /add printer/i })[0] as HTMLElement);
    const dialog = screen.getByRole('dialog');

    // Switch transport type to Windows printer.
    const kindSelect = within(dialog).getByLabelText('Transport type');
    await user.selectOptions(kindSelect, 'spooler_raw');

    // The dropdown is populated from the enumerated system printers.
    const printerSelect = await within(dialog).findByLabelText('Windows printer');
    await user.selectOptions(printerSelect, 'EPSON TM-T20 (Copy 1)');

    await user.type(within(dialog).getByLabelText(/^Name$/i), 'Front desk');
    await user.click(within(dialog).getByRole('button', { name: /^add printer$/i }));

    const row = await screen.findByText('Front desk');
    expect(row.closest('li')?.textContent).toContain('Spooler: EPSON TM-T20 (Copy 1)');
  });

  it('blocks saving a spooler printer with no Windows printer selected', async () => {
    const user = userEvent.setup();
    renderWithService(<PrintersScreen />, makeService());
    await user.click(screen.getAllByRole('button', { name: /add printer/i })[0] as HTMLElement);
    const dialog = screen.getByRole('dialog');
    await user.selectOptions(within(dialog).getByLabelText('Transport type'), 'spooler_raw');
    await user.type(within(dialog).getByLabelText(/^Name$/i), 'Front desk');
    await user.click(within(dialog).getByRole('button', { name: /^add printer$/i }));
    expect(await screen.findByText(/pick a windows printer/i)).toBeInTheDocument();
  });

  it('labels spooler transports in the printer list', async () => {
    const fresh = makeService();
    for (const p of await fresh.getPrinters()) {
      await fresh.removePrinter(p.config.printerId);
    }
    await fresh.addPrinter({
      name: 'Bar spooler',
      role: 'bar',
      paperWidthMm: 80,
      printableDots: 576,
      charsPerLine: 48,
      capabilities: { cut: true, qrCode: true, barcode128: false, statusPolling: false, cashDrawer: false },
      transport: { kind: 'spooler_raw', windowsPrinterName: 'Star TSP143 (STR-001)' },
    });
    renderWithService(<PrintersScreen />, fresh);
    expect(await screen.findByText('Spooler: Star TSP143 (STR-001)')).toBeInTheDocument();
  });
```

(Form inputs must be associated with their labels via `<Field label=…>` wrapping, so `getByLabelText` works — verify the `Field` primitive associates the label with the input; if it does not (renders label + child without htmlFor/id), use `within()` queries on field containers instead of changing the primitive.)

Run: `pnpm test -- tests/ui/printers.test.tsx`
Expected: FAIL — no "Transport type" control exists yet.

- [ ] **Step 2: Implement in `PrintersScreen.tsx`**

1. `transportLabel` (line ~66):

```ts
export function transportLabel(transport: PrinterProfile['transport']): string {
  return transport.kind === 'tcp_raw'
    ? `TCP ${transport.host}:${String(transport.port)}`
    : `Spooler: ${transport.windowsPrinterName}`;
}
```

2. In `PrinterFormDialog`, add state next to `transport`:

```ts
  const [transportKind, setTransportKind] = useState<'tcp_raw' | 'spooler_raw'>(
    initial?.transport.kind ?? 'tcp_raw',
  );
  const systemPrinters = useAsync(
    () => (transportKind === 'spooler_raw' ? service.listSystemPrinters() : Promise.resolve([])),
    [service, transportKind],
  );
```

(Import `useAsync` from `../../services/service-context` — it is already imported in this file at the top for the list screen; check the import line and extend it.)

3. Kind switch handler (next to `changePaperWidth`):

```ts
  const changeTransportKind = (kind: 'tcp_raw' | 'spooler_raw'): void => {
    setTransportKind(kind);
    setTransport(
      kind === 'tcp_raw'
        ? { kind: 'tcp_raw', host: initial?.transport.kind === 'tcp_raw' ? initial.transport.host : '', port: initial?.transport.kind === 'tcp_raw' ? initial.transport.port : 9100 }
        : {
            kind: 'spooler_raw',
            windowsPrinterName:
              initial?.transport.kind === 'spooler_raw' ? initial.transport.windowsPrinterName : '',
          },
    );
  };
```

4. Submit validation — after the name check in `submit`:

```ts
    if (transport.kind === 'spooler_raw' && transport.windowsPrinterName === '') {
      setError('Pick a Windows printer.');
      return;
    }
```

5. Replace the host/port `<div className="form-grid-2">` block (lines ~428–458) with:

```tsx
          <Field label="Transport type" hint="Network printers use TCP; driver-installed printers use the Windows queue.">
            <select
              className="input"
              value={transportKind}
              onChange={(e) => {
                const kind = e.target.value === 'spooler_raw' ? 'spooler_raw' : 'tcp_raw';
                changeTransportKind(kind);
              }}
              disabled={busy}
            >
              <option value="tcp_raw">Network printer (TCP)</option>
              <option value="spooler_raw">Windows printer (driver)</option>
            </select>
          </Field>
          {transportKind === 'tcp_raw' ? (
            <div className="form-grid-2">
              <Field label="Address">
                <input
                  className="input mono"
                  value={transport.host}
                  onChange={(e) => {
                    setTransport({ kind: 'tcp_raw', host: e.target.value, port: transport.port });
                  }}
                  placeholder="192.168.1.87"
                  disabled={busy}
                />
              </Field>
              <Field label="Port">
                <input
                  className="input mono"
                  type="number"
                  min={1}
                  max={65535}
                  value={transport.port}
                  onChange={(e) => {
                    const parsed = Number(e.target.value);
                    setTransport({
                      kind: 'tcp_raw',
                      host: transport.host,
                      port: Number.isInteger(parsed) ? parsed : transport.port,
                    });
                  }}
                  disabled={busy}
                />
              </Field>
            </div>
          ) : (
            <Field label="Windows printer" hint="Printers installed on this machine.">
              {systemPrinters.loading ? (
                <select className="input" disabled>
                  <option>Loading printers…</option>
                </select>
              ) : systemPrinters.error !== null ? (
                <div className="field">
                  <ErrorBanner
                    message={`Could not enumerate Windows printers. ${systemPrinters.error}`}
                    onRetry={systemPrinters.reload}
                  />
                </div>
              ) : (
                <select
                  className="input"
                  value={transport.kind === 'spooler_raw' ? transport.windowsPrinterName : ''}
                  onChange={(e) => {
                    setTransport({ kind: 'spooler_raw', windowsPrinterName: e.target.value });
                  }}
                  disabled={busy}
                >
                  <option value="">Select a printer…</option>
                  {(systemPrinters.data ?? []).map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          )}
```

(Adapt to the actual `Field`/`ErrorBanner` APIs in this file — `ErrorBanner` is already imported. Keep JSX structure consistent with neighboring markup.)

Run: `pnpm test -- tests/ui/printers.test.tsx && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/ui/screens/PrintersScreen.tsx tests/ui/printers.test.tsx
git commit -m "feat(ui): transport-type selector + Windows-printer dropdown on Printers screen"
```

---

### Task 11: File-port capture evidence (opt-in, real shim)

**Files:**
- Create: `tests/spooler-raw-capture.test.ts`
- Create: `scripts/setup-capture-printer.ps1`
- Modify: `docs/operations.md` (runbook note — content below; also used by Task 12's doc task)

- [ ] **Step 1: Create `scripts/setup-capture-printer.ps1`**

```powershell
# ADR-10 file-port capture printer for the spooler_raw byte-exact test.
# Run ELEVATED (writes the Local Port registry key under HKLM):
#   powershell -ExecutionPolicy Bypass -File scripts/setup-capture-printer.ps1
# Teardown: Remove-Printer PrintAgentCapture (and delete the port value).
param(
  [string]$PrinterName = 'PrintAgentCapture',
  [string]$CaptureFile = 'C:\print-agent-capture\capture.prn'
)
$ErrorActionPreference = 'Stop'

New-Item -ItemType Directory -Force -Path (Split-Path $CaptureFile) | Out-Null

# Local Port monitor: a port whose NAME is a file path writes RAW job bytes
# to that file verbatim. With DATATYPE "RAW" the driver never processes the
# job, so the (mangling-prone) Generic/Text-Only rendering path is bypassed —
# the port receives exactly what the agent wrote.
$portsKey = 'HKLM:\SYSTEM\CurrentControlSet\Control\Print\Monitors\Local Port\Ports'
New-Item -Path $portsKey -Force | Out-Null
New-ItemProperty -Path $portsKey -Name $CaptureFile -PropertyType String -Value '' -Force | Out-Null
Restart-Service Spooler -Force

Add-Printer -Name $PrinterName -DriverName 'Generic / Text Only' -PortName $CaptureFile
Write-Output "Created '$PrinterName' on file port '$CaptureFile'."
Write-Output 'Run: pnpm vitest run tests/spooler-raw-capture.test.ts'
```

- [ ] **Step 2: Create `tests/spooler-raw-capture.test.ts`**

```ts
import { readFile, rm } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createNativeSpoolerBridge } from '../src/main/transport/spooler-native';

/**
 * ADR-10 file-port capture: the REAL native shim writes through the Windows
 * spooler to a redirected file port; the captured file must equal the written
 * bytes exactly. Skips silently wherever the capture printer is not installed
 * (CI, contributor machines) — set it up once per validation machine with
 * scripts/setup-capture-printer.ps1. Hardware pass/fail stays R-VAL-4 (B1).
 */
const CAPTURE_PRINTER = process.env['PRINT_AGENT_CAPTURE_PRINTER'] ?? 'PrintAgentCapture';
const CAPTURE_FILE = process.env['PRINT_AGENT_CAPTURE_FILE'] ?? 'C:\\print-agent-capture\\capture.prn';

const bridge = createNativeSpoolerBridge();

describe('spooler-raw file-port capture (opt-in, ADR-10)', () => {
  let installed = false;
  beforeAll(async () => {
    installed = await bridge.printerExists(CAPTURE_PRINTER);
  });

  afterAll(() => {
    rm(CAPTURE_FILE, { force: true }).catch(() => {});
  });

  it('delivers byte-exact RAW output through the Windows spooler', async (ctx) => {
    if (!installed) ctx.skip(); // capture printer not installed on this machine
    await rm(CAPTURE_FILE, { force: true }).catch(() => {});

    // Deterministic pattern exercising init, text, and cut-style commands.
    const payload = Buffer.concat([
      Buffer.from([0x1b, 0x40]), // ESC @ init
      Buffer.from('print-agent capture\n', 'ascii'),
      Buffer.from([0x1d, 0x56, 0x01]), // GS V full cut
    ]);
    await bridge.writeRaw(CAPTURE_PRINTER, new Uint8Array(payload));

    // The spooler flushes asynchronously; poll for the file with the payload.
    const captured = await vi.waitFor(
      async () => {
        const data = await readFile(CAPTURE_FILE);
        // File ports may append across jobs — compare the tail.
        const tail = data.subarray(data.length - payload.length);
        expect(tail.equals(payload)).toBe(true);
        return data;
      },
      { timeout: 10_000, interval: 250 },
    );
    expect(captured.length).toBeGreaterThanOrEqual(payload.length);
  });

  it('reports a missing capture printer as printer_not_found through the transport', async (ctx) => {
    if (installed) ctx.skip(); // only meaningful without the capture printer
    const { createSpoolerRawTransport } = await import('../src/main/transport/spooler-raw');
    const transport = createSpoolerRawTransport({
      printerName: CAPTURE_PRINTER,
      bridge,
    });
    await expect(transport.healthCheck()).rejects.toMatchObject({ code: 'printer_not_found' });
  });
});
```

- [ ] **Step 3: Verify skip behavior on this machine**

Run: `pnpm vitest run tests/spooler-raw-capture.test.ts`
Expected: tests skipped (unless you ran the setup script — in that case they must PASS and are your byte-exact evidence).

- [ ] **Step 4: Add the operations.md runbook note** — in `docs/operations.md` §6 (release checklist section), append a numbered step (renumber to fit the existing list):

```markdown
5. Spooler RAW capture (release trains that change `native/spooler-raw/` or the
   transport layer): on a Windows machine, run
   `powershell -ExecutionPolicy Bypass -File scripts/setup-capture-printer.ps1`
   elevated, then `pnpm vitest run tests/spooler-raw-capture.test.ts` — the
   byte-exact capture test must PASS (it auto-skips without the printer).
   Teardown: `Remove-Printer PrintAgentCapture`. Real-hardware pass/fail stays
   tracked as R-VAL-4 (printer-compatibility §6).
```

- [ ] **Step 5: Gate + commit**

Run: `pnpm test && pnpm lint`
Expected: all green (capture test skips).

```bash
git add tests/spooler-raw-capture.test.ts scripts/setup-capture-printer.ps1 docs/operations.md
git commit -m "test(transport): opt-in file-port byte-exact capture for spooler_raw (ADR-10)"
```

---

### Task 12: Documentation sync

**Files:**
- Modify: `docs/api-contract.md`
- Modify: `docs/transport-adapters.md`
- Modify: `docs/printer-compatibility.md`
- Modify: `docs/production-readiness.md`

- [ ] **Step 1: `docs/api-contract.md` §4** — update the merge-policy paragraph (lines ~236–242). Replace:

> v1 applies `tcp_raw` with IP-literal hosts only — a config containing a hostname, `spooler_raw` (until P7), or `usb` (v1.1) printer, a duplicate `printer_id`, or an empty `name` is rejected whole (nothing applied).

with:

> v1 applies `tcp_raw` with IP-literal hosts only (no DNS surface) and `spooler_raw` (`windows_printer_name` ≤ 128 chars, non-empty; the printer must be installed on the agent machine at print time — otherwise jobs fail with `printer_not_found`). A config containing a hostname, `usb` (v1.1) printer, a duplicate `printer_id`, or an empty `name`/`windows_printer_name` is rejected whole (nothing applied).

- [ ] **Step 2: `docs/transport-adapters.md`** — add a section after the tcp_raw section (before "Adding a future transport adapter"):

```markdown
## v1 (A2) shipped transport: Windows spooler RAW

- **Own N-API shim** (`native/spooler-raw/`, ADR-4): `OpenPrinterW →
  StartDocPrinterW(DATATYPE "RAW") → WritePrinter → EndDocPrinter`. One RAW
  spooler job per `write()`; runs on an N-API AsyncWorker (main thread never
  blocks). The addon is dlopen'd lazily — tcp_raw-only installs never load it.
- **Semantics.** A resolved `write()` means **Windows accepted (spooled) the
  job** — never "printed". The vendor driver may buffer or hold the job
  (R-VAL-4 duplicate risk); this feeds the existing ambiguity/duplicate-policy
  flow. Media errors (paper-out, cover-open) are invisible, same as TCP
  (R-VAL-8 wording applies).
- **Endpoint.** `windowsPrinterName` (1–128 chars) lives in the printer store
  like any approved destination. Existence is validated at open/healthCheck
  time by an `OpenPrinterW` probe — printers can be installed/uninstalled
  after pairing, so the schema does not freeze the machine state.
- **Error mapping.** Existing codes kept; one documented addition:
  - `printer_not_found` — the `OpenPrinterW` probe found no such printer.
  - everything else (StartDoc/Write/EndDoc failures, access denied) →
    `write_failed` with the Windows error in the message.
- **Evidence.** Unit tests run against an injected fake bridge (ADR-10);
  byte-exact output is proven by the opt-in file-port capture test
  (`tests/spooler-raw-capture.test.ts`, `scripts/setup-capture-printer.ps1`).
  Real-hardware validation stays open under R-VAL-4 (§6).
```

Also update the "Adding a future transport adapter" checklist intro list `(`spooler_raw`, `usb`)` → `(`usb`)` and the registry comment reference if it names spooler_raw as future. Check `src/main/transport/registry.ts` — its old comment was already removed in Task 5.

- [ ] **Step 3: `docs/printer-compatibility.md`** — update two spots:
  - §3 row (line ~37): keep the mechanism text but change the trailing status `v1` note to reflect shipped-with-capture, e.g. append `(shipped A2 — byte-exact capture test; hardware pass/fail open R-VAL-4)`.
  - §5 dependency row (line ~73): `~100 lines; no maintained npm equivalent exists (verified)` → append `; shipped as native/spooler-raw (node-addon-api + node-gyp, MIT)`.

- [ ] **Step 4: `docs/production-readiness.md` A2** — mark status done (agent side). Replace the `Status:` line:

```markdown
- **Status:** done — agent side (2026-10-29). Own N-API shim in
  `native/spooler-raw/` + `transport/spooler-raw.ts` + registry/schema/
  config-apply support + UI dropdown + `printers:list-system` IPC. Evidence:
  `tests/spooler-raw.test.ts` (fake bridge), `tests/spooler-native.test.ts`,
  registry/schema/config-apply/IPC/UI tests, and the opt-in file-port
  capture `tests/spooler-raw-capture.test.ts`
  (`scripts/setup-capture-printer.ps1`). Byte-exact-vs-real-hardware
  evidence remains open as R-VAL-4 (B1).
```

and update the "Suggested order" line at the bottom: `A3 (parallel with A2) → …` → `A3 → B2 → B1 → C1 → C2 → C3.` (A2 is done).

- [ ] **Step 5: Commit**

```bash
git add docs/api-contract.md docs/transport-adapters.md docs/printer-compatibility.md docs/production-readiness.md
git commit -m "docs: A2 spooler RAW transport shipped — contract, adapters, readiness synced"
```

---

### Task 13: Full verification

- [ ] **Step 1: Full gate**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: every suite green; zero type/lint errors.

- [ ] **Step 2: Build + no-listen smoke (packaged-shape sanity)**

Run: `pnpm build && pnpm fuse:dev && pnpm no-listen`
Expected: build succeeds (the external addon resolves from node_modules), no-listen smoke passes (the spooler shim opens no socket — it is winspool-only).

- [ ] **Step 3: Manual smoke (dev machine, optional but recommended)**

Run: `pnpm dev` — add a printer of type "Windows printer", pick any installed printer, run "Test print". Expected: honest hand-off wording; a test page spools to that printer (or `printer_not_found` if the name vanished). Then confirm the capture evidence if the capture printer is installed: `pnpm vitest run tests/spooler-raw-capture.test.ts` must PASS.

- [ ] **Step 4: Final commit (if anything was touched)** and report completion of A2 against the spec's acceptance list.
