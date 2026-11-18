import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { PROFILE_REQUIREMENTS } from '../plugin/packages/campaign-core/src/core.mjs';

const root = join(import.meta.dirname, '..');
const declaration = JSON.parse(await readFile(join(root, 'dependencies.json'), 'utf8'));

test('dependency declaration matches the skills each campaign profile names', () => {
  assert.equal(declaration.bundled, false);
  const byId = new Map(declaration.dependencies.map(dependency => [dependency.id, dependency]));
  for (const [profile, requirement] of Object.entries(PROFILE_REQUIREMENTS)) {
    for (const skill of requirement.required_skills) {
      const id = skill.split(':')[0];
      const dependency = byId.get(id);
      assert.ok(dependency, `${profile} names ${skill}, but dependencies.json does not declare ${id}`);
      assert.ok(dependency.required_by_profiles.includes(profile), `${id} must list profile ${profile}`);
      assert.ok(dependency.skills_named_by_profiles.includes(skill), `${id} must list skill ${skill}`);
    }
  }
  for (const dependency of declaration.dependencies) {
    for (const profile of dependency.required_by_profiles) {
      const named = PROFILE_REQUIREMENTS[profile]?.required_skills ?? [];
      assert.ok(named.some(skill => skill.startsWith(`${dependency.id}:`)), `${dependency.id} lists ${profile}, which names none of its skills`);
    }
  }
});

test('each dependency names its upstream source, license and tested commit', () => {
  for (const dependency of declaration.dependencies) {
    assert.match(dependency.repository, /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/);
    assert.equal(dependency.license, 'MIT');
    assert.match(dependency.tested_commit, /^[0-9a-f]{40}$/);
    assert.ok(dependency.author);
    for (const client of ['hermes', 'codex']) assert.ok(dependency.install[client], `${dependency.id} needs ${client} install guidance`);
  }
});
