import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCatalogForHost } from '../../packages/core/src/model-registry/service.ts';

test('disk catalog uses exact partial scope, refreshes explicitly, and reports stale failed refresh', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orch-catalog-service-'));
  try {
    const executable = join(dir, 'codex'), global = join(dir, 'global'); await mkdir(global);
    await writeFile(join(global, 'config.yaml'), 'model_selection: {catalog_cache_ttl_hours: 1}\n');
    await writeFile(executable, `#!${process.execPath}\nimport{createInterface}from'node:readline';import{existsSync}from'node:fs';
if(process.argv[2]==='--version'){console.log('fixture-codex 1');process.exit(0)}
if(existsSync(new URL('./fail',import.meta.url)))process.exit(2);
createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(m.id)console.log(JSON.stringify({id:m.id,result:m.method==='initialize'?{}:{data:[{id:'fixture',model:'fixture',supportedReasoningEfforts:[]}]}}))});`, { mode: 0o700 });
    const now = Date.now(), options = { executable, cacheRoot: join(dir, 'cache'), now,
      env: { PATH: process.env.PATH, HOME: dir, ORCH_CONFIG_HOME: global } };
    const live = await getCatalogForHost(dir, 'codex', options);
    assert.equal(live.source, 'live'); assert.equal(live.status, 'partial'); assert.equal(live.contextMatches, false);
    assert.deepEqual(live.errors, []); assert.equal(live.models[0].access, 'unknown');
    const file = join(dir, 'cache', 'unknown', 'codex', `${live.cacheKey}.json`);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).context.scope, 'unknown');
    const alias = join(dir, 'alias'); await symlink(executable, alias);
    await writeFile(join(dir, 'fail'), '');
    const cached = await getCatalogForHost(dir, 'codex', { ...options, executable: alias });
    assert.equal(cached.cacheKey, live.cacheKey); assert.equal(cached.source, 'cache'); assert.equal(cached.stale, false);
    const failed = await getCatalogForHost(dir, 'codex', { ...options, refresh: true });
    assert.equal(failed.source, 'cache'); assert.equal(failed.models.length, 1); assert.ok(failed.errors.includes('CATALOG_PROCESS_CLOSED'));
    const stale = await getCatalogForHost(dir, 'codex', { ...options, now: now + 3600001 });
    assert.equal(stale.source, 'cache'); assert.equal(stale.stale, true); assert.ok(stale.errors.length > 0);
    await writeFile(join(global, 'config.yaml'), 'model_selection: {profile: quality}\n');
    const changed = await getCatalogForHost(dir, 'codex', options);
    assert.notEqual(changed.cacheKey, live.cacheKey); assert.equal(changed.source, 'none'); assert.equal(changed.status, 'failed');
    assert.ok(changed.errors.length > 0);
    await writeFile(join(global, 'config.yaml'), 'model_selection: {catalog_cache_ttl_hours: 1}\n');
    await writeFile(file, '{broken');
    const invalid = await getCatalogForHost(dir, 'codex', options);
    assert.equal(invalid.source, 'none'); assert.ok(invalid.errors.includes('CATALOG_CACHE_INVALID'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('missing executable and unavailable native metadata are explicit outcomes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orch-catalog-service-'));
  try {
    const env = { PATH: process.env.PATH, HOME: dir, ORCH_CONFIG_HOME: join(dir, 'global') };
    const missing = await getCatalogForHost(dir, 'codex', { executable: join(dir, 'absent'), env });
    assert.equal(missing.status, 'failed'); assert.equal(missing.source, 'none');
    assert.deepEqual(missing.errors, ['CATALOG_CONTEXT_UNAVAILABLE']);
    const executable = join(dir, 'claude'); await writeFile(executable, `#!${process.execPath}\nconsole.log('fixture-claude 1');`, { mode: 0o700 });
    for (const host of ['claude', 'hermes'] as const) {
      const partial = await getCatalogForHost(dir, host, { executable, env });
      assert.equal(partial.status, 'partial'); assert.equal(partial.source, 'none');
      assert.deepEqual(partial.errors, ['NATIVE_MODEL_METADATA_UNAVAILABLE']); assert.equal(partial.contextMatches, false);
      assert.deepEqual(partial.models, []); assert.equal(partial.context?.host, host);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('readonly metadata diagnostics do not create a cache directory',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'orch-readonly-catalog-'));
 try {
  const executable=join(dir,'codex'),cacheRoot=join(dir,'cache');
  await writeFile(executable,`#!${process.execPath}\nimport{createInterface}from'node:readline';if(process.argv[2]==='--version'){console.log('fixture 1');process.exit(0)}createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(m.id)console.log(JSON.stringify({id:m.id,result:m.method==='initialize'?{}:m.method==='config/read'?{config:{model_provider:'openai'}}:{data:[]}}))});`,{mode:0o700});
  assert.equal((await getCatalogForHost(dir,'codex',{executable,cacheRoot,readOnly:true,env:{PATH:process.env.PATH,HOME:dir}})).source,'live');
  await assert.rejects(stat(cacheRoot),{code:'ENOENT'});
 }finally{await rm(dir,{recursive:true,force:true})}
});
