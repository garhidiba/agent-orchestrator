import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { git } from '../../packages/core/src/git/repository.ts';
import { fixtureTaskResult } from '../fixtures/runtime.ts';
import { runtimeFixture } from '../fixtures/runtime.ts';

test('approved paused plan amendment records revisions and preserves the initial contract', async () => {
  const f = await runtimeFixture();
  try {
    await f.change({ action: 'plan' }, run => f.engine.plan(run, f.plan, true));
    await f.change({ action: 'pause' }, run => f.engine.control(run, 'pause'));
    const next = structuredClone(f.plan);
    next.tasks[0].write_paths.push('additional.txt');
    await f.change({ tool: 'orch_plan_amend', input: { plan: next, approved: true, reason: 'User approved additional output ownership' } },
      run => f.engine.amendPlan(run, { plan: next, approved: true, reason: 'User approved additional output ownership' }));
    const amended = f.engine.status(f.created.runId).data;
    assert.equal(amended.state, 'PAUSED');
    assert.deepEqual(amended.tasks.T1.spec.write_paths, ['T1.txt', 'additional.txt']);
    const revisions = f.engine.store.snapshots(amended.id).filter(item => item.kind === 'plan');
    assert.deepEqual(revisions.map(item => item.key), ['revision-1', 'revision-2']);
    assert.deepEqual((revisions[0].value as { plan: unknown }).plan, f.plan);
    assert.deepEqual((revisions[1].value as { plan: unknown }).plan, next);
    await f.change({ action: 'resume' }, run => f.engine.control(run, 'resume'));
    assert.equal(f.engine.status(amended.id).data.state, 'EXECUTING');
  } finally { await f.close(); }
});

test('public amendment tool authenticates, enforces CAS and rejects invalid contracts without changing revisions', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { createServer } = await import('../../packages/mcp-server/src/server.ts');
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const f = await runtimeFixture();
  const tokenPath = join(f.dir, 'coordinator.token');
  const server = await createServer(f.root, 'codex', join(f.dir, 'managed'), tokenPath);
  const client = new Client({ name: 'plan-amendment-contract', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a); await client.connect(b);
    await f.change({ action: 'plan' }, run => f.engine.plan(run, f.plan, true));
    await f.change({ action: 'pause' }, run => f.engine.control(run, 'pause'));
    const before = f.engine.status(f.created.runId);
    const next = structuredClone(f.plan); next.tasks[0].write_paths.push('extra.txt');
    const request = { coordinator_token: await readFile(tokenPath, 'utf8'), protocol_version: 1, run_id: f.created.runId, operation_id: 'amend-valid', expected_state_version: before.version, input: { plan: next, approved: true, reason: 'Approved scope expansion' } };
    for (const [suffix, overrides, error] of [
      ['auth', { coordinator_token: 'wrong' }, 'COORDINATOR_RELAY_REQUIRED'],
      ['cas', { expected_state_version: before.version - 1 }, 'STATE_CONFLICT'],
      ['approval', { input: { ...request.input, approved: false } }, null],
      ['reason', { input: { ...request.input, reason: ' ' } }, null],
      ['acceptance', { input: { ...request.input, plan: { ...next, acceptance: [{ id: 'AC-1', text: 'Changed requirement' }] } } }, 'REQUIREMENTS_PLAN_MISMATCH'],
      ['ownership', { input: { ...request.input, plan: { ...next, tasks: next.tasks.map(task => ({ ...task, write_paths: ['shared.txt'] })) } } }, 'OWNERSHIP_CONFLICT'],
      ['dag', { input: { ...request.input, plan: { ...next, tasks: next.tasks.map(task => ({ ...task, depends_on: [task.id] })) } } }, 'DAG_CYCLE'],
      ['gate', { input: { ...request.input, plan: { ...next, tasks: next.tasks.map(task => ({ ...task, verification_ids: ['unknown'] })) } } }, 'UNKNOWN_VERIFICATION'],
    ] as const) {
      const result = await client.callTool({ name: 'orch_plan_amend', arguments: { ...request, operation_id: `amend-${suffix}`, ...overrides } });
      assert.equal(result.isError, true, suffix);
      if (error) assert.match(JSON.stringify(result), new RegExp(error));
      assert.deepEqual(f.engine.status(f.created.runId), before);
      assert.equal(f.engine.store.snapshots(f.created.runId).filter(item => item.kind === 'plan').length, 1);
    }
    const result = await client.callTool({ name: 'orch_plan_amend', arguments: request });
    assert.notEqual(result.isError, true);
    assert.equal(f.engine.status(f.created.runId).data.planRevision, 2);
    const replay = await client.callTool({ name: 'orch_plan_amend', arguments: request });
    assert.deepEqual(replay, result);
    assert.equal(f.engine.store.snapshots(f.created.runId).filter(item => item.kind === 'plan').length, 2);
  } finally { await client.close(); await server.close(); await f.close(); }
});

test('pause alone does not authorize changing a worker lease; confirmed stopped worker can expand ownership', async () => {
  const f = await runtimeFixture();
  try {
    await f.change({ action: 'plan' }, run => f.engine.plan(run, f.plan, true));
    await f.change({ action: 'prepare' }, run => f.engine.prepare(run, 'T1'));
    const task = f.engine.status(f.created.runId).data.tasks.T1;
    await writeFile(join(task.path, 'extra.txt'), 'preserved stopped work');
    const next = structuredClone(f.plan); next.tasks[0].write_paths.push('extra.txt');
    const input = { plan: next, approved: true, reason: 'Approved ownership expansion' };
    await assert.rejects(f.change({ action: 'amend-running' }, run => f.engine.amendPlan(run, input)), /INVALID_RUN_STATE/);
    await f.change({ action: 'pause' }, run => f.engine.control(run, 'pause'));
    await assert.rejects(f.change({ action: 'amend-orphan' }, run => f.engine.amendPlan(run, input)), /WORKER_STOP_UNCONFIRMED/);
    await f.change({ action: 'retry-stopped' }, run => f.engine.retry(run, 'T1', task.lease, task.attempt, true, 'Host confirmed stopped'));
    await assert.rejects(f.change({ action: 'amend-outside' }, run => f.engine.amendPlan(run, { ...input, plan: f.plan })), /OWNERSHIP_VIOLATION/);
    await f.change({ action: 'amend' }, run => f.engine.amendPlan(run, input));
    assert.equal(f.engine.status(f.created.runId).data.tasks.T1.path, task.path);
    assert.equal(f.engine.status(f.created.runId).data.tasks.T1.attempt, 1);
    assert.deepEqual(f.engine.status(f.created.runId).data.tasks.T1.spec.write_paths, ['T1.txt', 'extra.txt']);
    assert.equal(await readFile(join(task.path, 'extra.txt'), 'utf8'), 'preserved stopped work');
    const evidence = f.engine.store.snapshots(f.created.runId).find(item => item.kind === 'plan' && item.key === 'revision-2')!.value as { previousTasks: Record<string, { spec: { write_paths: string[] } }> };
    assert.deepEqual(evidence.previousTasks.T1.spec.write_paths, ['T1.txt']);
  } finally { await f.close(); }
});

test('committed and integrated task contracts and results remain immutable; live review leases block amendments', async () => {
  const f = await runtimeFixture();
  try {
    f.plan.tasks = [f.plan.tasks[0]];
    await f.change({ action: 'plan' }, run => f.engine.plan(run, f.plan, true));
    await f.change({ action: 'prepare' }, run => f.engine.prepare(run, 'T1'));
    const task = f.engine.status(f.created.runId).data.tasks.T1;
    await f.change({ action: 'bind' }, run => f.engine.bind(run, 'T1', task.lease, task.attempt, 'writer', 'fixture-model', 'high'));
    await writeFile(join(task.path, 'T1.txt'), 'committed feature');
    await f.change({ action: 'validate' }, run => f.engine.validate(run, 'T1', task.lease, task.attempt));
    await f.change({ action: 'commit' }, run => f.engine.commit(run, 'T1', task.lease, task.attempt, 'U1'));
    await f.change({ action: 'complete' }, async run => f.engine.complete(run, 'T1', task.lease, task.attempt, true, await fixtureTaskResult(run, 'T1')));
    const next = structuredClone(f.plan); next.tasks[0].write_paths.push('extra.txt');
    const input = { plan: next, approved: true, reason: 'Approved scope amendment' };
    await f.change({ action: 'pause-committed' }, run => f.engine.control(run, 'pause'));
    await assert.rejects(f.change({ action: 'amend-committed' }, run => f.engine.amendPlan(run, input)), /TASK_EVIDENCE_IMMUTABLE/);
    await f.change({ action: 'resume' }, run => f.engine.control(run, 'resume'));
    await f.change({ action: 'integrate' }, async run => f.engine.integrate(run, 'T1', await git(run.integrationPath, 'rev-parse', 'HEAD')));
    await f.change({ action: 'pause-integrated' }, run => f.engine.control(run, 'pause'));
    await assert.rejects(f.change({ action: 'amend-integrated' }, run => f.engine.amendPlan(run, input)), /TASK_EVIDENCE_IMMUTABLE/);
    await f.change({ action: 'resume-verify' }, run => f.engine.control(run, 'resume'));
    await f.change({ action: 'verify' }, run => f.engine.verify(run));
    const dispatch = await f.change({ action: 'prepare-review' }, run => f.engine.prepareReview(run, 'reviewer'));
    await f.change({ action: 'pause-review' }, run => f.engine.control(run, 'pause'));
    const expanded = { ...f.plan, tasks: [...f.plan.tasks, { ...f.plan.tasks[0], id: 'T2', write_paths: ['T2.txt'] }] };
    await assert.rejects(f.change({ action: 'amend-review-active' }, run => f.engine.amendPlan(run, { ...input, plan: expanded })), /REVIEW_STOP_UNCONFIRMED/);
    await f.change({ action: 'stop-review' }, run => f.engine.stopReview(run, dispatch.result.dispatchId, true, null));
    const before = f.engine.status(f.created.runId).data.tasks.T1;
    await f.change({ action: 'amend-stopped-review' }, run => f.engine.amendPlan(run, { ...input, plan: expanded }));
    assert.deepEqual(f.engine.status(f.created.runId).data.tasks.T1, before);
    await f.change({ action: 'resume-added-task' }, run => f.engine.control(run, 'resume'));
    assert.equal(f.engine.status(f.created.runId).data.state, 'EXECUTING');
  } finally { await f.close(); }
});

test('amendment interrupted after immutable snapshot reconciles once without rewriting prior revisions', async () => {
  const f = await runtimeFixture();
  try {
    await f.change({ action: 'plan' }, run => f.engine.plan(run, f.plan, true));
    await f.change({ action: 'pause' }, run => f.engine.control(run, 'pause'));
    const next = structuredClone(f.plan); next.tasks[0].write_paths.push('extra.txt');
    const input = { plan: next, approved: true, reason: 'Approved additional output' };
    const request = { tool: 'orch_plan_amend', input };
    const before = f.engine.status(f.created.runId), save = f.engine.store.save.bind(f.engine.store);
    f.engine.store.save = () => { throw new Error('simulated save interruption'); };
    await assert.rejects(f.engine.change(f.created.runId, 'amend-crash', before.version, request, run => f.engine.amendPlan(run, input)), /simulated save interruption/);
    f.engine.store.save = save;
    assert.equal(f.engine.status(f.created.runId).data.planRevision, 1);
    const evidence = f.engine.store.snapshots(f.created.runId).filter(item => item.kind === 'plan');
    await f.engine.reconcile(f.created.runId, 'amend-crash', true);
    assert.equal(f.engine.status(f.created.runId).data.planRevision, 2);
    assert.deepEqual(f.engine.store.snapshots(f.created.runId).filter(item => item.kind === 'plan'), evidence);
    await f.engine.change(f.created.runId, 'amend-crash', before.version, request, async () => { throw new Error('must not replay'); });
    assert.equal(f.engine.status(f.created.runId).data.planRevision, 2);
  } finally { await f.close(); }
});

test('a paused unapproved draft cannot bypass initial plan approval and baseline creation', async () => {
  const f = await runtimeFixture();
  try {
    await f.change({ action: 'draft' }, run => f.engine.plan(run, f.plan, false));
    await f.change({ action: 'pause-draft' }, run => f.engine.control(run, 'pause'));
    await assert.rejects(f.change({ action: 'amend-draft' }, run => f.engine.amendPlan(run, { plan: f.plan, approved: true, reason: 'Must use initial approval first' })), /INVALID_RUN_STATE/);
    assert.deepEqual(f.engine.status(f.created.runId).data.tasks, {});
    assert.equal(f.engine.store.snapshots(f.created.runId).filter(item => item.kind === 'plan').length, 0);
  } finally { await f.close(); }
});
