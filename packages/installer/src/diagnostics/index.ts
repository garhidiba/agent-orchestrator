import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import * as TOML from '@iarna/toml';
import { z } from 'zod';
import { parseDocument } from 'yaml';
import { detectHost, type HostKind } from '../detection/host.ts';
import { globalConfigPath, loadConfig } from '../../../core/src/config/index.ts';
import { getCatalogForHost } from '../../../core/src/model-registry/service.ts';
import { git } from '../../../core/src/git/repository.ts';
import { verifyRelease } from '../installation/index.ts';
import { probeMcp } from './mcp.ts';
export { probeMcp } from './mcp.ts';

const entrySchema = z.object({ command: z.string(), args: z.array(z.string()) }).strict();
export async function doctor(origin: string | null, host: HostKind, options: { home?: string; root?: string; executable?: string; timeout?: number; catalog?: boolean } = {}) {
  const home = options.home ?? homedir();
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  if (options.home) { delete env.ORCH_CONFIG_HOME; delete env.XDG_CONFIG_HOME; }
  let base = origin ?? home;
  const userRoot = process.platform === 'win32' ? join(options.home ? join(home, 'AppData/Local') : process.env.LOCALAPPDATA ?? join(home, 'AppData/Local'), 'orch') : join(options.home ? join(home, '.local/share') : process.env.XDG_DATA_HOME ?? join(home, '.local/share'), 'orch');
  const detected = await detectHost(host, options.executable, options.timeout);
  let configuration = 'valid', gitStatus = 'available';
  try { await loadConfig(origin, globalConfigPath(env, process.platform, home)); } catch { configuration = 'invalid'; }
  try { await git(origin ?? home, '--version'); } catch { gitStatus = 'unavailable'; }
  let hostConfig = 'missing', installation = 'missing', mcp = 'not_configured';
  let protocol: Awaited<ReturnType<typeof probeMcp>> | null = null;
  try {
    const fileFor = (base: string) => host === 'codex' ? join(base, '.codex/config.toml') : host === 'hermes' ? join(base, '.hermes/config.yaml') : join(base, base === home ? '.claude.json' : '.mcp.json');
    let entries: Record<string, unknown> = {};
    for (const candidate of host === 'hermes' ? [home] : [...new Set([base, home])]) {
      let bytes: string;
      try { bytes = await readFile(fileFor(candidate), 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      if (Buffer.byteLength(bytes) > 1024 * 1024) throw new Error('HOST_CONFIG_TOO_LARGE');
      const doc = host === 'hermes' ? parseDocument(bytes, { uniqueKeys: true, schema: 'core' }) : null;
      if (doc && (doc.errors.length || doc.warnings.length)) throw new Error('HOST_CONFIG_INVALID');
      const parsed = doc ? doc.toJS({ maxAliasCount: 0 }) : host === 'codex' ? TOML.parse(bytes) : JSON.parse(bytes);
      const config = z.record(z.string(), z.unknown()).parse(parsed);
      entries = z.record(z.string(), z.unknown()).parse(config[host === 'claude' ? 'mcpServers' : 'mcp_servers'] ?? {});
      hostConfig = 'valid'; base = candidate;
      if (entries.orch !== undefined) break;
    }
    const root = options.root ?? (base === home ? userRoot : join(base, '.orch/installation'));
    if (entries.orch !== undefined) {
      mcp = 'unowned';
      try {
        const manifest = JSON.parse(await readFile(join(root, 'installation.json'), 'utf8'));
        const record = manifest.hosts?.[host];
        if (manifest.base === base && manifest.scope === (base === home ? 'user' : 'project') && record && isDeepStrictEqual(entries.orch, record.entry)) {
          const entry = entrySchema.parse(record.entry);
          const version = z.string().regex(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/).parse(record.version);
          await verifyRelease(join(root, 'versions', version), manifest.releases[version]);
          if (!isAbsolute(entry.command) || entry.command !== record.runtime || entry.args[0] !== join(root, 'versions', version, 'packages/mcp-server/src/stdio.ts') || entry.args[1] !== '--host' || entry.args[2] !== host || entry.args[3] !== '--origin' || entry.args[4] !== (base === home ? host === 'hermes' ? '${workspaceFolder}' : '.' : base) || entry.args.length !== 5) throw new Error();
          installation = 'integrity_verified'; mcp = 'not_run_untrusted';
          const currentStdio = await realpath(fileURLToPath(new URL('../../../mcp-server/src/stdio.ts', import.meta.url)));
          // Repository-owned hashes prove integrity, never authority to launch a different installation.
          if (entry.command === process.execPath && await realpath(entry.args[0]) === currentStdio) {
            installation = 'verified';
            protocol = await probeMcp({ command: process.execPath, args: [currentStdio, '--host', host], timeout: options.timeout });
            mcp = protocol.status;
          }
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { mcp = 'failed'; installation = 'invalid'; } }
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') hostConfig = 'invalid'; }
  const catalogOptions = { executable: options.executable, timeout: options.timeout, env, readOnly: true };
  const catalog = options.catalog === false ? { status: 'not_run', models: [] } : await getCatalogForHost(origin, host, catalogOptions);
  return { ...detected, installation, runtime: { status: Number(process.versions.node.split('.')[0]) >= 24 ? 'ready' : 'unsupported', version: process.version },
    git: { status: gitStatus }, configuration: { status: configuration }, hostConfig: { status: hostConfig }, mcp: { status: mcp, protocol }, catalog,
    reload: 'UNVERIFIED', authentication: 'NOT_CHECKED', executionReady: false };
}
