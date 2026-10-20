export type SemanticEvent = { type: string; payload: unknown };
type TaskState = { state: string; attempt: number; nativeId?: string | null; expires?: number; modelResolution?: unknown; observedModel?: string | null; observedEffort?: string | null; units?: Record<string, string>; heartbeat?: unknown };
type EvidenceState = { state?: string; configRevision?: number; tasks?: Record<string, TaskState>; findings?: { id: string; lifecycle: string }[]; reviews?: { reviewer: string; sha: string; final: boolean }[]; gates?: { status: string; task: string | null }[]; cleanup?: { path: string; status: string; reason: string | null }[] };
const changed = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b);

// Emit only recorded facts; eligibility, host status and model access are not inferred from silence.
export function transitionEvents(previous: unknown, current: unknown): SemanticEvent[] {
  const before = (previous && typeof previous === 'object' ? previous : {}) as EvidenceState;
  const after = (current && typeof current === 'object' ? current : {}) as EvidenceState, events: SemanticEvent[] = [];
  const add = (type: string, payload: unknown) => events.push({ type, payload });
  if (before.state !== after.state) {
    add('run.state_changed', { from: before.state ?? null, to: after.state ?? null });
    if (after.state?.startsWith('BLOCKED')) add('run.blocked', { state: after.state });
    if (['PAUSED', 'CANCELLED'].includes(before.state ?? '') && !['PAUSED', 'CANCELLED'].includes(after.state ?? '')) add('run.resumed', { state: after.state });
  }
  if (before.configRevision !== after.configRevision) add('config.changed', { revision: after.configRevision ?? null });
  const taskEvents: Record<string, string> = { READY: 'task.ready', LEASED: 'task.leased', RUNNING: 'task.started', INTEGRATED: 'task.integrated', ORPHANED_UNKNOWN: 'task.orphaned' };
  for (const [taskId, task] of Object.entries(after.tasks ?? {})) {
    const prior = before.tasks?.[taskId], identity = { taskId, attempt: task.attempt };
    if (prior?.state !== task.state && taskEvents[task.state]) add(taskEvents[task.state]!, { ...identity, state: task.state });
    if (task.modelResolution && changed(prior?.modelResolution, task.modelResolution)) add('model.resolved', { ...identity, resolution: task.modelResolution });
    if (task.nativeId && (prior?.nativeId !== task.nativeId || changed(prior?.observedModel, task.observedModel) || changed(prior?.observedEffort, task.observedEffort)))
      add('model.observed', { ...identity, nativeId: task.nativeId, model: task.observedModel ?? null, effort: task.observedEffort ?? null });
    if (task.heartbeat && changed(prior?.heartbeat, task.heartbeat)) add('task.heartbeat_confirmed', { ...identity, heartbeat: task.heartbeat, expires: task.expires });
    for (const [unitId, sha] of Object.entries(task.units ?? {})) if (prior?.units?.[unitId] !== sha) add('task.committed', { ...identity, unitId, sha });
  }
  for (const finding of after.findings ?? []) {
    const prior = before.findings?.find(item => item.id === finding.id);
    const types: Record<string, string> = { OPEN: 'finding.opened', REOPENED: 'finding.reopened', VERIFIED_FIXED: 'finding.verified_fixed' };
    if (prior?.lifecycle !== finding.lifecycle) add(types[finding.lifecycle] ?? 'finding.disposition_changed', { findingId: finding.id, lifecycle: finding.lifecycle });
  }
  for (const review of (after.reviews ?? []).slice(before.reviews?.length ?? 0)) add('review.completed', { reviewer: review.reviewer, sha: review.sha, final: review.final });
  for (const gate of (after.gates ?? []).slice(before.gates?.length ?? 0)) add(gate.task && !['passed', 'waived'].includes(gate.status) ? 'task.validation_failed' : 'gate.completed', { taskId: gate.task, status: gate.status });
  for (const resource of after.cleanup ?? []) {
    if (!before.cleanup?.some(item => !changed(item, resource))) add(resource.status === 'removed' ? 'cleanup.removed' : resource.status === 'candidate' ? 'cleanup.planned' : resource.status === 'absent' ? 'cleanup.absent' : 'cleanup.preserved', resource);
  }
  return events;
}
