import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseDocument } from 'yaml';
import { parseConfig, resolveConfig } from './index.ts';
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
