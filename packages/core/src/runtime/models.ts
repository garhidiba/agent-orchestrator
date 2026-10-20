import { z } from 'zod';
import { roleIds, type Config } from '../../../protocol/src/config.ts';
import { requireCondition as check, recommendationSchema } from '../../../protocol/src/runtime.ts';
import { claudeRoleDefinitionSchema, verifyClaudeRoleDefinitions } from './host-claude.ts';
import { modelSchema, type Model } from '../model-registry/index.ts';
export type RoleId = typeof roleIds[number];
// Only the authenticated coordinator may construct this from the current host tool receipt.
export const nativeModelContextSchema = z.strictObject({
 host:z.enum(['codex','claude']),verified:z.boolean(),contextMatches:z.boolean(),evidence:z.array(z.string().min(1)),
 perInvocationModel:z.boolean().optional(),perInvocationEffort:z.boolean().optional(),
 invocationModelIds:z.array(z.string().min(1).max(256)).max(256).optional(),
 model:z.string().min(1).nullable(),effort:z.string().min(1).nullable(),models:z.array(modelSchema).optional(),
 claudeRoleDefinitions:z.array(claudeRoleDefinitionSchema).max(roleIds.length).optional(),
});
export type NativeModelContext = z.infer<typeof nativeModelContextSchema> & {claudeDefinitionRoot?:string};
const automatic = (value: string) => value === 'auto' || value === 'inherit';
export function supportedModel(host: NativeModelContext['host'], value: Model, now: number) {
 const model=modelSchema.parse(value);
 check(model.host===host && model.family===(host==='codex'?'openai':'claude') && model.support!=='unsupported','MODEL_NOT_SUPPORTED');
 check(model.access!=='denied','MODEL_ACCESS_DENIED');
 check(!['rate_limited','unavailable'].includes(model.availability),'MODEL_UNAVAILABLE');
 check(model.expiresAt===null || Date.parse(model.expiresAt)>now,'CATALOG_EXPIRED');
 check(model.defaultEffort===null || model.efforts===null || model.efforts.includes(model.defaultEffort),'EFFORT_METADATA_INVALID');
 return model;
}
export function resolveRoleModel(input: {config:Config;host:NativeModelContext['host'];role:RoleId;native:NativeModelContext;now?:number}) {
 const {config,host,role,native}=input, requested=config.hosts[host].roles[role];
 check(config.hosts[host].enabled && native.verified && native.contextMatches && native.host===host && native.evidence.length>0,'BLOCKED_CAPABILITY');
 const modelId=automatic(requested.model)?native.model:requested.model;
 const descriptor=modelId===null?undefined:native.models?.find(model=>model.id===modelId);
 const model=descriptor?supportedModel(host,descriptor,input.now??Date.now()):undefined;
 let effort=requested.effort==='inherit'?native.effort:requested.effort==='auto'?(model?.defaultEffort??null):requested.effort;
 const inheritedEffortMatch=automatic(requested.model) && native.effort!==null && requested.effort===native.effort;
 const needsModel=!automatic(requested.model), needsEffort=effort!==null && requested.effort!=='inherit' && !inheritedEffortMatch;
 if(!automatic(requested.effort) && model?.efforts!==null && model?.efforts!==undefined) check(model.efforts.includes(requested.effort),'EFFORT_NOT_SUPPORTED');
 const directModel=native.perInvocationModel && (!native.invocationModelIds || native.invocationModelIds.includes(requested.model));
 const nativeArguments:{model?:string;reasoning_effort?:string;subagent_type?:string}={};
 const definitionRoute=host==='claude' && (needsModel&&!directModel || needsEffort&&!native.perInvocationEffort || needsModel&&!descriptor);
 if(definitionRoute) {
  check(native.claudeDefinitionRoot && native.claudeRoleDefinitions?.length,'CLAUDE_ROLE_DEFINITION_REQUIRED');
  const definition=verifyClaudeRoleDefinitions(native.claudeDefinitionRoot,native.claudeRoleDefinitions).find(value=>value.role===role);
  check(definition && definition.model===modelId && definition.effort===effort,'CLAUDE_ROLE_DEFINITION_MISMATCH');
  nativeArguments.subagent_type=definition.name;
 } else {
  // Inheritance needs no invented catalog entry; direct pins need current-host metadata.
  if(needsModel) check(descriptor,'MODEL_NOT_SUPPORTED');
  if(!automatic(requested.effort) && !inheritedEffortMatch) check(model?.efforts?.includes(requested.effort),'EFFORT_NOT_SUPPORTED');
  if(model?.efforts?.length===0) effort=null;
  if(needsModel) {check(directModel,'BLOCKED_CAPABILITY');nativeArguments.model=requested.model;}
  if(needsEffort && effort!==null) {check(native.perInvocationEffort,'BLOCKED_CAPABILITY');nativeArguments.reasoning_effort=effort;}
 }
 return {requestedModel:requested.model,requestedEffort:requested.effort,resolvedModel:modelId,resolvedEffort:effort,
 observedModel:null,observedEffort:null,nativeArguments,status:'pending_observation' as const,
 reasons:[automatic(requested.model)?'Parent model inherited; undisclosed identity remains unknown':definitionRoute?'Verified named Claude project definition selected':'Current-host model option selected', 'Actual application requires host observation']};
}

export type ModelAssessment={modelId:string;quality?:number;latencyMs?:number;usage?:number;evidenceRefs:string[]};
export function recommendModels(config:Config,host:NativeModelContext['host'],catalog:Model[],options:{
 profile?:Config['model_selection']['profile'];scope?:'global'|'project'|'session';configRevision?:number;
 defaultModelId?:string|null;assessments?:ModelAssessment[];now?:number;
}={}) {
 const profile=options.profile??config.model_selection.profile, now=options.now??Date.now();
 const candidates=catalog.filter(value=>{try{supportedModel(host,value,now);return !value.hidden}catch{return false}});
 const assessments=(options.assessments??[]).filter(a=>a.evidenceRefs.length && [a.quality,a.latencyMs,a.usage].every(n=>n===undefined || Number.isFinite(n)&&n>=0));
 const metric=profile==='quality'?'quality':profile==='fast'?'latencyMs':profile==='economy'?'usage':null;
 const measured=metric?assessments.filter(a=>a[metric]!==undefined && candidates.some(m=>m.id===a.modelId)).sort((a,b)=>metric==='quality'?b[metric]!-a[metric]!:a[metric]!-b[metric]!):[];
 const chosen=candidates.find(m=>m.id===measured[0]?.modelId)??candidates.find(m=>m.id===options.defaultModelId);
 const selections: {role:RoleId;modelId:string;effort:string|null;reasons:string[];evidenceRefs:string[];confidence:'low'|'medium'|'high'}[]=[], preservedOverrides:string[]=[], proposedPatch:{op:'replace';path:string;value:string}[]=[];
 for(const role of roleIds){
  const policy=config.hosts[host].roles[role];
  if(!automatic(policy.model)) preservedOverrides.push(`/hosts/${host}/roles/${role}/model`);
  if(!automatic(policy.effort)) preservedOverrides.push(`/hosts/${host}/roles/${role}/effort`);
  if(policy.model!=='auto'||!chosen) continue;
  const selectedEffort=automatic(policy.effort)?chosen.defaultEffort:policy.effort;
  if(selectedEffort!==null && !chosen.efforts?.includes(selectedEffort)) continue;
  selections.push({role,modelId:chosen.id,effort:selectedEffort,reasons:[measured.length?`${profile} selected from measured ${metric}`:'Verified host default; comparative quality, cost and latency unknown'],evidenceRefs:[...chosen.evidence.map(e=>e.ref),...(measured[0]?.evidenceRefs??[])],confidence:measured.length?'medium':'low'});
  proposedPatch.push({op:'replace',path:`/hosts/${host}/roles/${role}/model`,value:chosen.id});
  if(policy.effort==='auto' && selectedEffort!==null) proposedPatch.push({op:'replace',path:`/hosts/${host}/roles/${role}/effort`,value:selectedEffort});
 }
 return recommendationSchema.parse({scope:options.scope??'project',host,configRevision:options.configRevision??0,proposedPatch,selections,preservedOverrides,warnings:chosen?['Account access and actual application remain separate from advertised metadata']:['No verified host default or comparative evidence; no new model selected'],requiresApproval:true});
}

export function observeRoleModel(resolution:{requestedModel:string;requestedEffort:string;resolvedModel:string|null;resolvedEffort:string|null}, observation:{model:string|null;effort:string|null},catalog:Model[]=[]) {
 const actualModel=observation.model,actualEffort=observation.effort;
 check([actualModel,actualEffort].every(value=>value===null || typeof value==='string' && value.trim().length>0 && !/[\x00\r\n]/.test(value)),'MODEL_OBSERVATION_INVALID');
 const descriptor=catalog.find(model=>model.id===resolution.resolvedModel), concrete=descriptor?.resolvedId;
 const expected=concrete??resolution.resolvedModel;
 const modelComparison=actualModel===null || expected===null?'unknown':actualModel===expected || actualModel===resolution.resolvedModel?'matches':concrete || !descriptor?'differs':'unknown';
 const effortComparison=actualEffort===null || resolution.resolvedEffort===null?'unknown':actualEffort===resolution.resolvedEffort?'matches':'differs';
 return {observedModel:actualModel,observedEffort:actualEffort,modelComparison,effortComparison,
 policyViolation:modelComparison==='differs',
 status:actualModel===null && actualEffort===null?'unknown':modelComparison==='differs'||effortComparison==='differs'?'effective_differs':'observed'};
}
