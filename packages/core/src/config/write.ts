import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, realpath, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseDocument } from 'yaml';
import { loadConfig, parseConfig, resolveConfig } from './index.ts';
import { validateModels } from '../model-registry/index.ts';
import type { Scope } from './index.ts';
import type { Model } from '../model-registry/index.ts';
import { requireCondition as check } from '../../../protocol/src/runtime.ts';
import { configHash } from './hash.ts';
export { configHash } from './hash.ts';
async function read(path: string) { try { return await readFile(path, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } }
export type ConfigMutation = { path: string[]; value?: unknown; remove?: boolean };
type ProposalOptions = { scope?: Scope; layers?: Partial<Record<Scope, unknown>> };
export function proposeConfig(source: string | null, patches: ConfigMutation[], catalog: Model[] = [], options: ProposalOptions = {}) {
  const before = parseConfig(source ?? ''), doc = parseDocument(source ?? '');
  for (const patch of patches) {
    check(Array.isArray(patch.path) && patch.path.length && patch.path.every(key => typeof key === 'string' && /^[a-zA-Z0-9_-]+$/.test(key) && !['__proto__', 'constructor', 'prototype'].includes(key)), 'CONFIG_PATH_INVALID');
    if (patch.remove) doc.deleteIn(patch.path); else doc.setIn(patch.path, patch.value);
  }
  const text = doc.toString(), config = parseConfig(text), scope = options.scope ?? 'project';
  const layers = options.layers ?? {};
  const previous = resolveConfig({ ...layers, [scope]: before }).config;
  const { config: effective } = resolveConfig({ ...layers, [scope]: config });
  // Validate the edited scope before higher overrides can hide a new model or effort.
  if (scope !== 'session') {
    const scopedLayers = { ...layers, session: undefined, ...(scope === 'global' ? { project: undefined } : {}) };
    validateModels(resolveConfig({ ...scopedLayers, [scope]: config }).config, catalog,
      resolveConfig({ ...scopedLayers, [scope]: before }).config);
  }
  // Unchanged user pins do not require a live catalog for unrelated edits.
  validateModels(effective, catalog, previous);
  return { text, config, effective };
}
export async function patchConfig(file: string, expectedHash: string, patches: ConfigMutation[], catalog: Model[] = [], options: ProposalOptions & { dryRun?: boolean } = {}) {
  if (!options.dryRun) await mkdir(dirname(file), { recursive: true });
  const lock = `${file}.orch-lock`, temp = `${file}.${randomUUID()}.tmp`;
  if (!options.dryRun) await writeFile(lock, '', { flag: 'wx', mode: 0o600 }).catch(() => { throw new Error('CONFIG_CONFLICT'); });
  try {
    const stat = await lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    check(!stat || stat.isFile(), 'CONFIG_PATH_UNSAFE');
    const before = await read(file); check(configHash(before) === expectedHash, 'CONFIG_CONFLICT');
    const { text, config: patch, effective } = proposeConfig(before, patches, catalog, options);
    if (options.dryRun) return { hash: configHash(text), config: patch, effective, dryRun: true };
    check(configHash(await read(file)) === expectedHash, 'CONFIG_CONFLICT');
    await writeFile(temp, text, { flag: 'wx', mode: stat ? stat.mode & 0o777 : 0o600 });
    check(configHash(await read(file)) === expectedHash, 'CONFIG_CONFLICT');
    await rename(temp, file);
    check(await read(file) === text, 'CONFIG_READBACK_FAILED');
    return { hash: configHash(text), config: patch };
  } finally { if (!options.dryRun) { await rm(temp, { force: true }); await rm(lock); } }
}


export async function initializeProjectConfig(origin: string, options: {
  complete?: boolean; dryRun?: boolean; profile?: 'balanced' | 'quality' | 'economy' | 'fast';
} = {}) {
  const directory = join(await realpath(origin), '.orch'), file = join(directory, 'config.yaml');
  const folder = await lstat(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  check(!folder || (folder.isDirectory() && !folder.isSymbolicLink()), 'CONFIG_PATH_UNSAFE');
  async function existing() {
    const info = await lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!info) return null;
    check(info.isFile() && !info.isSymbolicLink(), 'CONFIG_PATH_UNSAFE');
    const text = await readFile(file, 'utf8'); parseConfig(text); return text;
  }
  const previous = await existing();
  const before = parseConfig(previous ?? '');
  if (previous !== null && !options.complete) return { created: false, updated: false, file, hash: configHash(previous), config: before };
  const loaded = await loadConfig(await realpath(origin));
  check(previous === null || loaded.hashes.project === configHash(previous), 'CONFIG_CONFLICT');
  const config = resolveConfig({ global: loaded.layers.global, project: { ...before,
    ...(options.profile === undefined ? {} : { model_selection: { ...before.model_selection, profile: options.profile } }) } }).config;
  const doc = parseDocument(previous ?? '');
  const patches: ConfigMutation[] = [];
  function fill(value: unknown, path: string[] = []) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [key, child] of Object.entries(value)) fill(child, [...path, key]);
    } else if (!doc.hasIn(path) || (options.profile !== undefined && path.join('.') === 'model_selection.profile' && doc.getIn(path) !== value)) {
      patches.push({ path, value }); doc.setIn(path, value);
    }
  }
  fill(config);
  const text = previous !== null && !patches.length ? previous : doc.toString();
  if (options.dryRun) return { created: previous === null, updated: previous !== null && text !== previous, file, hash: configHash(text), config, dryRun: true };
  if (previous !== null) {
    if (!patches.length) return { created: false, updated: false, file, hash: configHash(previous), config };
    const result = await patchConfig(file, configHash(previous), patches, [], { layers: loaded.layers });
    return { ...result, created: false, updated: true, file };
  }
  await mkdir(directory).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const createdFolder = await lstat(directory); check(createdFolder.isDirectory() && !createdFolder.isSymbolicLink(), 'CONFIG_PATH_UNSAFE');
  const temporary = join(directory, `.init-${randomUUID()}.tmp`);
  let created = false;
  try {
    await writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
    try { await link(temporary, file); created = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const saved = await existing(); check(saved !== null && (!created || saved === text), 'CONFIG_READBACK_FAILED');
    check(created || !options.complete || saved === text, 'CONFIG_CONFLICT');
    return { created, updated: false, file, hash: configHash(saved), config: parseConfig(saved) };
  } finally { await rm(temporary, { force: true }); }
}
