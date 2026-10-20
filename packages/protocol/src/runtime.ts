import { z } from 'zod';
import { roleIds } from './config.ts';

export const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/);
export const nativeAgentId = z.string().min(1).max(256).regex(/^[^\x00-\x1f\x7f]+$/).refine(value => value.trim().length > 0, 'Empty native identity');
export const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const relativePath = z.string().min(1).regex(/^(?![\\/])(?![A-Za-z]:)(?!.*(?:^|[\\/])\.{1,2}(?:[\\/]|$))[^\x00-\x1f\x7f]*$/);
export const taskSchema = z.strictObject({
  id, title: z.string().min(1), role: z.enum(roleIds).exclude(['coordinator', 'reviewer', 'final_auditor']),
  depends_on: z.array(id), acceptance_ids: z.array(id).min(1),
  read_paths: z.array(relativePath), write_paths: z.array(relativePath).min(1),
  exclusive_resources: z.array(id), risk: z.enum(['low', 'medium', 'high']),
  complexity: z.enum(['low', 'medium', 'high']), verification_ids: z.array(id).min(1),
  commit_units: z.array(z.strictObject({ id, purpose: z.string().min(1) })).min(1),
});
export const planSchema = z.strictObject({
  acceptance: z.array(z.strictObject({ id, text: z.string().min(1) })).min(1),
  tasks: z.array(taskSchema).min(1),
});
export const planAmendmentSchema = z.strictObject({
  plan: planSchema, approved: z.literal(true), reason: z.string().trim().min(1).max(4096),
});
export const findingSchema = z.strictObject({
  id, severity: z.enum(['critical', 'high', 'medium', 'low']), category: z.string().min(1),
  path: relativePath, symbol: z.string().min(1), line_start: z.int().positive(), line_end: z.int().positive(),
  summary: z.string().min(1), evidence: z.string().min(1), reproduction: z.string().min(1),
  acceptance: z.string().min(1), suggested_test: z.string().min(1), acceptance_ids: z.array(id).min(1),
  status: z.literal('open'),
});
export const hostHeartbeatSchema = z.strictObject({
  source: z.enum(['host_status', 'host_event']), status: z.literal('running'),
  observedAt: z.number().finite().nonnegative(), evidenceRef: z.string().trim().min(1).max(4096),
});
export const findingDispositionSchema = z.strictObject({
  finding_id: id, status: z.enum(['ACCEPTED_RISK', 'NOT_A_BUG', 'DEFERRED']),
  reason: z.string().trim().min(1).max(4096), approved: z.literal(true),
});
export const reviewSchema = z.strictObject({
  schema_version: z.literal(1), reviewed_sha: sha, reviewer_id: nativeAgentId,
  decision: z.enum(['approved', 'changes_requested']), findings: z.array(findingSchema),
  reviewed_areas: z.array(z.string().min(1)).min(1), limitations: z.array(z.string()),
  acceptance_ids: z.array(id).min(1),
});
export const envelopeSchema = z.strictObject({
  protocol_version: z.literal(1), run_id: id, operation_id: id,
  expected_state_version: z.int().nonnegative(), lease_id: id.optional(),
  fencing_token: z.int().positive().optional(), input: z.unknown(),
}).refine(value => (value.lease_id === undefined) === (value.fencing_token === undefined), 'Lease and fencing token must be paired')
  .refine(value => Object.hasOwn(value, 'input'), 'Input is required');

const text = z.string().trim().min(1);
const texts = z.array(text);
const acceptanceSchema = z.strictObject({ id, text });
const unique = (values: string[]) => new Set(values).size === values.length;
export const requirementsSchema = z.strictObject({
  schema_version: z.literal(1), goals: texts.min(1), in_scope: texts.min(1), out_of_scope: texts,
  acceptance: z.array(acceptanceSchema).min(1), constraints: texts, assumptions: texts, risks: texts,
  verification_plan: z.array(z.strictObject({ acceptance_id: id, method: text })).min(1),
}).refine(value => unique(value.acceptance.map(item => item.id)), 'Duplicate acceptance ID')
  .refine(value => value.verification_plan.every(item => value.acceptance.some(criterion => criterion.id === item.acceptance_id)) &&
    value.acceptance.every(item => value.verification_plan.some(method => method.acceptance_id === item.id)), 'Unmapped acceptance');

export const taskResultSchema = z.strictObject({
  schemaVersion: z.literal(1), runId: id, taskId: id, attemptId: id,
  status: z.enum(['ready_for_validation', 'blocked', 'failed']), baseSha: sha,
  worktreePath: text.regex(/^[^\x00-\x1f\x7f]+$/),
  completedUnits: z.array(z.strictObject({ unitId: id, commitSha: sha })), changedPaths: z.array(relativePath),
  acceptanceEvidence: z.array(z.strictObject({ acceptanceId: id, evidenceRefs: texts.min(1) })),
  gateResultIds: z.array(id), reportedModel: text.nullable(), remainingIssues: texts, summary: text,
}).refine(value => unique(value.completedUnits.map(unit => unit.unitId)) && unique(value.changedPaths) &&
  unique(value.acceptanceEvidence.map(item => item.acceptanceId)) && unique(value.gateResultIds), 'Duplicate result reference');

export const gateResultSchema = z.strictObject({
  id, runId: id, taskId: id.nullable(), gateId: id,
  stage: z.enum(['baseline', 'task', 'integration', 'final']), commitSha: sha.nullable(),
  sourceFingerprint: text, commandFingerprint: text, environmentFingerprint: text,
  status: z.enum(['passed', 'failed', 'timed_out', 'not_run', 'waived']), exitCode: z.int().nullable(),
  startedAt: z.iso.datetime({ offset: true }), finishedAt: z.iso.datetime({ offset: true }),
  logRef: text, waiverReason: text.nullable(),
}).refine(value => Date.parse(value.finishedAt) >= Date.parse(value.startedAt), 'Gate time reversed')
  .refine(value => value.status !== 'passed' || value.exitCode === 0, 'Passed gate needs successful exit')
  .refine(value => !['not_run', 'waived'].includes(value.status) || value.exitCode === null, 'Unrun gate cannot have an exit code')
  .refine(value => value.status !== 'waived' || value.waiverReason !== null, 'Waiver reason required');

const pointer = z.string().regex(/^\/(?:[^~\x00-\x1f]|~[01])+$/)
  .refine(value => !value.split('/').slice(1).some(part => ['__proto__', 'prototype', 'constructor', '.', '..', ''].includes(part)), 'Unsafe patch path');
const patchSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('add'), path: pointer, value: z.json() }),
  z.strictObject({ op: z.literal('replace'), path: pointer, value: z.json() }),
  z.strictObject({ op: z.literal('remove'), path: pointer }),
]);
export const recommendationSchema = z.strictObject({
  scope: z.enum(['global', 'project', 'session']), host: z.enum(['codex', 'claude']), configRevision: z.int().nonnegative(),
  proposedPatch: z.array(patchSchema), selections: z.array(z.strictObject({
    role: z.enum(roleIds), modelId: text, effort: text.nullable(), reasons: texts.min(1), evidenceRefs: texts,
    confidence: z.enum(['low', 'medium', 'high']),
  })), preservedOverrides: texts, warnings: texts, requiresApproval: z.boolean(),
}).refine(value => value.proposedPatch.every(patch => {
  const parts = patch.path.split('/');
  return parts[1] !== 'hosts' || (parts.length > 3 && parts[2] === value.host);
}), 'Cross-host patch forbidden')
  .refine(value => unique(value.selections.map(selection => selection.role)), 'Duplicate role selection');
export type Requirements = z.infer<typeof requirementsSchema>;
export type TaskResult = z.infer<typeof taskResultSchema>;
export type GateResult = z.infer<typeof gateResultSchema>;
export type Recommendation = z.infer<typeof recommendationSchema>;

export type Task = z.infer<typeof taskSchema>;
export type Plan = z.infer<typeof planSchema>;
export type Review = z.infer<typeof reviewSchema>;
export type Envelope = z.infer<typeof envelopeSchema>;

export class OrchError extends Error {
  code: string;
  constructor(code: string) { super(code); this.code = code; }
}
export function requireCondition(value: unknown, code: string): asserts value {
  if (!value) throw new OrchError(code);
}
export function validatePlan(input: unknown): Plan {
  const plan = planSchema.parse(input);
  const tasks = new Map(plan.tasks.map(task => [task.id, task]));
  const acceptance = new Set(plan.acceptance.map(item => item.id));
  requireCondition(tasks.size === plan.tasks.length && acceptance.size === plan.acceptance.length, 'DUPLICATE_ID');
  const visiting = new Set<string>(), visited = new Set<string>();
  function visit(task: Task) {
    requireCondition(!visiting.has(task.id), 'DAG_CYCLE');
    if (visited.has(task.id)) return;
    visiting.add(task.id);
    for (const dependency of task.depends_on) {
      const parent = tasks.get(dependency);
      requireCondition(parent, 'UNKNOWN_DEPENDENCY');
      visit(parent);
    }
    visiting.delete(task.id); visited.add(task.id);
  }
  for (const task of plan.tasks) {
    requireCondition(unique(task.depends_on), 'DUPLICATE_DEPENDENCY');
    requireCondition(unique(task.acceptance_ids), 'DUPLICATE_ACCEPTANCE');
    requireCondition(unique(task.verification_ids), 'DUPLICATE_VERIFICATION');
    requireCondition(task.acceptance_ids.every(key => acceptance.has(key)), 'UNKNOWN_ACCEPTANCE');
    requireCondition(new Set(task.commit_units.map(unit => unit.id)).size === task.commit_units.length, 'DUPLICATE_UNIT');
    visit(task);
  }
  requireCondition([...acceptance].every(key => plan.tasks.some(task => task.acceptance_ids.includes(key))), 'UNMAPPED_ACCEPTANCE');
  return plan;
}
