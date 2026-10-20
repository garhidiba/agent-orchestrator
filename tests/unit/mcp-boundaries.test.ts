import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findingDispositionSchema, hostHeartbeatSchema } from '../../packages/protocol/src/runtime.ts';

test('public heartbeat and finding inputs reject fabricated worker checkpoints and unapproved dispositions', () => {
  assert.equal(hostHeartbeatSchema.safeParse({ source: 'worker_checkpoint', status: 'running', observedAt: Date.now(), evidenceRef: 'worker claim' }).success, false);
  assert.equal(hostHeartbeatSchema.safeParse({ source: 'host_status', status: 'running', observedAt: Infinity, evidenceRef: 'native receipt' }).success, false);
  assert.equal(hostHeartbeatSchema.safeParse({ source: 'host_event', status: 'running', observedAt: Date.now(), evidenceRef: ' ' }).success, false);
  assert.equal(hostHeartbeatSchema.safeParse({ source: 'host_status', status: 'running', observedAt: Date.now(), evidenceRef: 'native://status/fixture' }).success, true);
  const disposition = { finding_id: 'F1', status: 'ACCEPTED_RISK', reason: 'User reviewed synthetic finding', approved: true };
  assert.equal(findingDispositionSchema.safeParse(disposition).success, true);
  assert.equal(findingDispositionSchema.safeParse({ ...disposition, approved: false }).success, false);
  assert.equal(findingDispositionSchema.safeParse({ ...disposition, reason: ' ' }).success, false);
  assert.equal(findingDispositionSchema.safeParse({ ...disposition, status: 'FIXED' }).success, false);
});
