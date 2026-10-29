import { parseArgs } from 'node:util';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { install, update, rollback, uninstall, packRelease, type Host } from './installation/index.ts';
import { detectHost } from './detection/host.ts';
import { getCatalogForHost } from '../../core/src/model-registry/service.ts';
import { globalConfigPath } from '../../core/src/config/index.ts';
import { git } from '../../core/src/git/repository.ts';

const help = `ORCH local release management (Node >=24 and Git required)
  pack --source DIR --bundle DIR --version VERSION
  install [--bundle DIR --checksum SHA256] [--target auto|codex|claude|hermes|both|all] [--scope user|project] [--project DIR] [--dry-run] [--yes]
  update --bundle DIR --checksum SHA256 [same options]
  rollback --version VERSION [--target auto|codex|claude|hermes|both|all] [same scope options]
  uninstall [--target auto|codex|claude|hermes|both|all] [--keep-data] [same scope options]

user is the global/current-user scope; project requires a Git root.
--checksum is the externally trusted SHA256 of the bundle's release.json.
Without bundle arguments, install/update build and verify this local source automatically.
Updates use local verified bundles; remote release retrieval is not configured.
--yes never authorizes overwrites. Data and old versions are always retained.
Host restart/reload and authenticated invocation remain separately unverified.`;

export async function manage(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    target: { type: 'string', default: 'auto' }, scope: { type: 'string', default: 'user' },
    project: { type: 'string' }, bundle: { type: 'string' }, checksum: { type: 'string' },
    source: { type: 'string' }, version: { type: 'string' }, root: { type: 'string' },
    'dry-run': { type: 'boolean' }, yes: { type: 'boolean' }, 'keep-data': { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help || !positionals.length) return { help };
  if (positionals.length !== 1) throw new Error('INVALID_COMMAND');
  const command = positionals[0];
  if (command === 'pack') {
    if (!values.source || !values.bundle || !values.version || values['dry-run']) throw new Error('PACK_REQUIRES_SOURCE_BUNDLE_VERSION');
    return { bundle: resolve(values.bundle), checksum: await packRelease(values.source, values.bundle, values.version) };
  }
  if (!['install', 'update', 'uninstall', 'rollback'].includes(command)) throw new Error('INVALID_COMMAND');
  if (values.scope !== 'user' && values.scope !== 'project') throw new Error('INVALID_SCOPE');
  if (!['auto', 'both', 'all', 'codex', 'claude', 'hermes'].includes(values.target)) throw new Error('INVALID_TARGET');
  const home = homedir(), scope: 'user' | 'project' = values.scope;
  let project: string | undefined;
  if (scope === 'project') {
    if (!values.project) throw new Error('PROJECT_REQUIRED');
    project = await realpath(resolve(values.project));
    const root = await git(project, 'rev-parse', '--show-toplevel');
    if (resolve(root) !== project) throw new Error('PROJECT_MUST_BE_GIT_ROOT');
  }
  await git(project ?? process.cwd(), '--version');
  const configFile = scope === 'project' ? join(project!, '.orch/config.yaml') : globalConfigPath(process.env, process.platform, home);
  const root = resolve(values.root ?? (scope === 'project' ? join(project!, '.orch/installation') : process.platform === 'win32' ? join(process.env.LOCALAPPDATA ?? join(home, 'AppData/Local'), 'orch') : join(process.env.XDG_DATA_HOME ?? join(home, '.local/share'), 'orch')));
  let hosts: Host[];
  if (command === 'uninstall' && values.target === 'auto') {
    try { hosts = Object.keys(JSON.parse(await readFile(join(root, 'installation.json'), 'utf8')).hosts) as Host[]; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; hosts = []; }
  } else {
    const customHermesHome = process.env.HERMES_HOME && resolve(process.env.HERMES_HOME) !== join(home, '.hermes');
    const requested: Host[] = values.target === 'both' ? ['codex', 'claude'] : values.target === 'all' || values.target === 'auto' ? ['codex', 'claude', 'hermes'] : [values.target as Host];
    if (values.target === 'auto' && (scope === 'project' || customHermesHome)) requested.splice(requested.indexOf('hermes'), 1);
    if (requested.includes('hermes') && scope === 'project') throw new Error('HERMES_USER_SCOPE_REQUIRED');
    if (requested.includes('hermes') && customHermesHome) throw new Error('HERMES_CUSTOM_HOME_UNSUPPORTED');
    if (command === 'uninstall' || command === 'rollback') hosts = requested;
    else {
      const detected = await Promise.all(requested.map(host => detectHost(host)));
      hosts = detected.filter(host => host.status === 'detected').map(host => host.host);
      if (values.target !== 'auto' && hosts.length !== requested.length) throw new Error('REQUESTED_HOST_NOT_FOUND');
      if (!hosts.length) throw new Error('NO_HOST_DETECTED');
    }
  }
  const catalogOptions = { readOnly: true, refresh: false };
  const options = { root, home, scope, project, configFile, hosts, dryRun: !!values['dry-run'], verifyMetadata: (host: Host) => getCatalogForHost(project ?? null, host, catalogOptions) };
  if (command === 'uninstall') return uninstall(options);
  if (command === 'rollback') {
    if (!values.version) throw new Error('ROLLBACK_VERSION_REQUIRED');
    return rollback({ ...options, version: values.version });
  }
  if (!values.bundle && !values.checksum) {
    const temporary = await mkdtemp(join(tmpdir(), 'orch-install-'));
    try {
      const bundle = join(temporary, 'bundle');
      const checksum = await packRelease(fileURLToPath(new URL('../../../', import.meta.url)), bundle, values.version);
      return await install({ ...options, bundle, checksum });
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  if (!values.bundle || !values.checksum) throw new Error('VERIFIED_LOCAL_BUNDLE_REQUIRED');
  if (values.version) {
    const release = JSON.parse(await readFile(join(values.bundle, 'release.json'), 'utf8'));
    if (release.version !== values.version) throw new Error('REQUESTED_VERSION_MISMATCH');
  }
  return (command === 'update' ? update : install)({ ...options, bundle: resolve(values.bundle), checksum: values.checksum });
}

if (process.argv[1] && await realpath(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  try { const result = await manage(process.argv.slice(2)); console.log('help' in result ? result.help : JSON.stringify(result, null, 2)); }
  catch (error) { console.error(error instanceof Error ? error.message : 'Installation failed'); process.exitCode = 1; }
}
