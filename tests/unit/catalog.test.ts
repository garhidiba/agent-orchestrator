import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverCodexModels } from '../../packages/host-codex/src/catalog.ts';

test('Codex metadata uses handshake, all pages, deduplication and unknown access/context', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orch-catalog-')), file = join(dir, 'fixture-host.mjs');
  try {
    await writeFile(file, `#!${process.execPath}\nimport { createInterface } from 'node:readline';
let initialized = false;
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize') console.log(JSON.stringify({id:m.id,result:{}}));
 else if(m.method==='initialized') initialized=true;
 else if(m.method==='model/list'&&initialized) console.log(JSON.stringify({id:m.id,result:{data:[{id:'fixture',supportedReasoningEfforts:[{reasoningEffort:'custom'}],defaultReasoningEffort:'custom'}],nextCursor:m.params.cursor?null:'page2'}}));
 else process.exit(2);
});\n`, { mode: 0o700 });
    const result = await discoverCodexModels(file);
    assert.equal(result.models.length, 1);
    assert.deepEqual(result.models[0].efforts, ['custom']);
    assert.equal(result.models[0].access, 'unknown');
    assert.equal(result.models[0].family, 'unknown');
    assert.equal(result.contextMatches, false);
    await writeFile(file, `#!${process.execPath}\nsetInterval(()=>{},1000)\n`, { mode: 0o700 });
    await assert.rejects(discoverCodexModels(file, 100), /CATALOG_TIMEOUT/);
    await assert.rejects(discoverCodexModels(join(dir, 'absent')), /CATALOG_PROCESS_FAILED/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
