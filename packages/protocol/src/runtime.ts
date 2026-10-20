import { z } from 'zod';
import { roleIds } from './config.ts';

export const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/);
export const sha = z.string().regex(/^[a-f0-9]{40,64}$/);
export const relativePath = z.string().min(1).regex(/^(?![\\/])(?![A-Za-z]:)(?!.*(?:^|[\\/])\.\.(?:[\\/]|$))[^\x00\r\n]*$/);
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
export const findingSchema = z.strictObject({
  id, severity: z.enum(['critical', 'high', 'medium', 'low']), category: z.string().min(1),
  path: relativePath, symbol: z.string().min(1), line_start: z.int().positive(), line_end: z.int().positive(),
  summary: z.string().min(1), evidence: z.string().min(1), reproduction: z.string().min(1),
  acceptance: z.string().min(1), suggested_test: z.string().min(1), acceptance_ids: z.array(id).min(1),
  status: z.literal('open'),
});
export const reviewSchema = z.strictObject({
  schema_version: z.literal(1), reviewed_sha: sha, reviewer_id: id,
  decision: z.enum(['approved', 'changes_requested']), findings: z.array(findingSchema),
  reviewed_areas: z.array(z.string().min(1)).min(1), limitations: z.array(z.string()),
  acceptance_ids: z.array(id).min(1),
});
export const envelopeSchema = z.strictObject({
  protocol_version: z.literal(1), run_id: id, operation_id: id,
  expected_state_version: z.int().nonnegative(), input: z.unknown(),
});
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
    requireCondition(task.acceptance_ids.every(key => acceptance.has(key)), 'UNKNOWN_ACCEPTANCE');
    requireCondition(new Set(task.commit_units.map(unit => unit.id)).size === task.commit_units.length, 'DUPLICATE_UNIT');
    visit(task);
  }
  requireCondition([...acceptance].every(key => plan.tasks.some(task => task.acceptance_ids.includes(key))), 'UNMAPPED_ACCEPTANCE');
  return plan;
}
