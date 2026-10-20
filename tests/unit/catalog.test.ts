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
 else if(m.method==='config/read'&&initialized) console.log(JSON.stringify({id:m.id,result:{config:{}}}));
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

test('Codex rejects malformed advertised fields and preserves split UTF-8', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orch-catalog-')), file = join(dir, 'host.mjs');
  try {
    for (const entry of [{ id: 'x', hidden: 'false' }, { id: 'x', supportedReasoningEfforts: {} }, { id: 'x', model: 1 }]) {
      await writeFile(file, `#!${process.execPath}\nimport{createInterface}from'node:readline';createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(m.id)console.log(JSON.stringify({id:m.id,result:m.method==='initialize'?{}:{data:[${JSON.stringify(entry)}]}}))});`, { mode: 0o700 });
      await assert.rejects(discoverCodexModels(file), /CATALOG_INVALID/);
    }
    await writeFile(file, `#!${process.execPath}\nimport{createInterface}from'node:readline';createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(!m.id)return;const b=Buffer.from(JSON.stringify({id:m.id,result:m.method==='initialize'?{}:{data:[{id:'한글'}]}})+'\\n');let i=b.indexOf(Buffer.from('한'));if(i<0)i=1;process.stdout.write(b.subarray(0,i+1));setTimeout(()=>process.stdout.write(b.subarray(i+1)),5)});`, { mode: 0o700 });
    assert.equal((await discoverCodexModels(file)).models[0].id, '한글');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Codex provider identity comes from effective config, never the model prefix', async () => {
 const dir=await mkdtemp(join(tmpdir(),'orch-provider-')), file=join(dir,'host.mjs');
 try {
  for(const [provider, expected, providers] of [['openai','openai',{}],['proxy','unknown',{}],['openai','unknown',{openai:{base_url:'https://untrusted.example/v1'}}]] as const){
   await writeFile(file,`#!${process.execPath}\nimport{createInterface}from'node:readline';createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(!m.id)return;console.log(JSON.stringify({id:m.id,result:m.method==='initialize'?{}:m.method==='config/read'?{config:{model_provider:'${provider}',model_providers:${JSON.stringify(providers)}}}:{data:[{id:'opaque-id'},{id:'gpt-counterfeit'}]}}))});`,{mode:0o700});
   assert.deepEqual((await discoverCodexModels(file)).models.map(m=>m.family),[expected,expected]);
  }
 }finally{await rm(dir,{recursive:true,force:true})}
});
