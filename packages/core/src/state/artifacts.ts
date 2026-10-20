import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { id, requireCondition as check } from '../../../protocol/src/runtime.ts';

async function checkDirectory(path: string) {
  const stat = await lstat(path);
  check(stat.isDirectory() && !stat.isSymbolicLink() && await realpath(path) === path, 'STATE_PATH_UNSAFE');
}
export async function safeStateDirectory(origin: string, runId: string, subdir?: 'logs' | 'reports'): Promise<string> {
  id.parse(runId);
  check(subdir === undefined || subdir === 'logs' || subdir === 'reports', 'STATE_PATH_UNSAFE');
  let directory = resolve(origin);
  await checkDirectory(directory);
  for (const part of ['.orch', 'state', 'runs', runId, ...(subdir ? [subdir] : [])]) {
    directory = join(directory, part);
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    await checkDirectory(directory);
  }
  return directory;
}
export async function writeStateArtifact(origin: string, runId: string, filename: string, content: string | Uint8Array, subdir?: 'logs' | 'reports'): Promise<string> {
  check(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(filename), 'STATE_FILENAME_UNSAFE');
  const directory = await safeStateDirectory(origin, runId, subdir);
  const file = join(directory, filename);
  const existing = await lstat(file).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  check(!existing || (existing.isFile() && !existing.isSymbolicLink() && existing.nlink === 1), 'STATE_PATH_UNSAFE');
  const temporary = join(directory, `.${filename}-${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(content);
    await handle.close();
    await safeStateDirectory(origin, runId, subdir);
    await rename(temporary, file);
  } finally {
    await handle.close();
    await rm(temporary, { force: true });
  }
  return file;
}
