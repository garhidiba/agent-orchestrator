import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCatalogCache, readCatalogCache, catalogCacheKey } from '../../packages/core/src/model-registry/cache.ts';

test('catalog cache requires exact context, reports expiry and never proves session equivalence', () => {
  const context = { host: 'codex' as const, executable: '/codex', version: '1', account: null, workspace: null, policyFingerprint: 'hash' };
  const cache = createCatalogCache(context, [], 1, 1000);
  assert.equal(readCatalogCache(cache, context, 2000).stale, false);
  assert.equal(readCatalogCache(cache, context, 3601000).stale, true);
  assert.equal(readCatalogCache(cache, context).contextMatches, false);
  assert.notEqual(catalogCacheKey(context), catalogCacheKey({ ...context, account: 'other' }));
  assert.throws(() => readCatalogCache(cache, { ...context, policyFingerprint: 'other' }), /CATALOG_CONTEXT_MISMATCH/);
  assert.throws(() => createCatalogCache(context, [], Infinity), /CATALOG_TTL_INVALID/);
});
