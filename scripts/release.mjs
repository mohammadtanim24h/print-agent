// Release driver: bump version, commit, tag, push. The Release workflow does
// the rest (build, package, smoke, GitHub Release). Refuses to overwrite an
// existing tag. Usage: pnpm release patch|minor|major
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PARTS = ['patch', 'minor', 'major'];

/** Pure semver bump. Throws on unparseable input. */
export function nextVersion(version, part) {
  const parts = version.split('.');
  if (parts.length !== 3 || parts.some((p) => !/^\d+$/.test(p))) {
    throw new Error(`unparseable version: ${version}`);
  }
  const [major, minor, patch] = parts.map(Number);
  switch (part) {
    case 'major':
      return `${(major ?? 0) + 1}.0.0`;
    case 'minor':
      return `${major ?? 0}.${(minor ?? 0) + 1}.0`;
    case 'patch':
      return `${major ?? 0}.${minor ?? 0}.${(patch ?? 0) + 1}`;
    default:
      throw new Error(`unknown part: ${part}`);
  }
}

/** Pure preflight over captured git state. Returns failure strings (empty = go). */
export function preflightFailures({ status, branch, behindCount, existingTag, part }) {
  const failures = [];
  if (!PARTS.includes(part))
    failures.push(`usage: pnpm release ${PARTS.join('|')} (got "${part}")`);
  if (status.trim() !== '') failures.push('working tree not clean — commit or stash first');
  if (branch !== 'main') failures.push(`must run on main (currently on "${branch}")`);
  if (behindCount > 0) failures.push(`main is ${behindCount} commit(s) behind origin — pull first`);
  if (existingTag) failures.push(`tag already exists — refusing to overwrite`);
  return failures;
}

// --- CLI (only when executed directly; importing this module must stay
// side-effect free so the test suite can unit-test the exported rules) ---
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const run = (args) => execFileSync('git', args, { encoding: 'utf8' });
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const part = process.argv[2];
  const pkgPath = join(root, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

  let existingTag = false;
  if (PARTS.includes(part)) {
    const tag = `v${nextVersion(pkg.version, part)}`;
    try {
      run(['rev-parse', '-q', '--verify', `refs/tags/${tag}`]);
      existingTag = true;
    } catch {
      // tag absent — the good case
    }
  }

  const status = run(['status', '--porcelain']);
  const branch = run(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  execFileSync('git', ['fetch', 'origin', 'main'], { stdio: 'ignore' });
  const behindCount = Number.parseInt(run(['rev-list', '--count', 'HEAD..origin/main']).trim(), 10);

  const failures = preflightFailures({ status, branch, behindCount, existingTag, part });
  if (failures.length > 0) {
    for (const f of failures) console.error(`REFUSED: ${f}`);
    process.exit(1);
  }

  const tag = `v${nextVersion(pkg.version, part)}`;
  const version = nextVersion(pkg.version, part);
  pkg.version = version;
  // package.json is 2-space indented; this preserves the existing formatting.
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

  execFileSync('git', ['add', 'package.json']);
  execFileSync('git', ['commit', '-m', `chore(release): ${tag}`], { stdio: 'inherit' });
  execFileSync('git', ['tag', tag]);
  execFileSync('git', ['push', 'origin', 'main'], { stdio: 'inherit' });
  execFileSync('git', ['push', 'origin', tag], { stdio: 'inherit' });
  console.log(`Pushed ${tag} — the Release workflow builds and publishes the GitHub Release.`);
}
