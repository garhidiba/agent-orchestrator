import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, mkdirSync, writeFileSync, appendFileSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { roleIds } from '../../../protocol/src/config.ts';
import { nativeAgentId, requireCondition as check } from '../../../protocol/src/runtime.ts';

const text = z.string().min(1).max(256).regex(/^[^\x00-\x1f\x7f]+$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const claudeRoleDefinitionSchema = z.strictObject({
 role:z.enum(roleIds), name:z.string().max(96).regex(/^orch-[a-z_]+-p[a-f0-9]{16}$/),
 path:z.string().max(128), sha256, model:text, effort:text.nullable(),
 loaded:z.strictObject({nativeAgentId,sha256}),
});
export type ClaudeRoleDefinition = z.infer<typeof claudeRoleDefinitionSchema>;
const digest = (value:string|Buffer) => createHash('sha256').update(value).digest('hex');

// Recheck immutable bytes at dispatch as files can change after the authenticated refresh.
export function verifyClaudeRoleDefinitions(originRoot:string, values:ClaudeRoleDefinition[]) {
 const definitions=z.array(claudeRoleDefinitionSchema).max(roleIds.length).parse(values);
 check(new Set(definitions.map(value=>value.role)).size===definitions.length,'CLAUDE_ROLE_DEFINITION_MISMATCH');
 check(realpathSync(originRoot)===originRoot,'CLAUDE_ROLE_DEFINITION_INVALID');
 for(const definition of definitions) {
  const name=`orch-${definition.role}-p${digest(JSON.stringify({originRoot,role:definition.role,model:definition.model,effort:definition.effort})).slice(0,16)}`;
  check(definition.name===name && definition.path===`.claude/agents/${name}.md`,'CLAUDE_ROLE_DEFINITION_MISMATCH');
  check(definition.loaded.sha256===definition.sha256,'NEEDS_RELOAD');
  try {
   for(const path of [join(originRoot,'.claude'),join(originRoot,'.claude/agents')]) {
    const stat=lstatSync(path);check(stat.isDirectory()&&!stat.isSymbolicLink(),'CLAUDE_ROLE_DEFINITION_INVALID');
   }
   const bytes=safeRead(join(originRoot,definition.path),16384);
   check(bytes.length<=16384 && digest(bytes)===definition.sha256,'CLAUDE_ROLE_DEFINITION_STALE');
   const match=/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*\S[\s\S]*)$/.exec(bytes.toString('utf8'));
   check(match,'CLAUDE_ROLE_DEFINITION_INVALID');
   const metadata=z.strictObject({name:text,description:z.string().min(1).max(1024),model:text,effort:text.optional(),tools:z.string().optional()}).parse(parse(match[1],{maxAliasCount:0}));
   check(metadata.tools===(['reviewer','final_auditor'].includes(definition.role)?'Read, Grep, Glob':undefined),'CLAUDE_ROLE_DEFINITION_MISMATCH');
   check(metadata.name===name&&metadata.model===definition.model&&(metadata.effort??null)===definition.effort,'CLAUDE_ROLE_DEFINITION_MISMATCH');
  }catch(error){
   if(error instanceof Error && /^CLAUDE_ROLE_DEFINITION_[A-Z_]+$/.test(error.message)) throw error;
   throw new Error('CLAUDE_ROLE_DEFINITION_INVALID');
  }
 }
 return definitions;
}

function safeDirectory(path:string, create:boolean) {
 try{const stat=lstatSync(path);check(stat.isDirectory()&&!stat.isSymbolicLink(),'CLAUDE_ROLE_DEFINITION_INVALID');return true;}
 catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;if(create)mkdirSync(path);return false;}
}
function safeRead(path:string,limit:number) {
 let fd:number;
 try{fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')throw error;throw new Error('CLAUDE_ROLE_DEFINITION_INVALID');}
 try{
  const stat=fstatSync(fd);check(stat.isFile()&&stat.size<=limit,'CLAUDE_ROLE_DEFINITION_INVALID');
  const bytes=Buffer.alloc(limit+1);let length=0,count:number;
  while(length<bytes.length&&(count=readSync(fd,bytes,length,bytes.length-length,null))>0)length+=count;
  check(length<=limit,'CLAUDE_ROLE_DEFINITION_INVALID');return bytes.subarray(0,length);
 }finally{closeSync(fd);}
}

export function prepareClaudeRoleDefinition(input:{originRoot:string;commonDir:string;role:typeof roleIds[number];model:string;effort:string|null;dryRun:boolean}) {
 const {originRoot,commonDir,role,model,effort,dryRun}=input;
 text.parse(model);if(effort!==null)text.parse(effort);z.enum(roleIds).parse(role);
 check(realpathSync(originRoot)===originRoot&&realpathSync(commonDir)===commonDir,'CLAUDE_ROLE_DEFINITION_INVALID');
 const name=`orch-${role}-p${digest(JSON.stringify({originRoot,role,model,effort})).slice(0,16)}`,path=`.claude/agents/${name}.md`;
 const template=readFileSync(new URL(`../../../../templates/claude/plugin/agents/orch-${role.replaceAll('_','-')}.md`,import.meta.url),'utf8');
 const content=template.replace(/^name: .*$/m,`name: ${name}`).replace(/\n---\n/,`\nmodel: ${JSON.stringify(model)}${effort===null?'':`\neffort: ${JSON.stringify(effort)}`}\n---\n`);
 safeDirectory(join(originRoot,'.claude'),!dryRun);
 const agentsDirectoryExisted=safeDirectory(join(originRoot,'.claude/agents'),!dryRun);
 const info=join(commonDir,'info');safeDirectory(info,!dryRun);
 const excludePath=join(info,'exclude');let exclude='';
 try{exclude=safeRead(excludePath,1024*1024).toString('utf8');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 try{check(safeRead(join(originRoot,path),16384).toString('utf8')===content,'CLAUDE_ROLE_DEFINITION_CONFLICT');}
 catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 if(!dryRun){
  const entry=`/${path}`;
  if(!exclude.split(/\r?\n/).includes(entry)){
   const fd=openSync(excludePath,constants.O_WRONLY|constants.O_APPEND|constants.O_CREAT|constants.O_NOFOLLOW,0o600);
   try{check(fstatSync(fd).isFile(),'CLAUDE_ROLE_DEFINITION_INVALID');appendFileSync(fd,`${exclude&&!exclude.endsWith('\n')?'\n':''}${entry}\n`);}finally{closeSync(fd);}
  }
  try{writeFileSync(join(originRoot,path),content,{flag:'wx',mode:0o600});}
  catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  check(safeRead(join(originRoot,path),16384).toString('utf8')===content,'CLAUDE_ROLE_DEFINITION_CONFLICT');
 }
 return {originRoot,role,name,path,sha256:digest(content),model,effort,agentsDirectoryExisted,reloadHint:agentsDirectoryExisted?'WATCH_OR_PROBE':'RELOAD_MAY_BE_REQUIRED',dryRun};
}
