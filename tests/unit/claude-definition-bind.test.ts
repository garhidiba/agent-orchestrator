import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runtimeFixture } from '../fixtures/runtime.ts';
import { inspectRepository } from '../../packages/core/src/git/repository.ts';
import { prepareClaudeRoleDefinition } from '../../packages/core/src/runtime/host-claude.ts';

async function fixture(role:'coder'|'reviewer') {
 const f=await runtimeFixture(true,{hosts:{claude:{roles:{[role]:{model:'claude-opus-5-5',effort:'high'}}}}});
 const repo=await inspectRepository(f.root);
 const prepared=await prepareClaudeRoleDefinition({originRoot:repo.root,commonDir:repo.commonDir,role,model:'claude-opus-5-5',effort:'high',dryRun:false});
 const {originRoot:_root,agentsDirectoryExisted:_existed,reloadHint:_hint,dryRun:_dry,...receipt}=prepared;
 f.engine.native={host:'claude',verified:true,contextMatches:true,evidence:['synthetic:named-probe'],model:null,effort:null,claudeDefinitionRoot:repo.root,claudeRoleDefinitions:[{...receipt,loaded:{nativeAgentId:'fixture-role-probe',sha256:receipt.sha256}}]};
 await f.change({},async run=>{run.host='claude';});await f.change({},run=>f.engine.plan(run,f.plan,true));
 const path=join(repo.root,receipt.path),bytes=await readFile(path,'utf8');
 return {...f,path,bytes};
}

test('Engine blocks edited prepared coder definition at bind and keeps attempt policy pinned',async()=>{
 const f=await fixture('coder');try{
  const prepared=await f.change({},run=>f.engine.prepare(run,'T1'));
  await writeFile(f.path,f.bytes+'tampered\n');
  await assert.rejects(f.change({},run=>f.engine.bind(run,'T1',prepared.result.leaseId,prepared.result.fencingToken,'fixture-worker',null,null)),/CLAUDE_ROLE_DEFINITION_STALE/);
  assert.equal(f.engine.status(f.created.runId).data.tasks.T1.state,'LEASED');
  await writeFile(f.path,f.bytes);f.engine.native!.claudeRoleDefinitions=[];
  await f.change({},async run=>{run.config.hosts.claude.roles.coder.effort='low';});
  assert.equal((await f.change({},run=>f.engine.bind(run,'T1',prepared.result.leaseId,prepared.result.fencingToken,'fixture-worker',null,null))).result.state,'RUNNING');
  assert.equal(f.engine.status(f.created.runId).data.tasks.T1.modelResolution?.resolvedEffort,'high');
 }finally{await f.close()}
});

test('Engine blocks edited prepared reviewer definition before binding review authority',async()=>{
 const f=await fixture('reviewer');try{
  await f.change({},async run=>{run.state='VERIFYING';});await f.change({},run=>f.engine.verify(run));
  const prepared=await f.change({},run=>f.engine.prepareReview(run,'reviewer'));
  await writeFile(f.path,f.bytes+'tampered\n');
  await assert.rejects(f.change({},run=>f.engine.bindReview(run,prepared.result.dispatchId,'fixture-reviewer',null,null,prepared.result.reviewedSha)),/CLAUDE_ROLE_DEFINITION_STALE/);
  assert.equal(f.engine.status(f.created.runId).data.reviewDispatches![prepared.result.dispatchId].state,'LEASED');
 }finally{await f.close()}
});
