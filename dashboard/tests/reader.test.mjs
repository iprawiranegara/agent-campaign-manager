import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync, statSync, readdirSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createReader, resolveScope } from '../src/read-store.mjs';
import { fixture, addPackage } from './fixture.mjs';

const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');

test('missing database is unavailable and never created', () => {
  const f = fixture();
  try {
    const missing = join(f.directory, 'missing.sqlite3');
    assert.throws(() => createReader({ dbPath: missing }).list(), { code: 'STORE_UNAVAILABLE' });
    assert.equal(existsSync(missing), false);
  } finally { f.close(); }
});

test('reads WAL updates without changing data, schema, file modes or creating another store', () => {
  const f = fixture();
  try {
    f.create('alpha');
    const reader = createReader({ dbPath: f.dbPath });
    assert.equal(reader.list().campaigns.length, 1);
    f.create('beta');
    const before = f.writer.db.query('SELECT * FROM event ORDER BY event_id');
    const schema = f.writer.db.query('SELECT sql FROM sqlite_master ORDER BY name');
    const mode = statSync(f.dbPath).mode;
    const bytes = hash(f.dbPath);
    const files = readdirSync(f.directory);
    assert.equal(reader.list().campaigns.length, 2);
    assert.equal(reader.detail('alpha').agent_activity, 'unknown');
    assert.deepEqual(f.writer.db.query('SELECT * FROM event ORDER BY event_id'), before);
    assert.deepEqual(f.writer.db.query('SELECT sql FROM sqlite_master ORDER BY name'), schema);
    assert.equal(statSync(f.dbPath).mode, mode);
    assert.equal(hash(f.dbPath), bytes);
    assert.deepEqual(readdirSync(f.directory), files);
    reader.close();
  } finally { f.close(); }
});

test('rejects unsupported schema and opening identity drift without repair', () => {
  const f = fixture();
  try {
    f.create('alpha');
    const reader = createReader({ dbPath: f.dbPath });
    f.writer.db.exec("UPDATE schema_migration SET checksum = 'unsupported'");
    assert.throws(() => reader.list(), { code: 'SCHEMA_UNSUPPORTED' });
    f.writer.db.exec("UPDATE schema_migration SET checksum = 'omo-research-campaign-schema-v1-fix1'");
    f.writer.db.exec("UPDATE campaign SET objective = 'drifted' WHERE campaign_id = 'alpha'");
    assert.throws(() => reader.list(), { code: 'STATE_INTEGRITY_ERROR' });
    assert.equal(f.writer.db.query("SELECT objective FROM campaign WHERE campaign_id='alpha'")[0].objective, 'drifted');
    f.writer.db.exec("UPDATE campaign SET objective='Review the campaign evidence',version=2 WHERE campaign_id='alpha'");
    assert.throws(() => reader.list(), {code:'STATE_INTEGRITY_ERROR'});
  } finally { f.close(); }
});

test('file and nested repository scopes resolve accurately; missing/non-Git scopes stay labelled', () => {
  const f = fixture();
  try {
    assert.equal(resolveScope(join(f.repository, 'note.md')).root, f.repository);
    assert.equal(resolveScope(f.nested).root, f.nested);
    assert.equal(resolveScope(f.repository).kind, 'repository');
    assert.equal(resolveScope(f.directory).kind, 'scope');
    assert.equal(resolveScope(join(f.directory, 'absent')).kind, 'missing');
    assert.equal(resolveScope(join(f.directory, 'absent')).root, join(f.directory, 'absent'));
  } finally { f.close(); }
});

test('all packages contribute to counts and details, including more than 100', () => {
  const f = fixture();
  try {
    f.create('alpha');
    for (let i=0;i<105;i++) addPackage(f, `p${i}`, i<101?'ACCEPTED':i===101?'CANCELLED':'BLOCKED');
    const reader = createReader({ dbPath: f.dbPath });
    const summary = reader.list().campaigns[0];
    assert.deepEqual(summary.packages, { total:105, accepted:101, cancelled:1, superseded:0 });
    assert.equal(reader.detail('alpha').work_packages.length,105);
    assert.equal(reader.detail('alpha').needs_owner,false);
    assert.equal(reader.detail('alpha').phase,null);
    assert.throws(() => reader.detail("alpha' OR 1=1 --"), { code:'INVALID_ID' });
    assert.equal(reader.detail('absent'), null);
  } finally { f.close(); }
});

test('proposed decisions count as owner attention and all scope groups remain available', () => {
  const f = fixture();
  try {
    f.create('alpha'); f.create('beta',f.nested);
    const sameName=join(f.directory,'other','workspace');mkdirSync(join(sameName,'.git'),{recursive:true});
    f.create('gamma',sameName);
    const stamp=new Date().toISOString();
    f.writer.db.exec('INSERT INTO decision VALUES (?, ?, ?, ?, ?, ?, ?, ?)', ['choice','alpha','PROPOSED','Choose method','PENDING','[]',stamp,stamp]);
    const data=createReader({dbPath:f.dbPath}).list();
    assert.equal(data.campaigns.find(c=>c.campaign_id==='alpha').needs_owner,true);
    assert.equal(data.repositories.length,3);
    assert.equal(new Set(data.repositories.map(r=>r.key)).size,3);
    assert.equal(data.repositories.filter(r=>r.name==='workspace').length,2);
    assert.ok(data.read_at);
  } finally {f.close();}
});
