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
