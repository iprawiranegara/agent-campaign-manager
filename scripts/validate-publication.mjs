#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const ignored=new Set(['.git','.local','dist','node_modules','__pycache__','.pytest_cache']);
const isGeneratedCachePath=path=>path.split(/[\\/]/).includes('__pycache__')||/\.(?:pyc|pyo)$/i.test(path);
const isPrivateArtifactPath=path=>/\.(?:sqlite(?:3)?(?:-(?:wal|shm))?|db|key)$/i.test(path)||path.split(/[\\/]/).at(-1)==='.env';
const paths=[];
function walk(dir) {
  for(const entry of readdirSync(dir,{withFileTypes:true})) {
    if(ignored.has(entry.name))continue;
    const path=join(dir,entry.name);
    if(path===join(root,'docs','superpowers'))continue;
    if(isGeneratedCachePath(path))continue;
    assert(!entry.isSymbolicLink(),`Source symlinks are not allowed: ${path}`);
    assert(!isPrivateArtifactPath(path),`Private/runtime file in source: ${path}`);
    if(entry.isDirectory())walk(path);else paths.push(path);
  }
}
walk(root);
for(const path of paths) {
  assert(!isPrivateArtifactPath(path) && !isGeneratedCachePath(path),`Private/runtime file in source: ${path}`);
  const text=readFileSync(path,'utf8');
  assert(!/\/home\/[a-zA-Z0-9._-]+\//.test(text),`Machine home path in source: ${path}`);
  assert(!/https?:\/\/[\w.-]+\.ts\.net/.test(text),`Private tailnet URL in source: ${path}`);
  assert(!/(?:ghp_|github_pat_)[a-zA-Z0-9_]{20,}|sk-[a-zA-Z0-9]{24,}|-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----/.test(text),`Possible credential in source: ${path}`);
  if(extname(path)==='.json')JSON.parse(text);
  if(extname(path)==='.md') {
    for(const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target=match[1].split('#')[0];
      if(!target||/^https?:|^mailto:/.test(target))continue;
      assert(existsSync(resolve(dirname(path),target)),`Broken local link in ${path}: ${target}`);
    }
  }
}
for(const required of ['README.md','LICENSE','THIRD_PARTY_NOTICES.md','docs/install-codex.md','docs/install-claude.md','docs/install-hermes.md','docs/usage.md','docs/compatibility.md','SECURITY.md'])assert(existsSync(join(root,required)),`Missing ${required}`);
const npmArgs=['pack','--dry-run','--json','--ignore-scripts'];
const pack=process.env.npm_execpath
  ? spawnSync(process.execPath,[process.env.npm_execpath,...npmArgs],{cwd:root,encoding:'utf8'})
  : spawnSync(process.platform==='win32'?'npm.cmd':'npm',npmArgs,{cwd:root,encoding:'utf8',shell:process.platform==='win32'});
assert.equal(pack.status,0,pack.stderr||pack.stdout);
const packed=JSON.parse(pack.stdout);
assert.equal(packed.length,1,'Expected one npm package manifest');
for(const file of packed[0].files) {
  const path=file.path;
  assert(!isPrivateArtifactPath(path) && !isGeneratedCachePath(path),`Private/runtime file in npm tarball: ${path}`);
  assert(!path.startsWith('docs/superpowers/'),`Internal process notes in npm tarball: ${path}`);
}
const result=spawnSync(process.execPath,['scripts/validate-plugin.mjs'],{cwd:join(root,'plugin'),encoding:'utf8'});
assert.equal(result.status,0,result.stderr||result.stdout);
console.log(`Validated ${paths.length} source files: manifests, local links and bounded privacy checks passed.`);
