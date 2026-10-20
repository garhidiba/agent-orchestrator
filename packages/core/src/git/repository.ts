import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs, { realpath, lstat } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { resolveExecutable } from '../process/executable.ts';
import { requireCondition } from '../../../protocol/src/runtime.ts';
const exec = promisify(execFile);
let executable: { path: string; identity: string } | null = null;
async function trustedGit(cwd: string) {
  const resolved = await resolveExecutable('git', { cwd });
  if (executable) requireCondition(resolved.path === executable.path && resolved.identity === executable.identity, 'GIT_EXECUTABLE_CHANGED');
  else {
    const response = await exec(resolved.command, [...resolved.args, '--version'], { env: resolved.env, timeout: 5000, maxBuffer: 16 * 1024, windowsHide: true });
    requireCondition(/^git version \d/.test(response.stdout), 'GIT_EXECUTABLE_UNAVAILABLE');
    executable = { path: resolved.path, identity: resolved.identity };
  }
  return resolved;
}
export async function git(cwd: string, ...args: string[]) {
  const resolved = await trustedGit(cwd);
  const { stdout } = await exec(resolved.command, [...resolved.args, '-C', cwd, ...args], {
    encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
    env: { ...resolved.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  });
  return stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;
}
// Inspect blobs without buffering arbitrary binary assets or including their contents in errors.
export async function gitBlobMatches(cwd: string, oid: string, matches: (text: string) => boolean) {
  requireCondition(/^[a-f0-9]{40,64}$/.test(oid), 'STAGED_SECRET_SCAN_FAILED');
  const resolved = await trustedGit(cwd);
  return new Promise<boolean>((resolve, reject) => {
    const child = spawn(resolved.command, [...resolved.args, '-C', cwd, 'cat-file', 'blob', oid], {
      env: { ...resolved.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    });
    let tail = '', found = false, expired = false;
    const timer = setTimeout(() => { expired = true; child.kill(); }, 30000);
    child.stdout.on('data', (chunk: Buffer) => {
      const text = tail + chunk.toString('latin1').replaceAll('\0', '');
      if (matches(text)) { found = true; child.kill(); }
      tail = text.slice(-4096);
    });
    child.on('error', () => { clearTimeout(timer); reject(new Error('STAGED_SECRET_SCAN_FAILED')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (!expired && (found || code === 0)) resolve(found);
      else reject(new Error('STAGED_SECRET_SCAN_FAILED'));
    });
  });
}
export async function inspectRepository(cwd: string) {
  const root = await realpath(await git(cwd, 'rev-parse', '--show-toplevel'));
  requireCondition(await git(root, 'rev-parse', '--is-bare-repository') === 'false', 'BARE_REPOSITORY');
  requireCondition(await git(root, 'rev-parse', '--show-superproject-working-tree') === '', 'SUBMODULE_UNSUPPORTED');
  const commonDir = await realpath(resolve(root, await git(root, 'rev-parse', '--git-common-dir')));
  const branch = await git(root, 'symbolic-ref', '--short', 'HEAD').catch(() => '');
  requireCondition(branch, 'DETACHED_HEAD');
  const head = await git(root, 'rev-parse', '--verify', 'HEAD').catch(() => '');
  requireCondition(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head), 'EMPTY_REPOSITORY');
  return { root, commonDir, branch, head, dirty: (await git(root, 'status', '--porcelain=v1', '--untracked-files=all')).length > 0 };
}
// Read-only checks: signing keys and LFS/submodule checkout are not verified in v1.
export async function preflightRepository(root: string, diskPaths: string[]) {
  const gitDir = await git(root, 'rev-parse', '--absolute-git-dir');
  for (const marker of ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'sequencer']) {
    const path = resolve(gitDir, marker);
    const present = await lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
    requireCondition(!present, 'GIT_OPERATION_IN_PROGRESS');
  }
  for (const identity of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
    const value = await git(root, 'var', identity).catch(() => '');
    requireCondition(/^[^<>\n]+ <[^<>\n]+> \d+ [+-]\d{4}$/.test(value), 'GIT_IDENTITY_REQUIRED');
  }
  const signing = await git(root, 'config', '--type=bool', '--get', 'commit.gpgsign').catch(error => {
    if (error.code === 1) return 'false'; throw error;
  });
  requireCondition(signing !== 'true', 'SIGNING_POLICY_UNVERIFIED');
  const entries = await git(root, 'ls-files', '--stage', '-z');
  requireCondition(!entries.split('\0').some(entry => entry.startsWith('160000 ') || entry.endsWith('\t.gitmodules')), 'SUPERPROJECT_SUBMODULES_UNSUPPORTED');
  const paths = (await git(root, 'ls-files', '-z')).split('\0').filter(Boolean);
  requireCondition(!paths.includes('.lfsconfig'), 'LFS_UNSUPPORTED');
  for (let offset = 0; offset < paths.length; offset += 128) {
    const attributes = (await git(root, 'check-attr', '-z', 'filter', '--', ...paths.slice(offset, offset + 128))).split('\0');
    requireCondition(!attributes.some((value, index) => index % 3 === 2 && value === 'lfs'), 'LFS_UNSUPPORTED');
  }
  for (const path of diskPaths) {
    const disk = await fs.statfs(path, { bigint: true });
    requireCondition(disk.bavail * disk.bsize > 0n, 'DISK_SPACE_UNAVAILABLE');
  }
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
  const { readFile, lstat, readlink } = await import('node:fs/promises');
  const files = (await git(cwd, 'ls-files', '-z', '--cached', '--others', '--exclude-standard')).split('\0').filter(Boolean).sort();
  const entries = await Promise.all(files.map(async path => {
    try {
      const file = resolve(cwd, path), stat = await lstat(file);
      return [path, stat.mode, stat.isSymbolicLink() ? await readlink(file) : (await readFile(file)).toString('base64')];
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [path, null]; throw error; }
  }));
  return hash(entries);
}
