#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCampaignStateDir } from '../scripts/paths.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const usage = `campaign-manager ${packageJson.version}

Usage:
  campaign-manager init [--state-dir <absolute-path>]
  campaign-manager prepare <codex|claude|hermes> [--state-dir <absolute-path>] [--output <absolute-path>] [--hermes-home <absolute-path>]
  campaign-manager dashboard [--state-dir <absolute-path>] [--port <0-65535>] [--projects <json-file>]
  campaign-manager --version

State defaults to CAMPAIGN_STATE_DIR (legacy alias CODEX_RESEARCH_CAMPAIGN_STATE_DIR), then XDG_STATE_HOME/omo-research,
then ~/.local/state/omo-research. Initialization is explicit; dashboard never creates state.
Preparation writes reviewable files in a per-user data directory and never edits client config.
`;

function parseOptions(argv, allowed) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.includes(key) || !value || value.startsWith('--') || options[key]) {
      throw new Error(`Unknown or incomplete option: ${key}\n${usage}`);
    }
    options[key] = value;
    index += 1;
  }
  return options;
}

function absoluteOption(options, key) {
  if (options[key] === undefined) return undefined;
  if (!isAbsolute(options[key])) throw new Error(`${key} must be an absolute path.`);
  return resolve(options[key]);
}

function stateDirectory(options) {
  return absoluteOption(options, '--state-dir') || resolveCampaignStateDir();
}

function runSetup(action, client, options, stateDir) {
  const args = [join(root, 'scripts/setup.mjs'), action, '--state-dir', stateDir];
  const output = absoluteOption(options, '--output');
  const hermesHome = absoluteOption(options, '--hermes-home');
  if (output) args.push('--output', output);
  if (hermesHome) args.push('--hermes-home', hermesHome);
  if (client) args[1] = client;
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

async function startDashboard(options) {
  const stateDir = stateDirectory(options);
  const dbPath = join(stateDir, 'campaigns.sqlite3');
  if (!existsSync(dbPath)) {
    throw new Error(`Campaign database does not exist at ${dbPath}. Run campaign-manager init first; dashboard never initializes state.`);
  }

  let port = 52526;
  if (options['--port'] !== undefined) {
    if (!/^\d+$/.test(options['--port'])) throw new Error('--port must be an integer from 0 through 65535.');
    port = Number(options['--port']);
    if (port > 65535) throw new Error('--port must be an integer from 0 through 65535.');
  }

  let projects = [];
  if (options['--projects'] !== undefined) {
    const projectsPath = resolve(options['--projects']);
    const parsed = JSON.parse(readFileSync(projectsPath, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error(`Project catalog must be a JSON array: ${projectsPath}`);
    projects = parsed;
  }

  const { startDashboard: start } = await import('../dashboard/src/server.mjs');
  const dashboard = await start({ dbPath, port, projects });
  const address = dashboard.address;
  const host = address.address.includes(':') ? `[${address.address}]` : address.address;
  console.log(`Campaign dashboard listening on http://${host}:${address.port}`);

  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    dashboard.close().catch(error => {
      console.error(`campaign-manager: dashboard shutdown failed: ${error.message}`);
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

async function main(argv) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    process.stdout.write(usage);
    return;
  }
  if (argv[0] === '--version' || argv[0] === '-v' || argv[0] === 'version') {
    console.log(packageJson.version);
    return;
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(usage);
    return;
  }

  const [command, ...args] = argv;
  if (command === 'init') {
    const options = parseOptions(args, ['--state-dir']);
    runSetup('init', undefined, options, stateDirectory(options));
    return;
  }
  if (command === 'prepare') {
    const [client, ...optionArgs] = args;
    if (!['codex', 'claude', 'hermes'].includes(client)) throw new Error(`Choose a client: codex, claude or hermes.\n${usage}`);
    const options = parseOptions(optionArgs, ['--state-dir', '--output', '--hermes-home']);
    if (client !== 'hermes' && options['--hermes-home']) throw new Error('--hermes-home is only valid with prepare hermes.');
    runSetup(client, undefined, options, stateDirectory(options));
    return;
  }
  if (command === 'dashboard') {
    const options = parseOptions(args, ['--state-dir', '--port', '--projects']);
    await startDashboard(options);
    return;
  }
  throw new Error(`Unknown command: ${command}\n${usage}`);
}

main(process.argv.slice(2)).catch(error => {
  console.error(`campaign-manager: ${error.message}`);
  process.exitCode = 1;
});
