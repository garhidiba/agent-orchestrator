import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig } from '../../packages/core/src/config/index.ts';
import { resolveRoleModel } from '../../packages/core/src/runtime/models.ts';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
async function fixture() {
 const dir = await mkdtemp(join(tmpdir(), 'orch-role-')), root = await realpath(dir);
 const policy = { originRoot: root, role: 'coder', model: 'claude-opus-5-5', effort: 'high' };
 const name = `orch-coder-p${digest(JSON.stringify(policy)).slice(0,16)}`, path = `.claude/agents/${name}.md`;
 const text = `---\nname: ${name}\ndescription: ORCH coder\nmodel: claude-opus-5-5\neffort: high\n---\nFollow the assigned handoff.\n`;
 await mkdir(join(root, '.claude/agents'), { recursive: true }); await writeFile(join(root,path),text);
 const receipt = {role:'coder' as const,name,path,sha256:digest(text),model:policy.model,effort:policy.effort,loaded:{nativeAgentId:'fixture-named-probe',sha256:digest(text)}};
 const native = {host:'claude' as const,verified:true,contextMatches:true,evidence:['fixture:parent-relay'],model:null,effort:null,perInvocationModel:false,perInvocationEffort:false,claudeDefinitionRoot:root,claudeRoleDefinitions:[receipt]};
 const config = resolveConfig({project:{hosts:{claude:{roles:{coder:{model:policy.model,effort:policy.effort}}}}}}).config;
 return {root,path,text,receipt,native,config,close:()=>rm(root,{recursive:true,force:true})};
}
test('Claude exact model and effort dispatch through a loaded named project definition without override arguments', async()=>{
 const f=await fixture();try{
  const result=resolveRoleModel({config:f.config,host:'claude',role:'coder',native:f.native});
  assert.deepEqual(result.nativeArguments,{subagent_type:f.receipt.name});
  assert.equal(result.resolvedModel,'claude-opus-5-5'); assert.equal(result.resolvedEffort,'high');
  assert.equal(result.observedModel,null);assert.equal(result.observedEffort,null);
 }finally{await f.close()}
});

test('Claude role transport rejects missing load proof, edited bytes and role/model/effort mismatch',async()=>{
 const f=await fixture();try{
  const resolve=(native: typeof f.native)=>resolveRoleModel({config:f.config,host:'claude',role:'coder',native});
  assert.throws(()=>resolve({...f.native,claudeRoleDefinitions:[]}),/CLAUDE_ROLE_DEFINITION_REQUIRED/);
  assert.throws(()=>resolve({...f.native,claudeDefinitionRoot:''}),/CLAUDE_ROLE_DEFINITION_REQUIRED/);
  assert.throws(()=>resolve({...f.native,claudeRoleDefinitions:[{...f.receipt,loaded:{...f.receipt.loaded,sha256:'0'.repeat(64)}}]}),/NEEDS_RELOAD/);
  f.config.hosts.claude.roles.coder.model='claude-sonnet-5-5';
  assert.throws(()=>resolve(f.native),/CLAUDE_ROLE_DEFINITION_MISMATCH/);
  f.config.hosts.claude.roles.coder.model=f.receipt.model; f.config.hosts.claude.roles.coder.effort='low';
  assert.throws(()=>resolve(f.native),/CLAUDE_ROLE_DEFINITION_MISMATCH/);
  f.config.hosts.claude.roles.coder.effort='high';
  await writeFile(join(f.root,f.path),f.text+'Changed after refresh.\n');
  assert.throws(()=>resolve(f.native),/CLAUDE_ROLE_DEFINITION_STALE/);
 }finally{await f.close()}
});

test('authenticated MCP validates named definition bytes on connect and refresh',async()=>{
 const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');
 const {InMemoryTransport}=await import('@modelcontextprotocol/sdk/inMemory.js');
 const {createServer}=await import('../../packages/mcp-server/src/server.ts');
 const {git}=await import('../../packages/core/src/git/repository.ts');
 const {readFile}=await import('node:fs/promises');
 const f=await fixture(); await git(f.root,'init');await git(f.root,'config','user.name','Fixture');await git(f.root,'config','user.email','fixture@example.invalid');
 await git(f.root,'add','.claude');await git(f.root,'commit','-m','fixture');
 const tokenPath=join(f.root,'coordinator.token');const server=await createServer(f.root,'claude',join(f.root,'managed'),tokenPath);
 const client=new Client({name:'named-role-contract',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
 try{
  await server.connect(a);await client.connect(b);
  const call=async(name:string,args:Record<string,unknown>={})=>JSON.parse(((await client.callTool({name,arguments:args})).content as {text:string}[])[0].text);
  const auth={coordinator_token:await readFile(tokenPath,'utf8')},env=(await call('orch_environment')).data;
  const probe={cwd:f.root,origin_root:f.root,branch:await git(f.root,'branch','--show-current'),head:await git(f.root,'rev-parse','HEAD')};
  const context={model:null,effort:null,perInvocationModel:false,perInvocationEffort:false,claudeRoleDefinitions:[f.receipt]};
  const connect={...auth,native_tool:'Agent',native_agent_id:'fixture-root-probe',probe:{...probe,challenge:env.nativeHandshake.challenge},native_context:context};
  const invalid=await call('orch_host_connect',{...connect,native_context:{...context,claudeRoleDefinitions:[{...f.receipt,sha256:'1'.repeat(64),loaded:{...f.receipt.loaded,sha256:'1'.repeat(64)}}]}});
  assert.equal(invalid.error?.code,'CLAUDE_ROLE_DEFINITION_STALE');
  assert.equal((await call('orch_host_connect',connect)).data.state,'READY');
  assert.deepEqual((await call('orch_models')).data.authenticatedNative.claudeRoleDefinitions,[f.receipt]);
  await writeFile(join(f.root,f.path),f.text+'stale\n');
  assert.equal((await call('orch_host_refresh',{...auth,probe,native_context:context})).error?.code,'CLAUDE_ROLE_DEFINITION_STALE');
 }finally{await client.close();await server.close();await f.close()}
});


test('authenticated role prepare reuses templates, ignores exact generated path and preserves config',async()=>{
 const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');
 const {InMemoryTransport}=await import('@modelcontextprotocol/sdk/inMemory.js');
 const {createServer}=await import('../../packages/mcp-server/src/server.ts');
 const {git}=await import('../../packages/core/src/git/repository.ts');
 const {readFile,access}=await import('node:fs/promises');
 const f=await fixture();await git(f.root,'init');await git(f.root,'config','user.name','Fixture');await git(f.root,'config','user.email','fixture@example.invalid');
 await mkdir(join(f.root,'.orch'));const configText=JSON.stringify(f.config);await writeFile(join(f.root,'.orch/config.yaml'),configText);
 await git(f.root,'add','.orch');await git(f.root,'commit','-m','fixture');
 const tokenPath=join(f.root,'coordinator.token'),server=await createServer(f.root,'claude',join(f.root,'managed'),tokenPath);
 const client=new Client({name:'prepare-role-contract',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
 try{
  await server.connect(a);await client.connect(b);
  const call=async(name:string,args:Record<string,unknown>={})=>JSON.parse(((await client.callTool({name,arguments:args})).content as {text:string}[])[0].text);
  const auth={coordinator_token:await readFile(tokenPath,'utf8')},env=(await call('orch_environment')).data;
  const model={host:'claude',id:'claude-opus-5-5',displayName:'fixture',resolvedId:null,family:'claude',support:'advertised',access:'unknown',availability:'unknown',efforts:['high'],defaultEffort:'high',hidden:false,source:'fixture',sourceVersion:null,fetchedAt:new Date().toISOString(),expiresAt:null,evidence:[{kind:'fixture',ref:'fixture:official-contract'}]};
  await call('orch_host_connect',{...auth,native_tool:'Agent',native_agent_id:'fixture-probe',probe:{challenge:env.nativeHandshake.challenge,cwd:f.root,origin_root:f.root,branch:await git(f.root,'branch','--show-current'),head:await git(f.root,'rev-parse','HEAD')},native_context:{model:null,effort:null,models:[model]}});
  const expected_hash=(await call('orch_config',{action:'effective'})).data.hashes.project;
  const args={...auth,role:'coder',expected_hash};
  // A pre-existing unknown definition with the right name is never overwritten.
  assert.equal((await call('orch_claude_role_prepare',args)).error?.code,'CLAUDE_ROLE_DEFINITION_CONFLICT');
  await rm(join(f.root,f.path));
  const preview=await call('orch_claude_role_prepare',{...args,dry_run:true});
  assert.equal(preview.data.model,'claude-opus-5-5');assert.equal(preview.data.effort,'high');assert.equal(preview.data.loaded,undefined);
  await assert.rejects(access(join(f.root,preview.data.path)));
  const generated=(await call('orch_claude_role_prepare',args)).data;
  assert.equal(generated.sha256,digest(await readFile(join(f.root,generated.path),'utf8')));
  assert.match(await readFile(join(f.root,generated.path),'utf8'),/Implement only the assigned worktree task/);
  assert.equal(await git(f.root,'check-ignore',generated.path),generated.path);
  assert.equal((await call('orch_claude_role_prepare',args)).data.sha256,generated.sha256);
  assert.equal(await readFile(join(f.root,'.orch/config.yaml'),'utf8'),configText);
  assert.equal((await call('orch_claude_role_prepare',{...args,expected_hash:'bad'})).error?.code,'CONFIG_CONFLICT');
 }finally{await client.close();await server.close();await f.close()}
});

test('generated reviewer definitions preserve read-only tools, dry-run purity and safe project boundaries',async()=>{
 const {prepareClaudeRoleDefinition,verifyClaudeRoleDefinitions}=await import('../../packages/core/src/runtime/host-claude.ts');
 const {symlink,access,readFile}=await import('node:fs/promises');
 const f=await fixture();try{
  const commonDir=join(f.root,'git-common');await mkdir(commonDir);
  await rm(join(f.root,'.claude'),{recursive:true});
  const input={originRoot:f.root,commonDir,role:'reviewer' as const,model:'claude-opus-5-5',effort:'high',dryRun:true};
  const preview=prepareClaudeRoleDefinition(input);assert.equal(preview.agentsDirectoryExisted,false);
  await assert.rejects(access(join(f.root,'.claude')));await assert.rejects(access(join(commonDir,'info')));
  await symlink(commonDir,join(f.root,'.claude'));
  assert.throws(()=>prepareClaudeRoleDefinition({...input,dryRun:false}),/CLAUDE_ROLE_DEFINITION_INVALID/);
  await rm(join(f.root,'.claude'));
  const prepared=prepareClaudeRoleDefinition({...input,dryRun:false});
  const bytes=await readFile(join(f.root,prepared.path),'utf8');
  assert.match(bytes,/tools: Read, Grep, Glob/);assert.match(bytes,/Independently review/);
  assert.equal(await readFile(join(commonDir,'info/exclude'),'utf8'),`/${prepared.path}\n`);
  const {originRoot:_root,agentsDirectoryExisted:_existed,reloadHint:_hint,dryRun:_dry,...receipt}=prepared;
  verifyClaudeRoleDefinitions(f.root,[{...receipt,loaded:{nativeAgentId:'fixture-review-probe',sha256:prepared.sha256}}]);
  const config=resolveConfig({project:{hosts:{claude:{roles:{reviewer:{model:input.model,effort:'high'}}}}}}).config;
  const native={...f.native,claudeRoleDefinitions:[{...receipt,loaded:{nativeAgentId:'fixture-review-probe',sha256:prepared.sha256}}]};
  assert.deepEqual(resolveRoleModel({config,host:'claude',role:'reviewer',native}).nativeArguments,{subagent_type:prepared.name});
  config.hosts.claude.roles.final_auditor={model:input.model,effort:'high'};
  assert.throws(()=>resolveRoleModel({config,host:'claude',role:'final_auditor',native}),/CLAUDE_ROLE_DEFINITION_MISMATCH/);
  const modified=bytes.replace('tools: Read, Grep, Glob','tools: Read, Write');
  await writeFile(join(f.root,prepared.path),modified);
  assert.throws(()=>verifyClaudeRoleDefinitions(f.root,[{...receipt,sha256:digest(modified),loaded:{nativeAgentId:'fixture-review-probe',sha256:digest(modified)}}]),/CLAUDE_ROLE_DEFINITION_MISMATCH/);
 }finally{await f.close()}
});

test('verified definitions never override explicit current-host access or support denials',async()=>{
 const model={host:'claude' as const,id:'claude-opus-5-5',displayName:'fixture',resolvedId:null,family:'claude' as const,support:'advertised' as const,access:'unknown' as const,availability:'unknown' as const,efforts:['high'],defaultEffort:'high',hidden:false,source:'fixture',sourceVersion:null,fetchedAt:new Date().toISOString(),expiresAt:null,evidence:[{kind:'fixture',ref:'fixture:host'}]};
 const f=await fixture();try{
  for(const [change,error] of [[{support:'unsupported'},/MODEL_NOT_SUPPORTED/],[{access:'denied'},/MODEL_ACCESS_DENIED/],[{availability:'unavailable'},/MODEL_UNAVAILABLE/]] as const){
   const native={...f.native,models:[{...model,host:'claude' as const,family:'claude' as const,id:f.receipt.model,...change}]};
   assert.throws(()=>resolveRoleModel({config:f.config,host:'claude',role:'coder',native}),error);
  }
  assert.throws(()=>resolveRoleModel({config:f.config,host:'claude',role:'coder',native:{...f.native,claudeRoleDefinitions:[{...f.receipt,path:'../outside.md'}]}}),/CLAUDE_ROLE_DEFINITION_MISMATCH/);
 }finally{await f.close()}
});
