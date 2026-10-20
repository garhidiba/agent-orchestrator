import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../../packages/core/src/runtime/engine.ts';
import { resolveConfig } from '../../packages/core/src/config/index.ts';
import { hash } from '../../packages/core/src/state/store.ts';
import { git } from '../../packages/core/src/git/repository.ts';

async function fixture(native = true) {
  const dir = await mkdtemp(join(tmpdir(), 'orch-engine-')), root = join(dir, 'repo');
  await mkdir(root); await git(root, 'init'); await git(root, 'config', 'user.name', 'ORCH Test'); await git(root, 'config', 'user.email', 'test@example.invalid');
  await writeFile(join(root, '.gitignore'), '.orch/state/\n'); await writeFile(join(root, 'base'), 'base');
  await git(root, 'add', '.gitignore', 'base'); await git(root, 'commit', '-m', 'base');
  const config = resolveConfig({ project: { quality: { commands: [{ id: 'unit', executable: process.execPath, args: ['-e', 'process.exit(0)'], cwd: '.', stages: ['baseline', 'task', 'integration', 'final'], required: true, timeout_seconds: 5 }] } } }).config;
  const engine = new Engine(join(root, '.orch/state/state.db'), native ? { host: 'codex', model: 'fixture-model', effort: 'high', evidence: ['test-fixture'], verified: true, contextMatches: true } : null);
  const created = await engine.create(root, config, 'codex', join(dir, 'managed'), hash(config.quality.commands));
  let op = 0;
  const change = (input: object, fn: Parameters<Engine['change']>[4]) => engine.change(created.runId, `op-${++op}`, engine.status(created.runId).version, input, fn);
  const plan = { acceptance: [{ id: 'AC-1', text: 'feature works' }], tasks: ['T1', 'T2'].map(task => ({ id: task, title: task, role: 'coder', depends_on: [], acceptance_ids: ['AC-1'], read_paths: [], write_paths: [`${task}.txt`], exclusive_resources: [], risk: 'low', complexity: 'low', verification_ids: ['unit'], commit_units: [{ id: 'U1', purpose: `implement ${task}` }] })) };
  return { dir, root, engine, created, change, plan, async close() { engine.store.close(); await rm(dir, { recursive: true, force: true }); } };
}

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
      await f.change({ action: 'complete', taskId }, run => f.engine.complete(run, taskId, task.lease, task.attempt, true));
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
    await f.change({ action: 'cleanup' }, run => f.engine.cleanup(run, false));
    assert.equal(f.engine.status(f.created.runId).data.cleanup.every(item => item.status === 'removed'), true);
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
