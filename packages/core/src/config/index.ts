import { parseDocument } from 'yaml';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, win32 } from 'node:path';
import { configSchema, configPatchSchema } from '../../../protocol/src/config.ts';
import type { ConfigPatch } from '../../../protocol/src/config.ts';

export function parseConfig(source: string): ConfigPatch {
  if (Buffer.byteLength(source) > 1024 * 1024) throw new Error('CONFIG_INVALID: file exceeds 1 MiB');
  try {
    const doc = parseDocument(source, { uniqueKeys: true, schema: 'core' });
    if (doc.errors.length || doc.warnings.length) throw new Error('Invalid YAML');
    const value: unknown = source.trim() === '' ? {} : doc.toJS({ maxAliasCount: 0 });
    return configPatchSchema.parse(value);
  } catch {
    // Do not echo YAML parser diagnostics: they may contain credential values.
    throw new Error('CONFIG_INVALID: expected ORCH v1 configuration with unique, known keys and valid types');
  }
}

type Scope = 'global' | 'project' | 'session';

export function resolveConfig(layers: Partial<Record<Scope, unknown>> = {}) {
  const config: Record<string, unknown> = {};
  const sources: Record<string, Scope | 'default'> = {};
  function merge(target: Record<string, unknown>, patch: Record<string, unknown>, scope: Scope | 'default', prefix = '') {
    for (const [key, value] of Object.entries(patch)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) target[key] = {};
        merge(target[key] as Record<string, unknown>, value as Record<string, unknown>, scope, path);
      } else {
        target[key] = structuredClone(value);
        sources[path] = scope;
      }
    }
  }
  merge(config, configSchema.parse(parseConfig(readFileSync(new URL('../../../../templates/defaults/config.yaml', import.meta.url), 'utf8'))), 'default');
  for (const scope of ['global', 'project', 'session'] as const) {
    if (layers[scope] !== undefined) merge(config, configPatchSchema.parse(layers[scope]), scope);
  }
  const resolved = configSchema.parse(config);
  const ids = resolved.quality.commands.map(command => command.id);
  if (new Set(ids).size !== ids.length) throw new Error('CONFIG_INVALID: duplicate quality command IDs');
  return { config: resolved, sources };
}

export function globalConfigPath(env: NodeJS.ProcessEnv = process.env, platform = process.platform, home = homedir()) {
  const path = platform === 'win32' ? win32 : { join };
  if (env.ORCH_CONFIG_HOME) return path.join(env.ORCH_CONFIG_HOME, 'config.yaml');
  if (platform === 'win32') {
    if (!env.APPDATA) throw new Error('CONFIG_INVALID: APPDATA is required on Windows');
    return path.join(env.APPDATA, 'orch', 'config.yaml');
  }
  return path.join(env.XDG_CONFIG_HOME || join(home, '.config'), 'orch', 'config.yaml');
}

export async function loadConfig(originRoot: string | null, globalFile = globalConfigPath()) {
  const files = { global: globalFile, project: originRoot === null ? null : join(originRoot, '.orch', 'config.yaml') };
  const layers: Partial<Record<Scope, unknown>> = {};
  for (const scope of ['global', 'project'] as const) {
    const file = files[scope];
    if (file === null) continue;
    try {
      layers[scope] = parseConfig(await readFile(file, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return { ...resolveConfig(layers), files };
}
