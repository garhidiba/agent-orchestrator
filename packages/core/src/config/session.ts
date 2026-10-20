import { parseConfig, resolveConfig } from './index.ts';
import type { Scope } from './index.ts';
import { configHash } from './hash.ts';
import { proposeConfig } from './write.ts';
import type { ConfigMutation } from './write.ts';
import type { Model } from '../model-registry/index.ts';
import { requireCondition as check } from '../../../protocol/src/runtime.ts';

type Layers = Partial<Record<Scope, unknown>>;
export function createSessionConfig() {
  let text: string | null = null, revision = 0;
  const current = () => ({ hash: configHash(text), revision });
  return {
    snapshot(layers: Layers = {}) {
      const config = parseConfig(text ?? '');
      const resolved = resolveConfig({ ...layers, session: config });
      return { ...current(), config, effective: resolved.config, sources: resolved.sources };
    },
    patch(expectedHash: string, patches: ConfigMutation[], catalog: Model[] = [], options: { layers?: Layers; dryRun?: boolean } = {}) {
      check(expectedHash === configHash(text), 'CONFIG_CONFLICT');
      const proposal = proposeConfig(text, patches, catalog, { layers: options.layers, scope: 'session' });
      if (!options.dryRun) { text = proposal.text; revision++; }
      return { current: current(), proposal: { hash: configHash(proposal.text), config: proposal.config, effective: proposal.effective }, applied: !options.dryRun };
    },
  };
}
