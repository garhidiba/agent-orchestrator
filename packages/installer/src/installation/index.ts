import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep, posix } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import * as TOML from '@iarna/toml';
import { z } from 'zod';
import { parseDocument } from 'yaml';
import { probeMcp } from '../diagnostics/mcp.ts';
import { parseConfig } from '../../../core/src/config/index.ts';

const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const versionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/);
const hashesSchema = z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/));
const releaseSchema = z.object({ schema: z.literal(1), version: versionSchema, nodeMajor: z.literal(24), platform: z.string(), arch: z.string(), hostExecution: z.literal('UNVERIFIED'), sqlite: z.literal('node:sqlite'), skippedOptionalPackages: z.array(z.string()).default([]), files: hashesSchema }).strict();
type Release = z.infer<typeof releaseSchema>;
const releaseSkills = (release: Release) => release.files['skills/agent-orch/SKILL.md'] ? ['agent-orch', 'agent-orch-configure'] : ['orch', 'orch-configure'];
export type Host = 'codex' | 'claude' | 'hermes';
export interface InstallOptions {
  root: string; home: string; scope: 'user' | 'project'; project?: string; configFile?: string;
  hosts: readonly Host[]; bundle: string; checksum: string; runtime?: string; dryRun?: boolean;
  verifyMetadata?: (host: Host) => Promise<unknown>;
  // Migration runs only against the backed-up ORCH config; host settings and run data are not migration inputs.
  migrate?: (configFile: string, previousVersion: string | null) => Promise<void>;
}
const hostRecordSchema = z.object({ version: versionSchema, files: hashesSchema, entry: z.record(z.string(), z.unknown()), runtime: z.string() }).strict();
const manifestSchema = z.object({ schema: z.literal(1), scope: z.enum(['user', 'project']), base: z.string(), releases: hashesSchema, activeVersion: versionSchema.nullable(), hosts: z.object({ codex: hostRecordSchema.optional(), claude: hostRecordSchema.optional(), hermes: hostRecordSchema.optional() }).strict() }).strict();
type Manifest = z.infer<typeof manifestSchema>;
type HostRecord = z.infer<typeof hostRecordSchema>;

async function optional(file: string): Promise<Buffer | null> {
  try { return await readFile(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
async function safe(file: string, base: string) {
  const inside = relative(base, file);
  if (inside.startsWith(`..${sep}`) || inside === '..' || isAbsolute(inside)) throw new Error('INSTALL_PATH_OUTSIDE_SCOPE');
  for (let path = file; path !== base; path = dirname(path)) {
    try { if ((await lstat(path)).isSymbolicLink()) throw new Error('INSTALL_SYMLINK_CONFLICT'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
async function filesAt(root: string, prefix = ''): Promise<Record<string, string>> {
  const names: string[] = [];
  const collect = async (directory: string) => {
    for (const entry of (await readdir(join(root, directory), { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const name = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error('RELEASE_UNSAFE_FILE');
      if (entry.isDirectory()) await collect(name); else names.push(name);
    }
  };
  await collect(prefix);
  const files: Record<string, string> = {};
  // Bound open files while preserving deterministic path order and checking every byte.
  for (let offset = 0; offset < names.length; offset += 32) {
    const batch = names.slice(offset, offset + 32);
    const hashes = await Promise.all(batch.map(async name => hash(await readFile(join(root, name)))));
    batch.forEach((name, index) => { files[name] = hashes[index]!; });
  }
  return files;
}
async function readAsset(bundle: string, release: Release, name: string) {
  const data = await readFile(join(bundle, name));
  if (hash(data) !== release.files[name]) throw new Error('RELEASE_CONTENT_MISMATCH');
  return data;
}
function validName(name: string) {
  if (!name || name.includes('\\') || name.startsWith('/') || name.split('/').some(part => part === '..' || part === '.' || !part) || name.includes(':')) throw new Error('RELEASE_UNSAFE_PATH');
}
export async function verifyRelease(bundle: string, checksum: string): Promise<Release> {
  const bytes = await readFile(join(bundle, 'release.json'));
  if (!/^[a-f0-9]{64}$/.test(checksum) || hash(bytes) !== checksum) throw new Error('RELEASE_CHECKSUM_MISMATCH');
  const release = releaseSchema.parse(JSON.parse(bytes.toString()));
  for (const name of Object.keys(release.files)) validName(name);
  const actual = await filesAt(bundle); delete actual['release.json'];
  if (!isDeepStrictEqual(actual, release.files)) throw new Error('RELEASE_CONTENT_MISMATCH');
  for (const required of ['package.json', 'packages/mcp-server/src/stdio.ts', ...releaseSkills(release).map(name => `skills/${name}/SKILL.md`), 'templates/defaults/config.yaml']) {
    if (!release.files[required]) throw new Error(`RELEASE_MISSING_ASSET: ${required}`);
  }
  if (release.platform !== process.platform || release.arch !== process.arch) throw new Error('RELEASE_PLATFORM_UNVERIFIED');
  if (Number(process.versions.node.split('.')[0]) < release.nodeMajor) throw new Error('RUNTIME_UNSUPPORTED: Node >=24 required');
  return release;
}

const dependenciesSchema = z.record(z.string(), z.string());
const lockEntrySchema = z.object({
  version: z.string().optional(), resolved: z.string().optional(), integrity: z.string().optional(), link: z.boolean().optional(),
  dependencies: dependenciesSchema.optional(), optionalDependencies: dependenciesSchema.optional(), peerDependencies: dependenciesSchema.optional(),
  peerDependenciesMeta: z.record(z.string(), z.object({ optional: z.boolean().optional() })).optional(),
}).passthrough();

async function copyProductionDependencies(source: string, bundle: string) {
  const pkg = z.object({ dependencies: dependenciesSchema.default({}), optionalDependencies: dependenciesSchema.default({}) })
    .parse(JSON.parse(await readFile(join(source, 'package.json'), 'utf8')));
  if (!Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies }).length) return [];
  await safe(join(source, 'package-lock.json'), source);
  const lockBytes = await optional(join(source, 'package-lock.json'));
  if (!lockBytes) throw new Error('RELEASE_LOCK_REQUIRED');
  const lock = z.object({ lockfileVersion: z.union([z.literal(2), z.literal(3)]), packages: z.record(z.string(), lockEntrySchema) })
    .parse(JSON.parse(lockBytes.toString()));
  if (!isDeepStrictEqual(lock.packages['']?.dependencies ?? {}, pkg.dependencies) ||
      !isDeepStrictEqual(lock.packages['']?.optionalDependencies ?? {}, pkg.optionalDependencies)) throw new Error('RELEASE_LOCK_STALE');
  const modulesRoot = await realpath(join(source, 'node_modules')); // The one allowed link is the shared root itself.
  const seen = new Set<string>(), skipped: string[] = [];
  const visit = async (requester: string, name: string, optionalDependency: boolean): Promise<void> => {
    if (!/^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(name)) throw new Error('RELEASE_DEPENDENCY_PATH_INVALID');
    let ancestor = requester, key: string | undefined;
    while (true) {
      const candidate = ancestor ? `${ancestor}/node_modules/${name}` : `node_modules/${name}`;
      if (lock.packages[candidate]) { key = candidate; break; }
      if (!ancestor) break;
      ancestor = posix.dirname(ancestor); if (ancestor === '.') ancestor = '';
    }
    if (!key) {
      if (optionalDependency) { skipped.push(`${requester || '<root>'}:${name}:not-locked`); return; }
      throw new Error(`RELEASE_DEPENDENCY_NOT_LOCKED: ${name}`);
    }
    if (seen.has(key)) return;
    const entry = lock.packages[key]!;
    if (entry.link || !entry.version || !entry.integrity || !entry.resolved?.startsWith('https://')) throw new Error('RELEASE_EXTERNAL_DEPENDENCY');
    if (!/^node_modules\/(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/node_modules\/(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/.test(key)) throw new Error('RELEASE_DEPENDENCY_PATH_INVALID');
    const packageDir = join(modulesRoot, key.slice('node_modules/'.length));
    await safe(packageDir, modulesRoot);
    try { await lstat(packageDir); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (optionalDependency) { skipped.push(`${key}:not-installed`); return; }
      throw new Error(`RELEASE_DEPENDENCY_MISSING: ${key}`);
    }
    await safe(join(packageDir, 'package.json'), modulesRoot);
    const installed = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')) as { version?: string };
    if (installed.version !== entry.version) throw new Error(`RELEASE_DEPENDENCY_VERSION_MISMATCH: ${key}`);
    await cp(packageDir, join(bundle, key), { recursive: true, dereference: false, filter: async path => {
      const info = await lstat(path);
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new Error('RELEASE_UNSAFE_FILE');
      return path === packageDir || path.split(sep).at(-1) !== 'node_modules';
    } });
    seen.add(key);
    await visitDependencies(key, entry);
  };
  const visitDependencies = async (requester: string, entry: z.infer<typeof lockEntrySchema>) => {
    const required = { ...entry.peerDependencies, ...entry.dependencies };
    for (const name of Object.keys({ ...required, ...entry.optionalDependencies })) {
      const optionalDependency = name in (entry.optionalDependencies ?? {}) ||
        (!(name in (entry.dependencies ?? {})) && entry.peerDependenciesMeta?.[name]?.optional === true);
      await visit(requester, name, optionalDependency);
    }
  };
  await visitDependencies('', { dependencies: pkg.dependencies, optionalDependencies: pkg.optionalDependencies });
  return skipped;
}

export async function packRelease(source: string, bundle: string, version?: string) {
  if (version !== undefined) versionSchema.parse(version);
  source = resolve(source); bundle = resolve(bundle);
  if (source === bundle || bundle.startsWith(`${source}${sep}`)) throw new Error('BUNDLE_MUST_BE_OUTSIDE_SOURCE');
  await mkdir(bundle); // Never reuse or overwrite a previous release directory.
  try {
    for (const asset of ['packages', 'skills', 'references', 'templates', 'package.json']) {
      if (asset !== 'package.json') await filesAt(join(source, asset));
      await cp(join(source, asset), join(bundle, asset), { recursive: true, dereference: false });
    }
    const skippedOptionalPackages = await copyProductionDependencies(source, bundle);
    for (const asset of ['scripts', 'README.md', 'LICENSE']) {
      try { await lstat(join(source, asset)); await cp(join(source, asset), join(bundle, asset), { recursive: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const lock = await optional(join(source, 'package-lock.json')); if (lock) await writeFile(join(bundle, 'package-lock.json'), lock);
    const plugin = await optional(join(bundle, 'templates/claude/plugin/.claude-plugin/plugin.json'));
    // Plugin wrappers read the canonical skill directly from the bundle.
    if (plugin) for (const name of Object.keys(await filesAt(join(bundle, 'skills')))) {
      if (/^[^/]+\/SKILL\.md$/.test(name)) await cp(join(bundle, 'references'), join(bundle, 'skills', dirname(name), 'references'), { recursive: true });
    }
    const preparePlugin = async (pluginVersion: string) => {
      if (!plugin) return; // Historical releases remain installable without a plugin.
      await mkdir(join(bundle, '.claude-plugin'), { recursive: true });
      await writeFile(join(bundle, '.claude-plugin/plugin.json'), JSON.stringify({ ...JSON.parse(plugin.toString()), version: pluginVersion }, null, 2) + '\n');
      await cp(join(bundle, 'templates/claude/plugin/.mcp.json'), join(bundle, '.mcp.json'));
      await cp(join(bundle, 'templates/claude/plugin/hooks'), join(bundle, 'hooks'), { recursive: true });
    };
    await preparePlugin(version ?? JSON.parse(await readFile(join(source, 'package.json'), 'utf8')).version);
    const files = await filesAt(bundle);
    // Content-derived versions make unchanged local installs idempotent, including outside Git.
    version ??= `${versionSchema.parse(JSON.parse(await readFile(join(source, 'package.json'), 'utf8')).version)}-local.${hash(JSON.stringify([process.platform, process.arch, files])).slice(0, 16)}`;
    if (plugin) { await preparePlugin(version); files['.claude-plugin/plugin.json'] = hash(await readFile(join(bundle, '.claude-plugin/plugin.json'))); }
    const release: Release = { schema: 1, version, nodeMajor: 24, platform: process.platform, arch: process.arch, hostExecution: 'UNVERIFIED', sqlite: 'node:sqlite', skippedOptionalPackages, files };
    const bytes = JSON.stringify(release, null, 2) + '\n';
    await writeFile(join(bundle, 'release.json'), bytes);
    const checksum = hash(bytes); await verifyRelease(bundle, checksum); return checksum;
  } catch (error) { await rm(bundle, { recursive: true, force: true }); throw error; }
}

function layout(options: Pick<InstallOptions, 'root' | 'home' | 'scope' | 'project' | 'configFile'>) {
  const root = resolve(options.root), home = resolve(options.home);
  if (options.scope === 'project' && !options.project) throw new Error('PROJECT_REQUIRED');
  const base = options.scope === 'project' ? resolve(options.project!) : home;
  return { root, home, base, manifest: join(root, 'installation.json'), config: options.configFile ? resolve(options.configFile) : options.scope === 'project' ? join(base, '.orch/config.yaml') : process.platform === 'win32' ? join(home, 'AppData/Roaming/orch/config.yaml') : join(home, '.config/orch/config.yaml') };
}
function configPath(host: Host, options: Pick<InstallOptions, 'home' | 'scope' | 'project'>) {
  if (host === 'hermes' && options.scope !== 'user') throw new Error('HERMES_USER_SCOPE_REQUIRED');
  const base = options.scope === 'user' ? resolve(options.home) : resolve(options.project!);
  return host === 'codex' ? join(base, '.codex/config.toml') : host === 'hermes' ? join(base, '.hermes/config.yaml') : join(base, options.scope === 'user' ? '.claude.json' : '.mcp.json');
}
function skillRoot(host: Host, base: string) { return join(base, host === 'codex' ? '.agents/skills' : host === 'hermes' ? '.hermes/skills' : '.claude/skills'); }
function decodeConfig(host: Host, data: Buffer | null): Record<string, unknown> {
  try {
    if (data && data.length > 1024 * 1024) throw new Error();
    const doc = host === 'hermes' ? parseDocument(data?.toString() ?? '{}', { uniqueKeys: true, schema: 'core' }) : null;
    if (doc && (doc.errors.length || doc.warnings.length)) throw new Error();
    const parsed: unknown = doc ? doc.toJS({ maxAliasCount: 0 }) : data === null ? {} : host === 'codex' ? TOML.parse(data.toString()) : JSON.parse(data.toString());
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch { throw new Error('HOST_CONFIG_INVALID'); }
}
function entries(host: Host, config: Record<string, unknown>) {
  const key = host === 'claude' ? 'mcpServers' : 'mcp_servers';
  if (config[key] === undefined) config[key] = {};
  if (!config[key] || typeof config[key] !== 'object' || Array.isArray(config[key])) throw new Error('HOST_CONFIG_INVALID');
  return config[key] as Record<string, unknown>;
}
function encodeConfig(host: Host, config: Record<string, unknown>, before: Buffer | null) {
  if (host === 'hermes') {
    const doc = parseDocument(before?.toString() ?? '{}', { uniqueKeys: true, schema: 'core' });
    const entry = (config.mcp_servers as Record<string, unknown>).orch;
    if (entry === undefined) doc.deleteIn(['mcp_servers', 'orch']);
    else doc.setIn(['mcp_servers', 'orch'], entry);
    return Buffer.from(doc.toString());
  }
  return Buffer.from(host === 'codex' ? TOML.stringify(config as Parameters<typeof TOML.stringify>[0]) : JSON.stringify(config, null, 2) + '\n');
}
async function getManifest(path: string, scope: 'user' | 'project', base: string): Promise<Manifest> {
  const bytes = await optional(path);
  const manifest = bytes ? manifestSchema.parse(JSON.parse(bytes.toString())) : { schema: 1 as const, scope, base, releases: {}, activeVersion: null, hosts: {} };
  if (manifest.scope !== scope || manifest.base !== base) throw new Error('INSTALL_SCOPE_MISMATCH');
  return manifest;
}
async function atomic(file: string, data: Buffer) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, data, { flag: 'wx', mode: 0o600 }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}
interface Change { file: string; before: Buffer | null; after: Buffer | null }
async function apply(changes: Change[]) {
  const completed: Change[] = [], createdDirs = new Set<string>();
  for (const change of changes) {
    for (let dir = dirname(change.file); dir !== dirname(dir); dir = dirname(dir)) {
      try { await lstat(dir); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; createdDirs.add(dir); }
    }
  }
  try {
    for (const change of changes) {
      if (!isDeepStrictEqual(await optional(change.file), change.before)) throw new Error('INSTALL_CONCURRENT_EDIT');
      if (change.after === null) await rm(change.file, { force: true }); else await atomic(change.file, change.after);
      completed.push(change);
    }
  } catch (error) {
    for (const change of completed.reverse()) {
      if (!isDeepStrictEqual(await optional(change.file), change.after)) continue; // Preserve concurrent user edits during rollback.
      if (change.before === null) await rm(change.file, { force: true }); else await atomic(change.file, change.before);
    }
    for (const dir of [...createdDirs].sort((a, b) => b.length - a.length)) {
      try { await rmdir(dir); } catch { /* A concurrent addition must be preserved. */ }
    }
    throw error;
  }
}
async function removeEmptyOwnedDirectories(changes: Change[]) {
  const dirs = new Set(changes.filter(change => change.after === null).map(change => dirname(change.file)));
  for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
    try { await rmdir(dir); } catch (error) { if (!['ENOENT', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code!)) throw error; }
  }
}
async function locked<T>(root: string, action: () => Promise<T>) {
  await safe(root, dirname(root));
  await mkdir(root, { recursive: true });
  const lock = join(root, '.install-lock');
  try { await mkdir(lock); } catch { throw new Error('INSTALL_LOCKED'); }
  try { return await action(); } finally { await rm(lock, { recursive: true, force: true }); }
}

export async function install(options: InstallOptions) {
  const { root, base, manifest: manifestFile, config: orchConfig } = layout(options);
  if (!options.hosts.length || options.hosts.some(host => host !== 'codex' && host !== 'claude' && host !== 'hermes')) throw new Error('INSTALL_HOST_REQUIRED');
  for (const host of options.hosts) configPath(host, options);
  const release = await verifyRelease(resolve(options.bundle), options.checksum);
  if (!relative(base, root).startsWith('..')) await safe(root, base);
  const runtime = resolve(options.runtime ?? process.execPath);
  if (!isAbsolute(options.runtime ?? process.execPath) || !(await lstat(runtime)).isFile()) throw new Error('RUNTIME_ABSOLUTE_FILE_REQUIRED');
  const plan = async () => {
    if (!relative(base, root).startsWith('..')) await safe(root, base);
    await safe(manifestFile, root);
    const manifest = await getManifest(manifestFile, options.scope, base), changes: Change[] = [];
    const versionDir = join(root, 'versions', release.version);
    await safe(versionDir, root);
    const existingVersion = await optional(join(versionDir, 'release.json'));
    if (!existingVersion) {
      try { await lstat(versionDir); throw new Error('INSTALL_VERSION_CONFLICT'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    if (existingVersion) await verifyRelease(versionDir, options.checksum);
    const newManifest = structuredClone(manifest);
    for (const host of new Set(options.hosts)) {
      const previous: HostRecord | undefined = manifest.hosts[host];
      const configFile = configPath(host, options); await safe(configFile, base);
      const before = await optional(configFile), config = decodeConfig(host, before), mcp = entries(host, config);
      if (mcp.orch !== undefined && (!previous || !isDeepStrictEqual(mcp.orch, previous.entry))) throw new Error(`INSTALL_CONFLICT: ${configFile} MCP orch`);
      if (previous && mcp.orch === undefined) throw new Error(`INSTALL_CONFLICT: ${configFile} owned MCP removed`);
      const entry = { command: runtime, args: [join(versionDir, 'packages/mcp-server/src/stdio.ts'), '--host', host, '--origin', options.scope === 'project' ? base : host === 'hermes' ? '${workspaceFolder}' : '.'] };
      mcp.orch = entry;
      const owned: Record<string, string> = {};
      const sources: Record<string, Buffer> = {};
      for (const skill of releaseSkills(release)) {
        const target = join(skillRoot(host, base), skill); await safe(target, base);
        const sourcePrefix = `skills/${skill}/`;
        for (const name of Object.keys(release.files)) {
          if (name.startsWith(sourcePrefix)) sources[join(target, name.slice(sourcePrefix.length))] = await readAsset(options.bundle, release, name);
          if (name.startsWith('references/')) sources[join(target, name)] = await readAsset(options.bundle, release, name);
        }
        try {
          const current = await filesAt(target);
          if (!previous?.files[join(target, 'SKILL.md')]) throw new Error(`INSTALL_CONFLICT: ${target}`);
          for (const name of Object.keys(current)) {
            const file = join(target, name);
            if (!previous || previous.files[file] !== current[name]) throw new Error(`INSTALL_CONFLICT: ${file}`);
          }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      for (const [file, data] of Object.entries(sources)) {
        await safe(file, base); const old = await optional(file);
        if (previous?.files[file] && (!old || hash(old) !== previous.files[file])) throw new Error(`INSTALL_CONFLICT: ${file}`);
        owned[file] = hash(data); changes.push({ file, before: old, after: data });
      }
      for (const [file, digest] of Object.entries(previous?.files ?? {})) {
        await safe(file, skillRoot(host, base));
        if (!(file in owned)) {
          const old = await optional(file);
          if (!old || hash(old) !== digest) throw new Error(`INSTALL_CONFLICT: ${file}`);
          changes.push({ file, before: old, after: null });
        }
      }
      const after = previous && isDeepStrictEqual(previous.entry, entry) ? before : encodeConfig(host, config, before);
      changes.push({ file: configFile, before, after });
      newManifest.hosts[host] = { version: release.version, files: owned, entry, runtime };
    }
    await safe(orchConfig, options.configFile ? dirname(orchConfig) : options.scope === 'project' ? base : resolve(options.home));
    const oldConfig = await optional(orchConfig);
    if (oldConfig) parseConfig(oldConfig.toString());
    else changes.push({ file: orchConfig, before: null, after: await readAsset(options.bundle, release, 'templates/defaults/config.yaml') });
    newManifest.activeVersion = release.version;
    newManifest.releases[release.version] = options.checksum;
    const result = { installation: options.dryRun ? 'PLANNED' : 'READY', version: release.version, hosts: [...new Set(options.hosts)], scope: options.scope, packagePath: versionDir, dryRun: !!options.dryRun, reload: 'NEEDS_RELOAD', execution: 'UNVERIFIED', mcp: options.dryRun ? 'NOT_RUN' : 'HANDSHAKE_VERIFIED', modelMetadata: {} as Partial<Record<Host, unknown>>, nativeCapability: 'UNVERIFIED', authentication: 'NOT_CHECKED', preservedRunVersions: true, ...(release.files['.claude-plugin/plugin.json'] ? { pluginPath: versionDir, pluginActivation: 'LOAD_WITH_CLAUDE_PLUGIN_DIR', standaloneAlias: releaseSkills(release)[0] } : {}) };
    if (options.dryRun) return result;
    if (!existingVersion) {
      await mkdir(dirname(versionDir), { recursive: true });
      const stage = `${versionDir}.${randomUUID()}.staging`;
      try {
        await cp(options.bundle, stage, { recursive: true }); await verifyRelease(stage, options.checksum);
        for (const host of new Set(options.hosts)) if ((await probeMcp({ command: runtime, args: [join(stage, 'packages/mcp-server/src/stdio.ts'), '--host', host] })).status !== 'verified') throw new Error('INSTALL_MCP_VERIFICATION_FAILED');
        await rename(stage, versionDir);
      }
      finally { await rm(stage, { recursive: true, force: true }); }
    }
    if (existingVersion) for (const host of new Set(options.hosts)) if ((await probeMcp({ command: runtime, args: [join(versionDir, 'packages/mcp-server/src/stdio.ts'), '--host', host] })).status !== 'verified') throw new Error('INSTALL_MCP_VERIFICATION_FAILED');
    for (const host of new Set(options.hosts)) result.modelMetadata[host] = options.verifyMetadata ? await options.verifyMetadata(host) : { status: 'NOT_CHECKED' };
    const backup = oldConfig === null ? null : join(root, 'backups', `${randomUUID()}.config.yaml`);
    if (backup) await atomic(backup, oldConfig!);
    try {
      if (options.migrate) { await options.migrate(orchConfig, manifest.activeVersion); const migrated = await optional(orchConfig); if (migrated) parseConfig(migrated.toString()); }
      changes.push({ file: manifestFile, before: await optional(manifestFile), after: Buffer.from(JSON.stringify(newManifest, null, 2) + '\n') });
      await apply(changes);
      await removeEmptyOwnedDirectories(changes);
    } catch (error) {
      if (options.migrate) { if (oldConfig) await atomic(orchConfig, oldConfig); else await rm(orchConfig, { force: true }); }
      throw error;
    }
    return result;
  };
  return options.dryRun ? plan() : locked(root, plan);
}

export const update = install;

export async function rollback(options: Omit<InstallOptions, 'bundle' | 'checksum'> & { version: string }) {
  const { root, base, manifest: file } = layout(options);
  const manifest = await getManifest(file, options.scope, base);
  const checksum = manifest.releases[options.version];
  if (!checksum) throw new Error('ROLLBACK_VERSION_NOT_OWNED');
  return install({ ...options, bundle: join(root, 'versions', options.version), checksum });
}

export async function uninstall(options: Pick<InstallOptions, 'root' | 'home' | 'scope' | 'project' | 'hosts' | 'dryRun'>) {
  const { root, base, manifest: manifestFile } = layout(options);
  if (!relative(base, root).startsWith('..')) await safe(root, base);
  const plan = async () => {
    if (!relative(base, root).startsWith('..')) await safe(root, base);
    await safe(manifestFile, root);
    const manifest = await getManifest(manifestFile, options.scope, base), next = structuredClone(manifest), changes: Change[] = [], preserved: string[] = [];
    for (const host of new Set(options.hosts)) {
      const owned = manifest.hosts[host]; if (!owned) continue;
      const configFile = configPath(host, options); await safe(configFile, base);
      const before = await optional(configFile), config = decodeConfig(host, before), mcp = entries(host, config);
      if (isDeepStrictEqual(mcp.orch, owned.entry)) { delete mcp.orch; changes.push({ file: configFile, before, after: encodeConfig(host, config, before) }); }
      else if (mcp.orch !== undefined) preserved.push(`${configFile}#orch`);
      for (const [file, digest] of Object.entries(owned.files)) {
        await safe(file, skillRoot(host, base));
        const old = await optional(file);
        if (old && hash(old) === digest) changes.push({ file, before: old, after: null });
        else if (old) preserved.push(file);
      }
      delete next.hosts[host];
    }
    next.activeVersion = Object.values(next.hosts)[0]?.version ?? null;
    if (!options.dryRun) {
      changes.push({ file: manifestFile, before: await optional(manifestFile), after: Buffer.from(JSON.stringify(next, null, 2) + '\n') });
      await apply(changes);
      await removeEmptyOwnedDirectories(changes);
    }
    return { removedHosts: options.hosts.filter(host => manifest.hosts[host]), preserved, keepData: true, retainedVersions: true, dryRun: !!options.dryRun };
  };
  return options.dryRun ? plan() : locked(root, plan);
}
