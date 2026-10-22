# Virtual ESC/POS Printer Research (Windows x64 Electron print agent)

Researched: 2026-10-22. Scope: hardware-free automated testing of ESC/POS output for
TCP 9100 / USB / Windows spooler transports. All URLs verified via GitHub/npm APIs on this date.

---

## 1. Raw TCP mock (port 9100)

### Protocol reality check (verified)
Port 9100 (JetDirect/AppSocket/"RAW") is **not a protocol** — it is a plain TCP socket:
open socket, write bytes, close. No negotiation, no handshake, **no application-level ACK**
(fire-and-forget). Sources:
- http://hacking-printers.net/wiki/index.php?title=Port_9100_printing
- https://www.papercut.com/blog/print_tips/what-is-so-important-about-port-9100
- https://www.brooksnet.com/port-9100-printing

Caveat: ESC/POS itself defines **bidirectional** status over the same socket via
`DLE EOT n` (0x10 0x04 n → 1 status byte back). Many printers/network configs return nothing
on 9100 (write-only), so clients polling status can hang. **Your mock should accept bytes
silently, and optionally answer DLE EOT with a 1-byte status** (e.g. 0x12 = online, ready).
Node-thermal-printer's `status`/`isConnected` rely on this. See Epson/Star ESC/POS command
manual: https://www.starmicronics.com/support/Mannualfolder/escpos_cm_en.pdf

### npm tools (checked via registry, 2026-10-22)
| Package | What it does | Status |
|---|---|---|
| **escpos-emulator** (v0.3.0, MIT, published 2026-09-16) | TCP listener on :9100, **parses** ESC/POS, live HTML preview, **REST API** for test assertions, WebSocket, Docker image `ghcr.io/lezram/escpos-emulator`. Emulates Epson TM-M30III (42 chars/line, 80mm). REST: `GET /api/printers/:id/receipts/last`, `DELETE /api/printers/:id/receipts`, `POST /api/printers/:id/toggle` (simulate offline). Only dep: `ws`. Repo: github.com/lezram/escpos-emulator (new, 8 stars, no LICENSE file in repo yet — npm declares MIT). | Best fit; run `npx escpos-emulator` in CI |
| escpos (v3.0.0-alpha.6, MIT) | ESC/POS *generator/driver*, not a simulator. | Not a mock |

There is no established package literally named `escpos-simulator` on npm.

### Related non-npm TCP emulators
- **Garletz/escpos-virtual-printer-emulator** — Rust, MIT, 124 stars, pushed 2026-08; GUI, port 9100, Windows installer. https://github.com/Garletz/escpos-virtual-printer-emulator
- **jflaflamme/escpresso** — Rust, MIT, pushed 2026-09; TCP :9100 + GUI preview. https://github.com/jflaflamme/escpresso
- **roydejong/EscPosEmulator** — C#, 73 stars, pushed 2025-07, no license file. https://github.com/roydejong/EscPosEmulator
- **gilbertfl/escpos-netprinter** — Python, AGPL-3.0, 61 stars, pushed 2026-10; containerized, renders receipts as HTML. https://github.com/gilbertfl/escpos-netprinter (AGPL — avoid linking into product; fine as external test service)
- **Virtual-Printer.online** — hosted virtual printer with public raw TCP port (third-party dependency; avoid in CI). https://virtual-printer.online

A minimal in-house mock is ~30 lines of Node (`net.createServer`, append chunks to a buffer,
optionally reply to DLE EOT). Worth having anyway so unit tests don't need an external process.

---

## 2. USB device simulation (feasibility notes)

- **usbipd-win does NOT create virtual devices.** It shares *real* USB devices attached to
  Windows out to other machines (WSL2/Hyper-V). It cannot make Windows *see* a fake USB
  printer. https://github.com/dorssel/usbipd-win ; https://learn.microsoft.com/en-us/windows/wsl/connect-usb
- The realistic route is a **USB gadget**: a Linux board (Raspberry Pi Zero) enumerating as a
  USB printer-class device to the Windows host, writing received bytes to `/dev/g_printer0` or a
  configfs/libcomposite function, then forwarding them to your TCP mock.
  - Working reference project: **Raspberryy/Emulated_USB_Printer** (C, GPL-3.0, 105 stars,
    pushed 2026-03): Pi Zero as bus-powered USB 2.0 printer. https://github.com/Raspberryy/Emulated_USB_Printer
  - Background: https://forums.raspberrypi.com/viewtopic.php?t=254595 ;
    https://unix.stackexchange.com/questions/408293
- Cheaper half-measure: Teensy/Arduino boards can enumerate as USB printer-class devices
  (https://forums.adafruit.com/viewtopic.php?t=50368), but capturing full streams is fiddly.

**Verdict:** feasible but requires hardware + a dedicated board per dev/CI runner. Poor
CI-friendliness. Recommendation: abstract the transport so USB is one pluggable backend, and
test USB with a mocked backend + (optionally) one manual Pi-Zero smoke test.

---

## 3. Windows spooler → file ("FILE:" port / Generic / Text Only)

- The spooler supports **RAW datatype** pass-through: app submits raw bytes with datatype
  `RAW` (via `StartDocPrinter`/`WritePrinter`, or Electron-side libraries like `node-printer`),
  and the spooler writes them to the port. If the port is a **local port mapped to a file path**
  (Add Printer → Local Port → `C:\path\out.prn`), the bytes land in a file you can assert on.
  `FILE:` port also works but **prompts for a filename in a GUI dialog** each print — bad for
  automation; use a fixed-path local port instead.
- **Gotcha:** installing the "Generic / Text Only" driver means the driver *renders* the job
  (text mangling, CR/LF/backspace translation) — output is **not** guaranteed to be your raw
  ESC/POS bytes. For byte-exact capture you want a raw-capable queue (most 80mm receipt
  drivers install a RAW port monitor) — same technique used to send ZPL/ESC/POS:
  - https://qz.io/wiki/raw (QZ Tray raw printing guide)
  - https://mike42.me/blog/2015-04-getting-a-usb-receipt-printer-working-on-windows
  - RedMon port redirection (capture spooled data into a program): https://stackoverflow.com/questions/11420237
- Known Windows-update breakage of the Generic/Text Only driver (KB5039211/KB5039212):
  https://www.accessforever.org/post/windows-generic-text-only-printer-driver-fails-with-access-reports
  — another reason not to depend on that driver in tests.

**Verdict:** usable as a second test surface for your spooler transport: create at setup
one local printer named e.g. "VPRINT-RAW" with a fixed local-port file. Assert on the
`.prn` file bytes. Avoid Generic/Text Only driver semantics.

---

## 4. ESC/POS parsers for assertions (decode bytes → readable)

No single dominant npm decoder exists. Options, by practicality:

- **escpos-emulator (npm)** — already parses the stream and exposes parsed receipts as JSON
  via REST (`/api/printers/:id/receipts/last`); this is the shortest path to
  "assert receipt contains a bold total line" (bold state is tracked per line).
- **amin-norollah/EscPosInspector** — TypeScript, browser-based ESC/POS debugger/decoder +
  emulator; pushed 2026-07, ~1 star, no license file. https://github.com/amin-norollah/EscPosInspector
- **aycyang/escpos-ts** — TypeScript ESC/POS parser & builder, BSD-3-Clause, pushed 2026-06.
  https://github.com/aycyang/escpos-ts
- **thaolt/escpos_parser** — C library for parsing raw ESC/POS, Apache-2.0, pushed 2026-09.
  https://github.com/thaolt/escpos_parser
- **maehw/EscPosDecoder** — Python, GPL-3.0, last push 2022 (stale).
  https://github.com/maehw/EscPosDecoder
- **python-escpos** itself has a `Dummy` connector that *captures* the byte stream in memory
  (great for generator-side tests, not a decoder):
  https://python-escpos.readthedocs.io (see `escpos.printer.Dummy`); PyESCPOS also ships a
  Dummy printer: https://pypi.org/project/PyESCPOS/
- Fallback: write a thin parser for the subset you emit (`ESC @`, `ESC a`, `ESC E`, `ESC !`,
  `GS !`, `GS v 0`, cut, feed) — ESC/POS is state-machine simple for text+styles.

---

## 5. Dedicated virtual-printer projects — status summary

| Project | Lang | License | Last push | Stars | Notes |
|---|---|---|---|---|---|
| lezram/escpos-emulator (npm) | TS | MIT (npm; repo file missing) | 2026-09 | 8 | TCP 9100 + REST API; CI-ready |
| Garletz/escpos-virtual-printer-emulator | Rust | MIT | 2026-08 | 124 | Windows GUI |
| gilbertfl/escpos-netprinter | Python | AGPL-3.0 | 2026-10 | 61 | Docker, HTML receipts |
| jflaflamme/escpresso | Rust | MIT | 2026-09 | 26 | GUI preview |
| Raspberryy/Emulated_USB_Printer | C | GPL-3.0 | 2026-03 | 105 | USB gadget (Pi Zero) |
| roydejong/EscPosEmulator | C# | none | 2025-07 | 73 | Desktop app |

---

## 6. How other open-source POS projects test without hardware

- **python-escpos**: tests run entirely against the in-process `Dummy` connector
  (byte-capturing); no hardware, no network. Reference:
  https://github.com/python-escpos/python-escpos (tests/), docs:
  https://python-escpos.readthedocs.io
- **node-thermal-printer**: repo (checked 2026-10) contains **no automated test suite** —
  only `examples/` (`connected.js`, `status.js`) run manually against real printers; MIT,
  916 stars, pushed 2026-08. https://github.com/Klemen1337/node-thermal-printer
  (I.e., this part of the ecosystem is weak — don't copy it.)
- **Odoo IoT Box**: routes ESC/POS through **CUPS** on the box; testing is done with a real or
  "Virtual IoT Box" (VM) plus real printers attached via CUPS queues; docs:
  https://www.odoo.com/documentation/16.0/applications/general/iot/config/troubleshooting.html ;
  related: https://github.com/odoo/odoo/issues/82872 ("we use CUPS to send ESC/POS").
- Community pattern (receipt/label SDKs, e.g. portakal issue #26,
  https://github.com/productdevbook/portakal/issues/26): a **virtual/mock printer for CI** is a
  widely requested missing feature — building one is a legitimate product decision, not a hack.

---

## Recommendation — most practical testing strategy

Layered, cheapest-first:

1. **Unit level (no process):** define a `Transport` interface (TCP/USB/Spooler implement it).
   Unit-test ESC/POS *generation* by writing to an in-memory `BufferTransport` (analogous to
   python-escpos `Dummy`) and asserting on bytes (`expect(buf).toContain(Buffer.from([0x1b,0x45]))`).
2. **Integration level (TCP):** run `npx escpos-emulator` (or a 30-line in-house `net` mock) in
   CI; point the agent at `localhost:9100`; assert via its REST API
   (`GET /api/printers/:id/receipts/last`) that the parsed receipt has the bold total line.
   Implement `DLE EOT` status reply in whatever mock you use, since your status polling code
   needs it.
3. **Spooler level:** install a one-time "VPRINT-RAW" local printer with a fixed local-port
   file (`C:\test\out.prn`); submit with datatype RAW; assert on the file bytes. Avoid the
   Generic/Text Only driver (mangles bytes, breaks under Windows updates).
4. **USB:** mocked transport in CI only; optional one-off manual smoke test with a Pi Zero
   running `Emulated_USB_Printer` before releases. Do not attempt usbipd-win-based virtual
   devices — it is the wrong direction (shares real devices out, doesn't create them).

This gives deterministic hardware-free tests for all three transports, with byte-level asserts
(generation) and semantic asserts (parsed receipt) covered.
