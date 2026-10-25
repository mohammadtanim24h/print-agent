// Hardens the Electron binary with the ADR P0 fuse set. Run against the
// packaged binary at release time; running `pnpm fuse:dev` also hardens the
// local dev binary. Packaging (P8) must repeat this — fuses live in the exe.
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
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  [FuseV1Options.GrantNetworkProtocolExtraPrivileges]: false,
});
console.log('fuses flipped on', electronExe);
