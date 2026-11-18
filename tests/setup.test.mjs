import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { createStore } from '../plugin/packages/campaign-core/src/core.mjs';

const root = join(import.meta.dirname, '..');
const run = args => spawnSync(process.execPath, [join(root,'scripts/setup.mjs'),...args], {encoding:'utf8'});
const json = path => readFile(path,'utf8').then(JSON.parse);
async function fixture(fn) {
  const scratchRoot = process.platform === 'win32'
    ? join(process.env.USERPROFILE || tmpdir(), '.campaign-manager-tests')
    : '/tmp';
  if (process.platform === 'win32') await mkdir(scratchRoot, { recursive: true });
  const dir = await mkdtemp(join(scratchRoot,'campaign-publication-'));
  try { await fn(dir); } finally { await rm(dir,{recursive:true,force:true}); }
}

test('explicit initialization creates an empty usable ledger and preserves existing campaigns on rerun', async () => fixture(async dir => {
  const state=join(dir,'state');
  let result=run(['init','--state-dir',state]);
  assert.equal(result.status,0,result.stderr);
  const store=createStore({stateDir:state});
  assert.equal(store.list().campaigns.length,0);
  await mkdir(join(dir,'scope'));
  store.create({campaign_id:'keep-me',objective:'Preserve the existing campaign',scope_roots:[join(dir,'scope')],actor:'owner'});
  store.dispose();
  result=run(['init','--state-dir',state]);assert.equal(result.status,0,result.stderr);
  const again=createStore({stateDir:state});
  assert.equal(again.detail('keep-me').version,1);again.dispose();
}));

test('Codex preparation creates a self-contained marketplace and server without editing host config', async () => fixture(async dir => {
  const state=join(dir,'state');assert.equal(run(['init','--state-dir',state]).status,0);
  const out=join(dir,'codex');const result=run(['codex','--state-dir',state,'--output',out]);
  assert.equal(result.status,0,result.stderr);
  const market=await json(join(out,'.agents/plugins/marketplace.json'));
  assert.equal(market.plugins[0].source.path,'./plugin');
  const mcp=(await json(join(out,'plugin/.mcp.json'))).mcpServers['research-campaign'];
  const probe=spawnSync(mcp.command,[...mcp.args],{cwd:mcp.cwd,env:{...process.env,...mcp.env},input:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})+'\n',encoding:'utf8'});
  assert.equal(probe.status,0,probe.stderr);
  const tools=JSON.parse(probe.stdout).result.tools;
  assert.equal(tools.length,15);assert.ok(tools.some(t=>t.name==='campaign_context_hook'));
  assert.equal(mcp.env.CODEX_RESEARCH_CAMPAIGN_STATE_DIR,state);
  const sentinel=join(out,'operator-note.txt');await writeFile(sentinel,'preserve');
  const duplicate=run(['codex','--state-dir',state,'--output',out]);
  assert.notEqual(duplicate.status,0,'Never silently overwrite an installation');
  assert.equal(await readFile(sentinel,'utf8'),'preserve');
}));

test('Hermes preparation generates an untrusted hidden router and profile-specific MCP grant', async () => fixture(async dir => {
  const state=join(dir,'state');assert.equal(run(['init','--state-dir',state]).status,0);
  const profile=join(dir,'hermes-home');const out=join(dir,'hermes-install');
  const result=run(['hermes','--state-dir',state,'--hermes-home',profile,'--output',out]);
  assert.equal(result.status,0,result.stderr);
  const config=await json(join(out,'config.fragment.json'));
  assert.deepEqual(config.plugins.entries['campaign-manager'].mcp_allowlist,['campaign-router']);
  const server=config.mcp_servers['campaign-router'];
  assert.equal(server.trust,'untrusted');assert.deepEqual(server.tools.include,[]);
  assert.equal((await import('node:fs')).existsSync(join(profile,'plugin-data/campaign-manager/channels')),true);
  const probe=spawnSync(server.command,server.args,{cwd:server.cwd,env:{...process.env,...server.env},input:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})+'\n',encoding:'utf8'});
  assert.equal(probe.status,0,probe.stderr);
  assert.equal(JSON.parse(probe.stdout).result.tools.length,14);
}));

test('Hermes router accepts the production ledger when it is reached through a symlinked path', { skip: process.platform === 'win32' && 'symlink creation needs extra privileges on Windows' }, async () => fixture(async dir => {
  // macOS temp and home paths often pass through /tmp, /var or a linked XDG directory.
  const state=join(dir,'state');assert.equal(run(['init','--state-dir',state]).status,0);
  const profile=join(dir,'hermes-home');const out=join(dir,'hermes-install');
  assert.equal(run(['hermes','--state-dir',state,'--hermes-home',profile,'--output',out]).status,0);
  const server=(await json(join(out,'config.fragment.json'))).mcp_servers['campaign-router'];
  const alias=join(dir,'state-alias');(await import('node:fs')).symlinkSync(state,alias,'dir');
  const args=server.args.map(value=>value===state?alias:value);
  assert.ok(args.includes(alias),'router arguments should name the state directory');
  const probe=spawnSync(server.command,args,{cwd:server.cwd,env:{...process.env,...server.env,CODEX_RESEARCH_CAMPAIGN_STATE_DIR:alias},input:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})+'\n',encoding:'utf8'});
  assert.equal(probe.status,0,probe.stderr);
  assert.equal(JSON.parse(probe.stdout).result.tools.length,14);
}));

test('Windows security checks start PowerShell without the parent PSModulePath', async () => {
  // PowerShell 7 puts its own modules first; Windows PowerShell 5.1 then cannot load Get-Acl.
  const { windowsSecurityEnvironment } = await import('../hermes/security.mjs');
  const env = windowsSecurityEnvironment({ Path: 'C:\\Windows\\System32', PSModulePath: 'C:\\Program Files\\PowerShell\\7\\Modules', psmodulepath: 'duplicate', SystemRoot: 'C:\\Windows' });
  assert.deepEqual(Object.keys(env).filter(key => key.toLowerCase() === 'psmodulepath'), []);
  assert.equal(env.Path, 'C:\\Windows\\System32');
  assert.equal(env.SystemRoot, 'C:\\Windows');
});

test('Hermes native Windows preparation uses LOCALAPPDATA profile unless HERMES_HOME overrides it', async () => {
  const { resolveHermesHome } = await import('../scripts/paths.mjs');
  assert.equal(resolveHermesHome({ platform: 'win32', home: 'C:\\Users\\tester', env: {
    LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
  } }), 'C:\\Users\\tester\\AppData\\Local\\hermes');
});

test('setup rejects missing explicit state and unknown options', async () => {
  assert.notEqual(run(['init']).status,0);
  assert.notEqual(run(['codex','--state-dir','relative-state','--unreviewed']).status,0);
});
