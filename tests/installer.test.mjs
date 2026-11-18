import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

test('shell and PowerShell installers require a local archive or HTTPS source with SHA-256', async () => {
  const shell = await readFile(join(root, 'install', 'install.sh'), 'utf8');
  const powershell = await readFile(join(root, 'install', 'install.ps1'), 'utf8');
  assert.match(shell, /--sha256/);
  assert.match(shell, /npm install --global --prefix .* --ignore-scripts/);
  assert.match(shell, /Launcher:/);
  assert.match(shell, /https/);
  assert.match(powershell, /Sha256/);
  assert.match(powershell, /Get-FileHash/);
  assert.match(powershell, /Invoke-WebRequest/);
  assert.match(powershell, /--prefix/);
  assert.match(powershell, /npm\.cmd/);
  assert.match(powershell, /--ignore-scripts/);
  assert.doesNotMatch(powershell, /iex/i);
});

test('shell installer rejects remote archives without a digest before invoking npm', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'campaign-installer-test-'));
  try {
    const npm = join(dir, 'npm');
    const marker = join(dir, 'npm-called');
    await writeFile(npm, `#!/bin/sh\nprintf called > '${marker}'\n`);
    await chmod(npm, 0o755);
    const result = spawnSync('bash', [join(root, 'install', 'install.sh'), 'https://example.invalid/package.tgz'], {
      encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--sha256/);
    await assert.rejects(readFile(marker));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('shell installer checks the digest and refuses non-HTTPS remote URLs', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'campaign-installer-test-'));
  try {
    const npm = join(dir, 'npm');
    const npmArgs = join(dir, 'npm-args');
    await writeFile(npm, '#!/bin/sh\nprintf "%s\\n" "$@" > "$NPM_ARGS"\n');
    await chmod(npm, 0o755);
    const badUrl = spawnSync('bash', [join(root, 'install', 'install.sh'), 'http://example.invalid/package.tgz', '--sha256', '0'.repeat(64)], {
      encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, NPM_ARGS: npmArgs },
    });
    assert.notEqual(badUrl.status, 0);
    assert.match(badUrl.stderr, /HTTPS/);

    const archive = join(dir, 'package.tgz');
    await writeFile(archive, 'synthetic local archive');
    const wrongDigest = createHash('sha256').update('not this file').digest('hex');
    const mismatch = spawnSync('bash', [join(root, 'install', 'install.sh'), archive, '--sha256', wrongDigest], {
      encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, NPM_ARGS: npmArgs },
    });
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /SHA-256/);

    const digest = createHash('sha256').update('synthetic local archive').digest('hex');
    const accepted = spawnSync('sh', [join(root, 'install', 'install.sh'), archive, '--sha256', digest], {
      encoding: 'utf8',
      env: { ...process.env, HOME: dir, PATH: `${dir}:${process.env.PATH}`, NPM_ARGS: npmArgs },
    });
    assert.equal(accepted.status, 0, accepted.stderr);
    const args = await readFile(npmArgs, 'utf8');
    assert.match(args, /--prefix/);
    assert.match(args, /--ignore-scripts/);
    assert.match(args, /campaign-manager-install|package\.tgz/);
    assert.match(accepted.stdout, /Launcher:/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('PowerShell installer verifies a local SHA-256 and uses npm.cmd without invoking it on mismatch', { skip: process.platform !== 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'campaign-installer-test-'));
  try {
    const npmArgs = join(dir, 'npm-args.txt');
    const npm = join(dir, 'npm.cmd');
    await writeFile(npm, '@echo off\necho %* > "%NPM_ARGS%"\nexit /b 0\n');
    const archive = join(dir, 'local-package.tgz');
    await writeFile(archive, 'synthetic local archive');
    const digest = createHash('sha256').update('synthetic local archive').digest('hex');
    const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const run = sha => spawnSync(powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', join(root, 'install', 'install.ps1'), '-Source', archive, '-Sha256', sha,
    ], {
      encoding: 'utf8',
      // Drop a PowerShell 7 parent's PSModulePath so Windows PowerShell 5.1 loads its own Get-FileHash.
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath')), LOCALAPPDATA: dir, NPM_ARGS: npmArgs, PATH: `${dir};${process.env.PATH}` },
      timeout: 15_000,
    });

    const rejected = run('0'.repeat(64));
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr + rejected.stdout, /SHA-256 digest mismatch/);
    await assert.rejects(readFile(npmArgs));

    const accepted = run(digest);
    assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
    const npmCommand = await readFile(npmArgs, 'utf8');
    assert.match(npmCommand, /--prefix/);
    assert.match(npmCommand, /--ignore-scripts/);
    assert.match(npmCommand, /local-package\.tgz/);
    assert.match(accepted.stdout, /campaign-manager\.cmd/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

