import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseDocument } from 'yaml';
import { parseConfig, resolveConfig } from './index.ts';
import { validateModels } from '../model-registry/index.ts';
import type { Model } from '../model-registry/index.ts';
import { requireCondition as check } from '../../../protocol/src/runtime.ts';
export const configHash = (source: string | null) => createHash('sha256').update(source === null ? 'missing' : `file:${source}`).digest('hex');
async function read(path: string) { try { return await readFile(path, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } }
export async function patchConfig(file: string, expectedHash: string, patches: { path: string[]; value?: unknown; remove?: boolean }[], catalog: Model[] = []) {
  await mkdir(dirname(file), { recursive: true });
  const lock = `${file}.orch-lock`, temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(lock, '', { flag: 'wx', mode: 0o600 }).catch(() => { throw new Error('CONFIG_CONFLICT'); });
  try {
    const stat = await lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    check(!stat || stat.isFile(), 'CONFIG_PATH_UNSAFE');
    const before = await read(file); check(configHash(before) === expectedHash, 'CONFIG_CONFLICT');
    parseConfig(before ?? ''); const doc = parseDocument(before ?? '');
    for (const patch of patches) {
      check(patch.path.length && patch.path.every(key => /^[a-zA-Z0-9_-]+$/.test(key) && !['__proto__', 'constructor', 'prototype'].includes(key)), 'CONFIG_PATH_INVALID');
      if (patch.remove) doc.deleteIn(patch.path); else doc.setIn(patch.path, patch.value);
    }
    const text = doc.toString(), patch = parseConfig(text), resolved = resolveConfig({ project: patch });
    validateModels(resolved.config, catalog);
    check(configHash(await read(file)) === expectedHash, 'CONFIG_CONFLICT');
    await writeFile(temp, text, { flag: 'wx', mode: stat ? stat.mode & 0o777 : 0o600 });
    await rename(temp, file);
    check(await read(file) === text, 'CONFIG_READBACK_FAILED');
    return { hash: configHash(text), config: patch };
  } finally { await rm(temp, { force: true }); await rm(lock); }
}
