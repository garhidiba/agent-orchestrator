import {test} from 'node:test';
import assert from 'node:assert/strict';
import {discoverClaudeModels} from '../../packages/host-claude/src/catalog.ts';
test('Claude supportedModels metadata adapter keeps provider identity and effort separate from access',async()=>{
 const adapter={supportedModels:async()=>[{value:'opaque-alias',displayName:'Opaque',description:'fixture',supportsEffort:true,supportedEffortLevels:['medium','max']}],providerFamily:'claude' as const,sourceVersion:'fixture-sdk',evidenceRef:'fixture:session-metadata'};
 const result=await discoverClaudeModels(adapter);
 assert.equal(result.models[0].family,'claude');
 assert.deepEqual(result.models[0].efforts,['medium','max']);
 assert.equal(result.models[0].access,'unknown');
 assert.equal(result.models[0].resolvedId,null);
 assert.equal((await discoverClaudeModels({...adapter,providerFamily:'unknown'})).models[0].family,'unknown');
 await assert.rejects(discoverClaudeModels({...adapter,supportedModels:async()=>[{value:'x',supportsEffort:false,supportedEffortLevels:['max']}]}),/CLAUDE_METADATA_INVALID/);
});
