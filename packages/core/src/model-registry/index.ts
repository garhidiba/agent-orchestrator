import { z } from 'zod';
import { requireCondition as check } from '../../../protocol/src/runtime.ts';
import type { Config } from '../../../protocol/src/config.ts';

export const modelSchema = z.strictObject({
  host: z.enum(['codex', 'claude']), id: z.string().min(1), displayName: z.string(), resolvedId: z.string().nullable(),
  family: z.enum(['openai', 'claude', 'unknown']), support: z.enum(['advertised', 'verified', 'unsupported']),
  access: z.enum(['unknown', 'confirmed', 'denied']), availability: z.enum(['unknown', 'available', 'rate_limited', 'unavailable']),
  efforts: z.array(z.string()).nullable(), defaultEffort: z.string().nullable(), hidden: z.boolean(),
  source: z.string(), sourceVersion: z.string().nullable(), fetchedAt: z.iso.datetime(), expiresAt: z.iso.datetime().nullable(),
  evidence: z.array(z.strictObject({ kind: z.string(), ref: z.string() })),
});
export type Model = z.infer<typeof modelSchema>;
export function validateModels(config: Config, catalog: Model[]) {
  const models = catalog.map(model => modelSchema.parse(model));
  for (const host of ['codex', 'claude'] as const) for (const policy of Object.values(config.hosts[host].roles)) {
    if (['auto', 'inherit'].includes(policy.model)) {
      check(['auto', 'inherit'].includes(policy.effort), 'MODEL_RESOLUTION_REQUIRED');
      continue;
    }
    const model = models.find(candidate => candidate.host === host && candidate.id === policy.model);
    check(model && model.support !== 'unsupported' && model.family === (host === 'codex' ? 'openai' : 'claude'), 'MODEL_NOT_SUPPORTED');
    check(model.access !== 'denied', 'MODEL_ACCESS_DENIED');
    check(model.availability !== 'unavailable', 'MODEL_UNAVAILABLE');
    check(!model.expiresAt || Date.parse(model.expiresAt) > Date.now(), 'CATALOG_EXPIRED');
    if (!['auto', 'inherit'].includes(policy.effort)) check(model.efforts?.includes(policy.effort), 'EFFORT_NOT_SUPPORTED');
  }
}
