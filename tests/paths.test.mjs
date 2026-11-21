import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveCampaignStateDir, resolveClientInstallDir, resolveHermesHome } from '../scripts/paths.mjs';

test('campaign state path precedence is explicit override, XDG state home, then home convention', () => {
  const home = '/users/tester';
  assert.equal(resolveCampaignStateDir({ platform: 'linux', home, env: {
    CODEX_RESEARCH_CAMPAIGN_STATE_DIR: '/users/tester/state/explicit',
    XDG_STATE_HOME: '/users/tester/state/xdg',
  } }), '/users/tester/state/explicit');
  assert.equal(resolveCampaignStateDir({ platform: 'linux', home, env: {
    XDG_STATE_HOME: '/users/tester/state/xdg',
  } }), '/users/tester/state/xdg/omo-research');
  assert.equal(resolveCampaignStateDir({ platform: 'linux', home, env: {} }), '/users/tester/.local/state/omo-research');
  assert.equal(resolveCampaignStateDir({ platform: 'linux', home, env: {
    CAMPAIGN_STATE_DIR: '/users/tester/state/current',
    CODEX_RESEARCH_CAMPAIGN_STATE_DIR: '/users/tester/state/legacy',
  } }), '/users/tester/state/current');
});

test('Hermes profile follows native Windows LOCALAPPDATA and honors an explicit override', () => {
  assert.equal(resolveHermesHome({ platform: 'win32', home: 'C:\\Users\\tester', env: {
    LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
  } }), 'C:\\Users\\tester\\AppData\\Local\\hermes');
  assert.equal(resolveHermesHome({ platform: 'win32', home: 'C:\\Users\\tester', env: {
    HERMES_HOME: 'D:\\Profiles\\hermes',
    LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
  } }), 'D:\\Profiles\\hermes');
});

test('client payloads default to stable per-user data directories on each native platform', () => {
  assert.equal(resolveClientInstallDir('codex', { platform: 'win32', home: 'C:\\Users\\tester', env: {
    LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
  } }), 'C:\\Users\\tester\\AppData\\Local\\omo-research\\clients\\codex');
  assert.equal(resolveClientInstallDir('hermes', { platform: 'darwin', home: '/users/tester', env: {} }),
    '/users/tester/Library/Application Support/omo-research/clients/hermes');
  assert.equal(resolveClientInstallDir('codex', { platform: 'linux', home: '/users/tester', env: {} }),
    '/users/tester/.local/share/omo-research/clients/codex');
  assert.equal(resolveClientInstallDir('claude', { platform: 'linux', home: '/users/tester', env: {} }),
    '/users/tester/.local/share/omo-research/clients/claude');
});

