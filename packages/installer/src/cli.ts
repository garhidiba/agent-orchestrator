import { parseArgs } from 'node:util';
import { git } from '../../core/src/git/repository.ts';
import { parseDocument } from 'yaml';
import { loadConfig } from '../../core/src/config/index.ts';
import { patchConfig } from '../../core/src/config/write.ts';
import { roleIds } from '../../protocol/src/config.ts';
import { getCatalogForHost } from '../../core/src/model-registry/service.ts';
import type { Model } from '../../core/src/model-registry/index.ts';
import { detectHost } from './detection/host.ts';

async function originRoot() {
  try {
    return await git(process.cwd(), 'rev-parse', '--show-toplevel');
  } catch (error) {
    const failure = error as { code?: number; stderr?: string };
    if (failure.code === 128 && failure.stderr?.includes('not a git repository')) return null;
    throw new Error('GIT_INSPECTION_FAILED');
  }
}
try {
  const { values: flags, positionals: args } = parseArgs({ allowPositionals: true, options: {
    host: { type: 'string' }, effective: { type: 'boolean' }, help: { type: 'boolean' }, global: { type: 'boolean' },
    'dry-run': { type: 'boolean' }, profile: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' },
  } });
  const host = flags.host === 'codex' || flags.host === 'claude' ? flags.host : null;
  const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  const invalid = () => { throw new Error('Invalid command. Run npm run orch -- --help'); };
  if (flags.help || args.length === 0) {
    console.log(`ORCH development tools
Usage:
  npm run orch -- doctor --host <codex|claude>
  npm run orch -- config --effective
  npm run orch -- config <set|unset> <path> [YAML-value] [--global] [--dry-run]
  npm run orch -- models [available|refresh] --host <codex|claude>
  npm run orch -- models set <role> --host <codex|claude> --model <ID> [--effort <LEVEL>] [--global] [--dry-run]
  npm run orch -- configure [--profile <balanced|quality|economy|fast>] [--global] [--dry-run]`);
  } else if (args[0] === 'doctor' && args.length === 1 && host && !flags.effective && !flags.global && !flags['dry-run'] && !flags.profile && !flags.model && !flags.effort) {
    const result = await detectHost(host); print(result); if (result.status !== 'detected') process.exitCode = 1;
  } else {
    const origin = await originRoot();
    const loaded = await loadConfig(origin);
    const scope = flags.global ? 'global' : 'project';
    const file = loaded.files[scope];
    const discover = (refresh = false) => host ? getCatalogForHost(origin, host, { refresh }) : invalid();
    const save = async (patches: { path: string[]; value?: unknown; remove?: boolean }[], catalog: Model[] = []) => {
      if (!file) throw new Error('PROJECT_REQUIRED');
      return patchConfig(file, loaded.hashes[scope]!, patches, catalog, { scope, layers: loaded.layers, dryRun: flags['dry-run'] });
    };
    if (args[0] === 'config' && args.length === 1 && flags.effective && !flags.host && !flags.profile && !flags.model && !flags.effort && !flags.global && !flags['dry-run']) print(loaded);
    else if (args[0] === 'config' && ['set', 'unset'].includes(args[1]) && !flags.effective && !flags.host && !flags.profile && !flags.model && !flags.effort) {
      if (args.length !== (args[1] === 'set' ? 4 : 3)) invalid();
      let value: unknown;
      if (args[1] === 'set') {
        try { const doc = parseDocument(args[3], { uniqueKeys: true, schema: 'core' }); if (doc.errors.length || doc.warnings.length) throw new Error(); value = doc.toJS({ maxAliasCount: 0 }); }
        catch { throw new Error('CONFIG_INVALID'); }
      }
      print(await save([{ path: args[2].split('.'), value, remove: args[1] === 'unset' }]));
    } else if (args[0] === 'models' && host && !flags.effective && !flags.profile) {
      if (args.length === 1 && !flags.model && !flags.effort && !flags.global && !flags['dry-run']) {
        print(Object.fromEntries(roleIds.map(role => [role, { requested: loaded.config.hosts[host].roles[role], resolved: null, observed: null,
          source: { model: loaded.sources[`hosts.${host}.roles.${role}.model`], effort: loaded.sources[`hosts.${host}.roles.${role}.effort`] }, status: 'verification_pending' }])));
      } else if (args.length === 2 && ['available', 'refresh'].includes(args[1]) && !flags.model && !flags.effort && !flags.global && !flags['dry-run']) print(await discover(args[1] === 'refresh'));
      else if (args.length === 3 && args[1] === 'set' && roleIds.includes(args[2] as typeof roleIds[number]) && flags.model) {
        const metadata = ['auto', 'inherit'].includes(flags.model) ? { models: [] } : await discover();
        const patches = [{ path: ['hosts', host, 'roles', args[2], 'model'], value: flags.model }];
        if (flags.effort) patches.push({ path: ['hosts', host, 'roles', args[2], 'effort'], value: flags.effort });
        print(await save(patches, [...metadata.models]));
      } else invalid();
    } else if (args[0] === 'configure' && args.length === 1 && !flags.host && !flags.effective && !flags.model && !flags.effort) {
      const result = await save([{ path: ['model_selection', 'profile'], value: flags.profile ?? loaded.config.model_selection.profile }]);
      print({ ...result, activation: 'next_worker_only', recommendation: 'Existing role pins preserved; host defaults retained because current-session model access and comparative performance are unverified.' });
    } else invalid();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'ORCH command failed');
  process.exitCode = 1;
}
