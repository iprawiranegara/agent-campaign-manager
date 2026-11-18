import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from '../src/server.mjs';
import { createReader } from '../src/read-store.mjs';
import { fixture, addPackage } from './fixture.mjs';

if(!process.env.PLAYWRIGHT_MODULE) throw new Error('Set PLAYWRIGHT_MODULE to an installed Playwright entrypoint to run browser verification.');
const playwright=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const f=fixture();
const otherRoot=join(f.directory,'archive');mkdirSync(join(otherRoot,'.git'),{recursive:true});
f.writer.create({campaign_id:'alpha',scope_roots:[
  join(f.repository,'docs'),join(f.nested,'src'),join(f.directory,'alpha-staging'),
],objective:'Verify <img src=x onerror="window.injected=true"> stored text safely.',actor:'reviewer',accountable_primary:'campaign-lead',profile:'engineering'});
f.create('beta',otherRoot,'Review a separate workspace.');
addPackage(f,'verify-alpha','ACCEPTED');
const stamp=new Date().toISOString();
f.writer.db.exec('INSERT INTO decision VALUES (?, ?, ?, ?, ?, ?, ?, ?)', ['choose','beta','PROPOSED','Choose a method','PENDING','[]',stamp,stamp]);
const projects=[
  {name:'Workspace',root:f.repository,aliases:['D:\\Workspaces\\Alpha']},
  {name:'Extension',root:f.nested},
  {name:'Archive',root:otherRoot},
];
const storedWindowsPaths=['D:\\Workspaces\\Alpha\\alias-subdir','D:\\Workspaces\\Alpha-extra\\review'];
const windowsPathRows=storedWindowsPaths.map((path,index)=>({key:path,name:index===0?'alias-subdir':'review',root:path,kind:'scope'}));
const baseReader=createReader({dbPath:f.dbPath});
const reader={
  list() {
    const data=baseReader.list();
    const campaign=data.campaigns.find(item=>item.campaign_id==='alpha');
    campaign.scope_roots.push(...storedWindowsPaths);
    campaign.repositories.push(...windowsPathRows);
    data.repositories.push(...windowsPathRows.map(repository=>({...repository,count:1})));
    return data;
  },
  detail(id) {
    const detail=baseReader.detail(id);
    if(detail?.campaign_id==='alpha') {
      detail.scope_roots.push(...storedWindowsPaths);
      detail.repositories.push(...windowsPathRows);
    }
    return detail;
  },
};
const server=createServer({reader,projects});
server.listen(0,'127.0.0.1');await once(server,'listening');
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await playwright.chromium.launch({headless:true,args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:1280,height:1000},colorScheme:'light',timezoneId:'America/Los_Angeles'});
const errors=[];page.on('pageerror',error=>errors.push(error.message));
const output=process.env.DASHBOARD_EVIDENCE_DIR;
if(output) mkdirSync(output,{recursive:true});
try {
  await page.goto(base);
  await page.getByRole('heading',{name:'All campaigns',exact:true}).waitFor({timeout:5000});
  await page.locator('#cp-rows tr').first().waitFor();
  assert.equal(await page.locator('#cp-rows tr').count(),2);
  const groups=await page.locator('#cp-repositories [data-repo]').evaluateAll(items=>items.map(item=>item.innerText.split('\n')[0]));
  assert.deepEqual(groups,['All repositories','alpha-staging','Archive','Extension','review','Workspace']);
  await page.getByRole('button',{name:'Needs you',exact:true}).click();
  assert.equal(await page.locator('#cp-rows tr').count(),1);
  assert.match(await page.locator('#cp-rows').innerText(),/beta/);
  await page.getByRole('button',{name:'Open',exact:true}).click();
  await page.locator('[data-campaign="alpha"]').click();
  await page.locator('#cp-detail').getByText('1 of 1 accepted',{exact:true}).waitFor();
  const localDate=await page.evaluate(async()=>{
    const response=await fetch('/api/campaigns/alpha');
    const data=await response.json();
    return new Intl.DateTimeFormat('en-GB',{dateStyle:'medium',timeStyle:'short'}).format(new Date(data.updated_at));
  });
  assert.match(await page.locator('#cp-detail .cp-meta-label').innerText(),new RegExp(localDate.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert.doesNotMatch(await page.locator('#cp-detail .cp-meta-label').innerText(),/WIB|Asia\/Jakarta/);
  assert.match(await page.locator('#cp-detail .cp-paths').innerText(),/alpha-staging/);
  assert.match(await page.locator('#cp-detail .cp-paths').innerText(),/D:\\Workspaces\\Alpha\\alias-subdir/);
  assert.match(await page.locator('[data-campaign="alpha"]').locator('xpath=../..').innerText(),/Workspace/);
  await page.locator(`[data-repo="${f.repository}"]`).click();
  assert.equal(await page.locator('#cp-rows tr').count(),1);
  assert.match(await page.locator('#cp-rows').innerText(),/alpha/);
  await page.getByRole('button',{name:'All repositories',exact:false}).click();
  await page.locator('[data-campaign="alpha"]').focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(()=>document.activeElement.dataset.campaign),'alpha','Keyboard selection must retain focus');
  assert.equal(await page.locator('#cp-detail img').count(),0);
  assert.equal(await page.evaluate(()=>window.injected),undefined);
  await page.locator(`[data-repo="${otherRoot}"]`).click();
  assert.equal(await page.locator('#cp-rows tr').count(),1);
  assert.match(await page.locator('#cp-rows').innerText(),/beta/);
  await page.getByRole('button',{name:'All repositories',exact:false}).click();

  // A delayed response for one selection must not replace a later selection.
  let delayed;
  await page.route('**/api/campaigns/alpha',async route=>{
    const response=await route.fetch();
    await new Promise(resolve=>{delayed=resolve;});
    await route.fulfill({response});
  });
  await page.locator('[data-campaign="alpha"]').click();
  await page.waitForFunction(()=>document.getElementById('cp-detail').textContent.includes('Loading'));
  await page.locator('[data-campaign="beta"]').click();
  await page.locator('#cp-detail-id').getByText('beta',{exact:true}).waitFor();
  while(!delayed) await new Promise(resolve=>setTimeout(resolve,10));
  delayed();await page.waitForTimeout(80);
  assert.equal(await page.locator('#cp-detail-id').innerText(),'beta');
  await page.unroute('**/api/campaigns/alpha');

  await page.route('**/api/campaigns',route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"STORE_UNAVAILABLE"}'}));
  await page.getByRole('button',{name:'Refresh',exact:true}).click();
  await page.getByRole('alert').waitFor();
  assert.equal(await page.locator('#cp-rows tr').count(),2);
  assert.match(await page.locator('#cp-sync-state').innerText(),/stale/i);
  await page.unroute('**/api/campaigns');
  await page.getByRole('button',{name:'Retry',exact:true}).click();
  await page.waitForFunction(()=>document.getElementById('cp-error').hidden);
  f.create('gamma',otherRoot,'A fresh campaign becomes visible.');
  await page.getByRole('button',{name:'Refresh',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('#cp-rows tr').length===3);

  // A later successful refresh clears a detail error after filters remove its row.
  await page.route('**/api/campaigns/alpha',route=>route.fulfill({status:503,body:'unavailable'}));
  await page.locator('[data-campaign="alpha"]').click();
  await page.getByRole('alert').waitFor();
  await page.locator(`[data-repo="${f.repository}"]`).click();
  await page.getByRole('button',{name:'Needs you',exact:true}).click();
  await page.locator('#cp-empty').waitFor();
  await page.unroute('**/api/campaigns/alpha');
  await page.getByRole('button',{name:'Refresh',exact:true}).click();
  await page.waitForFunction(()=>!document.getElementById('cp-refresh').disabled);
  assert.equal(await page.locator('#cp-sync-state').innerText(),'Up to date');
  await page.getByRole('button',{name:'All repositories',exact:false}).click();
  await page.getByRole('button',{name:'Open',exact:true}).click();

  for(const width of [1280,768,320]) {
    await page.setViewportSize({width,height:1000});
    const geometry=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));
    assert.ok(geometry.scroll<=geometry.width,JSON.stringify(geometry));
    if(output) await page.screenshot({path:join(output,`dashboard-${width}.png`),fullPage:true});
  }
  await page.setViewportSize({width:1280,height:1000});
  await page.emulateMedia({colorScheme:'dark'});
  if(output) await page.screenshot({path:join(output,'dashboard-dark.png'),fullPage:true});
  assert.deepEqual(errors,[]);
  const empty=await browser.newPage();
  await empty.route('**/api/campaigns',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({campaigns:[],repositories:[],project_catalog:[],read_at:new Date().toISOString()})}));
  await empty.goto(base);await empty.getByText('No campaigns have been recorded yet.',{exact:true}).waitFor();
  assert.equal(await empty.locator('#cp-detail').isVisible(),false);await empty.close();
  const unavailable=await browser.newPage();
  await unavailable.route('**/api/campaigns',route=>route.fulfill({status:503,body:'unavailable'}));
  await unavailable.goto(base);await unavailable.getByRole('alert').waitFor();
  assert.match(await unavailable.locator('#cp-last-read').innerText(),/No successful refresh/);
  assert.equal(await unavailable.locator('#cp-table').isVisible(),false);
  await unavailable.unroute('**/api/campaigns');await unavailable.getByRole('button',{name:'Retry',exact:true}).click();
  await unavailable.locator('#cp-rows tr').first().waitFor();await unavailable.close();
  console.log('Browser PASS: filters, details, generic catalog grouping, exact scope paths, XSS text, delayed selection, stale refresh/retry, live refresh, responsive geometry, light/dark appearance.');
} finally {
  await browser.close();await new Promise(resolve=>server.close(resolve));f.close();
}
