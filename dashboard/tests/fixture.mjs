import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../../plugin/packages/campaign-core/src/core.mjs';

export function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'campaign-dashboard-'));
  const repository = join(directory, 'workspace');
  const nested = join(repository, 'extension');
  mkdirSync(join(repository, '.git'), { recursive: true });
  mkdirSync(join(nested, '.git'), { recursive: true });
  writeFileSync(join(repository, 'note.md'), 'fixture');
  const dbPath = join(directory, 'campaigns.sqlite3');
  const writer = createStore({ dbPath, allowCreate: true });
  const create = (id, scope = repository, objective = 'Review the campaign evidence') => writer.create({
    campaign_id: id, objective, scope_roots: [scope], actor: 'reviewer',
    accountable_primary: 'campaign-lead', profile: 'engineering',
  });
  return { directory, repository, nested, dbPath, writer, create,
    close() { writer.dispose(); rmSync(directory, { recursive: true, force: true }); } };
}

export function addPackage(f, id, status = 'DRAFT', campaign = 'alpha') {
  const timestamp = new Date().toISOString();
  f.writer.db.exec('INSERT INTO work_package VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, campaign, status, `Review ${id}`, '[]', JSON.stringify({ title: `Package ${id}` }), timestamp, timestamp]);
}
