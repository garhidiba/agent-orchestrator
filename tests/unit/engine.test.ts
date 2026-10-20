import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Engine } from '../../packages/core/src/runtime/engine.ts';
import { runtimeFixture as fixture, fixtureTaskResult } from '../fixtures/runtime.ts';
import { git } from '../../packages/core/src/git/repository.ts';


test('two tasks use isolated worktrees, preserve commits, require independent review and finalize approval', async () => {
  const f = await fixture();
  try {
    await f.change({ action: 'plan' }, run => f.engine.plan(run, f.plan, true));
    for (const taskId of ['T1', 'T2']) await f.change({ action: 'prepare', taskId }, run => f.engine.prepare(run, taskId));
    const tasks = f.engine.status(f.created.runId).data.tasks;
    assert.notEqual(tasks.T1.path, tasks.T2.path); assert.equal(tasks.T1.base, tasks.T2.base);
    for (const taskId of ['T1', 'T2']) {
      const task = f.engine.status(f.created.runId).data.tasks[taskId];
      await f.change({ action: 'bind', taskId }, run => f.engine.bind(run, taskId, task.lease, task.attempt, `native-${taskId}`, 'fixture-model', 'high'));
      await writeFile(join(task.path, `${taskId}.txt`), taskId);
      await f.change({ action: 'validate', taskId }, run => f.engine.validate(run, taskId, task.lease, task.attempt));
      await f.change({ action: 'commit', taskId }, run => f.engine.commit(run, taskId, task.lease, task.attempt, 'U1'));
      await f.change({ action: 'complete', taskId }, async run => f.engine.complete(run, taskId, task.lease, task.attempt, true, await fixtureTaskResult(run, taskId)));
      const head = await git(f.engine.status(f.created.runId).data.integrationPath, 'rev-parse', 'HEAD');
      await f.change({ action: 'integrate', taskId }, run => f.engine.integrate(run, taskId, head));
    }
    await f.change({ action: 'verify' }, run => f.engine.verify(run));
    let run = f.engine.status(f.created.runId).data;
    const sha = await git(run.integrationPath, 'rev-parse', 'HEAD');
    const review = { schema_version: 1, reviewed_sha: sha, reviewer_id: 'reviewer', decision: 'approved', findings: [], reviewed_areas: ['all'], limitations: [], acceptance_ids: ['AC-1'] };
    await assert.rejects(f.change({ action: 'bad-review' }, run => f.engine.review(run, { ...review, reviewer_id: 'native-T1' })), /REVIEW_NOT_INDEPENDENT/);
    await f.change({ action: 'review' }, run => f.engine.review(run, review));
    await f.change({ action: 'audit' }, run => f.engine.review(run, { ...review, reviewer_id: 'auditor' }, true));
    run = f.engine.status(f.created.runId).data;
    await assert.rejects(f.change({ action: 'unapproved-finalize' }, run => f.engine.finalize(run, false, run.targetBase)), /APPROVAL_REQUIRED/);
    assert.equal(await git(f.root, 'rev-parse', 'HEAD'), run.targetBase);
    await f.change({ action: 'finalize' }, run => f.engine.finalize(run, true, run.targetBase));
    assert.equal(await git(f.root, 'rev-parse', 'HEAD'), sha);
    const commits = await git(f.root, 'log', '--format=%B'); assert.match(commits, /Orch-Task: T1/); assert.match(commits, /Orch-Task: T2/);
    const save = f.engine.store.save.bind(f.engine.store);
    f.engine.store.save = () => { throw new Error('cleanup DB crash'); };
    await assert.rejects(f.engine.change(f.created.runId, 'cleanup-crash', f.engine.status(f.created.runId).version, { tool: 'orch_cleanup', input: { dry_run: false } }, run => f.engine.cleanup(run, false)), /cleanup DB crash/);
    f.engine.store.save = save;
    await f.engine.reconcile(f.created.runId, 'cleanup-crash', true);
    assert.equal(f.engine.status(f.created.runId).data.cleanup.every(item => item.status === 'absent'), true);
    await f.change({ action: 'cleanup-again' }, run => f.engine.cleanup(run, false));
    assert.equal(f.engine.status(f.created.runId).data.cleanup.every(item => item.status === 'absent'), true);
  } finally { await f.close(); }
});

test('unverified capabilities block dispatch and stale lease cannot bind', async () => {
  const f = await fixture(false);
  try {
    await f.change({ action: 'plan' }, run => f.engine.plan(run, f.plan, true));
    await assert.rejects(f.change({ action: 'prepare' }, run => f.engine.prepare(run, 'T1')), /BLOCKED_CAPABILITY/);
    await assert.rejects(f.change({ action: 'bind' }, run => f.engine.bind(run, 'T1', 'stale', 99, 'agent', null, null)), /STALE_LEASE/);
    assert.equal(f.engine.status(f.created.runId).data.tasks.T1.state, 'PENDING');
  } finally { await f.close(); }
});

test('crash after Git commit or merge reconciles durable intent without repeating history', async () => {
  const f = await fixture();
  try {
    f.plan.tasks = [f.plan.tasks[0]];
    await f.change({ action: 'plan' }, run => f.engine.plan(run, f.plan, true));
    await f.change({ action: 'prepare' }, run => f.engine.prepare(run, 'T1'));
    const task = f.engine.status(f.created.runId).data.tasks.T1;
    await f.change({ action: 'bind' }, run => f.engine.bind(run, 'T1', task.lease, task.attempt, 'native-T1', 'fixture-model', 'high'));
    await writeFile(join(task.path, 'T1.txt'), 'feature');
    await f.change({ action: 'validate' }, run => f.engine.validate(run, 'T1', task.lease, task.attempt));
    const save = f.engine.store.save.bind(f.engine.store);
    const commitInput = { tool: 'orch_task_commit', input: { task_id: 'T1', unit_id: 'U1' } };
    f.engine.store.save = () => { throw new Error('simulated DB crash'); };
    const before = f.engine.status(f.created.runId).version;
    await assert.rejects(f.engine.change(f.created.runId, 'crashed-commit', before, commitInput, run => f.engine.commit(run, 'T1', task.lease, task.attempt, 'U1')), /simulated DB crash/);
    f.engine.store.save = save;
    const sha = await git(task.path, 'rev-parse', 'HEAD');
    await f.engine.reconcile(f.created.runId, 'crashed-commit', true);
    assert.equal(f.engine.status(f.created.runId).data.tasks.T1.units.U1, sha);
    await f.engine.change(f.created.runId, 'crashed-commit', before, commitInput, async () => { throw new Error('must not replay'); });
    assert.equal(await git(task.path, 'rev-parse', 'HEAD'), sha);
    await f.change({ action: 'complete' }, run => f.engine.complete(run, 'T1', task.lease, task.attempt, true));
    const expected = await git(f.engine.status(f.created.runId).data.integrationPath, 'rev-parse', 'HEAD');
    f.engine.store.save = () => { throw new Error('simulated DB crash'); };
    await assert.rejects(f.engine.change(f.created.runId, 'crashed-merge', f.engine.status(f.created.runId).version,
      { tool: 'orch_integrate', input: { task_id: 'T1', expected_integration_sha: expected } }, run => f.engine.integrate(run, 'T1', expected)), /simulated DB crash/);
    f.engine.store.save = save;
    const merged = await git(f.engine.status(f.created.runId).data.integrationPath, 'rev-parse', 'HEAD');
    await f.engine.reconcile(f.created.runId, 'crashed-merge', true);
    assert.equal(f.engine.status(f.created.runId).data.tasks.T1.state, 'INTEGRATED');
    assert.equal(await git(f.engine.status(f.created.runId).data.integrationPath, 'rev-parse', 'HEAD'), merged);
  } finally { await f.close(); }
});

test('dirty original, task ownership violations, unconfirmed stop and source changes fail closed', async () => {
  const f = await fixture();
  try {
    await f.change({ action: 'plan' }, run => f.engine.plan(run, f.plan, true));
    await f.change({ action: 'prepare' }, run => f.engine.prepare(run, 'T1'));
    const task = f.engine.status(f.created.runId).data.tasks.T1;
    await f.change({ action: 'bind' }, run => f.engine.bind(run, 'T1', task.lease, task.attempt, 'native-T1', 'fixture-model', 'high'));
    await writeFile(join(task.path, 'outside.txt'), 'keep');
    await assert.rejects(f.change({ action: 'validate-outside' }, run => f.engine.validate(run, 'T1', task.lease, task.attempt)), /OWNERSHIP_VIOLATION/);
    await rm(join(task.path, 'outside.txt'));
    await writeFile(join(task.path, 'T1.txt'), 'feature');
    await f.change({ action: 'validate' }, run => f.engine.validate(run, 'T1', task.lease, task.attempt));
    await writeFile(join(task.path, 'T1.txt'), 'changed after validation');
    await assert.rejects(f.change({ action: 'commit' }, run => f.engine.commit(run, 'T1', task.lease, task.attempt, 'U1')), /VALIDATION_STALE/);
    await assert.rejects(f.change({ action: 'complete' }, run => f.engine.complete(run, 'T1', task.lease, task.attempt, false)), /WORKER_STOP_UNCONFIRMED/);
    await f.change({ action: 'pause' }, run => f.engine.control(run, 'pause'));
    assert.equal(f.engine.status(f.created.runId).data.tasks.T1.state, 'ORPHANED_UNKNOWN');
    await assert.rejects(f.change({ action: 'resume' }, run => f.engine.control(run, 'resume')), /ORPHANED_UNKNOWN/);
    const dry = await f.engine.cleanup(f.engine.status(f.created.runId).data);
    assert.equal(dry.every(item => item.status === 'preserved'), true);
    assert.equal(await import('node:fs/promises').then(fs => fs.readFile(join(task.path, 'T1.txt'), 'utf8')), 'changed after validation');
  } finally { await f.close(); }
});

test('resuming a partial unit cannot bypass completion, and never-started leases can be recovered', async () => {
  const f = await fixture();
  try {
    f.plan.tasks = [f.plan.tasks[0]];
    f.plan.tasks[0].commit_units.push({ id: 'U2', purpose: 'second unit' });
    await f.change({ action: 'plan' }, run => f.engine.plan(run, f.plan, true));
    await f.change({ action: 'prepare' }, run => f.engine.prepare(run, 'T1'));
    let task = f.engine.status(f.created.runId).data.tasks.T1;
    await f.change({ action: 'pause-unstarted' }, run => f.engine.control(run, 'pause'));
    await assert.rejects(f.change({ action: 'resume-unknown' }, run => f.engine.control(run, 'resume')), /ORPHANED_UNKNOWN/);
    await f.change({ action: 'resume-unstarted' }, run => f.engine.control(run, 'resume', [], ['T1']));
    await f.change({ action: 'prepare-again' }, run => f.engine.prepare(run, 'T1'));
    task = f.engine.status(f.created.runId).data.tasks.T1;
    await f.change({ action: 'bind' }, run => f.engine.bind(run, 'T1', task.lease, task.attempt, 'native-T1', 'fixture-model', 'high'));
    await writeFile(join(task.path, 'T1.txt'), 'first');
    await f.change({ action: 'validate' }, run => f.engine.validate(run, 'T1', task.lease, task.attempt));
    await f.change({ action: 'commit' }, run => f.engine.commit(run, 'T1', task.lease, task.attempt, 'U1'));
    await f.change({ action: 'pause-partial' }, run => f.engine.control(run, 'pause'));
    await f.change({ action: 'resume-partial' }, run => f.engine.control(run, 'resume', ['native-T1']));
    assert.equal(f.engine.status(f.created.runId).data.tasks.T1.state, 'RETRYABLE_FAILED');
    const integration = f.engine.status(f.created.runId).data.integrationPath;
    await assert.rejects(f.change({ action: 'invalid-integrate' }, run => f.engine.integrate(run, 'T1', run.targetBase)), /TASK_NOT_READY/);
    assert.equal(await git(integration, 'rev-parse', 'HEAD'), f.engine.status(f.created.runId).data.targetBase);
    await f.change({ action: 'continue-partial' }, run => f.engine.prepare(run, 'T1'));
    const continued = f.engine.status(f.created.runId).data.tasks.T1;
    assert.equal(continued.path, task.path);
    assert.equal(continued.units.U1, await git(task.path, 'rev-parse', 'HEAD'));
    await assert.rejects(f.change({ action: 'late-bind' }, run => f.engine.bind(run, 'T1', task.lease, task.attempt, 'late', 'fixture-model', 'high')), /STALE_LEASE/);
  } finally { await f.close(); }
});


async function finishFixtureTask(f: Awaited<ReturnType<typeof fixture>>, taskId: string) {
  await f.change({ action: 'prepare', taskId }, run => f.engine.prepare(run, taskId));
  const task = f.engine.status(f.created.runId).data.tasks[taskId];
  await f.change({ action: 'bind', taskId }, run => f.engine.bind(run, taskId, task.lease, task.attempt, `native-${taskId}`, 'fixture-model', 'high'));
  await writeFile(join(task.path, task.spec.write_paths[0]), `feature ${taskId}`);
  await f.change({ action: 'validate', taskId }, run => f.engine.validate(run, taskId, task.lease, task.attempt));
  await f.change({ action: 'commit', taskId }, run => f.engine.commit(run, taskId, task.lease, task.attempt, 'U1'));
  await f.change({ action: 'complete', taskId }, async run => f.engine.complete(run, taskId, task.lease, task.attempt, true, await fixtureTaskResult(run, taskId)));
  const expected = await git(f.engine.status(f.created.runId).data.integrationPath, 'rev-parse', 'HEAD');
  await f.change({ action: 'integrate', taskId }, run => f.engine.integrate(run, taskId, expected));
  await f.change({ action: 'verify', taskId }, run => f.engine.verify(run));
}

test('plan worktree creation crash recovers approved plan and does not recreate its branch', async () => {
  const f = await fixture();
  try {
    const save = f.engine.store.save.bind(f.engine.store);
    f.engine.store.save = () => { throw new Error('plan DB crash'); };
    await assert.rejects(f.engine.change(f.created.runId, 'plan-crash', f.engine.status(f.created.runId).version, { tool: 'orch_plan_submit', input: { plan: f.plan, approved: true } }, run => f.engine.plan(run, f.plan, true)), /plan DB crash/);
    f.engine.store.save = save;
    assert.equal(f.engine.status(f.created.runId).data.state, 'PREFLIGHT');
    await f.engine.reconcile(f.created.runId, 'plan-crash', true);
    assert.equal(f.engine.status(f.created.runId).data.state, 'EXECUTING');
    assert.equal(Object.keys(f.engine.status(f.created.runId).data.tasks).length, 2);
  } finally { await f.close(); }
});

test('finding severity cannot be lowered, repair proposes fixes, and independent review verifies them', async () => {
  const f = await fixture();
  try {
    f.plan.tasks = [f.plan.tasks[0]];
    await f.change({ action: 'plan' }, run => f.engine.plan(run, f.plan, true));
    await finishFixtureTask(f, 'T1');
    let current = f.engine.status(f.created.runId).data;
    const finding = { id: 'F1', severity: 'high', category: 'correctness', path: 'T1.txt', symbol: 'feature', line_start: 1, line_end: 1, summary: 'missing requirement', evidence: 'fixture evidence', reproduction: 'fixture command', acceptance: 'feature works', suggested_test: 'assert feature', acceptance_ids: ['AC-1'], status: 'open' };
    const review = { schema_version: 1, reviewed_sha: await git(current.integrationPath, 'rev-parse', 'HEAD'), reviewer_id: 'reviewer', decision: 'changes_requested', findings: [finding], reviewed_areas: ['all'], limitations: [], acceptance_ids: ['AC-1'] };
    await f.change({ action: 'review' }, run => f.engine.review(run, review));
    const repairPlan = { acceptance: f.plan.acceptance, tasks: [{ ...f.plan.tasks[0], id: 'R1', role: 'repair' }] };
    await f.change({ action: 'repair' }, run => f.engine.repair(run, repairPlan, ['F1']));
    assert.equal(f.engine.status(f.created.runId).data.findings[0].lifecycle, 'FIX_PROPOSED');
    await finishFixtureTask(f, 'R1');
    current = f.engine.status(f.created.runId).data;
    review.reviewed_sha = await git(current.integrationPath, 'rev-parse', 'HEAD');
    await assert.rejects(f.change({ action: 'downgrade' }, run => f.engine.review(run, { ...review, decision: 'approved', findings: [{ ...finding, severity: 'low' }] })), /FINDING_SEVERITY_DOWNGRADE/);
    await f.change({ action: 'verified-review' }, run => f.engine.review(run, { ...review, decision: 'approved', findings: [] }));
    assert.equal(f.engine.status(f.created.runId).data.findings[0].lifecycle, 'VERIFIED_FIXED');
    assert.equal(f.engine.status(f.created.runId).data.state, 'FINAL_AUDIT');
  } finally { await f.close(); }
});

test('new worker config revisions preserve already prepared model policy and canonical gate evidence', async () => {
  const f = await fixture();
  try {
    await f.change({ action: 'plan' }, run => f.engine.plan(run, f.plan, true));
    await f.change({ action: 'prepare-first' }, run => f.engine.prepare(run, 'T1'));
    const before = f.engine.status(f.created.runId).data;
    const next = structuredClone(before.config); next.model_selection.profile = 'quality'; next.hosts.codex.roles.coder.effort = 'high';
    f.engine.readConfig = async () => next;
    await f.change({ action: 'prepare-next' }, run => f.engine.prepare(run, 'T2'));
    const run = f.engine.status(f.created.runId).data;
    assert.equal(run.tasks.T1.configRevision, 1); assert.equal(run.tasks.T2.configRevision, 2);
    assert.equal(run.tasks.T1.modelResolution?.requestedEffort, 'auto');
    assert.equal(run.tasks.T2.modelResolution?.requestedEffort, 'high');
    const evidence = run.gates[0].details![0];
    assert.equal(evidence.status, 'passed'); assert.equal(evidence.exitCode, 0); assert.match(evidence.environmentFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(await import('node:fs/promises').then(fs => fs.stat(evidence.logRef)).then(stat => stat.isFile()), true);
  } finally { await f.close(); }
});

test('a different immutable runtime root can read status but cannot resume a pinned run', async () => {
  const f = await fixture();
  let other: Engine | null = null;
  try {
    const { cp, symlink } = await import('node:fs/promises');
    const { fileURLToPath, pathToFileURL } = await import('node:url');
    const source = fileURLToPath(new URL('../../', import.meta.url));
    const copy = join(f.dir, 'other-version'); await mkdir(copy);
    await cp(join(source, 'packages'), join(copy, 'packages'), { recursive: true });
    await symlink(join(source, 'node_modules'), join(copy, 'node_modules'));
    await writeFile(join(copy, 'package.json'), '{"type":"module"}');
    const module = await import(pathToFileURL(join(copy, 'packages/core/src/runtime/engine.ts')).href) as { Engine: typeof Engine };
    other = new module.Engine(join(f.root, '.orch/state/state.db'));
    assert.equal(other.status(f.created.runId).data.id, f.created.runId);
    await assert.rejects(other.change(f.created.runId, 'wrong-version', 0, {}, async () => ({})), /RUNTIME_VERSION_PINNED/);
  } finally { other?.store.close(); await f.close(); }
});

test('retry preserves dirty failed work and committed units while fencing the old attempt', async () => {
  const f = await fixture();
  try {
    f.plan.tasks = [f.plan.tasks[0]];
    f.plan.tasks[0].commit_units.push({ id: 'U2', purpose: 'finish retry' });
    await f.change({ action: 'plan' }, run => f.engine.plan(run, f.plan, true));
    await f.change({ action: 'prepare' }, run => f.engine.prepare(run, 'T1'));
    const old = f.engine.status(f.created.runId).data.tasks.T1;
    await f.change({ action: 'bind' }, run => f.engine.bind(run, 'T1', old.lease, old.attempt, 'first', 'fixture-model', 'high'));
    await writeFile(join(old.path, 'T1.txt'), 'committed unit');
    await f.change({ action: 'validate' }, run => f.engine.validate(run, 'T1', old.lease, old.attempt));
    await f.change({ action: 'commit' }, run => f.engine.commit(run, 'T1', old.lease, old.attempt, 'U1'));
    await writeFile(join(old.path, 'T1.txt'), 'dirty failed attempt');
    await assert.rejects(f.change({ action: 'unsafe-retry' }, run => f.engine.retry(run, 'T1', old.lease, old.attempt, false, 'test failure')), /WORKER_STOP_UNCONFIRMED/);
    await f.change({ action: 'retry' }, run => f.engine.retry(run, 'T1', old.lease, old.attempt, true, 'test failure'));
    await f.change({ action: 'new-attempt' }, run => f.engine.prepare(run, 'T1'));
    const current = f.engine.status(f.created.runId).data.tasks.T1;
    const { readFile } = await import('node:fs/promises');
    assert.notEqual(current.path, old.path);
    assert.equal(await readFile(join(old.path, 'T1.txt'), 'utf8'), 'dirty failed attempt');
    assert.equal(await readFile(join(current.path, 'T1.txt'), 'utf8'), 'committed unit');
    assert.equal(current.units.U1, await git(current.path, 'rev-parse', 'HEAD'));
    await assert.rejects(f.change({ action: 'late-old-result' }, run => f.engine.complete(run, 'T1', old.lease, old.attempt, true)), /STALE_LEASE/);
  } finally { await f.close(); }
});

test('ready wave prioritizes critical path and serializes shared resource ownership', async () => {
  const f = await fixture();
  try {
    f.plan.tasks[0].exclusive_resources.push('shared'); f.plan.tasks[1].exclusive_resources.push('shared');
    f.plan.tasks.push({ ...structuredClone(f.plan.tasks[0]), id: 'T3', depends_on: ['T1'], write_paths: ['T3.txt'], exclusive_resources: [] });
    await f.change({ action: 'plan' }, run => f.engine.plan(run, f.plan, true));
    assert.deepEqual(f.engine.ready(f.engine.status(f.created.runId).data), ['T1']);
    await f.change({ action: 'prepare' }, run => f.engine.prepare(run, 'T1'));
    await assert.rejects(f.change({ action: 'collision' }, run => f.engine.prepare(run, 'T2')), /OWNERSHIP_CONFLICT/);
    await assert.rejects(f.change({ action: 'dependency' }, run => f.engine.prepare(run, 'T3')), /DEPENDENCY_NOT_INTEGRATED/);
  } finally { await f.close(); }
});

test('each mutation verifies the common-dir run lock and an external commit cannot become an engine unit', async () => {
  const f = await fixture();
  try {
    const run = f.engine.status(f.created.runId).data;
    const lock = join(run.commonDir, 'orch/locks/write.json');
    await writeFile(lock, JSON.stringify({ runId: 'another-run' }));
    await assert.rejects(f.change({ action: 'plan-foreign-lock' }, current => f.engine.plan(current, f.plan, true)), /RUN_LOCK_OWNERSHIP_MISMATCH/);
    await writeFile(lock, JSON.stringify({ runId: run.id }));
    await f.change({ action: 'plan' }, current => f.engine.plan(current, f.plan, true));
    await f.change({ action: 'prepare' }, current => f.engine.prepare(current, 'T1'));
    const task = f.engine.status(f.created.runId).data.tasks.T1;
    await f.change({ action: 'bind' }, current => f.engine.bind(current, 'T1', task.lease, task.attempt, 'native', 'fixture-model', 'high'));
    await writeFile(join(task.path, 'T1.txt'), 'feature');
    await f.change({ action: 'validate' }, current => f.engine.validate(current, 'T1', task.lease, task.attempt));
    await git(task.path, 'commit', '--allow-empty', '-m', 'outside engine');
    await assert.rejects(f.change({ action: 'commit' }, current => f.engine.commit(current, 'T1', task.lease, task.attempt, 'U1')), /COMMIT_HEAD_MISMATCH/);
    assert.deepEqual(f.engine.status(f.created.runId).data.tasks.T1.units, {});
  } finally { await f.close(); }
});

test('verified dispatch may bind unobserved model fields as null without claiming model observation', async () => {
  const f = await fixture();
  try {
    await f.change({ action: 'plan' }, run => f.engine.plan(run, f.plan, true));
    await f.change({ action: 'prepare' }, run => f.engine.prepare(run, 'T1'));
    const task = f.engine.status(f.created.runId).data.tasks.T1;
    await f.change({ action: 'unknown-observation' }, run => f.engine.bind(run, 'T1', task.lease, task.attempt, 'native', null, null));
    const bound = f.engine.status(f.created.runId).data.tasks.T1;
    assert.equal(bound.state, 'RUNNING'); assert.equal(bound.observedModel, null); assert.equal(bound.observedEffort, null);
    assert.equal(bound.modelResolution?.resolvedModel, 'fixture-model');
    const { buildReport } = await import('../../packages/core/src/reporting/index.ts');
    const run = f.engine.status(f.created.runId).data;
    run.config.hosts.codex.roles.coder.effort = 'later-profile';
    const report = buildReport(run, 1, null);
    assert.equal(report.tasks[0].requested.effort, 'auto');
    assert.equal(report.tasks[0].selectedModel, 'fixture-model'); assert.equal(report.tasks[0].configRevision, 1);
    assert.equal(report.tasks[0].observedModel, null);
    await f.change({ action: 'prepare-mismatch' }, run => f.engine.prepare(run, 'T2'));
    const mismatched = f.engine.status(f.created.runId).data.tasks.T2;
    const rejected = await f.change({ action: 'wrong-observation' }, run => f.engine.bind(run, 'T2', mismatched.lease, mismatched.attempt, 'wrong-native', 'different-model', 'high'));
    assert.equal(rejected.result.reason, 'MODEL_OBSERVATION_MISMATCH');
    const paused = f.engine.status(f.created.runId).data;
    assert.equal(paused.state, 'PAUSED'); assert.equal(paused.tasks.T2.state, 'ORPHANED_UNKNOWN');
    assert.equal(paused.tasks.T2.observedModel, 'different-model');
  } finally { await f.close(); }
});

test('gate logs reject a linked runs folder without writing outside owned state', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    const { symlink, readdir } = await import('node:fs/promises');
    const external = join(f.dir, 'external'); await mkdir(external);
    await rm(join(f.root, '.orch/state/runs'), { recursive: true });
    await symlink(external, join(f.root, '.orch/state/runs'));
    await assert.rejects(f.change({ action: 'plan' }, run => f.engine.plan(run, f.plan, true)), /STATE_PATH_UNSAFE/);
    assert.deepEqual(await readdir(external), []);
  } finally { await f.close(); }
});

test('run-scoped explicit preapproval permits finalization without another approval after all gates', async () => {
  const f = await fixture();
  try {
    f.plan.tasks = [f.plan.tasks[0]];
    const initial = f.engine.status(f.created.runId).data;
    await assert.rejects(f.change({ action: 'unapproved-policy' }, run => f.engine.preapproveFinalization(run, run.target, false)), /APPROVAL_REQUIRED/);
    await f.change({ action: 'preapprove' }, run => f.engine.preapproveFinalization(run, run.target, true));
    await f.change({ action: 'plan' }, run => f.engine.plan(run, f.plan, true));
    await finishFixtureTask(f, 'T1');
    const current = f.engine.status(f.created.runId).data, sha = await git(current.integrationPath, 'rev-parse', 'HEAD');
    const review = { schema_version: 1, reviewed_sha: sha, reviewer_id: 'reviewer', decision: 'approved', findings: [], reviewed_areas: ['all'], limitations: [], acceptance_ids: ['AC-1'] };
    await f.change({ action: 'review' }, run => f.engine.review(run, review));
    await f.change({ action: 'audit' }, run => f.engine.review(run, { ...review, reviewer_id: 'auditor' }, true));
    await f.change({ action: 'finalize' }, run => f.engine.finalize(run, false, initial.targetBase));
    assert.equal(await git(f.root, 'rev-parse', 'HEAD'), sha);
    assert.equal(f.engine.status(f.created.runId).data.state, 'COMPLETED');
  } finally { await f.close(); }
});

test('explicit pause time is excluded from the active run timeout budget', async context => {
  const start = Date.UTC(2026, 9, 20);
  context.mock.timers.enable({ apis: ['Date'], now: start });
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    f = await fixture(true, { execution: { run_timeout_minutes: 1 } });
    const active = f;
    await f.change({ action: 'plan' }, run => active.engine.plan(run, active.plan, true));
    context.mock.timers.setTime(start + 1000);
    await f.change({ action: 'pause' }, run => active.engine.control(run, 'pause'));
    context.mock.timers.setTime(start + 3_600_000);
    await f.change({ action: 'resume' }, run => active.engine.control(run, 'resume'));
    await f.change({ action: 'prepare' }, run => active.engine.prepare(run, 'T1'));
    const run = f.engine.status(f.created.runId).data;
    assert.equal(run.tasks.T1.state, 'LEASED');
    assert.equal(run.activeTimeMs, 1000); assert.equal(run.pauseTimeMs, 3_599_000);
  } finally { await f?.close(); context.mock.timers.reset(); }
});

test('a failing gate requires explicit scoped approval and remains waived rather than passed', async () => {
  const f = await fixture(true, { quality: { commands: [{ id: 'unit', executable: process.execPath, args: ['-e', 'process.exit(2)'], cwd: '.', stages: ['baseline', 'task', 'integration', 'final'], required: true, timeout_seconds: 5 }] } });
  try {
    await f.change({ action: 'plan' }, run => f.engine.plan(run, f.plan, true));
    assert.equal(f.engine.status(f.created.runId).data.state, 'BLOCKED_BASELINE');
    await assert.rejects(f.change({ action: 'deny' }, run => f.engine.waiveGate(run, 'baseline', 'unit', null, 'known baseline failure', false)), /APPROVAL_REQUIRED/);
    await f.change({ action: 'waive' }, run => f.engine.waiveGate(run, 'baseline', 'unit', null, 'known baseline failure', true));
    await f.change({ action: 'replan' }, run => f.engine.plan(run, f.plan, true));
    const run = f.engine.status(f.created.runId).data;
    assert.equal(run.state, 'EXECUTING'); assert.equal(run.gates.at(-1)?.status, 'waived'); assert.equal(run.gates.at(-1)?.results[0].exitCode, null);
  } finally { await f.close(); }
});

test('repeated findings stop repairs until explicit reanalysis is recorded', async () => {
  const f = await fixture(true, { execution: { max_repeated_finding_rounds: 2 } });
  try {
    f.plan.tasks = [f.plan.tasks[0]];
    await f.change({ action: 'plan' }, run => f.engine.plan(run, f.plan, true));
    await finishFixtureTask(f, 'T1');
    const finding = { id: 'F1', severity: 'high', category: 'correctness', path: 'T1.txt', symbol: 'feature', line_start: 1, line_end: 1, summary: 'missing requirement', evidence: 'fixture evidence', reproduction: 'fixture command', acceptance: 'feature works', suggested_test: 'assert feature', acceptance_ids: ['AC-1'], status: 'open' };
    const review = { schema_version: 1, reviewed_sha: await git(f.engine.status(f.created.runId).data.integrationPath, 'rev-parse', 'HEAD'), reviewer_id: 'reviewer', decision: 'changes_requested', findings: [finding], reviewed_areas: ['all'], limitations: [], acceptance_ids: ['AC-1'] };
    await f.change({ action: 'review' }, run => f.engine.review(run, review));
    const repairPlan = { acceptance: f.plan.acceptance, tasks: [{ ...f.plan.tasks[0], id: 'R1', role: 'repair' }] };
    await f.change({ action: 'repair' }, run => f.engine.repair(run, repairPlan, ['F1']));
    await finishFixtureTask(f, 'R1');
    review.reviewed_sha = await git(f.engine.status(f.created.runId).data.integrationPath, 'rev-parse', 'HEAD');
    await f.change({ action: 'repeat' }, run => f.engine.review(run, review));
    assert.equal(f.engine.status(f.created.runId).data.state, 'BLOCKED_REPEATED_FINDING');
    repairPlan.tasks[0].id = 'R2';
    await assert.rejects(f.change({ action: 'no-analysis' }, run => f.engine.repair(run, repairPlan, ['F1'])), /REANALYSIS_REQUIRED/);
    await f.change({ action: 'reanalyzed' }, run => f.engine.repair(run, repairPlan, ['F1'], 'Prior repair changed the wrong condition; replace the owning branch.'));
    assert.equal(f.engine.status(f.created.runId).data.repairAnalyses?.length, 1);
  } finally { await f.close(); }
});


test('requirements persist before planning and cannot be weakened or replaced after execution starts', async () => {
  const f = await fixture();
  try {
    const run = f.engine.status(f.created.runId).data;
    assert.equal(JSON.parse(await readFile(run.requirementRefs!.json, 'utf8')).acceptance[0].text, 'feature works');
    await assert.rejects(f.change({ action: 'missing' }, async current => { delete current.requirements; return f.engine.plan(current, f.plan, true); }), /REQUIREMENTS_REQUIRED/);
    await assert.rejects(f.change({ action: 'weakened' }, current => f.engine.plan(current, { ...f.plan, acceptance: [{ id: 'AC-1', text: 'weaker' }] }, true)), /REQUIREMENTS_PLAN_MISMATCH/);
    await f.change({ action: 'preview' }, current => f.engine.plan(current, f.plan, false));
    await f.change({ action: 'revise' }, current => f.engine.submitRequirements(current, run.requirements));
    assert.equal(f.engine.status(f.created.runId).data.plan, null);
    await f.change({ action: 'plan' }, current => f.engine.plan(current, f.plan, true));
    await assert.rejects(f.change({ action: 'late-requirements' }, current => f.engine.submitRequirements(current, run.requirements)), /INVALID_RUN_STATE/);
  } finally { await f.close(); }
});


test('missing tests remain blocked without a separate explicit user waiver and are never reported passed', async () => {
  await assert.rejects(fixture(true, { quality: { commands: [] } }), /TRUST_APPROVAL_REQUIRED/);
  await assert.rejects(fixture(true, { quality: { commands: [] } }, tmpdir(), { missingTestsWaiver: { approved: false, reason: 'no tests yet' } }), /APPROVAL_REQUIRED/);
  const f = await fixture(true, { quality: { commands: [] } }, tmpdir(), { missingTestsWaiver: { approved: true, reason: 'No project tests exist; user accepts unverified execution.' } });
  try {
    for (const task of f.plan.tasks) task.verification_ids = ['missing-tests'];
    await f.change({ action: 'plan' }, run => f.engine.plan(run, f.plan, true));
    const run = f.engine.status(f.created.runId).data;
    assert.equal(run.state, 'EXECUTING'); assert.equal(run.gates[0].status, 'waived');
    assert.equal(run.gates[0].details![0].exitCode, null); assert.equal(run.missingTestsWaiver?.actor, 'user');
    const { buildReport } = await import('../../packages/core/src/reporting/index.ts');
    const report = buildReport(run, f.engine.status(run.id).version, null);
    assert.equal(report.completionVerified, false); assert.equal(report.missingTestsWaiver?.reason, run.missingTestsWaiver?.reason);
  } finally { await f.close(); }
});


test('blocked integration tests can retry normally or enter a bounded repair plan', async () => {
  const f = await fixture(true, { quality: { commands: [
    { id: 'unit', executable: process.execPath, args: ['-e', 'process.exit(0)'], cwd: '.', stages: ['baseline', 'task', 'final'], required: true, timeout_seconds: 5 },
    { id: 'integration', executable: process.execPath, args: ['-e', 'process.exit(2)'], cwd: '.', stages: ['integration'], required: true, timeout_seconds: 5 },
  ] } });
  try {
    f.plan.tasks = [f.plan.tasks[0]];
    await f.change({}, run => f.engine.plan(run, f.plan, true));
    await finishFixtureTask(f, 'T1');
    assert.equal(f.engine.status(f.created.runId).data.state, 'BLOCKED_TESTS');
    await f.change({}, async run => { run.config.quality.commands[1].args = ['-e', 'process.exit(0)']; return {}; });
    await f.change({}, run => f.engine.verify(run));
    assert.equal(f.engine.status(f.created.runId).data.state, 'REVIEWING');
    await f.change({}, async run => { run.config.quality.commands[1].args = ['-e', 'process.exit(2)']; return {}; });
    await f.change({}, run => f.engine.verify(run));
    await f.change({}, run => f.engine.repair(run, { acceptance: f.plan.acceptance, tasks: [{ ...f.plan.tasks[0], id: 'R1', role: 'repair' }] }, [], 'Fix failed integration gate.'));
    assert.equal(f.engine.status(f.created.runId).data.state, 'EXECUTING');
    assert.equal(f.engine.status(f.created.runId).data.reviewRound, 1);
  } finally { await f.close(); }
});


test('finalization rejects missing task evidence and review limitations exactly as reporting does', async () => {
  const f = await fixture();
  try {
    f.plan.tasks = [f.plan.tasks[0]];
    await f.change({}, run => f.engine.plan(run, f.plan, true));
    await finishFixtureTask(f, 'T1');
    const current = f.engine.status(f.created.runId).data;
    const review = { schema_version: 1, reviewed_sha: current.integrationSha, reviewer_id: 'reviewer', decision: 'approved', findings: [], reviewed_areas: ['all'], limitations: [], acceptance_ids: ['AC-1'] };
    await f.change({}, run => f.engine.review(run, review));
    await f.change({}, run => f.engine.review(run, { ...review, reviewer_id: 'auditor', limitations: ['acceptance was not executed'] }, true));
    await assert.rejects(f.change({}, run => f.engine.finalize(run, true, run.targetBase)), /COMPLETION_UNVERIFIED/);
    await f.change({}, async run => { run.reviews.at(-1)!.limitations = []; run.tasks.T1.acceptanceEvidence = []; return {}; });
    await assert.rejects(f.change({}, run => f.engine.finalize(run, true, run.targetBase)), /COMPLETION_UNVERIFIED/);
    assert.equal(await git(f.root, 'rev-parse', 'HEAD'), current.targetBase);
  } finally { await f.close(); }
});

test('target drift is merged and invalidates reviews before fresh verification and finalization', async () => {
  const f = await fixture();
  try {
    f.plan.tasks = [f.plan.tasks[0]];
    await f.change({}, run => f.engine.plan(run, f.plan, true));
    await finishFixtureTask(f, 'T1');
    let current = f.engine.status(f.created.runId).data;
    const review = { schema_version: 1, reviewed_sha: current.integrationSha, reviewer_id: 'reviewer', decision: 'approved', findings: [], reviewed_areas: ['all'], limitations: [], acceptance_ids: ['AC-1'] };
    await f.change({}, run => f.engine.review(run, review));
    await f.change({}, run => f.engine.review(run, { ...review, reviewer_id: 'auditor' }, true));
    await writeFile(join(f.root, 'target.txt'), 'concurrent target change');
    await git(f.root, 'add', 'target.txt'); await git(f.root, 'commit', '-m', 'target advanced');
    const target = await git(f.root, 'rev-parse', 'HEAD');
    await assert.rejects(f.change({}, run => f.engine.finalize(run, true, run.targetBase)), /TARGET_DRIFT/);
    const save = f.engine.store.save.bind(f.engine.store);
    f.engine.store.save = () => { throw new Error('reintegrate DB crash'); };
    await assert.rejects(f.engine.change(current.id, 'reintegrate-crash', f.engine.status(current.id).version, { tool: 'orch_reintegrate', input: { expected_target_sha: target } }, run => f.engine.reintegrateTarget(run, target)), /reintegrate DB crash/);
    f.engine.store.save = save;
    await f.engine.reconcile(current.id, 'reintegrate-crash', true);
    current = f.engine.status(f.created.runId).data;
    assert.equal(current.state, 'VERIFYING'); assert.deepEqual(current.reviews, []);
    assert.equal(current.targetBase, target); assert.notEqual(current.integrationSha, review.reviewed_sha);
    assert.equal(await readFile(join(current.integrationPath, 'target.txt'), 'utf8'), 'concurrent target change');
    await f.change({}, run => f.engine.verify(run));
    const updated = { ...review, reviewed_sha: current.integrationSha };
    await f.change({}, run => f.engine.review(run, updated));
    await f.change({}, run => f.engine.review(run, { ...updated, reviewer_id: 'auditor' }, true));
    await f.change({}, run => f.engine.finalize(run, true, target));
    assert.equal(f.engine.status(f.created.runId).data.state, 'COMPLETED');
  } finally { await f.close(); }
});

test('cleanup retries a remaining owned branch after its worktree was already removed', async () => {
  const f = await fixture();
  try {
    await f.change({}, run => f.engine.plan(run, f.plan, true));
    const current = f.engine.status(f.created.runId).data;
    const branch = `orch/${current.id}/conflict/removed-tree`, path = join(current.managedRoot, current.id, 'removed-tree');
    await git(f.root, 'worktree', 'add', '-b', branch, path, current.targetBase);
    await git(f.root, 'worktree', 'remove', path);
    await f.change({}, async run => { run.state = 'COMPLETED'; run.candidates = [{ path, branch }]; return {}; });
    await f.change({}, run => f.engine.cleanup(run, false));
    await assert.rejects(git(f.root, 'show-ref', '--verify', `refs/heads/${branch}`));
    await f.change({}, run => f.engine.cleanup(run, false));
    assert.ok(f.engine.status(current.id).data.cleanup.every(item => ['removed', 'absent'].includes(item.status)));
  } finally { await f.close(); }
});

test('finding dispositions require user approval and reason, preserve audit evidence and require rereview', async () => {
  const f = await fixture();
  try {
    await f.change({}, async run => { run.state = 'REPAIR_PLANNING'; run.findings.push({ id: 'F1', severity: 'high', category: 'correctness', path: 'T1.txt', symbol: 'feature', line_start: 1, line_end: 1, summary: 'risk', evidence: 'fixture', reproduction: 'fixture', acceptance: 'works', suggested_test: 'assert', acceptance_ids: ['AC-1'], status: 'open', fingerprint: 'fixture', lifecycle: 'OPEN' }); return {}; });
    await assert.rejects(f.change({}, run => f.engine.disposeFinding(run, 'F1', 'ACCEPTED_RISK', 'accepted fixture risk', false)), /APPROVAL_REQUIRED/);
    await assert.rejects(f.change({}, run => f.engine.disposeFinding(run, 'F1', 'NOT_A_BUG', ' ', true)), /APPROVAL_REQUIRED/);
    for (const status of ['DEFERRED', 'NOT_A_BUG', 'ACCEPTED_RISK'] as const) {
      await f.change({}, run => f.engine.disposeFinding(run, 'F1', status, 'User reviewed the original evidence.', true));
      const current = f.engine.status(f.created.runId).data;
      assert.equal(current.findings[0].lifecycle, status);
      assert.equal(current.findings[0].dispositions?.at(-1)?.actor, 'user');
      assert.equal(current.state, 'REVIEWING');
      const { findingBlocks } = await import('../../packages/core/src/runtime/completion.ts');
      assert.equal(findingBlocks(current, current.findings[0]), status === 'DEFERRED');
    }
    assert.equal(f.engine.status(f.created.runId).data.findings[0].dispositions?.length, 3);
  } finally { await f.close(); }
});

test('target conflict resolves through the existing stopped-worker path and repeated unchanged findings retain scoped disposition', async () => {
  const f = await fixture();
  try {
    f.plan.tasks = [f.plan.tasks[0]];
    await f.change({}, run => f.engine.plan(run, f.plan, true)); await finishFixtureTask(f, 'T1');
    await writeFile(join(f.root, 'T1.txt'), 'target version'); await git(f.root, 'add', 'T1.txt'); await git(f.root, 'commit', '-m', 'target conflict');
    await f.change({}, async run => f.engine.reintegrateTarget(run, await git(f.root, 'rev-parse', 'HEAD')));
    let current = f.engine.status(f.created.runId).data;
    assert.equal(current.state, 'BLOCKED_CONFLICT'); assert.ok(current.targetConflict);
    await assert.rejects(f.change({}, run => f.engine.resolveConflict(run, false)), /CONFLICT_RESOLUTION_NOT_READY/);
    await writeFile(join(current.targetConflict!.path, 'T1.txt'), 'resolved feature');
    await f.change({}, run => f.engine.resolveConflict(run, true));
    assert.equal(f.engine.status(current.id).data.state, 'VERIFYING');
    await f.change({}, run => f.engine.verify(run)); current = f.engine.status(current.id).data;
    const finding = { id: 'F1', severity: 'high', category: 'correctness', path: 'T1.txt', symbol: 'feature', line_start: 1, line_end: 1, summary: 'known risk', evidence: 'exact fixture evidence', reproduction: 'fixture', acceptance: 'works', suggested_test: 'assert', acceptance_ids: ['AC-1'], status: 'open' };
    const review = { schema_version: 1, reviewed_sha: current.integrationSha, reviewer_id: 'reviewer', decision: 'changes_requested', findings: [finding], reviewed_areas: ['all'], limitations: [], acceptance_ids: ['AC-1'] };
    await f.change({}, run => f.engine.review(run, review));
    await f.change({}, run => f.engine.disposeFinding(run, 'F1', 'ACCEPTED_RISK', 'User accepts the evidenced risk.', true));
    await f.change({}, run => f.engine.review(run, { ...review, decision: 'approved' }));
    assert.equal(f.engine.status(current.id).data.findings[0].lifecycle, 'ACCEPTED_RISK');
    assert.equal(f.engine.status(current.id).data.state, 'FINAL_AUDIT');
    await f.change({}, run => f.engine.review(run, { ...review, reviewer_id: 'auditor', decision: 'approved', findings: [{ ...finding, severity: 'critical' }] }, true));
    assert.equal(f.engine.status(current.id).data.state, 'REPAIR_PLANNING');
  } finally { await f.close(); }
});

test('final gate branch switching cannot finalize an unrelated checkout', async () => {
  const switchCode = "const cp=require('node:child_process');const origin=cp.execFileSync('git',['worktree','list','--porcelain'],{encoding:'utf8'}).split('\\n')[0].slice(9);cp.execFileSync('git',['-C',origin,'switch','-c','other']);";
  const f = await fixture(true, { quality: { commands: [
    { id: 'unit', executable: process.execPath, args: ['-e', 'process.exit(0)'], cwd: '.', stages: ['baseline', 'task', 'integration'], required: true, timeout_seconds: 5 },
    { id: 'switch', executable: process.execPath, args: ['-e', switchCode], cwd: '.', stages: ['final'], required: true, timeout_seconds: 5 },
  ] } });
  try {
    f.plan.tasks = [f.plan.tasks[0]]; await f.change({}, run => f.engine.plan(run, f.plan, true)); await finishFixtureTask(f, 'T1');
    const current = f.engine.status(f.created.runId).data;
    const review = { schema_version: 1, reviewed_sha: current.integrationSha, reviewer_id: 'reviewer', decision: 'approved', findings: [], reviewed_areas: ['all'], limitations: [], acceptance_ids: ['AC-1'] };
    await f.change({}, run => f.engine.review(run, review)); await f.change({}, run => f.engine.review(run, { ...review, reviewer_id: 'auditor' }, true));
    await assert.rejects(f.change({}, run => f.engine.finalize(run, true, run.targetBase)), /TARGET_DRIFT/);
    assert.equal(await git(f.root, 'branch', '--show-current'), 'other');
    assert.equal(await git(f.root, 'rev-parse', 'HEAD'), current.targetBase);
    assert.notEqual(f.engine.status(current.id).data.state, 'COMPLETED');
  } finally { await f.close(); }
});
