// AC-4 smoke: launch the app and assert it opens zero LISTEN sockets.
// Windows-only (project target).
//   pnpm no-listen                             — dev electron against out/main
//   node scripts/no-listen-smoke.mjs <exe>     — a packaged build (release gate)
// Note: PIDs are matched by image name, so quit any running instance of the
// same binary before running this (local dev machines may have one in the tray).
import { execSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = dirname(fileURLToPath(import.meta.url));
const electronExe = process.argv[2] ?? require('electron'); // electron.exe path or packaged exe
const isDevElectron = basename(electronExe).toLowerCase() === 'electron.exe';
const imageName = basename(electronExe);

const SETTLE_MS = 7000;

function fail(message, childPid) {
  if (childPid !== undefined) {
    // /T kills the whole process tree (gpu/renderer helpers included).
    // Needed because process.exit below skips the try/finally taskkill.
    spawn('taskkill', ['/PID', String(childPid), '/T', '/F'], { stdio: 'ignore' });
  }
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function appPids() {
  const out = execSync(`tasklist /FI "IMAGENAME eq ${imageName}" /FO CSV /NH`, {
    encoding: 'utf8',
  });
  return new Set(
    out
      .split(/\r?\n/)
      .filter((l) => l.startsWith(`"${imageName}"`))
      .map((l) => l.split('","')[1])
      .filter(Boolean),
  );
}

function listeningLines() {
  return execSync('netstat -ano -p tcp', { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter((l) => l.includes('LISTENING'));
}

const child = spawn(
  electronExe,
  // The packaged exe boots its own embedded app; only dev electron needs the
  // entry script passed explicitly.
  isDevElectron ? [join(root, '../out/main/main.js')] : [],
  {
    cwd: join(root, '..'),
    stdio: 'ignore',
    windowsHide: true,
  },
);

await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

try {
  const pids = appPids();
  if (pids.size === 0) fail(`no ${imageName} processes found — app did not start`, child.pid);

  const offenders = listeningLines().filter((line) => {
    const pid = line.trim().split(/\s+/).at(-1);
    return pid !== undefined && pids.has(pid);
  });

  if (offenders.length > 0) {
    fail(`LISTEN sockets found:\n${offenders.join('\n')}`, child.pid);
  }
  console.log(`OK: ${pids.size} ${imageName} process(es), zero LISTEN sockets (AC-4).`);
} finally {
  // /T kills the whole process tree (gpu/renderer helpers included).
  spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
}
