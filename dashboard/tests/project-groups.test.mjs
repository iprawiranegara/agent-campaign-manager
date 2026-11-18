import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectCampaigns, validateProjects } from '../src/project-catalog.mjs';

const repo=(key,name,root,kind='repository')=>({key,name,root,kind});
const campaign=(id,scope_roots,repositories)=>({campaign_id:id,scope_roots,repositories,objective:'Preserve this objective'});
const names=data=>data.projected_repositories.map(item=>item.name);

const projects=[
  {name:'Atlas workspace',root:'/srv/work/alpha',aliases:['D:\\Workspace\\Alpha','\\\\fileserver\\share\\alpha']},
  {name:'Extension',root:'/srv/work/alpha/extensions/tools'},
  {name:'Archive',root:'/srv/work/archive'},
];

test('configured parent roots absorb nested checkouts while the longest configured child wins',()=>{
  const input={campaigns:[campaign('alpha',[
    '/srv/work/alpha/docs',
    '/srv/work/alpha/extensions/tools/src',
    '/srv/work/alpha-copy/review',
    '/srv/work/ALPHA/docs',
    'd:\\workspace\\alpha\\module\\file.mjs',
    '\\\\FILESERVER\\SHARE\\ALPHA\\Docs',
  ],[
    repo('/srv/work/alpha/docs','docs','/srv/work/alpha/docs','scope'),
    repo('/srv/work/alpha/extensions/tools','tools','/srv/work/alpha/extensions/tools'),
    repo('/srv/work/alpha-copy','alpha-copy','/srv/work/alpha-copy'),
    repo('/srv/work/ALPHA/docs','docs','/srv/work/ALPHA/docs','scope'),
    repo('d:\\workspace\\alpha\\module\\file.mjs','file.mjs','d:\\workspace\\alpha\\module\\file.mjs','scope'),
    repo('\\\\FILESERVER\\SHARE\\ALPHA\\Docs','Docs','\\\\FILESERVER\\SHARE\\ALPHA\\Docs','scope'),
  ])],repositories:[],read_at:'2026-11-17T00:00:00.000Z'};
  const before=structuredClone(input);
  const result=projectCampaigns(input,projects);
  assert.deepEqual(names(result),['alpha-copy','Atlas workspace','docs','Extension']);
  assert.deepEqual(result.campaigns[0].projected_repositories.map(item=>item.name),['alpha-copy','Atlas workspace','docs','Extension']);
  assert.equal(result.campaigns[0].projected_repositories.filter(item=>item.name==='Atlas workspace').length,1);
  assert.equal(result.campaigns[0].scope_roots.length,6);
  assert.deepEqual(result.campaigns[0].repositories,input.campaigns[0].repositories,'Reader attribution stays in its original field');
  assert.deepEqual(result.repositories,input.repositories,'Raw top-level attribution remains available');
  assert.deepEqual(input,before,'Projection leaves reader attribution and exact stored paths untouched');
});

test('configured groups count campaigns once and keep multi-repository campaigns in both groups',()=>{
  const data={campaigns:[
    campaign('first',['/srv/work/alpha/docs','/srv/work/archive/review'],[
      repo('/srv/work/alpha','alpha','/srv/work/alpha'),repo('/srv/work/archive','archive','/srv/work/archive'),
    ]),
    campaign('second',['/srv/work/alpha-copy/review'],[
      repo('/srv/work/alpha-copy','alpha-copy','/srv/work/alpha-copy'),
    ]),
  ],repositories:[]};
  const result=projectCampaigns(data,projects);
  assert.deepEqual(result.projected_repositories.map(item=>[item.name,item.count]),[
    ['alpha-copy',1],['Archive',1],['Atlas workspace',1],
  ]);
  assert.deepEqual(result.campaigns[0].projected_repositories.map(item=>item.name),['Archive','Atlas workspace']);
});

test('a configured root inside an outer Git repository matches the exact stored scope',()=>{
  const rawOuter=repo('/srv/workspace','workspace','/srv/workspace');
  const scope='/srv/workspace/research/child';
  const input={campaigns:[campaign('scoped',[scope],[rawOuter])],repositories:[{...rawOuter,count:1}]};
  const result=projectCampaigns(input,[{name:'Research',root:'/srv/workspace/research'}]);
  assert.deepEqual(result.campaigns[0].projected_repositories,[
    {key:'/srv/workspace/research',name:'Research',root:'/srv/workspace/research',kind:'project'},
  ]);
  assert.deepEqual(result.campaigns[0].scope_roots,[scope]);
  assert.deepEqual(result.campaigns[0].repositories,[rawOuter]);
  assert.deepEqual(result.repositories,[{...rawOuter,count:1}]);
});

test('unmatched sibling scopes retain their reader groups beside configured matches',()=>{
  const input={campaigns:[campaign('mixed',[
    '/srv/workspace/research/child','/srv/workspace/Research-extra/review',
  ],[
    repo('/srv/workspace','workspace','/srv/workspace'),
    repo('/srv/workspace/Research-extra','Research-extra','/srv/workspace/Research-extra'),
  ])],repositories:[]};
  const result=projectCampaigns(input,[{name:'Research',root:'/srv/workspace/research'}]);
  assert.deepEqual(result.campaigns[0].projected_repositories.map(item=>item.name),['Research','Research-extra']);
});

test('without a catalog the UI uses reader attribution and does not invent groups',()=>{
  const raw=repo('/srv/work/group','group','/srv/work/group');
  const input={campaigns:[campaign('one',['/srv/work/group'],[raw])],repositories:[{...raw,count:1}],read_at:'stamp'};
  const result=projectCampaigns(input);
  assert.deepEqual(names(result),['group']);
  assert.equal(result.projected_repositories[0].key,raw.key);
  assert.equal(result.campaigns[0].repositories[0].kind,'repository');
});

test('POSIX paths stay case-sensitive and path prefixes do not match roots',()=>{
  const result=projectCampaigns({campaigns:[campaign('outside',[
    '/srv/work/alpha-extra/review','/srv/work/ALPHA/review',
  ],[
    repo('/srv/work/alpha-extra','alpha-extra','/srv/work/alpha-extra'),
    repo('/srv/work/ALPHA','ALPHA','/srv/work/ALPHA'),
  ])],repositories:[]},projects);
  assert.deepEqual(names(result),['ALPHA','alpha-extra']);
});

test('empty collections have no configured sidebar projects',()=>{
  assert.deepEqual(projectCampaigns({campaigns:[],repositories:[]},projects).projected_repositories,[]);
});

test('catalog rejects relative paths, duplicate roots and duplicate names',()=>{
  assert.throws(()=>validateProjects([{name:'Bad',root:'relative/path'}]),/absolute/i);
  assert.throws(()=>validateProjects([
    {name:'First',root:'/srv/work/shared'},
    {name:'Second',root:'D:\\work\\shared',aliases:['\\\\fileserver\\share\\shared']},
    {name:'Third',root:'\\\\FILESERVER\\SHARE\\SHARED'},
  ]),/root|path/i);
  assert.throws(()=>validateProjects([
    {name:'Duplicate',root:'/srv/work/one'},
    {name:'Duplicate',root:'/srv/work/two'},
  ]),/name/i);
  assert.throws(()=>validateProjects([{name:'Bad',root:'/srv/work/one',aliases:'not-an-array'}]),/aliases/i);
});
