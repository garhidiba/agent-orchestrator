import { lstat, readFile, readlink, realpath, stat, symlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { git } from '../git/repository.ts';
import { hash } from '../state/store.ts';
import { requireCondition as check } from '../../../protocol/src/runtime.ts';

const rootInputs = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'bun.lock', 'bun.lockb', '.npmrc', '.yarnrc', '.yarnrc.yml'];
const dependencyInput = (path: string) => rootInputs.includes(basename(path));
async function optionalFile(path: string) {
  try { return await readFile(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
async function entry(path: string) {
  try { return await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

export type DependencySetup = { method: 'shared_origin_symlink'; source: string; target: string; inputsFingerprint: string; mutationPolicy: 'preserve_source_dependencies' };

export async function prepareNodeDependencies(origin: string, target: string): Promise<DependencySetup | null> {
  if (origin === target || !await optionalFile(join(target, 'package.json'))) return null;
  const sourcePath = join(origin, 'node_modules'), targetPath = join(target, 'node_modules');
  const existing = await entry(targetPath);
  const source = await realpath(sourcePath).catch(() => null);
  const shared = existing?.isSymbolicLink() && (source && await realpath(targetPath).catch(() => null) === source || await readlink(targetPath) === sourcePath);
  // Keep user-owned directories and links, including dangling links, untouched.
  if (existing && !shared) return null;
  if (!source) {
    const manifest = JSON.parse((await readFile(join(target, 'package.json'))).toString());
    check(!Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies }).length, 'BLOCKED_DEPENDENCY_SETUP_ORIGIN_MISSING');
    return null;
  }
  check((await stat(source)).isDirectory(), 'BLOCKED_DEPENDENCY_SETUP_ORIGIN_INVALID');
  const tracked = await Promise.all([origin, target].map(path => git(path, 'ls-files', '-z')));
  const files = [...new Set([...rootInputs, ...tracked.flatMap(paths => paths.split('\0').filter(dependencyInput))])].sort();
  const inputs: [string, string | null][] = [];
  for (const file of files) {
    const [original, assigned] = await Promise.all([optionalFile(join(origin, file)), optionalFile(join(target, file))]);
    check(original === null ? assigned === null : assigned !== null && original.equals(assigned), 'BLOCKED_DEPENDENCY_SETUP_INPUT_MISMATCH');
    inputs.push([file, original?.toString('base64') ?? null]);
  }
  check(!tracked[1].split('\0').some(path => path === 'node_modules' || path.startsWith('node_modules/')), 'BLOCKED_DEPENDENCY_SETUP_TRACKED_TARGET');
  await git(target, 'check-ignore', '--quiet', 'node_modules').catch(() => { throw new Error('BLOCKED_DEPENDENCY_SETUP_IGNORE_REQUIRED'); });
  if (!existing) await symlink(source, targetPath, process.platform === 'win32' ? 'junction' : 'dir');
  return { method: 'shared_origin_symlink', source, target: targetPath, inputsFingerprint: hash(inputs), mutationPolicy: 'preserve_source_dependencies' };
}
