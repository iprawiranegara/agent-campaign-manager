import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createStore } from '../plugin/packages/campaign-core/src/core.mjs';

const root = join(fileURLToPath(new URL('..', import.meta.url)));
const cli = join(root, 'bin', 'campaign-manager.mjs');
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

function run(args, env = {}, options = {}) {
  const childEnv = { ...process.env };
  delete childEnv.CODEX_RESEARCH_CAMPAIGN_STATE_DIR;
  delete childEnv.XDG_STATE_HOME;
  delete childEnv.HERMES_HOME;
  Object.assign(childEnv, env);
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: options.cwd || root,
    encoding: 'utf8',
    env: childEnv,
    timeout: 15_000,
  });
}

async function fixture(fn) {
  const scratchRoot = process.platform === 'win32'
    ? join(process.env.USERPROFILE || tmpdir(), '.campaign-manager-tests')
    : '/tmp';
  if (process.platform === 'win32') await mkdir(scratchRoot, { recursive: true });
  const scratch = await mkdtemp(join(scratchRoot, 'campaign-cli-'));
  const dir = join(scratch, 'private');
  await mkdir(dir, { mode: 0o700 });
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

function initState(state, env = {}) {
  const result = run(['init', '--state-dir', state], env);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('package exposes the campaign-manager executable without install lifecycle hooks', async () => {
  assert.equal(packageJson.bin['campaign-manager'], 'bin/campaign-manager.mjs');
  assert.equal(packageJson.engines.node, '>=24');
  for (const scriptName of ['preinstall', 'install', 'postinstall', 'prepare']) {
    assert.equal(packageJson.scripts?.[scriptName], undefined, `${scriptName} must not run during install`);
  }
});

test('help and version are available without touching campaign state', async () => fixture(async dir => {
  const help = run(['--help'], { CODEX_RESEARCH_CAMPAIGN_STATE_DIR: join(dir, 'state') });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /init/);
  assert.match(help.stdout, /prepare <codex\|claude\|hermes>/);
  assert.match(help.stdout, /dashboard/);

  const version = run(['--version'], { CODEX_RESEARCH_CAMPAIGN_STATE_DIR: join(dir, 'state') });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), packageJson.version);
  assert.equal(existsSync(join(dir, 'state')), false, 'help and version must not create state');
}));

test('init prefers the explicit campaign state environment path and creates an empty usable ledger', async () => fixture(async dir => {
  const state = join(dir, 'explicit-state');
  const result = run(['init'], {
    CODEX_RESEARCH_CAMPAIGN_STATE_DIR: state,
    XDG_STATE_HOME: join(dir, 'xdg'),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).state_dir, state);
  assert.equal(existsSync(join(state, 'campaigns.sqlite3')), true);
  assert.equal(existsSync(join(dir, 'xdg', 'omo-research')), false);
  const store = createStore({ stateDir: state });
  try { assert.deepEqual(store.list().campaigns, []); } finally { store.dispose(); }
}));

test('init uses XDG_STATE_HOME when no explicit campaign state path is set', async () => fixture(async dir => {
  const xdg = join(dir, 'xdg-state');
  const expected = join(xdg, 'omo-research');
  await mkdir(xdg, { mode: 0o700 });
  const result = run(['init'], { XDG_STATE_HOME: xdg });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).state_dir, expected);
  assert.equal(existsSync(join(expected, 'campaigns.sqlite3')), true);
}));

test('prepare codex keeps a stable explicit output and does not overwrite it', async () => fixture(async dir => {
  const state = join(dir, 'state');
  initState(state);
  const out = join(dir, 'codex');
  const prepared = run(['prepare', 'codex', '--state-dir', state, '--output', out]);
  assert.equal(prepared.status, 0, prepared.stderr);
  const config = JSON.parse(await readFile(join(out, 'plugin', '.mcp.json'), 'utf8'));
  assert.equal(config.mcpServers['research-campaign'].env.CAMPAIGN_STATE_DIR, state);
  const marker = join(out, 'reviewed-by-owner.txt');
  await writeFile(marker, 'preserve');
  const duplicate = run(['prepare', 'codex', '--state-dir', state, '--output', out]);
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /already exists|Choose a new/);
  assert.equal(await readFile(marker, 'utf8'), 'preserve');
}));

test('prepare hermes provisions channels under the selected native profile before producing its fragment', async () => fixture(async dir => {
  const state = join(dir, 'state');
  initState(state);
  const profile = join(dir, 'hermes-profile');
  const output = join(dir, 'hermes-install');
  const env = process.platform === 'win32'
    ? { LOCALAPPDATA: dir }
    : { HERMES_HOME: profile };
  const result = run(['prepare', 'hermes', '--state-dir', state, '--output', output], env);
  assert.equal(result.status, 0, result.stderr);
  const configuredProfile = process.platform === 'win32' ? join(dir, 'hermes') : profile;
  const channels = join(configuredProfile, 'plugin-data', 'campaign-manager', 'channels');
  assert.equal(existsSync(channels), true);
  const fragment = JSON.parse(await readFile(join(output, 'config.fragment.json'), 'utf8'));
  assert.equal(fragment.plugins.entries['campaign-manager'].settings.channel_dir, channels);
  assert.equal(fragment.mcp_servers['campaign-router'].args.includes(channels), true);
}));

test('dashboard refuses to initialize a missing ledger', async () => fixture(async dir => {
  const state = join(dir, 'missing-state');
  const result = run(['dashboard', '--state-dir', state, '--port', '0']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /campaign|state|database/i);
  assert.equal(existsSync(state), false);
}));

test('dashboard command listens on loopback and exits cleanly after SIGTERM', async () => fixture(async dir => {
  const state = join(dir, 'state');
  initState(state);
  const child = spawn(process.execPath, [cli, 'dashboard', '--state-dir', state, '--port', '0'], {
    cwd: root,
    env: { ...process.env, CODEX_RESEARCH_CAMPAIGN_STATE_DIR: '', XDG_STATE_HOME: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = createInterface({ input: child.stdout });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const listenLine = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`dashboard startup timed out: ${stderr}`)), 10_000);
    stdout.once('line', line => { clearTimeout(timeout); resolve(line); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`dashboard exited ${code}: ${stderr}`)); });
  });
  try {
    const match = listenLine.match(/^Campaign dashboard listening on http:\/\/127\.0\.0\.1:(\d+)$/);
    assert.ok(match, listenLine);
    const response = await fetch(`http://127.0.0.1:${match[1]}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok', read_only: true });
  } finally {
    if (process.platform === 'win32') {
      child.kill();
      await new Promise(resolve => child.once('exit', resolve));
    }
    else {
      child.kill('SIGTERM');
      const exit = await new Promise(resolve => child.once('exit', resolve));
      assert.equal(exit, 0, stderr);
    }
    stdout.close();
  }
}));

