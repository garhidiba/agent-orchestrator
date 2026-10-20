import { z } from 'zod';

export const roleIds = ['coordinator', 'requirements', 'planner', 'coder', 'tester', 'reviewer', 'repair', 'final_auditor'] as const;
const roleId = z.enum(roleIds);
const text = z.string().trim().min(1).regex(/^[^\x00\r\n]+$/);
const positive = z.int().positive();
const role = z.strictObject({ model: text, effort: text });
const host = z.strictObject({ enabled: z.boolean(), roles: z.record(roleId, role) });
const command = z.strictObject({
  id: text, executable: text, args: z.array(z.string().regex(/^[^\x00]*$/)),
  cwd: z.string().min(1).regex(/^(?![\\/])(?![A-Za-z]:)(?!.*(?:^|[\\/])\.\.(?:[\\/]|$))[^\x00]*$/),
  stages: z.array(z.enum(['baseline', 'task', 'integration', 'final'])).min(1),
  required: z.boolean(), timeout_seconds: positive,
});
const modelSelection = z.strictObject({
  profile: z.enum(['balanced', 'quality', 'economy', 'fast']),
  allow_cross_host: z.literal(false), allow_unverified_models: z.literal(false),
  catalog_cache_ttl_hours: positive, on_model_unavailable: z.literal('pause'),
  on_catalog_change: z.literal('recommend_only'),
});
const execution = z.strictObject({
  mode: z.literal('interactive_native'), max_parallel_workers: positive,
  max_parallel_test_jobs: positive, max_task_attempts: positive,
  max_review_rounds: z.int().nonnegative(), max_repeated_finding_rounds: positive,
  task_timeout_minutes: positive, run_timeout_minutes: positive,
  on_host_disconnect: z.literal('pause_and_preserve'),
});
const planning = z.strictObject({ require_approval: z.boolean(), preserve_user_overrides: z.literal(true) });
const git = z.strictObject({
  target_branch: text.nullable(), integration_prefix: text,
  merge_strategy: z.literal('merge_no_ff'), commit_policy: z.literal('atomic_unit'),
  finalization: z.enum(['approval_required', 'auto_on_success']),
  remote_push: z.literal(false), dirty_checkout_policy: z.literal('stop'),
});
const review = z.strictObject({
  required: z.literal(true), block_on: z.array(z.enum(['critical', 'high', 'medium', 'low'])).min(1),
  independent_session: z.literal(true), final_audit: z.literal(true), unresolved_nonblocking: z.literal('report'),
});
const quality = z.strictObject({
  baseline_required: z.literal(true), commands: z.array(command), allow_missing_tests: z.boolean(),
});
const cleanup = z.strictObject({
  on_success: z.literal('owned_merged_clean_only'), on_failure: z.literal('preserve'),
  keep_reports: z.literal(true), keep_integration_until_finalized: z.literal(true),
});
const observability = z.strictObject({
  telemetry: z.literal('off'), store_raw_prompts: z.literal(false), redact_secrets: z.literal(true),
});

export const configSchema = z.strictObject({
  schema_version: z.literal(1), model_selection: modelSelection,
  hosts: z.strictObject({ codex: host, claude: host }), execution, planning, git, review, quality, cleanup, observability,
});
const hostPatch = host.partial().extend({ roles: z.partialRecord(roleId, role.partial()).optional() });
export const configPatchSchema = configSchema.partial().extend({
  hosts: z.strictObject({ codex: hostPatch.optional(), claude: hostPatch.optional() }).optional(),
  model_selection: modelSelection.partial().optional(), execution: execution.partial().optional(),
  planning: planning.partial().optional(), git: git.partial().optional(), review: review.partial().optional(),
  quality: quality.partial().optional(), cleanup: cleanup.partial().optional(), observability: observability.partial().optional(),
});
export type Config = z.infer<typeof configSchema>;
export type ConfigPatch = z.infer<typeof configPatchSchema>;
