import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { runtimeFixture } from '../fixtures/runtime.ts';
import { modelSchema } from '../../packages/core/src/model-registry/index.ts';

const descriptor = (id: string) => modelSchema.parse({ host: 'codex', id, displayName: id, resolvedId: id,
  family: 'openai', support: 'advertised', access: 'unknown', availability: 'unknown', efforts: ['high', 'low'], defaultEffort: 'low',
  hidden: false, source: 'synthetic-native-tool-metadata', sourceVersion: null, fetchedAt: new Date().toISOString(), expiresAt: null,
  evidence: [{ kind: 'fixture', ref: 'synthetic-contract' }] });

test('Engine dispatch applies role pins and preserves each attempt resolution across config revisions', async () => {
  const f = await runtimeFixture(true, { hosts: { codex: { roles: { coder: { model: 'fixture-fast', effort: 'low' } } } } });
  try {
    Object.assign(f.engine.native!, { perInvocationModel: true, perInvocationEffort: true, models: [descriptor('fixture-fast'), descriptor('fixture-careful')] });
    await f.change({ action: 'plan' }, run => f.engine.plan(run, f.plan, true));
    const first = await f.change({ action: 'prepare' }, run => f.engine.prepare(run, 'T1'));
    assert.equal(first.result.modelId, 'fixture-fast'); assert.equal(first.result.effort, 'low');
    assert.deepEqual(first.result.nativeArguments, { model: 'fixture-fast', reasoning_effort: 'low' });
    const prior = structuredClone(f.engine.status(f.created.runId).data.config);
    prior.hosts.codex.roles.coder = { model: 'fixture-careful', effort: 'high' };
    f.engine.readConfig = async () => prior;
    const second = await f.change({ action: 'prepare' }, run => f.engine.prepare(run, 'T2'));
    assert.equal(second.result.modelId, 'fixture-careful'); assert.equal(second.result.configRevision, 2);
    const t1 = f.engine.status(f.created.runId).data.tasks.T1;
    assert.equal(t1.modelResolution?.resolvedModel, 'fixture-fast'); assert.equal(t1.configRevision, 1);
    assert.equal(first.result.resources.environment.ORCH_BUILD_DIR.startsWith(await realpath(f.root)), true);
    assert.notEqual(first.result.resources.tmp, second.result.resources.tmp);
    assert.ok(f.engine.store.snapshots(f.created.runId).some(item => item.kind === 'model'));
  } finally { await f.close(); }
});

test('unknown inherited identity accepts actual observed model instead of comparing it against null', async () => {
  const f = await runtimeFixture();
  try {
    f.engine.native!.model = null; f.engine.native!.effort = null;
    await f.change({ action: 'plan' }, run => f.engine.plan(run, f.plan, true));
    const prepared = await f.change({}, run => f.engine.prepare(run, 'T1'));
    await f.change({}, run => f.engine.bind(run, 'T1', prepared.result.leaseId, prepared.result.fencingToken, 'observed-worker', 'actual-model', 'high'));
    const work = f.engine.status(f.created.runId).data.tasks.T1;
    assert.equal(work.observedModel, 'actual-model'); assert.equal(work.observedEffort, 'high');
  } finally { await f.close(); }
});

test('active run budget blocks verification even when no further worker is dispatched', async () => {
  const f = await runtimeFixture();
  try {
    await f.change({}, run => f.engine.plan(run, f.plan, true));
    await f.change({}, async run => { run.state = 'VERIFYING'; run.activeTimeMs = run.config.execution.run_timeout_minutes * 60000; });
    await assert.rejects(f.change({}, run => f.engine.verify(run)), /RUN_TIMEOUT/);
  } finally { await f.close(); }
});

test('reviewer dispatch is readonly, role-specific and required for authenticated native review results', async () => {
  const f = await runtimeFixture(true, { hosts: { codex: { roles: { reviewer: { model: 'fixture-careful', effort: 'high' } } } } });
  try {
    Object.assign(f.engine.native!, { source: 'coordinator_native_receipt', perInvocationModel: true, perInvocationEffort: true, models: [descriptor('fixture-careful')] });
    await f.change({}, run => f.engine.plan(run, f.plan, true));
    await f.change({}, async run => { run.state = 'VERIFYING'; });
    await f.change({}, run => f.engine.verify(run));
    const prepared = await f.change({}, run => f.engine.prepareReview(run, 'reviewer'));
    assert.equal(prepared.result.readOnly, true); assert.deepEqual(prepared.result.writePaths, []);
    assert.equal(prepared.result.modelId, 'fixture-careful'); assert.equal(prepared.result.effort, 'high');
    const review = { schema_version: 1, reviewed_sha: prepared.result.reviewedSha, reviewer_id: 'native-reviewer', decision: 'approved', findings: [], reviewed_areas: ['fixture'], limitations: [], acceptance_ids: ['AC-1'] };
    await assert.rejects(f.change({}, run => f.engine.review(run, review, false, true)), /REVIEW_DISPATCH_REQUIRED/);
    await f.change({}, run => f.engine.bindReview(run, prepared.result.dispatchId, 'native-reviewer', 'fixture-careful', 'high', prepared.result.reviewedSha));
    await assert.rejects(f.change({}, run => f.engine.review(run, review)), /WORKER_STOP_UNCONFIRMED/);
    await f.change({}, run => f.engine.review(run, review, false, true));
    const { buildReport } = await import('../../packages/core/src/reporting/index.ts');
    assert.equal(buildReport(f.engine.status(f.created.runId).data, 1, null).models.find(item => item.role === 'reviewer')?.observations[0]?.observedModel, 'fixture-careful');
    assert.equal(f.engine.status(f.created.runId).data.state, 'FINAL_AUDIT');
    const stopped = await f.change({}, run => f.engine.stopReview(run, prepared.result.dispatchId, true, 'native-reviewer'));
    assert.equal(stopped.result.state, 'COMPLETED');
  } finally { await f.close(); }
});

test('approval-wait phases still charge the currently executing operation before running a gate', async () => {
  const f = await runtimeFixture(true, { execution: { run_timeout_minutes: 1 } });
  try {
    await assert.rejects(f.change({}, async run => {
      run.activeTimeMs = 59950;
      await new Promise(resolve => setTimeout(resolve, 80));
      return f.engine.gate(run, 'baseline', run.origin);
    }), /RUN_TIMEOUT/);
  } finally { await f.close(); }
});

test('maximum-length logical task IDs still produce valid bounded attempt evidence keys', async () => {
  const f = await runtimeFixture();
  try {
    const taskId = 'T'.repeat(100), spec = { ...f.plan.tasks[0], id: taskId };
    await f.change({}, run => f.engine.plan(run, { ...f.plan, tasks: [spec] }, true));
    const prepared = await f.change({}, run => f.engine.prepare(run, taskId));
    assert.ok(prepared.result.attemptId.length <= 100);
    assert.ok(f.engine.store.snapshots(f.created.runId).some(item => item.kind === 'attempt'));
  } finally { await f.close(); }
});

test('persisted native runs require a new host connection before accepting review results after restart', async () => {
  const f = await runtimeFixture();
  try {
    await f.change({}, run => f.engine.plan(run, f.plan, true));
    await f.change({}, async run => { run.state = 'VERIFYING'; run.hostEvidence!.source = 'coordinator_native_receipt'; });
    await f.change({}, run => f.engine.verify(run));
    const run = f.engine.status(f.created.runId).data;
    f.engine.native = null;
    await assert.rejects(f.change({}, current => f.engine.review(current, { schema_version: 1, reviewed_sha: run.integrationSha, reviewer_id: 'unbound', decision: 'approved', findings: [], reviewed_areas: ['fixture'], limitations: [], acceptance_ids: ['AC-1'] })), /BLOCKED_CAPABILITY/);
  } finally { await f.close(); }
});

test('budget exhaustion inside a gate persists timeout evidence instead of stranding an operation intent', async () => {
  const f = await runtimeFixture(true, { execution: { run_timeout_minutes: 1 } });
  try {
    await f.change({}, run => f.engine.plan(run, f.plan, true));
    const result = await f.change({}, async run => {
      run.state = 'VERIFYING'; run.activeTimeMs = 59950;
      return f.engine.verify(run);
    });
    assert.equal(result.result.status, 'timed_out');
    assert.equal(f.engine.status(f.created.runId).data.state, 'BLOCKED_TESTS');
    assert.equal(f.engine.store.pending(f.created.runId).length, 0);
    assert.ok(f.engine.status(f.created.runId).data.gates.at(-1)?.details?.length);
  } finally { await f.close(); }
});

test('readonly native workers cannot be duplicated or cleaned up without an exact stop confirmation', async () => {
  const f = await runtimeFixture();
  try {
    await f.change({}, run => f.engine.plan(run, f.plan, true));
    await f.change({}, async run => { run.state = 'VERIFYING'; });
    await f.change({}, run => f.engine.verify(run));
    const dispatch = await f.change({}, run => f.engine.prepareReview(run, 'reviewer'));
    await assert.rejects(f.change({}, run => f.engine.prepareReview(run, 'reviewer')), /REVIEW_ALREADY_ACTIVE/);
    const run = f.engine.status(f.created.runId).data;
    const cleanup = await f.engine.cleanup({ ...run, state: 'COMPLETED' }, true);
    assert.equal(cleanup.find(item => item.path === run.integrationPath)?.reason, 'worker_stop_unconfirmed');
    await assert.rejects(f.change({}, current => f.engine.stopReview(current, dispatch.result.dispatchId, false, null)), /WORKER_STOP_UNCONFIRMED/);
    await f.change({}, current => f.engine.stopReview(current, dispatch.result.dispatchId, true, null));
    const next = await f.change({}, current => f.engine.prepareReview(current, 'reviewer'));
    assert.notEqual(next.result.dispatchId, dispatch.result.dispatchId);
  } finally { await f.close(); }
});
