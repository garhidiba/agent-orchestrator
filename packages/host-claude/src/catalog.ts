import {z} from 'zod';
import type {Model} from '../../core/src/model-registry/index.ts';
const metadata=z.array(z.object({value:z.string().min(1),displayName:z.string(),description:z.string().optional(),supportsEffort:z.boolean().optional(),supportedEffortLevels:z.array(z.string().min(1)).optional(),defaultEffort:z.string().nullable().optional()})).max(1000);
// Supply an existing official SDK session's metadata method; never start an inference/controller here.
export type ClaudeMetadataAdapter={supportedModels:()=>Promise<unknown>;providerFamily:'claude'|'unknown';sourceVersion:string|null;evidenceRef:string};
export async function discoverClaudeModels(adapter?:ClaudeMetadataAdapter):Promise<{status:'partial';models:Model[];contextMatches:false;reason?:string}> {
 if(!adapter)return {status:'partial',models:[],contextMatches:false,reason:'NATIVE_MODEL_METADATA_UNAVAILABLE'};
 const parsed=metadata.safeParse(await adapter.supportedModels());
 if(!parsed.success || !adapter.evidenceRef || !['claude','unknown'].includes(adapter.providerFamily)) throw new Error('CLAUDE_METADATA_INVALID');
 const seen=new Set<string>(),fetchedAt=new Date().toISOString();
 const models=parsed.data.map(entry=>{
  if(seen.has(entry.value) || entry.supportsEffort===false && (entry.supportedEffortLevels?.length || entry.defaultEffort) || entry.defaultEffort && entry.supportedEffortLevels && !entry.supportedEffortLevels.includes(entry.defaultEffort))throw new Error('CLAUDE_METADATA_INVALID');
  seen.add(entry.value);
  return {host:'claude' as const,id:entry.value,displayName:entry.displayName,resolvedId:null,family:adapter.providerFamily,support:'advertised' as const,access:'unknown' as const,availability:'unknown' as const,efforts:entry.supportsEffort===false?[]:entry.supportedEffortLevels??null,defaultEffort:entry.defaultEffort??null,hidden:false,source:'Claude Agent SDK supportedModels()',sourceVersion:adapter.sourceVersion,fetchedAt,expiresAt:new Date(Date.parse(fetchedAt)+86400000).toISOString(),evidence:[{kind:'metadata',ref:adapter.evidenceRef}]};
 });
 return {status:'partial',models,contextMatches:false};
}
