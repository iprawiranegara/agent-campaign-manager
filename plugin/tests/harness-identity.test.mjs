import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { createStore } from '../packages/campaign-core/src/core.mjs';

const root = join(import.meta.dirname, '..');
const serverPath = join(root, 'packages/mcp-server/src/server.mjs');

async function seed() {
  const dir = await mkdtemp(join(tmpdir(), 'campaign-harness-'));
  const scope = join(dir, 'scope'); await mkdir(scope);
  const stateDir = join(dir, 'state');
  const store = createStore({ stateDir, allowCreate: true });
  const alpha = store.create({ campaign_id: 'alpha-harness', objective: 'Harness-neutral objective', scope_roots: [scope], actor: 'owner' });
  store.dispose();
  return { dir, stateDir, alpha };
}

function start(env) {
  const child = spawn(process.execPath, [serverPath], { cwd: tmpdir(), env: { ...process.env, CODEX_CAMPAIGN_CONTEXT_HOOKS: '', CAMPAIGN_HARNESS: '', CAMPAIGN_CONTEXT_HOOKS: '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let serial = 0; let stderr = '';
  child.stderr.on('data', b => { stderr += b; });
  createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); pending.get(m.id)?.(m); pending.delete(m.id); });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++serial; const t = setTimeout(() => reject(new Error('timeout ' + stderr)), 8000);
    pending.set(id, m => { clearTimeout(t); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const value = async (name, args = {}, meta) => (await rpc('tools/call', { name, arguments: args, ...(meta ? { _meta: meta } : {}) })).result.structuredContent;
  const stop = () => new Promise(r => { child.once('exit', r); child.kill('SIGTERM'); });
  return { child, rpc, value, stop, stderr: () => stderr };
}

function exitOf(env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [serverPath], { env: { ...process.env, CODEX_CAMPAIGN_CONTEXT_HOOKS: '', CAMPAIGN_HARNESS: '', CAMPAIGN_CONTEXT_HOOKS: '', ...env }, stdio: ['pipe', 'ignore', 'pipe'] });
    let err = ''; child.stderr.on('data', b => { err += b; });
    child.on('exit', code => resolve({ code, err }));
  });
}

const bindArgs = (a) => ({ campaign_id: a.campaign_id, identity_digest: a.identity_digest, expected_version: a.version, actor: 'owner', run_id: 'run-1', thread_id: 'forged-thread', client: 'forged-client' });

test('claude profile: per-process identity, real harness name, reminder after compaction', async () => {
  const { dir, stateDir, alpha } = await seed();
  const a = start({ CODEX_RESEARCH_CAMPAIGN_STATE_DIR: '', CAMPAIGN_STATE_DIR: stateDir, CAMPAIGN_HARNESS: 'claude', CAMPAIGN_CONTEXT_HOOKS: '1' });
  const b = start({ CAMPAIGN_STATE_DIR: stateDir, CAMPAIGN_HARNESS: 'claude', CAMPAIGN_CONTEXT_HOOKS: '1' });
  try {
    const init = await a.rpc('initialize', {});
    assert.equal(init.result.serverInfo.name, 'agent-campaign-manager');
    const tools = (await a.rpc('tools/list', {})).result.tools.map(t => t.name);
    assert.ok(tools.includes('campaign_context_hook'));
    // Claude sends no thread id in _meta; calls must still work.
    const listed = await a.value('campaign_list', {}, { 'claudecode/toolUseId': 'toolu_x', progressToken: 1 });
    assert.equal(listed.campaigns.length, 1);
    const detail = await a.value('campaign_detail', { campaign_id: 'alpha-harness' });
    const bound = await a.value('campaign_bind', bindArgs(detail));
    assert.notEqual(bound.code, 'CAMPAIGN_RUNTIME_IDENTITY_REQUIRED', JSON.stringify(bound));
    const status = await a.value('campaign_status', {});
    assert.equal(status.bound_run.client, 'claude');
    assert.match(status.bound_run.thread_id, /^claude-process-[0-9a-f-]{36}$/);
    // Another process (another Claude session) is not bound.
    assert.equal((await b.value('campaign_status', {})).code, 'CAMPAIGN_NOT_BOUND');
    // Reminder: nothing before compaction, checkpoint after SessionStart(compact).
    const hook = async (event, extra = {}) => {
      const r = await a.value('campaign_context_hook', { event, ...extra });
      return r.hookSpecificOutput?.additionalContext ?? '';
    };
    assert.equal(await hook('PostToolUse'), '');
    const text = await hook('SessionStart', { source: 'compact' });
    assert.match(text, /Campaign: alpha-harness v/);
    assert.equal(await hook('PostToolUse'), '', 'unchanged reminder is suppressed');
    assert.equal(await hook('SessionStart', { source: 'startup' }), '');
    const after = createStore({ stateDir }); assert.equal(after.detail('alpha-harness').version, alpha.version); after.dispose();
  } finally { await a.stop(); await b.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('codex profile (new and legacy spelling) still requires native threadId', async () => {
  const { dir, stateDir } = await seed();
  for (const env of [{ CAMPAIGN_HARNESS: 'codex', CAMPAIGN_CONTEXT_HOOKS: '1' }, { CODEX_CAMPAIGN_CONTEXT_HOOKS: '1' }]) {
    const s = start({ CAMPAIGN_STATE_DIR: stateDir, ...env });
    try {
      assert.equal((await s.value('campaign_list', {})).code, 'CAMPAIGN_RUNTIME_IDENTITY_REQUIRED');
      assert.equal((await s.value('campaign_list', {}, { threadId: 't-1' })).campaigns.length, 1);
      const detail = await s.value('campaign_detail', { campaign_id: 'alpha-harness' }, { threadId: 't-1' });
      await s.value('campaign_bind', bindArgs(detail), { threadId: 't-1' });
      const status = await s.value('campaign_status', {}, { threadId: 't-1' });
      assert.equal(status.bound_run.client, 'codex');
      assert.equal(status.bound_run.thread_id, 't-1');
    } finally { await s.stop(); }
  }
  await rm(dir, { recursive: true, force: true });
});

test('default mode keeps the 14-tool contract and caller-supplied identity (Hermes)', async () => {
  const { dir, stateDir } = await seed();
  const s = start({ CAMPAIGN_STATE_DIR: stateDir });
  try {
    const tools = (await s.rpc('tools/list', {})).result.tools.map(t => t.name);
    assert.equal(tools.includes('campaign_context_hook'), false);
    assert.equal(tools.length, 14);
    const detail = await s.value('campaign_detail', { campaign_id: 'alpha-harness' });
    await s.value('campaign_bind', { ...bindArgs(detail), thread_id: 'hermes-route', client: 'hermes' });
    const status = await s.value('campaign_status', {});
    assert.equal(status.bound_run.client, 'hermes');
    assert.equal(status.bound_run.thread_id, 'hermes-route');
  } finally { await s.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('invalid harness configuration refuses to start', async () => {
  for (const env of [
    { CAMPAIGN_CONTEXT_HOOKS: '1' },
    { CAMPAIGN_HARNESS: 'Bad Name', CAMPAIGN_CONTEXT_HOOKS: '1' },
    { CODEX_CAMPAIGN_CONTEXT_HOOKS: '1', CAMPAIGN_HARNESS: 'claude' },
  ]) {
    const { code, err } = await exitOf(env);
    assert.equal(code, 2, JSON.stringify(env));
    assert.match(err, /agent-campaign-manager:/);
  }
});
