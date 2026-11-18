import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const WINDOWS_SECURITY = join(dirname(fileURLToPath(import.meta.url)), 'windows-security.ps1');
const OWNER_UID = typeof process.getuid === 'function' ? process.getuid() : null;

function fail(message) {
  throw new Error(message);
}

function windowsPowerShell() {
  const root = process.env.SystemRoot || 'C:\\Windows';
  return join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

// Windows PowerShell 5.1 must build its own module path. Started from PowerShell 7, the
// inherited PSModulePath lists PowerShell 7 modules first and Get-Acl then fails to load.
export function windowsSecurityEnvironment(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
}

function runWindowsSecurity(operation, pathname) {
  const result = spawnSync(windowsPowerShell(), [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', WINDOWS_SECURITY, operation, resolve(pathname),
  ], { encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024, env: windowsSecurityEnvironment() });
  if (result.error || result.status !== 0) {
    const combined = `${result.stderr || ''}\n${result.stdout || ''}`;
    const detail = combined.match(/Windows private-path security check failed: ([^\r\n]+)/)?.[1];
    fail(detail ? `Windows private-path security check failed: ${detail}` : 'Windows private-path security check failed');
  }
}

function checkPosixAncestors(pathname) {
  const absolute = resolve(pathname);
  const root = parse(absolute).root;
  let current = root;
  const components = relative(root, absolute).split(sep).filter(Boolean);
  for (const component of components) {
    current = join(current, component);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) fail('Private path ancestor may not be a symlink');
    if (!stat.isDirectory()) fail('Private path ancestors must be directories');
    const sticky = (stat.mode & 0o1000) !== 0;
    if ((stat.mode & 0o022) !== 0 && !sticky) fail('Private path ancestor is writable by other users');
    if (stat.uid !== OWNER_UID && stat.uid !== 0) fail('Private path ancestor has an unexpected owner');
  }
}

function canonicalPosixTarget(pathname, allowMissing = false) {
  const requested = resolve(pathname);
  const leaf = basename(requested);
  if (!leaf) fail('A filesystem root cannot be a private channel path');
  try {
    const requestedStat = lstatSync(requested);
    if (requestedStat.isSymbolicLink()) fail('Private path may not be a symlink');
    const parent = resolve(dirname(requested));
    const canonicalParent = realpathSync(parent);
    return join(canonicalParent, leaf);
  } catch (error) {
    if (!allowMissing || error.code !== 'ENOENT') throw error;
  }
  let existing = resolve(dirname(requested));
  const missing = [];
  while (true) {
    try {
      const stat = lstatSync(existing);
      if (stat.isSymbolicLink() || !stat.isDirectory()) fail('Private path parent must be a real directory');
      const canonicalParent = realpathSync(existing);
      return join(canonicalParent, ...missing.reverse(), leaf);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      missing.push(basename(existing));
      existing = parent;
    }
  }
}

function verifyPosixPrivatePath(pathname, kind) {
  if (OWNER_UID === null) fail('POSIX ownership checks are unavailable');
  const current = canonicalPosixTarget(pathname);
  checkPosixAncestors(dirname(current));
  const stat = lstatSync(current);
  if (stat.isSymbolicLink()) fail('Private path may not be a symlink');
  if (kind === 'directory' && !stat.isDirectory()) fail('Private path is not a directory');
  if (kind === 'key' && !stat.isFile()) fail('Private path is not a regular file');
  if (stat.uid !== OWNER_UID || (stat.mode & 0o077) !== 0) fail('Private path owner or permissions rejected');
  return current;
}

export function verifyPrivatePath(pathname, kind) {
  if (!['directory', 'key'].includes(kind)) fail('Unsupported private-path kind');
  if (process.platform === 'win32') {
    runWindowsSecurity(kind === 'directory' ? 'verify-directory' : 'verify-key', pathname);
    return resolve(pathname);
  }
  return verifyPosixPrivatePath(pathname, kind);
}

export function ensurePrivateDirectory(pathname) {
  if (process.platform === 'win32') {
    runWindowsSecurity('ensure-directory', pathname);
    return resolve(pathname);
  }
  try {
    return verifyPosixPrivatePath(pathname, 'directory');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const requested = resolve(pathname);
  const requestedLeaf = basename(requested);
  if (!requestedLeaf) fail('A filesystem root cannot be a private channel directory');
  let existing = dirname(requested);
  const missing = [];
  while (true) {
    try {
      const stat = lstatSync(existing);
      if (stat.isSymbolicLink() || !stat.isDirectory()) fail('Private path parent must be a real directory');
      existing = realpathSync(existing);
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      missing.push(basename(existing));
      existing = parent;
    }
  }
  checkPosixAncestors(existing);
  let current = existing;
  for (const component of [...missing.reverse(), requestedLeaf]) {
    current = join(current, component);
    try { mkdirSync(current, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('Private path component is not a real directory');
    if (stat.uid !== OWNER_UID || (stat.mode & 0o077) !== 0) fail('New private directory has insecure owner or permissions');
  }
  return verifyPosixPrivatePath(current, 'directory');
}
