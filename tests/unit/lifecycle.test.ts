import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeElapsedMs, enforceRunBudget, reconcileExpiredTasks, confirmHostHeartbeat } from '../../packages/core/src/runtime/lifecycle.ts';

test('active budget includes current activity but excludes a paused interval', () => {
  const run = { activeTimeMs: 20000, activeSince: 1000, config: { execution: { run_timeout_minutes: 1 } } };
  assert.equal(activeElapsedMs(run, 41000), 60000);
  assert.throws(() => enforceRunBudget(run, 41000), /RUN_TIMEOUT/);
  run.activeSince = 0;
  assert.equal(activeElapsedMs({ ...run, activeSince: null }, 999999), 20000);
});

test('expired workers remain unknown and retain their resources until host confirmation', () => {
  const tasks = {
    active: { state: 'RUNNING', expires: 500, path: '/preserve', nativeId: 'native-1' },
    waiting: { state: 'LEASED', expires: 501, path: '/waiting', nativeId: null },
    merged: { state: 'INTEGRATED', expires: 100, path: '/merged', nativeId: 'done' },
  };
  assert.deepEqual(reconcileExpiredTasks(tasks, 500), ['active']);
  assert.equal(tasks.active.state, 'ORPHANED_UNKNOWN');
  assert.equal(tasks.active.path, '/preserve');
  assert.equal(tasks.waiting.state, 'LEASED');
  assert.deepEqual(reconcileExpiredTasks(tasks, 500), []);
});

test('only authenticated, fresh host status can renew the exact current worker lease', () => {
  const task = { state: 'RUNNING', expires: 2000, lease: 'lease-1', attempt: 2, nativeId: 'native-1', heartbeat: undefined as { observedAt: number; evidenceRef: string } | undefined };
  const identity = { leaseId: 'lease-1', generation: 2, nativeId: 'native-1' };
  const receipt = { source: 'host_status' as const, status: 'running' as const, observedAt: 1000, evidenceRef: 'receipt-1' };
  assert.throws(() => confirmHostHeartbeat(task, identity, receipt, false, 2000, 1100), /PARENT_CONFIRMATION_REQUIRED/);
  assert.throws(() => confirmHostHeartbeat(task, { ...identity, generation: 1 }, receipt, true, 2000, 1100), /STALE_LEASE/);
  assert.throws(() => confirmHostHeartbeat(task, identity, { ...receipt, observedAt: 1200 }, true, 2000, 1100), /HEARTBEAT_EVIDENCE_INVALID/);
  assert.throws(() => confirmHostHeartbeat(task, identity, { ...receipt, source: 'model_checkpoint' as 'host_status' }, true, 2000, 1100), /HEARTBEAT_EVIDENCE_INVALID/);
  confirmHostHeartbeat(task, identity, receipt, true, 2000, 1100, 2500);
  assert.equal(task.expires, 2500);
  assert.deepEqual(task.heartbeat, { observedAt: 1000, evidenceRef: 'receipt-1' });
  assert.throws(() => confirmHostHeartbeat(task, identity, receipt, true, 2000, 1100), /HEARTBEAT_EVIDENCE_INVALID/);
  assert.throws(() => confirmHostHeartbeat(task, identity, { ...receipt, observedAt: 3000 }, true, 2000, 3000), /STALE_LEASE/);
});
