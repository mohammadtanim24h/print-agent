// Hardens the DEV Electron binary with the project fuse set. This script
// always resolves `require('electron')` — the dev binary. Packaged builds
// get their fuse set from `electronFuses` in electron-builder.yml; never run
// this against dist-release binaries (it would disable asar integrity).
import { flipFuses, FuseV1Options, FuseVersion } from '@electron/fuses';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electronExe = require('electron');

await flipFuses(electronExe, {
  version: FuseVersion.V1,
  [FuseV1Options.RunAsNode]: false, // no NODE_OPTIONS-style Node reuse (T6)
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false, // no inspect port in prod (AC-4)
  // Requires asar + embedded integrity headers. Packaged builds set this via
  // `electronFuses` in electron-builder.yml (keep the two sets in sync).
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,
  // onlyLoadAppFromAsar is packaging-only too (electron-builder.yml): it
  // requires asar and would break asar-less dev loading if set here.
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
});
console.log('fuses flipped on', electronExe);
