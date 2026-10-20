import { access, lstat, open, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative } from 'node:path';

export async function executableIdentity(path: string) {
  const item = await stat(path);
  return `${item.dev}:${item.ino}:${item.size}:${item.mtimeMs}:${item.ctimeMs}`;
}
async function repositoryRoot(cwd: string) {
  let directory = await realpath(cwd);
  while (true) {
    try { await lstat(join(directory, '.git')); return directory; }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    const parent = dirname(directory); if (parent === directory) return null; directory = parent;
  }
}
function owned(roots: string[], path: string) {
  return roots.some(root => { const part = relative(root, path); return part === '' || part !== '..' && !part.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(part); });
}
async function externalDirectory(path: string, roots: string[]) {
  if (!isAbsolute(path) || /(^|[\\/])node_modules[\\/]\.bin([\\/]|$)/i.test(path) || owned(roots, path)) return null;
  const canonical = await realpath(path);
  if (owned(roots, canonical) || !(await stat(canonical)).isDirectory()) return null;
  return canonical;
}
async function safeEnvironment(env: NodeJS.ProcessEnv, roots: string[], pinNode = true) {
  const directories: string[] = [];
  for (const path of [...(pinNode ? [dirname(process.execPath)] : []), ...(env.PATH ?? '').split(delimiter), ...(process.platform === 'win32' ? [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')] : ['/usr/bin', '/bin'])]) {
    try { const directory = await externalDirectory(path, roots); if (directory && !directories.includes(directory)) directories.push(directory); }
    catch { /* Uninspectable PATH entries cannot establish an external executable boundary. */ }
  }
  if (!directories.length) throw new Error('EXECUTABLE_ENVIRONMENT_UNAVAILABLE');
  const clean = { ...env }; for (const key of Object.keys(clean)) if (key.toLowerCase() === 'path') delete clean[key];
  return { ...clean, PATH: directories.join(delimiter) };
}
async function rootsFor(cwd = process.cwd()) {
  return [...new Set((await Promise.all([repositoryRoot(process.cwd()), repositoryRoot(cwd)])).filter((root): root is string => root !== null))];
}
export async function safeProcessEnvironment(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()) {
  return safeEnvironment(env, await rootsFor(cwd));
}
async function launch(path: string, env: NodeJS.ProcessEnv & { PATH: string }) {
  const file = await open(path, 'r');
  let shebang: string;
  try { const prefix = Buffer.alloc(512); const { bytesRead } = await file.read(prefix); shebang = prefix.subarray(0, bytesRead).toString('utf8').split('\n', 1)[0]; }
  finally { await file.close(); }
  // Pin env-node entrypoints to this already-running runtime, even when node's install is Git-managed.
  const node = /^#!\/usr\/bin\/env[ \t]+node[ \t]*\r?$/.test(shebang);
  return { path, command: node ? process.execPath : path, args: node ? [path] : [], env, identity: await executableIdentity(path) };
}
// trustedExecutable is an explicit developer/fixture injection, never a public MCP/CLI option.
export async function resolveExecutable(name: string, options: { cwd?: string; env?: NodeJS.ProcessEnv; trustedExecutable?: string } = {}) {
  const roots = await rootsFor(options.cwd);
  const env = await safeEnvironment(options.env ?? process.env, roots);
  const search = await safeEnvironment(options.env ?? process.env, roots, false);
  if (options.trustedExecutable !== undefined) {
    if (!isAbsolute(options.trustedExecutable)) throw new Error('EXECUTABLE_OVERRIDE_MUST_BE_ABSOLUTE');
    const path = await realpath(options.trustedExecutable);
    await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    if (!(await stat(path)).isFile()) throw new Error('EXECUTABLE_UNAVAILABLE');
    return launch(path, env);
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('EXECUTABLE_NAME_INVALID');
  const suffixes = process.platform === 'win32' ? ['.exe'] : [''];
  for (const directory of search.PATH.split(delimiter)) for (const suffix of suffixes) {
    try {
      const candidate = join(directory, name + suffix);
      await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      const path = await realpath(candidate);
      if (!await externalDirectory(dirname(path), roots) || !(await stat(path)).isFile()) continue;
      return launch(path, env);
    } catch { /* Continue only to another external candidate; never execute a rejected path. */ }
  }
  throw new Error('EXECUTABLE_UNAVAILABLE');
}
