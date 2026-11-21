import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

function pathApi(platform) {
  return platform === 'win32' ? win32 : posix;
}

function absolutePath(value, label, path) {
  if (typeof value !== 'string' || value.trim() === '' || !path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path.`);
  }
  return path.resolve(value);
}

export function resolveCampaignStateDir({ env = process.env, home = homedir(), platform = process.platform } = {}) {
  const path = pathApi(platform);
  // CAMPAIGN_STATE_DIR is the current name; CODEX_RESEARCH_CAMPAIGN_STATE_DIR is accepted as a legacy alias.
  for (const name of ['CAMPAIGN_STATE_DIR', 'CODEX_RESEARCH_CAMPAIGN_STATE_DIR']) {
    const override = env[name];
    if (override !== undefined && override !== '') return absolutePath(override, name, path);
  }
  const xdgStateHome = env.XDG_STATE_HOME;
  if (xdgStateHome !== undefined && xdgStateHome !== '') {
    return path.join(absolutePath(xdgStateHome, 'XDG_STATE_HOME', path), 'omo-research');
  }
  return path.join(path.resolve(home), '.local', 'state', 'omo-research');
}

export function resolveHermesHome({ env = process.env, home = homedir(), platform = process.platform } = {}) {
  const path = pathApi(platform);
  if (env.HERMES_HOME !== undefined && env.HERMES_HOME !== '') {
    return absolutePath(env.HERMES_HOME, 'HERMES_HOME', path);
  }
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA
      ? absolutePath(env.LOCALAPPDATA, 'LOCALAPPDATA', path)
      : path.join(path.resolve(home), 'AppData', 'Local');
    return path.join(localAppData, 'hermes');
  }
  return path.join(path.resolve(home), '.hermes');
}

export function resolveClientInstallDir(client, { env = process.env, home = homedir(), platform = process.platform } = {}) {
  if (!['codex', 'claude', 'hermes'].includes(client)) throw new Error(`Unknown client: ${client}`);
  const path = pathApi(platform);
  let dataHome;
  if (platform === 'win32') {
    dataHome = env.LOCALAPPDATA
      ? absolutePath(env.LOCALAPPDATA, 'LOCALAPPDATA', path)
      : path.join(path.resolve(home), 'AppData', 'Local');
  } else if (platform === 'darwin') {
    dataHome = path.join(path.resolve(home), 'Library', 'Application Support');
  } else {
    dataHome = env.XDG_DATA_HOME !== undefined && env.XDG_DATA_HOME !== ''
      ? absolutePath(env.XDG_DATA_HOME, 'XDG_DATA_HOME', path)
      : path.join(path.resolve(home), '.local', 'share');
  }
  return path.join(dataHome, 'omo-research', 'clients', client);
}
