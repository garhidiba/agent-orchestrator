import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateModels, type Model } from '../../packages/core/src/model-registry/index.ts';
import { resolveConfig } from '../../packages/core/src/config/index.ts';
const model: Model = {host:'codex', id:'opaque-id',displayName:'Opaque',resolvedId:null,family:'openai',support:'advertised',access:'unknown',availability:'unknown',efforts:['medium','high'],defaultEffort:'medium',hidden:false,source:'fixture verified provider metadata',sourceVersion:'1',fetchedAt:new Date().toISOString(),expiresAt:null,evidence:[{kind:'provider',ref:'fixture:openai'}]};
export { model };
test('storage rejects rate-limited models and inconsistent default effort metadata', () => {
 const config=resolveConfig({project:{hosts:{codex:{roles:{coder:{model:'opaque-id',effort:'high'}}}}}}).config;
 assert.throws(()=>validateModels(config,[{...model,availability:'rate_limited'}]),/MODEL_UNAVAILABLE/);
 assert.throws(()=>validateModels(config,[{...model,defaultEffort:'unsupported'}]),/EFFORT_METADATA_INVALID/);
 validateModels(config,[model]);
});

const runtime = await import('../../packages/core/src/runtime/models.ts');
test('per-role native dispatch carries concrete pins and keeps unknown observations honest', () => {
 const config=resolveConfig({project:{hosts:{codex:{roles:{reviewer:{model:'opaque-id',effort:'high'}}}}}}).config;
 const native={host:'codex' as const,contextMatches:true,verified:true,perInvocationModel:true,perInvocationEffort:true,model:null,effort:null,models:[model],evidence:['fixture:native-tool-schema']};
 const resolved=runtime.resolveRoleModel({config,host:'codex',role:'reviewer',native});
 assert.deepEqual(resolved.nativeArguments,{model:'opaque-id',reasoning_effort:'high'});
 assert.equal(resolved.observedModel,null);
 assert.throws(()=>runtime.resolveRoleModel({config,host:'codex',role:'reviewer',native:{...native,perInvocationModel:false}}),/BLOCKED_CAPABILITY/);
 assert.throws(()=>runtime.resolveRoleModel({config,host:'codex',role:'reviewer',native:{...native,contextMatches:false}}),/BLOCKED_CAPABILITY/);
 assert.equal(runtime.resolveRoleModel({config,host:'codex',role:'coder',native}).resolvedModel,null);
});

test('advisor selects from measured profile evidence while preserving user model and effort pins',()=>{
 const config=resolveConfig({project:{hosts:{codex:{roles:{coder:{model:'opaque-id',effort:'high'},tester:{effort:'high'}}}}}}).config;
 const other={...model,id:'second',defaultEffort:'medium'};
 const quality=runtime.recommendModels(config,'codex',[model,other],{profile:'quality',assessments:[{modelId:'opaque-id',quality:1,evidenceRefs:['fixture:evaluation']},{modelId:'second',quality:2,evidenceRefs:['fixture:evaluation']}]});
 assert.equal(quality.selections.find(s=>s.role==='reviewer')?.modelId,'second');
 assert.equal(quality.selections.find(s=>s.role==='tester')?.effort,'high');
 assert.ok(!quality.proposedPatch.some(p=>p.path.includes('/coder/')));
 assert.ok(!quality.proposedPatch.some(p=>p.path==='/hosts/codex/roles/tester/effort'));
 assert.equal(runtime.recommendModels(config,'codex',[model,other]).proposedPatch.length,0);
 assert.equal(runtime.recommendModels(config,'codex',[model,other],{defaultModelId:'second'}).selections[0].modelId,'second');
});

test('real observations accept undisclosed inheritance and distinguish alias uncertainty from a verified mismatch',()=>{
 const unknown={requestedModel:'inherit',requestedEffort:'inherit',resolvedModel:null,resolvedEffort:null};
 assert.deepEqual(runtime.observeRoleModel(unknown,{model:'actual',effort:'high'}),{observedModel:'actual',observedEffort:'high',modelComparison:'unknown',effortComparison:'unknown',policyViolation:false,status:'observed'});
 const pinned={requestedModel:'opaque-id',requestedEffort:'high',resolvedModel:'opaque-id',resolvedEffort:'high'};
 assert.equal(runtime.observeRoleModel(pinned,{model:'actual',effort:'medium'},[model]).modelComparison,'unknown');
 const mismatch=runtime.observeRoleModel(pinned,{model:'wrong',effort:'medium'},[{...model,resolvedId:'actual'}]);
 assert.equal(mismatch.policyViolation,true);
 assert.equal(mismatch.effortComparison,'differs');
 assert.equal(runtime.observeRoleModel(pinned,{model:null,effort:null}).status,'unknown');
});

test('explicit effort matching the verified inherited parent needs no model override capability', () => {
 const config=resolveConfig({}).config;
 config.hosts.codex.roles.coder.effort='high';
 const result=runtime.resolveRoleModel({config,host:'codex',role:'coder',native:{host:'codex',verified:true,contextMatches:true,evidence:['synthetic-parent-receipt'],model:'undisclosed-option',effort:'high'}});
 assert.equal(result.resolvedEffort,'high'); assert.deepEqual(result.nativeArguments,{});
});
