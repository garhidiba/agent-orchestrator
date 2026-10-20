import { requireCondition as check } from '../../../protocol/src/runtime.ts';

type Budget = { activeTimeMs?: number; activeSince?: number | null; config: { execution: { run_timeout_minutes: number } } };
export function activeElapsedMs(run: Pick<Budget, 'activeTimeMs' | 'activeSince'>, now = Date.now()) {
  return (run.activeTimeMs ?? 0) + (run.activeSince == null ? 0 : Math.max(0, now - run.activeSince));
}
export function enforceRunBudget(run: Budget, now = Date.now()) {
  check(activeElapsedMs(run, now) < run.config.execution.run_timeout_minutes * 60000, 'RUN_TIMEOUT');
}
export function reconcileExpiredTasks(tasks: Record<string, { state: string; expires: number }>, now = Date.now()) {
  const expired: string[] = [];
  for (const [id, task] of Object.entries(tasks)) {
    if (['LEASED', 'RUNNING', 'VALIDATING'].includes(task.state) && task.expires <= now) {
      task.state = 'ORPHANED_UNKNOWN'; expired.push(id);
    }
  }
  return expired;
}
export type HostHeartbeat = { source: 'host_status' | 'host_event'; status: 'running'; observedAt: number; evidenceRef: string };
export type LeaseIdentity = { leaseId: string; generation: number; nativeId: string };
export type HeartbeatTask = { state: string; expires: number; lease: string; attempt: number; nativeId: string | null; heartbeat?: { observedAt: number; evidenceRef: string } };
// Authentication belongs to the parent-only host adapter, never to a worker-supplied checkpoint.
export function confirmHostHeartbeat(task: HeartbeatTask, identity: LeaseIdentity, receipt: HostHeartbeat, authenticatedParent: boolean, leaseMs: number, now = Date.now(), deadline = Infinity) {
  check(authenticatedParent, 'PARENT_CONFIRMATION_REQUIRED');
  check(task.lease === identity.leaseId && task.attempt === identity.generation && task.nativeId !== null && task.nativeId === identity.nativeId && task.expires > now, 'STALE_LEASE');
  check(['LEASED', 'RUNNING', 'VALIDATING'].includes(task.state), 'INVALID_TASK_STATE');
  check(['host_status', 'host_event'].includes(receipt.source) && receipt.status === 'running' && receipt.evidenceRef.trim().length > 0 &&
    Number.isFinite(leaseMs) && leaseMs > 0 && Number.isFinite(receipt.observedAt) && receipt.observedAt <= now && now - receipt.observedAt < leaseMs &&
    receipt.observedAt > (task.heartbeat?.observedAt ?? -Infinity) && deadline > now, 'HEARTBEAT_EVIDENCE_INVALID');
  task.heartbeat = { observedAt: receipt.observedAt, evidenceRef: receipt.evidenceRef };
  task.expires = Math.min(receipt.observedAt + leaseMs, deadline);
  return { expiresAt: new Date(task.expires).toISOString(), heartbeat: task.heartbeat };
}
