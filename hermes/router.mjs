#!/usr/bin/env node
// Transport isolation only. Campaign semantics remain in the unchanged server.
import { spawn } from 'node:child_process';
import { constants, lstatSync, openSync, readFileSync, closeSync, realpathSync, fstatSync } from 'node:fs';
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { TOOL_DEFINITIONS } from '../plugin/packages/codex-mcp/src/tools.mjs';
import { verifyPrivatePath } from './security.mjs';

const SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), '../plugin');
const argv = process.argv.slice(2);
const option = name => argv[argv.indexOf(name) + 1];
if (!argv.includes('--channels') || !argv.includes('--state')) throw new Error('Explicit channels and state required');
const channelsArgument = option('--channels');
const channels = verifyPrivatePath(channelsArgument, 'directory');
const state = realpathSync(option('--state'));
const fixture = argv.includes('--fixture');
const production = resolve(process.env.CODEX_RESEARCH_CAMPAIGN_STATE_DIR || join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'omo-research'));
const fixtureRoot = fixture && argv.includes('--fixture-root') ? realpathSync(option('--fixture-root')) : null;
const subpath = fixtureRoot ? relative(fixtureRoot, state) : null;
const insideFixture = subpath && subpath !== '..' && !subpath.startsWith('..' + sep) && !isAbsolute(subpath);
if ((!fixture && state !== production) || (fixture && (state === production || !insideFixture))) throw new Error('State boundary rejected');
const epoch = randomUUID();
const sessions = new Map();
const nonces = new Map();
const maxSessions = 128;
const timeoutMs = 15000;
let serial = 0;
let closing = false;
const toolNames = new Set(TOOL_DEFINITIONS.map(t => t.name));
// Audited read paths in unchanged tools.mjs/core.mjs. Mutations remain untrusted writes.
const readOnly = new Set(['campaign_list','campaign_search','campaign_detail','campaign_status','campaign_preflight']);

function failure(code, message, mutated = false) {
  const value = {code, message, details: {mutated, next_action: mutated === null ? 'Inspect campaign state before any retry. Rebind explicitly after connection loss.' : 'Correct the request or explicitly rebind; no automatic retry.'}};
  return {isError: true, content: [{type: 'text', text: JSON.stringify(value)}], structuredContent: value, _meta: {adapter_epoch: epoch}};
}
function authenticate(name, args) {
  if (!args || !args._adapter || Object.keys(args).some(k => !['_adapter','arguments'].includes(k))) throw new Error('AUTH');
  const {channel, payload, signature} = args._adapter;
  if (!/^[a-f0-9]{32}$/.test(channel) || typeof payload !== 'string' || payload.length > 300000 || !/^[a-f0-9]{64}$/.test(signature)) throw new Error('AUTH');
  const path = verifyPrivatePath(join(channels, channel + '.key'), 'key');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('AUTH');
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const fd = openSync(path, constants.O_RDONLY | noFollow);
  let key;
  try {
    const opened = fstatSync(fd);
    const sameIdentity = stat.dev === opened.dev && stat.ino === opened.ino && stat.size === opened.size;
    if (!opened.isFile() || !sameIdentity) throw new Error('AUTH');
    key = readFileSync(fd);
  } finally {closeSync(fd);}
  if (key.length !== 32) throw new Error('AUTH');
  const expected = createHmac('sha256', key).update(payload).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) throw new Error('AUTH');
  const data = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  if (Object.hasOwn(args,'arguments') && JSON.stringify(args.arguments) !== JSON.stringify(data.arguments)) {
    // Compare structurally, independent of JSON object key order.
    const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k,sorted(value[k])])) : value;
    if (JSON.stringify(sorted(args.arguments)) !== JSON.stringify(sorted(data.arguments))) throw new Error('AUTH');
  }
  if (data.tool !== name || typeof data.route !== 'string' || !/^[a-f0-9]{64}$/.test(data.route) || !/^[a-f0-9]{32}$/.test(data.nonce) || !Number.isInteger(data.time) || Math.abs(Date.now()/1000-data.time) > 45 || !data.arguments || typeof data.arguments !== 'object' || Array.isArray(data.arguments)) throw new Error('AUTH');
  for (const [nonce, expires] of nonces) if (expires < Date.now()) nonces.delete(nonce);
  const nonce = channel + ':' + data.nonce;
  if (nonces.has(nonce) || nonces.size >= 10000) throw new Error('AUTH');
  nonces.set(nonce, Date.now()+90000);
  return {...data, sessionKey: channel + ':' + data.route};
}
function terminate(entry) {
  entry.dead = true;
  entry.child?.kill('SIGTERM');
}
function childFor(key) {
  if (sessions.has(key)) return sessions.get(key);
  if (sessions.size >= maxSessions) throw new Error('CAPACITY');
  const child = spawn(process.execPath, [SOURCE + '/packages/codex-mcp/src/server.mjs'], {cwd: SOURCE, env: {...process.env, CODEX_RESEARCH_CAMPAIGN_STATE_DIR: state, CODEX_CAMPAIGN_CONTEXT_HOOKS: '0'}, stdio: ['pipe','pipe','ignore']});
  const entry = {child, dead: false, binding: null, pending: new Map(), queue: Promise.resolve()};
  readline.createInterface({input: child.stdout}).on('line', line => {
    try {
      const message = JSON.parse(line);
      const waiter = entry.pending.get(message.id);
      if (waiter) {entry.pending.delete(message.id); clearTimeout(waiter.timer); waiter.resolve(message);}
    } catch {terminate(entry);}
  });
  const exited = () => {
    entry.dead = true;
    for (const waiter of entry.pending.values()) {clearTimeout(waiter.timer); waiter.reject(new Error('UNKNOWN'));}
    entry.pending.clear();
  };
  child.on('exit', exited);
  child.on('error', exited);
  child.stdin.on('error', exited);
  entry.call = (tool, args) => {
    const run = async () => {
      if (entry.dead) return failure('ADAPTER_CONNECTION_LOST', 'Campaign connection lost. Explicitly unbind then bind to start a fresh connection.');
      const id = ++serial;
      try {
        const response = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {entry.pending.delete(id); terminate(entry); reject(new Error('UNKNOWN'));}, timeoutMs);
          entry.pending.set(id, {resolve, reject, timer});
          child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name:tool,arguments:args}})+'\n');
        });
        if (response.error) return failure('ADAPTER_OUTCOME_UNKNOWN', 'Campaign RPC failed; operation outcome unknown.', null);
        if (!response.result?.isError && tool === 'campaign_bind') entry.binding = response.result.structuredContent?.binding_token || null;
        if (!response.result?.isError && tool === 'campaign_unbind') entry.binding = null;
        return {...response.result, _meta: {...response.result?._meta, adapter_epoch: epoch}};
      } catch {return failure('ADAPTER_OUTCOME_UNKNOWN', 'Campaign connection failed after dispatch; operation outcome unknown.', null);}
    };
    const result = entry.queue.then(run);
    entry.queue = result.then(() => undefined, () => undefined);
    return result;
  };
  sessions.set(key, entry);
  return entry;
}
async function invoke(name, args) {
  let data;
  try {data = authenticate(name,args);} catch {return failure('ADAPTER_AUTH_REJECTED','Routing authentication failed.');}
  if (!toolNames.has(name)) return failure('UNKNOWN_TOOL','Unsupported campaign operation.');
  const entry = sessions.get(data.sessionKey);
  if (data.expected_binding && (!entry || entry.binding !== data.expected_binding)) return failure('ADAPTER_BINDING_LOST','Binding belongs to an earlier connection. Explicitly rebind; operation was not dispatched.');
  if (data.control === 'release') {
    if (name !== 'campaign_unbind') return failure('ADAPTER_AUTH_REJECTED','Invalid control operation.');
    if (entry) {await entry.queue; terminate(entry); sessions.delete(data.sessionKey);}
    return {content:[{type:'text',text:'{"released":true,"mutated":false}'}],structuredContent:{released:true,mutated:false},_meta:{adapter_epoch:epoch}};
  }
  if (data.control === 'rotate') {
    if (name !== 'campaign_status' || !/^[a-f0-9]{64}$/.test(data.target || '')) return failure('ADAPTER_AUTH_REJECTED','Invalid rotation.');
    const target = data.sessionKey.slice(0,33) + data.target;
    if (!entry || sessions.has(target)) return failure('ADAPTER_ROTATION_REJECTED','Missing origin or target already exists.');
    await entry.queue;
    sessions.delete(data.sessionKey); sessions.set(target,entry);
    return {content:[{type:'text',text:'{"rotated":true}'}],structuredContent:{rotated:true},_meta:{adapter_epoch:epoch}};
  }
  if (data.control) return failure('ADAPTER_AUTH_REJECTED','Unknown control operation.');
  // Lost connections never silently respawn or replay. Unbind is the explicit reset.
  if (entry?.dead && name === 'campaign_unbind') {sessions.delete(data.sessionKey);return failure('CAMPAIGN_NOT_BOUND','Lost binding cleared.');}
  try {return await childFor(data.sessionKey).call(name,data.arguments);} catch {return failure('ADAPTER_CAPACITY','Session capacity reached; release an unused binding.');}
}
async function handle(request) {
  if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') return {jsonrpc:'2.0',id:request?.id ?? null,error:{code:-32600,message:'Invalid request'}};
  if (request.method.startsWith('notifications/')) return null;
  const base={jsonrpc:'2.0',id:request.id ?? null};
  if (request.method === 'initialize') return {...base,result:{protocolVersion:request.params?.protocolVersion || '2025-06-18',capabilities:{tools:{listChanged:false}},serverInfo:{name:'hermes-campaign-router',version:'0.2.0'}}};
  if (request.method === 'tools/list') return {...base,result:{tools:TOOL_DEFINITIONS.map(t => ({...t,annotations:{readOnlyHint:readOnly.has(t.name)}}))}};
  if (request.method === 'ping') return {...base,result:{}};
  if (request.method === 'tools/call') return {...base,result:await invoke(request.params?.name,request.params?.arguments)};
  return {...base,error:{code:-32601,message:'Unknown method'}};
}
function close() {if (closing) return;closing=true;for (const entry of sessions.values()) terminate(entry);}
const input=readline.createInterface({input:process.stdin});
input.on('line', async line => {
  let request;
  try {request=JSON.parse(line); const result=await handle(request);if (result) process.stdout.write(JSON.stringify(result)+'\n');}
  catch {process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request?.id ?? null,error:{code:-32603,message:'Router request failed'}})+'\n');}
});
input.on('close',close);
process.on('SIGTERM',()=>{close();process.exit(0);});
process.on('SIGINT',()=>{close();process.exit(0);});
