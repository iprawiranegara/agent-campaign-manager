const CONTROL = /[\u0000-\u001f\u007f]/;

function fail(message) {
  throw new TypeError(`Invalid dashboard project catalog: ${message}`);
}

function portablePath(value) {
  if (typeof value !== 'string' || !value || value.trim() !== value || CONTROL.test(value)) {
    fail('project roots and aliases must be non-empty paths without control characters or surrounding whitespace.');
  }

  const normalizedSeparators = value.replaceAll('\\', '/');
  if (normalizedSeparators.startsWith('//')) {
    const segments = normalizedSeparators.slice(2).split('/').filter(Boolean);
    if (segments.length < 2) fail(`UNC path "${value}" must include a server and share.`);
    const stack = segments.slice(0, 2);
    for (const segment of segments.slice(2)) {
      if (segment === '.') continue;
      if (segment === '..') {
        if (stack.length > 2) stack.pop();
      } else stack.push(segment);
    }
    const normalized = `//${stack.join('/')}`;
    return { type: 'windows', value: normalized, compare: normalized.toLowerCase() };
  }

  if (/^[A-Za-z]:\//.test(normalizedSeparators)) {
    const drive = normalizedSeparators.slice(0, 2);
    const stack = [];
    for (const segment of normalizedSeparators.slice(3).split('/')) {
      if (!segment || segment === '.') continue;
      if (segment === '..') stack.pop();
      else stack.push(segment);
    }
    const normalized = `${drive}/${stack.join('/')}`;
    return { type: 'windows', value: normalized, compare: normalized.toLowerCase() };
  }

  if (normalizedSeparators.startsWith('/')) {
    const stack = [];
    for (const segment of normalizedSeparators.split('/')) {
      if (!segment || segment === '.') continue;
      if (segment === '..') stack.pop();
      else stack.push(segment);
    }
    const normalized = `/${stack.join('/')}`;
    return { type: 'posix', value: normalized, compare: normalized };
  }

  fail(`"${value}" must be an absolute POSIX, Windows drive, or UNC path.`);
}

function ownsPath(root, candidate) {
  if (root.type !== candidate.type) return false;
  if (root.compare === candidate.compare) return true;
  if (root.type === 'posix' && root.compare === '/') return candidate.compare.startsWith('/');
  if (root.type === 'windows' && /^[a-z]:\/$/.test(root.compare)) return candidate.compare.startsWith(root.compare);
  return candidate.compare.startsWith(`${root.compare}/`);
}

function compileProjects(projects) {
  if (!Array.isArray(projects)) fail('expected an array.');
  const names = new Set();
  const paths = new Map();
  return projects.map((project, index) => {
    if (!project || typeof project !== 'object' || Array.isArray(project)) fail(`entry ${index + 1} must be an object.`);
    const keys = Object.keys(project);
    if (keys.some(key => !['name', 'root', 'aliases'].includes(key))) fail(`entry ${index + 1} may contain only name, root, and aliases.`);
    const name = project.name;
    if (typeof name !== 'string' || !name.trim() || name.trim() !== name || name.length > 100 || CONTROL.test(name)) {
      fail(`entry ${index + 1} needs a display name of 1 to 100 characters.`);
    }
    const nameKey = name.toLocaleLowerCase('en-US');
    if (names.has(nameKey)) fail(`project name "${name}" is duplicated.`);
    names.add(nameKey);
    if (project.aliases !== undefined && !Array.isArray(project.aliases)) fail(`aliases for "${name}" must be an array.`);
    const aliases = project.aliases ?? [];
    if (aliases.some(alias => typeof alias !== 'string')) fail(`every alias for "${name}" must be a path string.`);
    const configuredPaths = [project.root, ...aliases].map(portablePath);
    for (const path of configuredPaths) {
      const owner = paths.get(`${path.type}:${path.compare}`);
      if (owner && owner !== name) fail(`path "${path.value}" is assigned to both "${owner}" and "${name}".`);
      paths.set(`${path.type}:${path.compare}`, name);
    }
    return { name, root: project.root, aliases: [...aliases], matchPaths: configuredPaths };
  });
}

export function validateProjects(projects = []) {
  return compileProjects(projects).map(({ name, root, aliases }) => ({ name, root, aliases }));
}

function matchProject(value, projects) {
  let candidate;
  try { candidate = portablePath(value); }
  catch { return null; }
  let match = null;
  let matchLength = -1;
  for (const project of projects) {
    for (const root of project.matchPaths) {
      if (ownsPath(root, candidate) && root.compare.length > matchLength) {
        match = project;
        matchLength = root.compare.length;
      }
    }
  }
  return match;
}

function projectRow(project) {
  return { key: project.root, name: project.name, root: project.root, kind: 'project' };
}

function rawRow(repository) {
  const key = repository.key ?? repository.root ?? repository.name ?? 'unknown';
  return { ...repository, key };
}

export function projectCampaigns(data, projects = data?.project_catalog ?? []) {
  const catalog = compileProjects(projects);
  const counts = new Map();
  const campaigns = (data?.campaigns ?? []).map(campaign => {
    const matchedProjects = new Map();
    const matchedScopes = [];
    for (const scope of campaign.scope_roots ?? []) {
      const project = matchProject(scope, catalog);
      if (project) {
        matchedProjects.set(project.root, projectRow(project));
        try { matchedScopes.push(portablePath(scope)); } catch { /* invalid scopes remain visible in their stored form */ }
      }
    }
    for (const repository of campaign.repositories ?? []) {
      const project = matchProject(repository.root ?? repository.key, catalog);
      if (project) matchedProjects.set(project.root, projectRow(project));
    }
    for (const repository of campaign.repositories ?? []) {
      if (matchProject(repository.root ?? repository.key, catalog)) continue;
      let repositoryPath;
      try { repositoryPath = portablePath(repository.root ?? repository.key); }
      catch { repositoryPath = null; }
      const isOuterAttribution = repositoryPath && matchedScopes.some(scope => ownsPath(repositoryPath, scope));
      if (!isOuterAttribution) {
        const row = rawRow(repository);
        if (!matchedProjects.has(row.key)) matchedProjects.set(row.key, row);
      }
    }
    const assigned = matchedProjects.size ? matchedProjects : new Map();
    const projected_repositories = [...assigned.values()].sort((a, b) => a.name.localeCompare(b.name) || String(a.root ?? '').localeCompare(String(b.root ?? '')));
    for (const repository of projected_repositories) {
      if (!counts.has(repository.key)) counts.set(repository.key, { ...repository, count: 0 });
      counts.get(repository.key).count++;
    }
    return { ...campaign, projected_repositories };
  });
  const projected_repositories = [...counts.values()].sort((a, b) => a.name.localeCompare(b.name) || String(a.root ?? '').localeCompare(String(b.root ?? '')));
  return { ...data, campaigns, projected_repositories };
}
