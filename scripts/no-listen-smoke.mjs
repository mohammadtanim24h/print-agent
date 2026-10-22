// AC-4 smoke: launch the built app and assert it opens zero LISTEN sockets.
// Windows-only (project target). Run after `pnpm build`: `pnpm no-listen`.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const electronExe = require('electron'); // path to electron.exe when run from Node
const root = dirname(fileURLToPath(import.meta.url));

const SETTLE_MS = 7000;

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function electronPids() {
  const out = require('node:child_process').execSync(
    'tasklist /FI "IMAGENAME eq electron.exe" /FO CSV /NH',
    { encoding: 'utf8' },
  );
  return new Set(
    out
      .split(/\r?\n/)
      .filter((l) => l.startsWith('"electron.exe"'))
      .map((l) => l.split('","')[1])
      .filter(Boolean),
  );
}

function listeningLines() {
  return require('node:child_process')
    .execSync('netstat -ano -p tcp', { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter((l) => l.includes('LISTENING'));
}

const child = spawn(electronExe, [join(root, '../out/main/main.js')], {
  cwd: join(root, '..'),
  stdio: 'ignore',
  windowsHide: true,
});

await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

try {
  const pids = electronPids();
  if (pids.size === 0) fail('no electron processes found — app did not start');

  const offenders = listeningLines().filter((line) => {
    const pid = line.trim().split(/\s+/).at(-1);
    return pid !== undefined && pids.has(pid);
  });

  if (offenders.length > 0) {
    fail(`LISTEN sockets found:\n${offenders.join('\n')}`);
  }
  console.log(`OK: ${pids.size} electron process(es), zero LISTEN sockets (AC-4).`);
} finally {
  // /T kills the whole process tree (gpu/renderer helpers included).
  spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
}
