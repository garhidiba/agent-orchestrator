import { createHash } from 'node:crypto';
import { z } from 'zod';
import { modelSchema } from './index.ts';

// Unknown identity fields cannot establish equivalence with a native session.
export const catalogContextSchema = z.strictObject({
  host: z.enum(['codex', 'claude']), executable: z.string().min(1), version: z.string().min(1),
  account: z.string().min(1).nullable(), workspace: z.string().min(1).nullable(),
  policyFingerprint: z.string().min(1),
  settingsFingerprint: z.string().min(1).optional(), originRoot: z.string().nullable().optional(),
  scope: z.enum(['unknown', 'verified']).default('unknown'), authFingerprint: z.string().nullable().default(null),
});
export type CatalogContext = z.input<typeof catalogContextSchema>;
const cacheSchema = z.strictObject({ context: catalogContextSchema, fetchedAt: z.iso.datetime(), expiresAt: z.iso.datetime(), models: z.array(modelSchema) });
export function catalogCacheKey(context: CatalogContext) {
  const parsed = catalogContextSchema.parse(context);
  return createHash('sha256').update(JSON.stringify(parsed)).digest('hex');
}
export function createCatalogCache(context: CatalogContext, models: unknown[], ttlHours: number, now = Date.now()) {
  if (!Number.isFinite(ttlHours) || ttlHours <= 0) throw new Error('CATALOG_TTL_INVALID');
  return cacheSchema.parse({ context, models, fetchedAt: new Date(now).toISOString(), expiresAt: new Date(now + ttlHours * 3600000).toISOString() });
}
export function readCatalogCache(value: unknown, context: CatalogContext, now = Date.now()) {
  const cache = cacheSchema.parse(value);
  if (catalogCacheKey(cache.context) !== catalogCacheKey(context)) throw new Error('CATALOG_CONTEXT_MISMATCH');
  if (cache.models.some(model => model.host !== context.host)) throw new Error('CATALOG_CONTEXT_MISMATCH');
  return { ...cache, stale: Date.parse(cache.expiresAt) <= now || cache.models.some(model => model.expiresAt !== null && Date.parse(model.expiresAt) <= now),
    contextMatches: false as const };
}
