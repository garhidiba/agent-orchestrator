import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runtimeFixture, fixtureTaskResult } from '../fixtures/runtime.ts';
import { git } from '../../packages/core/src/git/repository.ts';

async function partialUnitFixture(conflict = false) {
  const f = await runtimeFixture();
  f.plan.tasks[0].commit_units.push({ id: 'U2', purpose: 'finish feature with dependency' });
  if (conflict) f.plan.tasks[1].write_paths = ['T1.txt'];
  await f.change({}, run => f.engine.plan(run, f.plan, true));
  const prepared = await f.change({}, run => f.engine.prepare(run, 'T1'));
  await f.change({}, run => f.engine.bind(run, 'T1', prepared.result.leaseId, prepared.result.fencingToken, 'old-worker', null, null));
  await writeFile(join(prepared.result.worktreePath, 'T1.txt'), 'committed feature\n');
  await f.change({}, run => f.engine.validate(run, 'T1', prepared.result.leaseId, prepared.result.fencingToken));
  await f.change({}, run => f.engine.commit(run, 'T1', prepared.result.leaseId, prepared.result.fencingToken, 'U1'));
  return f;
}

test('a stopped partial task replays only owned units onto the latest integration and completes normally', async () => {
  const f = await partialUnitFixture();
  try {
    const old = f.engine.status(f.created.runId).data.tasks.T1;
    await writeFile(join(old.path, 'T1.txt'), 'dirty work preserved separately\n');
    const dependency = await f.change({}, run => f.engine.prepare(run, 'T2'));
    await f.change({}, run => f.engine.bind(run, 'T2', dependency.result.leaseId, dependency.result.fencingToken, 'dependency-worker', null, null));
    await writeFile(join(dependency.result.worktreePath, 'T2.txt'), 'new dependency\n');
    await f.change({}, run => f.engine.validate(run, 'T2', dependency.result.leaseId, dependency.result.fencingToken));
    await f.change({}, run => f.engine.commit(run, 'T2', dependency.result.leaseId, dependency.result.fencingToken, 'U1'));
    await f.change({}, async run => f.engine.complete(run, 'T2', dependency.result.leaseId, dependency.result.fencingToken, true, await fixtureTaskResult(run, 'T2')));
    await f.change({}, run => f.engine.integrate(run, 'T2', run.integrationSha!));
    const integration = f.engine.status(f.created.runId).data.integrationSha!;
    await f.change({}, run => f.engine.retry(run, 'T1', old.lease, old.attempt, true, 'dependency integrated'));
    const prepared = await f.change({}, run => f.engine.prepare(run, 'T1'));
    const recovered = f.engine.status(f.created.runId).data.tasks.T1;
    assert.equal(await readFile(join(recovered.path, 'T2.txt'), 'utf8'), 'new dependency\n');
    assert.equal(await readFile(join(recovered.path, 'T1.txt'), 'utf8'), 'committed feature\n');
    assert.equal(await readFile(join(old.path, 'T1.txt'), 'utf8'), 'dirty work preserved separately\n');
    assert.equal(await git(old.path, 'rev-parse', 'HEAD'), old.units.U1);
    assert.equal(prepared.result.lineageBaseSha, integration);
    assert.equal(recovered.base, integration);
    assert.equal(prepared.result.baseSha, recovered.units.U1);
    assert.notEqual(recovered.units.U1, old.units.U1);
    assert.equal(await git(recovered.path, 'show', '-s', '--format=%P', recovered.units.U1), integration);
    const evidence = f.engine.store.snapshots(f.created.runId);
    assert.ok(evidence.some(snapshot => snapshot.kind === 'attempt' && (snapshot.value as { units?: { U1?: string } }).units?.U1 === old.units.U1));
    await f.change({}, run => f.engine.bind(run, 'T1', prepared.result.leaseId, prepared.result.fencingToken, 'replacement-worker', null, null));
    await writeFile(join(recovered.path, 'T1.txt'), 'feature using new dependency\n');
    await f.change({}, run => f.engine.validate(run, 'T1', prepared.result.leaseId, prepared.result.fencingToken));
    await f.change({}, run => f.engine.commit(run, 'T1', prepared.result.leaseId, prepared.result.fencingToken, 'U2'));
    await f.change({}, async run => f.engine.complete(run, 'T1', prepared.result.leaseId, prepared.result.fencingToken, true, await fixtureTaskResult(run, 'T1')));
    await f.change({}, run => f.engine.integrate(run, 'T1', integration));
    assert.equal(f.engine.status(f.created.runId).data.tasks.T1.state, 'INTEGRATED');
  } finally { await f.close(); }
});

test('conflicting replay preserves dirty source and candidate and reconciles without a new worker lease', async () => {
  const f = await partialUnitFixture(true);
  try {
    const old = f.engine.status(f.created.runId).data.tasks.T1;
    await writeFile(join(old.path, 'T1.txt'), 'dirty source stays here\n');
    await f.change({}, run => f.engine.retry(run, 'T1', old.lease, old.attempt, true, 'old worker stopped'));
    const other = await f.change({}, run => f.engine.prepare(run, 'T2'));
    await f.change({}, run => f.engine.bind(run, 'T2', other.result.leaseId, other.result.fencingToken, 'other-worker', null, null));
    await writeFile(join(other.result.worktreePath, 'T1.txt'), 'different integrated version\n');
    await f.change({}, run => f.engine.validate(run, 'T2', other.result.leaseId, other.result.fencingToken));
    await f.change({}, run => f.engine.commit(run, 'T2', other.result.leaseId, other.result.fencingToken, 'U1'));
    await f.change({}, async run => f.engine.complete(run, 'T2', other.result.leaseId, other.result.fencingToken, true, await fixtureTaskResult(run, 'T2')));
    await f.change({}, run => f.engine.integrate(run, 'T2', run.integrationSha!));
    const before = f.engine.status(f.created.runId);
    await assert.rejects(f.engine.change(f.created.runId, 'conflicting-replay', before.version,
      { tool: 'orch_task_prepare', input: { task_id: 'T1' } }, run => f.engine.prepare(run, 'T1')), /RECOVERY_REPLAY_CONFLICT/);
    assert.equal(f.engine.store.pending(f.created.runId)[0].id, 'conflicting-replay');
    const result = await f.engine.reconcile(f.created.runId, 'conflicting-replay', true);
    const recovered = result.result as { state: string; preserved: string; requiresNewPrepare: boolean };
    assert.equal(recovered.state, 'BLOCKED_RECOVERY_CONFLICT');
    assert.equal(recovered.requiresNewPrepare, false);
    const task = f.engine.status(f.created.runId).data.tasks.T1;
    assert.equal(task.attempt, old.attempt);
    assert.equal(task.expires, 0);
    assert.equal(task.path, old.path);
    assert.deepEqual(task.units, old.units);
    assert.deepEqual(f.engine.status(f.created.runId).data.gates, before.data.gates);
    assert.equal(await readFile(join(old.path, 'T1.txt'), 'utf8'), 'dirty source stays here\n');
    assert.equal(await git(recovered.preserved, 'rev-parse', 'CHERRY_PICK_HEAD'), old.units.U1);
    assert.match(await readFile(join(recovered.preserved, 'T1.txt'), 'utf8'), /<<<<<<< HEAD/);
    assert.equal(f.engine.store.pending(f.created.runId).length, 0);
  } finally { await f.close(); }
});

test('foreign commits cannot enter a recovered unit chain even when they modify owned paths', async () => {
  const f = await partialUnitFixture();
  try {
    const old = f.engine.status(f.created.runId).data.tasks.T1;
    await writeFile(join(old.path, 'T1.txt'), 'foreign commit\n');
    await git(old.path, 'add', 'T1.txt'); await git(old.path, 'commit', '-m', 'foreign commit without a unit receipt');
    await f.change({}, run => f.engine.retry(run, 'T1', old.lease, old.attempt, true, 'worker stopped'));
    const before = f.engine.status(f.created.runId);
    await assert.rejects(f.change({}, run => f.engine.prepare(run, 'T1')), /UNTRACKED_COMMIT/);
    assert.deepEqual(f.engine.status(f.created.runId), before);
    assert.equal(f.engine.store.pending(f.created.runId).length, 0);
  } finally { await f.close(); }
});

test('interrupted replay preserves its isolated candidate and requires fresh preparation without adopting commits', async () => {
  const f = await partialUnitFixture();
  try {
    const old = f.engine.status(f.created.runId).data.tasks.T1;
    await f.change({}, run => f.engine.retry(run, 'T1', old.lease, old.attempt, true, 'worker stopped'));
    // A disjoint committed integration advance is the controlled recovery baseline for this interruption fixture.
    const run = f.engine.status(f.created.runId).data;
    await writeFile(join(run.integrationPath, 'T2.txt'), 'later dependency\n');
    await git(run.integrationPath, 'add', 'T2.txt'); await git(run.integrationPath, 'commit', '-m', 'controlled dependency baseline');
    await f.change({}, async current => { current.integrationSha = await git(current.integrationPath, 'rev-parse', 'HEAD'); });
    const checkpoint = f.engine.checkpointIntent.bind(f.engine);
    let checkpoints = 0;
    f.engine.checkpointIntent = current => { if (++checkpoints === 2) throw new Error('SIMULATED_PROCESS_EXIT'); checkpoint(current); };
    await assert.rejects(f.engine.change(f.created.runId, 'interrupted-replay', f.engine.status(f.created.runId).version,
      { tool: 'orch_task_prepare', input: { task_id: 'T1' } }, current => f.engine.prepare(current, 'T1')), /SIMULATED_PROCESS_EXIT/);
    f.engine.checkpointIntent = checkpoint;
    const result = await f.engine.reconcile(f.created.runId, 'interrupted-replay', true);
    const recovery = result.result as { requiresNewPrepare: boolean; preserved: string };
    assert.equal(recovery.requiresNewPrepare, true);
    assert.equal(await readFile(join(recovery.preserved, 'T2.txt'), 'utf8'), 'later dependency\n');
    assert.deepEqual(f.engine.status(f.created.runId).data.tasks.T1.units, old.units);
    await f.change({}, current => f.engine.prepare(current, 'T1'));
    assert.equal(f.engine.status(f.created.runId).data.tasks.T1.attempt, 2);
  } finally { await f.close(); }
});
