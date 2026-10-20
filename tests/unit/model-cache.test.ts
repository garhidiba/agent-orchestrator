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

test('verified exact contexts can match while missing identity never establishes equivalence',async()=>{
 const {sameCatalogContext}=await import('../../packages/core/src/model-registry/cache.ts');
 const context = { host: 'codex' as const, executable: '/codex', version: '1', account: null, workspace: null, policyFingerprint: 'hash' };
 const verified={...context,scope:'verified' as const,account:'fixture-account',workspace:'fixture-workspace',authFingerprint:'fixture-auth',policyFingerprint:'fixture-policy',settingsFingerprint:'fixture-settings'};
 assert.equal(sameCatalogContext(verified,verified),true);
 assert.equal(sameCatalogContext(context,context),false);
 assert.equal(sameCatalogContext(verified,{...verified,authFingerprint:'rotated'}),false);
});
