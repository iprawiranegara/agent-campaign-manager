import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { createStore } from '../packages/campaign-core/src/core.mjs';

const root = join(import.meta.dirname, '..');
const hookTool = 'campaign_context_hook';

async function fixture(run, objective = 'Only this campaign objective') {
  const dir = await mkdtemp(join(tmpdir(), 'codex-campaign-hooks-'));
  const scope = join(dir, 'scope'); await mkdir(scope);
  const stateDir = join(dir, 'state');
  const seed = createStore({ stateDir, allowCreate: true });
  const alpha = seed.create({ campaign_id: 'alpha-private', objective, scope_roots: [scope], actor: 'owner' });
  const beta = seed.create({ campaign_id: 'beta-private', objective: 'Beta exclusive objective', scope_roots: [scope], actor: 'owner' });
  seed.dispose();
  const child = spawn(process.execPath, [join(root, 'packages/codex-mcp/src/server.mjs')], {
    cwd: root, env: { ...process.env, CODEX_RESEARCH_CAMPAIGN_STATE_DIR: stateDir, CODEX_CAMPAIGN_CONTEXT_HOOKS: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map(); let serial = 0; let stderr = '';
  child.stderr.on('data', b => { stderr += b; });
  createInterface({ input: child.stdout }).on('line', line => {
    const msg = JSON.parse(line); const done = pending.get(msg.id);
    if (done) { pending.delete(msg.id); done(msg); }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++serial; const timer = setTimeout(() => reject(new Error('RPC timeout: ' + stderr)), 8000);
    pending.set(id, msg => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const call = async (name, args = {}, thread = 'runtime-thread-a') => {
    const response = await rpc('tools/call', { name, arguments: args,
      ...(thread === null ? {} : { _meta: { threadId: thread } }) });
    return response.result;
  };
  const value = async (...args) => (await call(...args)).structuredContent;
  const bind = (detail, thread = 'runtime-thread-a') => value('campaign_bind', {
    campaign_id: detail.campaign_id, identity_digest: detail.identity_digest,
    expected_version: detail.version, actor: 'owner', run_id: 'run-' + thread,
    thread_id: 'forged-model-thread', client: 'forged-model-client',
  }, thread);
  const hook = async (event, thread = 'runtime-thread-a', extra = {}) => {
    const result = await call(hookTool, { event, ...(event === 'SessionStart' ? { source: 'compact' } : {}), ...extra }, thread);
    assert.equal(result.isError, undefined, JSON.stringify(result));
    const output = JSON.parse(result.content[0].text);
    return output.hookSpecificOutput?.additionalContext ?? '';
  };
  try { await run({ rpc, call, value, bind, hook, alpha, beta, stateDir, scope }); }
  finally {
    child.kill('SIGTERM'); await new Promise(resolve => child.exitCode !== null || child.signalCode !== null ? resolve() : child.once('exit', resolve));
    await rm(dir, { recursive: true, force: true });
  }
}

test('native metadata isolates two campaign bindings and reminder refresh never advances state', async () => {
  await fixture(async ({ rpc, value, bind, hook, alpha, beta }) => {
    const tools = (await rpc('tools/list', {})).result.tools;
    assert.equal(tools.find(t => t.name === hookTool)?.annotations?.readOnlyHint, true);
    assert.equal(await hook('SessionStart'), '');
    await bind(alpha);
    const before = await value('campaign_status');
    assert.equal(before.bound_run.thread_id, 'runtime-thread-a');
    assert.equal(before.bound_run.client, 'codex');
    assert.equal(await hook('PostToolUse'), '', 'Binding alone must not activate a post-compaction reminder');
    const first = await hook('SessionStart');
    assert.match(first, /alpha-private/); assert.doesNotMatch(first, /beta-private/);
    assert.equal(await hook('SessionStart', 'runtime-thread-b'), '');
    await bind(beta, 'runtime-thread-b');
    const other = await hook('SessionStart', 'runtime-thread-b');
    assert.match(other, /beta-private/); assert.doesNotMatch(other, /alpha-private/);
    for (let i = 0; i < 5; i++) assert.equal(await hook('PostToolUse'), '');
    const after = await value('campaign_status');
    assert.equal(after.version, before.version);
    assert.equal(after.durable_event_count, before.durable_event_count);
    await value('campaign_update', { expected_version: 1, actor: 'owner', lifecycle: 'ORIENTING' }, 'runtime-thread-b');
    assert.equal(await hook('PostToolUse'), '');
    assert.match(await hook('PostToolUse', 'runtime-thread-b'), /beta-private v2/);
    assert.equal(await hook('PostToolUse', 'runtime-thread-b'), '');
    assert.equal(await hook('PostToolUse', 'runtime-thread-a', { campaign_id: 'beta-private' }), '');
    assert.equal((await value('campaign_status', {}, null)).code, 'CAMPAIGN_RUNTIME_IDENTITY_REQUIRED');
    assert.equal(await hook('PostToolUse', null), '');
  });
});

test('unbind, binding switches and invalid identity cannot replay another campaign reminder', async () => {
  await fixture(async ({ value, bind, hook, alpha, beta }) => {
    await bind(alpha); assert.match(await hook('SessionStart'), /alpha-private/);
    await value('campaign_unbind');
    const cleared = await hook('PostToolUse');
    assert.match(cleared, /unbound/i); assert.doesNotMatch(cleared, /alpha-private|beta-private/);
    assert.equal(await hook('PostToolUse'), '');
    await bind(beta);
    assert.equal(await hook('PostToolUse'), '');
    const next = await hook('SessionStart');
    assert.match(next, /beta-private/); assert.doesNotMatch(next, /alpha-private/);
    const rejected = await value('campaign_bind', {
      campaign_id: alpha.campaign_id, identity_digest: '0'.repeat(64), expected_version: 1,
      actor: 'owner', run_id: 'bad-bind', thread_id: 'runtime-thread-c',
    }, 'runtime-thread-c');
    assert.equal(rejected.code, 'CAMPAIGN_IDENTITY_MISMATCH');
    assert.equal(await hook('SessionStart', 'runtime-thread-c'), '');
    assert.match(await hook('SessionStart'), /beta-private/);
  });
});

test('reminder context has a strict 2000-character cap and is renewed after each compaction', async () => {
  await fixture(async ({ bind, hook, alpha }) => {
    await bind(alpha);
    const text = await hook('SessionStart');
    assert.ok(text.length > 0 && text.length <= 2000, text.length);
    assert.match(text, /alpha-private v1/);
    assert.equal(await hook('PostToolUse'), '');
    assert.equal(await hook('UserPromptSubmit'), '');
    assert.equal(await hook('SessionStart'), text);
    assert.equal(await hook('SessionStart', 'runtime-thread-a', { source: 'resume' }), '');
  }, 'Unicode objective ' + '🧭'.repeat(3000));
});
