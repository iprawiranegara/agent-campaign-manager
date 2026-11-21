#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createStore } from '../plugin/packages/campaign-core/src/core.mjs';
import { resolveClientInstallDir, resolveHermesHome } from './paths.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_NAME = 'agent-campaign-manager';
const usage = 'Usage: node scripts/setup.mjs <init|codex|claude|hermes> --state-dir <absolute-directory> [--output <absolute-directory>] [--hermes-home <absolute-profile>]';

function parseArgs(argv) {
  const [action, ...optionsArgv] = argv;
  if (!['init', 'codex', 'claude', 'hermes'].includes(action)) throw new Error(usage);
  const options = {};
  for (let i = 0; i < optionsArgv.length; i += 2) {
    const key = optionsArgv[i];
    const value = optionsArgv[i + 1];
    if (!['--state-dir', '--output', '--hermes-home'].includes(key)
      || !value || value.startsWith('--') || options[key]) throw new Error(usage);
    if (!isAbsolute(value)) throw new Error(`${key} must be an absolute path.`);
    options[key] = resolve(value);
  }
  if (!options['--state-dir']) throw new Error(`An explicit --state-dir is required. ${usage}`);
  if (action === 'init' && (options['--output'] || options['--hermes-home'])) throw new Error(usage);
  if (action !== 'hermes' && options['--hermes-home']) throw new Error(usage);
  return { action, options };
}

async function runSetup(argv) {
  const { action, options } = parseArgs(argv);
  const state = options['--state-dir'];
  const database = join(state, 'campaigns.sqlite3');
  const databaseExists = existsSync(database);
  if (action !== 'init' && !databaseExists) {
    throw new Error(`Campaign database does not exist at ${database}. Run campaign-manager init first; setup never initializes state implicitly.`);
  }

  const { ensurePrivateDirectory } = await import('../hermes/security.mjs');
  try {
    ensurePrivateDirectory(state);
  } catch (error) {
    throw new Error(`Campaign state path is not private or cannot be created (${error.message}). Choose a per-user state directory with no symlink or untrusted writable parent; existing permissions are never changed automatically.`);
  }

  const store = createStore({ stateDir: state, allowCreate: action === 'init' });
  let campaignCount;
  try { campaignCount = store.list().campaigns.length; } finally { store.dispose(); }

  if (action === 'init') {
    console.log(JSON.stringify({
      state_dir: state,
      created: !databaseExists,
      campaign_count: campaignCount,
      next_actions: [
        'Run campaign-manager prepare codex, campaign-manager prepare claude or campaign-manager prepare hermes to generate reviewable client files.',
        'Run campaign-manager dashboard after initialization to view campaigns locally.',
      ],
    }));
    return;
  }

  const output = options['--output'] || resolveClientInstallDir(action);
  if (existsSync(output)) {
    throw new Error(`Output already exists at ${output}. Choose a new --output directory or inspect and move the existing directory yourself; setup never overwrites it.`);
  }

  let profile;
  let channels;
  if (action === 'hermes') {
    profile = options['--hermes-home'] ? resolve(options['--hermes-home']) : resolveHermesHome();
    channels = join(profile, 'plugin-data', 'campaign-manager', 'channels');
    try {
      ensurePrivateDirectory(channels);
    } catch (error) {
      throw new Error(`Hermes profile channel path is not private or cannot be created (${error.message}). Choose a profile with trusted parent permissions; existing permissions are never changed automatically.`);
    }
  }

  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  mkdirSync(output, { mode: 0o700 });
  cpSync(join(root, 'plugin'), join(output, 'plugin'), { recursive: true });
  const save = (path, value) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  };

  if (action === 'codex') {
    save(join(output, 'plugin', '.mcp.json'), {
      mcpServers: {
        'research-campaign': {
          command: process.execPath,
          args: ['packages/mcp-server/src/server.mjs'],
          cwd: join(output, 'plugin'),
          env: { CAMPAIGN_HARNESS: 'codex', CAMPAIGN_CONTEXT_HOOKS: '1', CAMPAIGN_STATE_DIR: state },
        },
      },
    });
    save(join(output, '.agents/plugins/marketplace.json'), {
      name: 'campaign-manager',
      interface: { displayName: 'Campaign Manager' },
      plugins: [{
        name: PLUGIN_NAME,
        source: { source: 'local', path: './plugin' },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        category: 'Productivity',
      }],
    });
    console.log(JSON.stringify({
      output,
      marketplace: join(output, '.agents/plugins/marketplace.json'),
      state_dir: state,
      next_actions: [
        `Review the generated marketplace at ${join(output, '.agents/plugins/marketplace.json')} and MCP descriptor at ${join(output, 'plugin', '.mcp.json')}.`,
        `Register it with Codex using codex plugin marketplace add "${output}" --json, then codex plugin add ${PLUGIN_NAME}@campaign-manager --json.`,
        'Review hook definitions and approvals in Codex; preparation never trusts hooks or edits Codex configuration.',
      ],
    }));
    return;
  }

  if (action === 'claude') {
    // Claude Code resolves ${CLAUDE_PLUGIN_ROOT} to the installed (cached) plugin copy.
    save(join(output, 'plugin', '.mcp.json'), {
      mcpServers: {
        'research-campaign': {
          command: process.execPath,
          args: ['${CLAUDE_PLUGIN_ROOT}/packages/mcp-server/src/server.mjs'],
          env: { CAMPAIGN_HARNESS: 'claude', CAMPAIGN_CONTEXT_HOOKS: '1', CAMPAIGN_STATE_DIR: state },
        },
      },
    });
    const codexManifest = JSON.parse(readFileSync(join(root, 'plugin', '.codex-plugin', 'plugin.json'), 'utf8'));
    save(join(output, 'plugin', '.claude-plugin', 'plugin.json'), {
      name: PLUGIN_NAME,
      version: codexManifest.version,
      description: 'Durable campaign ledger, skills and post-compaction reminders for long-running Claude Code work.',
      author: codexManifest.author,
      license: codexManifest.license,
      keywords: ['campaign', 'research', 'governance', 'mcp'],
    });
    // Same callback as the Codex hooks; Claude names plugin MCP servers plugin:<plugin>:<server>.
    const handler = (event, statusMessage) => ({
      type: 'mcp_tool', server: `plugin:${PLUGIN_NAME}:research-campaign`, tool: 'campaign_context_hook',
      input: event === 'SessionStart' ? { event, source: '${source}' } : { event }, timeout: 5, statusMessage,
    });
    save(join(output, 'plugin', 'hooks', 'hooks.json'), {
      description: 'Read-only reminders for the explicitly bound campaign after compaction.',
      hooks: {
        SessionStart: [{ matcher: 'compact', hooks: [handler('SessionStart', 'Refreshing bound campaign context')] }],
        PostToolUse: [{ hooks: [handler('PostToolUse', 'Checking bound campaign context')] }],
        UserPromptSubmit: [{ hooks: [handler('UserPromptSubmit', 'Checking bound campaign context')] }],
      },
    });
    save(join(output, '.claude-plugin', 'marketplace.json'), {
      name: 'campaign-manager',
      owner: codexManifest.author,
      plugins: [{ name: PLUGIN_NAME, source: './plugin', description: 'Durable campaign ledger, skills and reminder hooks' }],
    });
    console.log(JSON.stringify({
      output,
      marketplace: join(output, '.claude-plugin', 'marketplace.json'),
      state_dir: state,
      next_actions: [
        `Review the generated marketplace at ${join(output, '.claude-plugin', 'marketplace.json')}, MCP descriptor at ${join(output, 'plugin', '.mcp.json')} and hooks at ${join(output, 'plugin', 'hooks', 'hooks.json')}.`,
        `Register it with Claude Code using claude plugin marketplace add "${output}", then claude plugin install ${PLUGIN_NAME}@campaign-manager.`,
        'Start a new Claude Code session; preparation never edits Claude Code settings.',
      ],
    }));
    return;
  }

  cpSync(join(root, 'hermes'), join(output, 'hermes'), { recursive: true });
  save(join(output, 'config.fragment.json'), {
    plugins: { entries: { 'campaign-manager': { mcp_allowlist: ['campaign-router'], settings: { channel_dir: channels } } } },
    mcp_servers: {
      'campaign-router': {
        command: process.execPath,
        args: [join(output, 'hermes/router.mjs'), '--channels', channels, '--state', state],
        cwd: output,
        env: { CAMPAIGN_STATE_DIR: state },
        trust: 'untrusted',
        tools: { include: [] },
        resources: false,
        prompts: false,
        sampling: false,
        lazy: false,
      },
    },
  });
  console.log(JSON.stringify({
    output,
    config_fragment: join(output, 'config.fragment.json'),
    plugin_path: join(output, 'hermes'),
    state_dir: state,
    hermes_home: profile,
    channel_directory: channels,
    next_actions: [
      `Review ${join(output, 'config.fragment.json')} and merge it manually into the selected Hermes profile config.`,
      `Expose the generated plugin from ${join(output, 'hermes')} in the selected Hermes profile, then run hermes plugins doctor "${join(output, 'hermes')}" --ci and explicitly enable campaign-manager.`,
      'Review Hermes tool access and native approval prompts; preparation never merges config, approves tools, or creates services.',
    ],
  }));
}

export { parseArgs, runSetup };

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  runSetup(process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
