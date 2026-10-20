import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { requireCondition } from '../../../protocol/src/runtime.ts';
const exec = promisify(execFile);
export async function git(cwd: string, ...args: string[]) {
  const { stdout } = await exec('git', ['-C', cwd, ...args], {
    encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  });
  return stdout.trimEnd();
}
export async function inspectRepository(cwd: string) {
  const root = await realpath(await git(cwd, 'rev-parse', '--show-toplevel'));
  requireCondition(await git(root, 'rev-parse', '--is-bare-repository') === 'false', 'BARE_REPOSITORY');
  requireCondition(await git(root, 'rev-parse', '--show-superproject-working-tree') === '', 'SUBMODULE_UNSUPPORTED');
  const commonDir = await realpath(resolve(root, await git(root, 'rev-parse', '--git-common-dir')));
  const branch = await git(root, 'symbolic-ref', '--short', 'HEAD').catch(() => '');
  requireCondition(branch, 'DETACHED_HEAD');
  const head = await git(root, 'rev-parse', '--verify', 'HEAD').catch(() => '');
  requireCondition(/^[a-f0-9]{40,64}$/.test(head), 'EMPTY_REPOSITORY');
  return { root, commonDir, branch, head, dirty: (await git(root, 'status', '--porcelain=v1', '--untracked-files=all')).length > 0 };
}
export function within(root: string, path: string) {
  const part = relative(root, path);
  return part !== '' && part !== '..' && !part.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(part);
}
export function owns(patterns: string[], path: string) {
  return patterns.some(pattern => pattern === path || pattern.endsWith('/**') && path.startsWith(pattern.slice(0, -2)));
}
export function overlaps(a: string[], b: string[]) {
  return a.some(x => b.some(y => x === y || x.includes('*') || y.includes('*')));
}
export async function changedPaths(cwd: string, base = 'HEAD') {
  const tracked = await git(cwd, 'diff', '--no-renames', '--name-only', '-z', base);
  const untracked = await git(cwd, 'ls-files', '--others', '--exclude-standard', '-z');
  return [...new Set([...tracked.split('\0'), ...untracked.split('\0')].filter(Boolean))];
}
export async function sourceFingerprint(cwd: string) {
  const { hash } = await import('../state/store.ts');
  // Include tracked content, deletions and untracked files, not only the HEAD SHA.
  const { readFile } = await import('node:fs/promises');
  const files = (await git(cwd, 'ls-files', '-z', '--cached', '--others', '--exclude-standard')).split('\0').filter(Boolean).sort();
  const entries = await Promise.all(files.map(async path => {
    try { return [path, (await readFile(resolve(cwd, path))).toString('base64')]; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [path, null]; throw error; }
  }));
  return hash(entries);
}
