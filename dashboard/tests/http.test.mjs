import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { createServer, startDashboard } from '../src/server.mjs';
import { createReader } from '../src/read-store.mjs';
import { fixture } from './fixture.mjs';

function requestWithHost(base,path,host) {
  const url=new URL(base);
  return new Promise((resolve,reject)=>{
    const request=httpRequest({hostname:url.hostname,port:url.port,path,headers:{Host:host}},response=>{
      response.resume();response.on('end',()=>resolve(response));
    });
    request.on('error',reject);request.end();
  });
}

async function withServer(callback,readerOverride,options={}) {
  const f=fixture();f.create('alpha');
  const server=createServer({reader:readerOverride??createReader({dbPath:f.dbPath}),...options});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try {await callback(`http://127.0.0.1:${server.address().port}`,f,server);}
  finally {await new Promise(resolve=>server.close(resolve));f.close();}
}

test('lists raw reader attribution and catalog separately with no-store and security headers',async()=>{
  const projects=[{name:'Workspace',root:'/srv/workspace'}];
  await withServer(async base=>{
    const res=await fetch(base+'/api/campaigns');
    assert.equal(res.status,200);
    assert.equal(res.headers.get('cache-control'),'no-store');
    assert.equal(res.headers.get('access-control-allow-origin'),null);
    assert.match(res.headers.get('content-security-policy'),/default-src 'self'/);
    const body=await res.json();
    assert.equal(body.campaigns[0].campaign_id,'alpha');
    assert.equal(body.campaigns[0].repositories[0].kind,'repository');
    assert.deepEqual(body.project_catalog,[{...projects[0],aliases:[]}]);
    assert.equal((await (await fetch(base+'/api/campaigns/alpha')).json()).campaign_id,'alpha');
    assert.equal((await fetch(base+'/api/campaigns/absent')).status,404);
    assert.equal((await fetch(base+'/api/campaigns/alpha%27')).status,400);
  },undefined,{projects});
});

test('rejects mutation methods, unknown routes, unapproved Host and foreign origins',async()=>{
  await withServer(async base=>{
    for(const method of ['POST','PUT','PATCH','DELETE']) assert.equal((await fetch(base+'/api/campaigns',{method})).status,405);
    for(const path of ['/package.json','/api/sql','/src/server.mjs','/.env','/%2e%2e/README.md']) assert.equal((await fetch(base+path)).status,404);
    assert.equal((await requestWithHost(base,'/api/campaigns','remote.example')).statusCode,403);
    assert.equal((await fetch(base+'/api/campaigns',{headers:{Origin:'https://unrelated.invalid'}})).status,403);
    assert.equal((await fetch(base+'/api/campaigns',{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
  });
});

test('custom approved host is allowed while default host list stays local',async()=>{
  await withServer(async base=>{
    const local=await fetch(base+'/health');
    assert.equal(local.status,200);
    const custom=await requestWithHost(base,'/health','dashboard.example');
    assert.equal(custom.statusCode,403);
  });
  await withServer(async base=>{
    const response=await requestWithHost(base,'/health','dashboard.example');
    assert.equal(response.statusCode,200);
  },undefined,{allowedHosts:['dashboard.example']});
});

test('catalog validation happens before requests are served',()=>{
  const f=fixture();
  try {
    assert.throws(()=>createServer({reader:createReader({dbPath:f.dbPath}),projects:[{name:'bad',root:'relative'}]}),/absolute/i);
  } finally {f.close();}
});

test('store failures are redacted 503 responses, including health',async()=>{
  const failing={list(){throw new Error('/secret/path SECRET_MARKER');},detail(){throw new Error('SECRET_MARKER');}};
  await withServer(async base=>{
    for(const path of ['/health','/api/campaigns','/api/campaigns/alpha']) {
      const res=await fetch(base+path);assert.equal(res.status,503);
      const body=await res.text();assert.doesNotMatch(body,/SECRET_MARKER|secret\/path|stack/i);
      assert.match(body,/unavailable/i);
    }
  },failing);
});

test('serves executable browser assets as bytes and supports HEAD',async()=>{
  await withServer(async base=>{
    const page=await fetch(base+'/');
    assert.equal(page.status,200);assert.match(await page.text(),/^<!doctype html>/i);
    const script=await fetch(base+'/dashboard.js');
    assert.match(script.headers.get('content-type'),/javascript/);
    assert.match(await script.text(),/async function refresh/);
    assert.equal((await fetch(base+'/',{method:'HEAD'})).status,200);
    assert.equal(await (await fetch(base+'/',{method:'HEAD'})).text(),'');
  });
});

test('malformed origins are denied as access errors',async()=>{
  await withServer(async base=>{
    assert.equal((await fetch(base+'/api/campaigns',{headers:{Origin:'null'}})).status,403);
  });
});

test('startDashboard preflights an existing store, binds loopback, returns address and closes',async()=>{
  const f=fixture();f.create('alpha');
  let started;
  try {
    started=await startDashboard({dbPath:f.dbPath,port:0});
    assert.equal(started.address.address,'127.0.0.1');
    assert.ok(started.address.port>0);
    assert.equal((await fetch(`http://127.0.0.1:${started.address.port}/health`)).status,200);
  } finally {
    if(started) await started.close();
    f.close();
  }
});

test('startDashboard rejects missing and unsupported stores without creating or changing them',async()=>{
  const f=fixture();
  try {
    const missing=f.dbPath+'.missing';
    await assert.rejects(startDashboard({dbPath:missing,port:0}),/database|store|readable|configured/i);
    assert.equal((await import('node:fs')).existsSync(missing),false);
    f.create('alpha');
    f.writer.db.exec("UPDATE schema_migration SET checksum='unsupported'");
    await assert.rejects(startDashboard({dbPath:f.dbPath,port:0}),/schema|unsupported/i);
  } finally {f.close();}
});

test('importing the server module exits without starting a listener',()=>{
  const moduleUrl=import.meta.resolve('../src/server.mjs');
  assert.doesNotThrow(()=>execFileSync(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(moduleUrl)})`],{timeout:3000}));
});
