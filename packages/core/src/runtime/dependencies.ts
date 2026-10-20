import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, readlink, realpath, stat, symlink } from 'node:fs/promises';
import { basename, join, resolve, toNamespacedPath } from 'node:path';
import { git, within } from '../git/repository.ts';
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

export async function prepareNodeDependencies(origin: string, target: string, previous?: DependencySetup | null): Promise<DependencySetup | null> {
  if (origin === target || !await optionalFile(join(target, 'package.json'))) return null;
  const sourcePath = join(origin, 'node_modules'), targetPath = join(target, 'node_modules');
  const existing = await entry(targetPath);
  const source = await realpath(sourcePath).catch(() => null);
  const targetSource = existing?.isSymbolicLink() ? await realpath(targetPath).catch(() => null) : null;
  const linked = existing?.isSymbolicLink() ? toNamespacedPath(resolve(target, await readlink(targetPath))) : null;
  const shared = existing?.isSymbolicLink() && (source && targetSource === source ||
    linked === toNamespacedPath(sourcePath) || previous && linked === toNamespacedPath(previous.source));
  // Keep user-owned directories and links, including dangling links, untouched.
  if (existing && !shared) return null;
  check(!existing || !source || targetSource === source, 'BLOCKED_DEPENDENCY_SETUP_SOURCE_CHANGED');
  const manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
  const versions = Object.values({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies });
  check(!('workspaces' in manifest) && !versions.some(version => typeof version === 'string' && /^(workspace:|file:|link:|\.\.?[\\/]|[\\/])/.test(version)), 'BLOCKED_DEPENDENCY_SETUP_LOCAL_SOURCE');
  if (!source) {
    check(!versions.length, 'BLOCKED_DEPENDENCY_SETUP_ORIGIN_MISSING');
    return null;
  }
  check((await stat(source)).isDirectory(), 'BLOCKED_DEPENDENCY_SETUP_ORIGIN_INVALID');
  for (const file of await readdir(source, { recursive: true, withFileTypes: true })) {
    if (!file.isSymbolicLink()) continue;
    const linked = await realpath(join(file.parentPath, file.name)).catch(() => null);
    check(linked && (linked === source || within(source, linked)), 'BLOCKED_DEPENDENCY_SETUP_EXTERNAL_LINK');
  }
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
  if (!existing) await symlink(sourcePath, targetPath, process.platform === 'win32' ? 'junction' : 'dir');
  return { method: 'shared_origin_symlink', source, target: targetPath, inputsFingerprint: hash(inputs), mutationPolicy: 'preserve_source_dependencies' };
}

// Hash installed bytes, including ignored files; visit each canonical directory once to bound symlink cycles.
export async function dependencyFingerprint(root: string): Promise<string> {
  const digest = createHash('sha256'), visited = new Set<string>();
  const installation = await realpath(join(root, 'node_modules')).catch(() => null);
  async function visit(path: string, name: string): Promise<void> {
    const info = await entry(path);
    digest.update(JSON.stringify([name, info?.mode ?? null]));
    if (!info) return;
    if (info.isSymbolicLink()) {
      const destination = await realpath(path).catch(() => null);
      digest.update(JSON.stringify([await readlink(path), destination]));
      check(!destination || destination === installation || installation && within(installation, destination), 'BLOCKED_DEPENDENCY_EXTERNAL_LINK');
      if (destination) await visit(destination, `${name}/@target`);
    } else if (info.isDirectory()) {
      const canonical = await realpath(path);
      if (visited.has(canonical)) return;
      visited.add(canonical);
      for (const child of (await readdir(path)).sort()) await visit(join(path, child), `${name}/${child}`);
    } else if (info.isFile()) {
      const file = createHash('sha256');
      for await (const chunk of createReadStream(path)) file.update(chunk);
      digest.update(file.digest());
    }
  }
  await visit(join(root, 'node_modules'), 'node_modules');
  return digest.digest('hex');
}

export const environmentFingerprint = (overrides: Record<string, string>) =>
  hash({ node: process.version, platform: process.platform, arch: process.arch, env: { ...process.env, ...overrides } });
