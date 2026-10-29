import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { discoverCodexModels } from '../../../host-codex/src/catalog.ts';
import { type ClaudeMetadataAdapter, discoverClaudeModels } from '../../../host-claude/src/catalog.ts';
import { globalConfigPath, loadConfig } from '../config/index.ts';
import { catalogCacheKey, createCatalogCache, readCatalogCache } from './cache.ts';
import type { CatalogContext } from './cache.ts';
import type { Model } from './index.ts';

import { resolveExecutable } from '../process/executable.ts';
const exec = promisify(execFile);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type Host = 'codex' | 'claude' | 'hermes';
export type CatalogOptions = { refresh?: boolean; readOnly?: boolean; claudeMetadata?: ClaudeMetadataAdapter; executable?: string; cacheRoot?: string; timeout?: number; now?: number; env?: NodeJS.ProcessEnv };
export type CatalogResult = {
  status: 'partial' | 'failed'; models: Model[]; contextMatches: false; source: 'live' | 'cache' | 'none';
  stale: boolean | null; fetchedAt: string | null; expiresAt: string | null;
  context: CatalogContext | null; cacheKey: string | null; errors: string[];
};

async function settingsFingerprint(origin: string | null, host: Host, env: NodeJS.ProcessEnv) {
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  const hostHome = host === 'codex' ? env.CODEX_HOME ?? join(home, '.codex') : host === 'hermes' ? env.HERMES_HOME ?? join(home, '.hermes') : env.CLAUDE_CONFIG_DIR ?? join(home, '.claude');
  const paths = [globalConfigPath(env), host === 'codex' ? join(hostHome, 'config.toml') : join(hostHome, host === 'hermes' ? 'config.yaml' : 'settings.json')];
  if (host === 'claude') paths.push(join(home, '.claude.json'));
  for (let dir = origin; dir !== null; dir = dirname(dir) === dir ? null : dirname(dir)) {
    paths.push(join(dir, '.orch', 'config.yaml'));
    paths.push(...(host === 'codex' ? [join(dir, '.codex', 'config.toml')] : host === 'hermes' ? [] : [join(dir, '.claude', 'settings.json'), join(dir, '.claude', 'settings.local.json')]));
  }
  const snapshots: unknown[] = [];
  for (const path of [...new Set(paths)].sort()) {
    try {
      if ((await stat(path)).size > 1024 * 1024) throw new Error('CATALOG_SETTINGS_TOO_LARGE');
      const source = await readFile(path);
      if (source.length > 1024 * 1024) throw new Error('CATALOG_SETTINGS_TOO_LARGE');
      snapshots.push([path, createHash('sha256').update(source).digest('hex')]);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; snapshots.push([path, null]); }
  }
  // Auth file metadata detects local rotation without reading credentials or asserting account identity.
  for (const path of host === 'hermes' ? [join(hostHome, '.env'), join(hostHome, 'auth.json')] : [join(hostHome, host === 'codex' ? 'auth.json' : '.credentials.json')]) {
    try { const info = await stat(path); snapshots.push([path, info.size, info.mtimeMs, info.ctimeMs]); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; snapshots.push([path, null]); }
  }
  return hash(JSON.stringify({ snapshots, runtime: { executable: process.execPath, version: process.version }, environment: Object.entries(env).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)) }));
}

export async function getCatalogForHost(origin: string | null, host: Host, options: CatalogOptions = {}): Promise<CatalogResult> {
  const result: CatalogResult = { status: 'failed', models: [], contextMatches: false, source: 'none', stale: null,
    fetchedAt: null, expiresAt: null, context: null, cacheKey: null, errors: [] };
  let env = options.env ?? process.env;
  const now = options.now ?? Date.now(), timeout = options.timeout ?? 10000;
  let context: CatalogContext, ttl: number, cacheFile: string;
  try {
    if (!['codex', 'claude', 'hermes'].includes(host)) throw new Error('CATALOG_HOST_INVALID');
    const cwd = origin === null ? null : await realpath(origin);
    const resolved = await resolveExecutable(host, { cwd: cwd ?? undefined, env, trustedExecutable: options.executable });
    const executable = resolved.path; env = resolved.env;
    const version = (await exec(resolved.command, [...resolved.args, '--version'], { env, cwd: cwd ?? undefined, timeout, killSignal: 'SIGKILL', maxBuffer: 16384, windowsHide: true })).stdout.trim();
    if (!version) throw new Error('CATALOG_VERSION_UNAVAILABLE');
    context = { host, executable, version, originRoot: cwd, settingsFingerprint: await settingsFingerprint(cwd, host, env),
      account: null, workspace: null, policyFingerprint: 'unknown', authFingerprint: null, scope: 'unknown' };
    ttl = (await loadConfig(cwd, globalConfigPath(env))).config.model_selection.catalog_cache_ttl_hours;
    result.context = context; result.cacheKey = catalogCacheKey(context);
    cacheFile = join(options.cacheRoot ?? join(dirname(globalConfigPath(env)), 'cache', 'models'), 'unknown', host, `${result.cacheKey}.json`);
  } catch { result.errors.push('CATALOG_CONTEXT_UNAVAILABLE'); return result; }
  let cached: ReturnType<typeof readCatalogCache> | null = null;
  try {
    if ((await stat(cacheFile)).size > 4 * 1024 * 1024) throw new Error('CATALOG_CACHE_TOO_LARGE');
    cached = readCatalogCache(JSON.parse(await readFile(cacheFile, 'utf8')), context, now);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') result.errors.push('CATALOG_CACHE_INVALID'); }
  const useCache = () => ({ ...result, status: 'partial' as const, source: 'cache' as const, models: cached!.models,
    stale: cached!.stale, fetchedAt: cached!.fetchedAt, expiresAt: cached!.expiresAt });
  if (cached && !cached.stale && !options.refresh) return useCache();
  try {
    const live = host === 'hermes' ? { status: 'partial' as const, models: [], reason: 'NATIVE_MODEL_METADATA_UNAVAILABLE' } : host === 'codex' ? await discoverCodexModels(context.executable, timeout, { env, cwd: context.originRoot ?? undefined }) : await discoverClaudeModels(options.claudeMetadata);
    if ('reason' in live && live.reason === 'NATIVE_MODEL_METADATA_UNAVAILABLE') throw new Error('NATIVE_MODEL_METADATA_UNAVAILABLE');
    const cache = createCatalogCache(context, [...live.models], ttl, now);
    result.status = 'partial'; result.models = cache.models; result.source = 'live'; result.stale = false;
    result.fetchedAt = cache.fetchedAt; result.expiresAt = cache.expiresAt;
    if (options.readOnly) return result;
    const temp = `${cacheFile}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(cacheFile), { recursive: true, mode: 0o700 });
      await writeFile(temp, JSON.stringify(cache), { flag: 'wx', mode: 0o600 }); await rename(temp, cacheFile);
    } catch { result.errors.push('CATALOG_CACHE_WRITE_FAILED'); }
    finally { await rm(temp, { force: true }).catch(() => {}); }
    return result;
  } catch (error) {
    const code = error instanceof Error && /^CATALOG_[A-Z_]+$|^NATIVE_MODEL_METADATA_UNAVAILABLE$/.test(error.message) ? error.message : 'CATALOG_QUERY_FAILED';
    result.errors.push(code);
    if (code === 'NATIVE_MODEL_METADATA_UNAVAILABLE') result.status = 'partial';
    return cached ? useCache() : result;
  }
}
