import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runtimeFixture, fixtureTaskResult } from '../fixtures/runtime.ts';
import { git } from '../../packages/core/src/git/repository.ts';
import { buildReport } from '../../packages/core/src/reporting/index.ts';

async function prepareReviewedRun(f: Awaited<ReturnType<typeof runtimeFixture>>) {
  f.plan.tasks = [f.plan.tasks[0]];
  await f.change({}, run => f.engine.plan(run, f.plan, true));
  if (f.engine.status(f.created.runId).data.state === 'BLOCKED_BASELINE') {
    await f.change({}, run => f.engine.waiveGate(run, 'baseline', 'unit', null, 'Known baseline limitation', true));
    await f.change({}, run => f.engine.plan(run, f.plan, true));
  }
  await f.change({}, run => f.engine.prepare(run, 'T1'));
  const task = f.engine.status(f.created.runId).data.tasks.T1;
  await f.change({}, run => f.engine.bind(run, 'T1', task.lease, task.attempt, 'worker', 'fixture-model', 'high'));
  await writeFile(join(task.path, 'T1.txt'), 'feature');
  await f.change({}, run => f.engine.validate(run, 'T1', task.lease, task.attempt));
  if (!f.engine.status(f.created.runId).data.tasks.T1.validated) {
    await f.change({}, run => f.engine.waiveGate(run, 'task', 'unit', 'T1', 'Known task limitation', true));
    await f.change({}, run => f.engine.validate(run, 'T1', task.lease, task.attempt));
  }
  await f.change({}, run => f.engine.commit(run, 'T1', task.lease, task.attempt, 'U1'));
  await f.change({}, async run => f.engine.complete(run, 'T1', task.lease, task.attempt, true, await fixtureTaskResult(run, 'T1')));
  await f.change({}, run => f.engine.integrate(run, 'T1', run.integrationSha!));
  await f.change({}, run => f.engine.verify(run));
  const current = f.engine.status(f.created.runId).data;
  if (current.state === 'BLOCKED_TESTS') {
    await f.change({}, run => f.engine.waiveGate(run, 'integration', 'integration', null, 'Known integration limitation', true));
    await f.change({}, run => f.engine.verify(run));
  }
  const review = { schema_version: 1, reviewed_sha: current.integrationSha, reviewer_id: 'reviewer', decision: 'approved', findings: [], reviewed_areas: ['all'], limitations: [], acceptance_ids: ['AC-1'] };
  await f.change({}, run => f.engine.review(run, review));
  await f.change({}, run => f.engine.review(run, { ...review, reviewer_id: 'auditor' }, true));
}

test('approved scoped gate waivers permit finalization and crash recovery without claiming verified completion', async () => {
  const f = await runtimeFixture(true, { quality: { commands: [
    { id: 'unit', executable: process.execPath, args: ['-e', 'process.exit(0)'], cwd: '.', stages: ['baseline', 'task'], required: true, timeout_seconds: 5 },
    ...['integration', 'final'].map(stage => ({ id: stage, executable: process.execPath, args: ['-e', 'process.exit(2)'], cwd: '.', stages: [stage], required: true, timeout_seconds: 5 })),
  ] } });
  try {
    await prepareReviewedRun(f);
    await f.change({}, run => f.engine.waiveGate(run, 'final', 'final', null, 'Known final limitation', true));
    const current = f.engine.status(f.created.runId).data;
    for (const patch of [
      { sha: current.targetBase }, { source: 'stale' }, { command: 'stale' }, { stage: 'task' }, { taskId: 'T1' },
      { actor: 'worker' }, { reason: ' ' }, { approvedAt: 'invalid' }, { approvedAt: '2099-01-01T00:00:00Z' },
    ]) {
      await assert.rejects(f.change({ patch }, run => {
        Object.assign(run.waivers![0], patch);
        return f.engine.finalize(run, true, run.targetBase);
      }), /COMPLETION_UNVERIFIED/);
    }
    await assert.rejects(f.change({}, run => {
      run.waivers = [];
      return f.engine.finalize(run, true, run.targetBase);
    }), /COMPLETION_UNVERIFIED/);
    await assert.rejects(f.change({}, run => {
      run.reviews.at(-1)!.limitations = ['Acceptance not checked'];
      return f.engine.finalize(run, true, run.targetBase);
    }), /COMPLETION_UNVERIFIED/);
    await assert.rejects(f.change({}, run => {
      run.tasks.T1.acceptanceEvidence = [];
      return f.engine.finalize(run, true, run.targetBase);
    }), /COMPLETION_UNVERIFIED/);
    assert.equal(await git(f.root, 'rev-parse', 'HEAD'), current.targetBase);
    const save = f.engine.store.save.bind(f.engine.store);
    f.engine.store.save = () => { throw new Error('finalization save crash'); };
    try {
      await assert.rejects(f.engine.change(current.id, 'waiver-finalize-crash', f.engine.status(current.id).version,
        { tool: 'orch_finalize', input: { approved: true, expected_target_sha: current.targetBase } }, run => f.engine.finalize(run, true, run.targetBase)), /finalization save crash/);
    } finally { f.engine.store.save = save; }
    await f.engine.reconcile(current.id, 'waiver-finalize-crash', true);
    const run = f.engine.status(f.created.runId);
    assert.equal(run.data.state, 'COMPLETED');
    assert.equal(await git(f.root, 'rev-parse', 'HEAD'), current.integrationSha);
    const report = buildReport(run.data, run.version, current.integrationSha!);
    assert.equal(report.completionVerified, false);
    assert.equal(report.finalizedWithApprovedExceptions, true);
    assert.deepEqual(report.nextActions, []);
    assert.ok(report.blockers.includes('INTEGRATION_GATE_UNVERIFIED'));
    for (const stage of ['integration', 'final']) {
      const gate = report.gates.filter(gate => gate.stage === stage).at(-1)!;
      assert.equal(gate.status, 'waived');
      assert.equal(gate.details![0].exitCode, null);
      assert.match(gate.details![0].waiverReason!, /Known/);
      assert.equal(report.waivers.find(waiver => waiver.stage === stage)?.actor, 'user');
    }
  } finally { await f.close(); }
});

test('used baseline and task waivers remain exceptions even when final gates pass', async () => {
  const f = await runtimeFixture(true, { quality: { commands: [
    { id: 'unit', executable: process.execPath, args: ['-e', 'process.exit(2)'], cwd: '.', stages: ['baseline', 'task'], required: true, timeout_seconds: 5 },
    { id: 'verification', executable: process.execPath, args: ['-e', 'process.exit(0)'], cwd: '.', stages: ['integration', 'final'], required: true, timeout_seconds: 5 },
  ] } });
  try {
    await prepareReviewedRun(f);
    await f.change({}, run => f.engine.finalize(run, true, run.targetBase));
    const saved = f.engine.status(f.created.runId), run = saved.data;
    const report = buildReport(run, saved.version, run.integrationSha!);
    assert.equal(report.completionVerified, false);
    assert.equal(report.finalizedWithApprovedExceptions, true);
    assert.deepEqual(report.nextActions, []);
    assert.equal(report.gates.at(-1)?.status, 'passed');
    assert.ok(report.blockers.includes('BASELINE_GATE_UNVERIFIED'));
    assert.ok(report.blockers.includes('TASK_GATE_UNVERIFIED'));
    for (const gate of run.gates.filter(gate => gate.status === 'waived')) {
      run.gates.push({ ...gate, status: 'passed', results: gate.results.map(result => ({ ...result, status: 'passed', exitCode: 0 })), details: gate.details?.map(detail => ({ ...detail, status: 'passed', exitCode: 0, waiverReason: null })) });
    }
    const revalidated = buildReport(run, saved.version, run.integrationSha!);
    assert.equal(revalidated.completionVerified, true);
    assert.equal(revalidated.finalizedWithApprovedExceptions, false);
  } finally { await f.close(); }
});

test('explicit missing-tests waiver permits finalization and stays unverified', async () => {
  const f = await runtimeFixture(true, { quality: { commands: [] } }, tmpdir(), { missingTestsWaiver: { approved: true, reason: 'No tests exist; approved exception' } });
  try {
    for (const task of f.plan.tasks) task.verification_ids = ['missing-tests'];
    await prepareReviewedRun(f);
    await f.change({}, run => f.engine.finalize(run, true, run.targetBase));
    const run = f.engine.status(f.created.runId);
    const report = buildReport(run.data, run.version, await git(f.root, 'rev-parse', 'HEAD'));
    assert.equal(report.state, 'COMPLETED');
    assert.equal(report.completionVerified, false);
    assert.equal(report.finalizedWithApprovedExceptions, true);
    assert.deepEqual(report.nextActions, []);
    assert.equal(report.gates.at(-1)?.status, 'waived');
    assert.equal(report.missingTestsWaiver?.actor, 'user');
  } finally { await f.close(); }
});
