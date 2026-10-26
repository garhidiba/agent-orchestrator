import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runtimeFixture } from '../fixtures/runtime.ts';
import { hash } from '../../packages/core/src/state/store.ts';

const confirmation = { approved: true, reason: 'Discard stopped smoke run; preserve its files', previous_coordinator_stopped: true, stopped_agents: [], never_started_tasks: [], never_started_reviews: [] };

test('explicit abandonment releases a pinned run without executing its old runtime and fences subsequent writes', async () => {
  const f = await runtimeFixture();
  try {
    const pinned = f.engine.runtimeRoot;
    f.engine.runtimeRoot = '/different-installed-runtime/';
    await assert.rejects(f.change({}, run => f.engine.control(run, 'cancel')), /RUNTIME_VERSION_PINNED/);
    const operation = 'abandon-stopped-run', version = f.engine.status(f.created.runId).version;
    const result = await f.engine.abandon(f.created.runId, operation, version, confirmation);
    assert.equal(result.result.state, 'CANCELLED');
    const archived = f.engine.status(f.created.runId);
    assert.equal(archived.data.runtimeRoot, pinned);
    assert.equal(archived.data.abandonment?.reason, confirmation.reason);
    const created = await f.engine.create(f.root, archived.data.config, 'codex', join(f.dir, 'managed'), hash(archived.data.config.quality.commands));
    assert.notEqual(created.runId, f.created.runId);
    const lock = join(archived.data.commonDir, 'orch/locks/write.json');
    const newerLock = await readFile(lock, 'utf8');
    assert.equal(JSON.parse(newerLock).runId, created.runId);
    await assert.rejects(f.engine.abandon(f.created.runId, operation, version, { ...confirmation, reason: 'different request' }), /IDEMPOTENCY_CONFLICT/);
    assert.deepEqual(await f.engine.abandon(f.created.runId, operation, version, confirmation), result);
    assert.equal(await readFile(lock, 'utf8'), newerLock);
    f.engine.runtimeRoot = pinned;
    await assert.rejects(f.change({}, run => f.engine.control(run, 'resume')), /RUN_LOCK_OWNERSHIP_MISMATCH/);
  } finally { await f.close(); }
});

test('abandonment requires real stop confirmations and preserves dirty worktrees', async () => {
  const f = await runtimeFixture();
  try {
    f.plan.tasks = [f.plan.tasks[0]];
    await f.change({}, run => f.engine.plan(run, f.plan, true));
    await f.change({}, run => f.engine.prepare(run, 'T1'));
    const task = f.engine.status(f.created.runId).data.tasks.T1;
    await f.change({}, run => f.engine.bind(run, 'T1', task.lease, task.attempt, 'native-worker', null, null));
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(task.path, 'T1.txt'), 'preserved user work\n');
    f.engine.runtimeRoot = '/different-installed-runtime/';
    let op = 0;
    const abandon = (input: unknown) => f.engine.abandon(f.created.runId, `abandon-${++op}`, f.engine.status(f.created.runId).version, input);
    await assert.rejects(abandon({ ...confirmation, approved: false }));
    await assert.rejects(abandon({ ...confirmation, previous_coordinator_stopped: false }));
    await assert.rejects(abandon(confirmation), /WORKER_STOP_UNCONFIRMED/);
    await assert.rejects(abandon({ ...confirmation, never_started_tasks: ['T1'] }), /WORKER_STOP_UNCONFIRMED/);
    await abandon({ ...confirmation, stopped_agents: ['native-worker'] });
    assert.equal(await readFile(join(task.path, 'T1.txt'), 'utf8'), 'preserved user work\n');
    assert.equal(f.engine.status(f.created.runId).data.tasks.T1.state, 'STOPPED');
  } finally { await f.close(); }
});

test('a committed abandonment can retry lock release after interruption without rerunning the mutation', async () => {
  const f = await runtimeFixture();
  try {
    const save = f.engine.store.save.bind(f.engine.store);
    f.engine.store.save = (...args) => { save(...args); throw new Error('SIMULATED_INTERRUPTION'); };
    const version = f.engine.status(f.created.runId).version;
    await assert.rejects(f.engine.abandon(f.created.runId, 'interrupted-abandon', version, confirmation), /SIMULATED_INTERRUPTION/);
    assert.equal(JSON.parse(await readFile(join(f.root, '.git/orch/locks/write.json'), 'utf8')).runId, f.created.runId);
    f.engine.store.save = save;
    const result = await f.engine.abandon(f.created.runId, 'interrupted-abandon', version, confirmation);
    assert.equal(result.result.abandoned, true);
    const run = f.engine.status(f.created.runId);
    assert.equal(run.version, version + 1);
    await f.engine.create(f.root, run.data.config, 'codex', join(f.dir, 'managed'), hash(run.data.config.quality.commands));
  } finally { await f.close(); }
});

test('confirmed cancellation frees the writer lock while uncertain cancellation keeps it', async () => {
  const f = await runtimeFixture();
  try {
    f.plan.tasks = [f.plan.tasks[0]];
    await f.change({}, run => f.engine.plan(run, f.plan, true));
    await f.change({}, run => f.engine.prepare(run, 'T1'));
    const task = f.engine.status(f.created.runId).data.tasks.T1;
    await f.change({}, run => f.engine.bind(run, 'T1', task.lease, task.attempt, 'cancel-worker', null, null));
    await writeFile(join(task.path, 'wip.txt'), 'uncommitted work'); // a clean merged worktree is swept by the next run; unfinished work must survive
    await f.change({}, run => f.engine.control(run, 'cancel'));
    const config = f.engine.status(f.created.runId).data.config;
    await assert.rejects(f.engine.create(f.root, config, 'codex', join(f.dir, 'managed'), hash(config.quality.commands)), /REPOSITORY_RUN_LOCKED/);
    await f.change({}, run => f.engine.control(run, 'cancel', ['cancel-worker']));
    assert.equal(f.engine.status(f.created.runId).data.tasks.T1.state, 'STOPPED');
    await f.engine.create(f.root, config, 'codex', join(f.dir, 'managed'), hash(config.quality.commands));
    assert.equal(await readFile(join(task.path, 'wip.txt'), 'utf8'), 'uncommitted work');
  } finally { await f.close(); }
});

test('finalization releases the writer lock before cleanup and old cleanup preserves the next run lock', async () => {
  const f = await runtimeFixture();
  try {
    f.plan.tasks = [f.plan.tasks[0]];
    await f.change({}, run => f.engine.plan(run, f.plan, true));
    await f.change({}, run => f.engine.prepare(run, 'T1'));
    const task = f.engine.status(f.created.runId).data.tasks.T1;
    await f.change({}, run => f.engine.bind(run, 'T1', task.lease, task.attempt, 'finish-worker', null, null));
    const { writeFile } = await import('node:fs/promises');
    const { fixtureTaskResult } = await import('../fixtures/runtime.ts');
    const { git } = await import('../../packages/core/src/git/repository.ts');
    await writeFile(join(task.path, 'T1.txt'), 'completed work\n');
    await f.change({}, run => f.engine.validate(run, 'T1', task.lease, task.attempt));
    await f.change({}, run => f.engine.commit(run, 'T1', task.lease, task.attempt, 'U1'));
    await f.change({}, async run => f.engine.complete(run, 'T1', task.lease, task.attempt, true, await fixtureTaskResult(run, 'T1')));
    await f.change({}, run => f.engine.integrate(run, 'T1', run.integrationSha!));
    await f.change({}, run => f.engine.verify(run));
    for (const final of [false, true]) await f.change({}, run => f.engine.review(run, { schema_version: 1, reviewed_sha: run.integrationSha, reviewer_id: final ? 'final-reviewer' : 'independent-reviewer', decision: 'approved', findings: [], reviewed_areas: ['T1.txt'], limitations: [], acceptance_ids: ['AC-1'] }, final));
    await f.change({}, run => f.engine.finalize(run, true, run.targetBase));
    assert.equal(await git(task.path, 'rev-parse', 'HEAD'), f.engine.status(f.created.runId).data.tasks.T1.units.U1);
    const config = f.engine.status(f.created.runId).data.config;
    const created = await f.engine.create(f.root, config, 'codex', join(f.dir, 'managed'), hash(config.quality.commands));
    const lock = join(f.root, '.git/orch/locks/write.json'), nextLock = await readFile(lock, 'utf8');
    const before = f.engine.status(f.created.runId);
    const save = f.engine.store.save.bind(f.engine.store);
    f.engine.store.save = () => { throw new Error('SIMULATED_CLEANUP_INTERRUPTION'); };
    await assert.rejects(f.engine.change(f.created.runId, 'old-cleanup', before.version, { tool: 'orch_cleanup', input: { dry_run: false } }, run => f.engine.cleanup(run, false)), /SIMULATED_CLEANUP_INTERRUPTION/);
    f.engine.store.save = save;
    await f.engine.reconcile(f.created.runId, 'old-cleanup', true);
    assert.equal(await readFile(lock, 'utf8'), nextLock);
    assert.equal(JSON.parse(nextLock).runId, created.runId);
  } finally { await f.close(); }
});

test('pending administrative disposal reconciles on a new runtime without relaxing ordinary runtime pins', async () => {
  const f = await runtimeFixture();
  try {
    f.engine.runtimeRoot = '/different-installed-runtime/';
    const save = f.engine.store.save.bind(f.engine.store);
    f.engine.store.save = () => { throw new Error('SIMULATED_BEFORE_SAVE'); };
    const before = f.engine.status(f.created.runId);
    await assert.rejects(f.engine.abandon(f.created.runId, 'pending-abandon', before.version, confirmation), /SIMULATED_BEFORE_SAVE/);
    f.engine.store.save = save;
    const result = await f.engine.reconcile(f.created.runId, 'pending-abandon', true);
    assert.equal((result.result as { state: string }).state, 'CANCELLED');
    const run = f.engine.status(f.created.runId);
    await f.engine.create(f.root, run.data.config, 'codex', join(f.dir, 'managed'), hash(run.data.config.quality.commands));
  } finally { await f.close(); }
});

test('explicit forced disposal fences the old run while preserving uncertain agents, pending evidence and files', async () => {
  const f = await runtimeFixture();
  try {
    f.plan.tasks = [f.plan.tasks[0]];
    await f.change({}, run => f.engine.plan(run, f.plan, true));
    await f.change({}, run => f.engine.prepare(run, 'T1'));
    const task = f.engine.status(f.created.runId).data.tasks.T1;
    await f.change({}, run => f.engine.bind(run, 'T1', task.lease, task.attempt, 'unknown-worker', null, null));
    const { mkdir, writeFile } = await import('node:fs/promises');
    await writeFile(join(task.path, 'T1.txt'), 'unfinished work\n');
    const version = f.engine.status(f.created.runId).version;
    f.engine.store.intent(f.created.runId, 'old-interrupted-operation', { tool: 'orch_task_commit' });
    await mkdir(join(f.root, '.git/orch/locks/operation'));
    await assert.rejects(f.engine.abandon(f.created.runId, 'wrong-version-force', version + 1, { ...confirmation, force: true }), /STATE_CONFLICT/);
    const result = await f.engine.abandon(f.created.runId, 'force-dispose', version, { ...confirmation, force: true });
    assert.equal(result.result.state, 'CANCELLED');
    const run = f.engine.status(f.created.runId).data;
    assert.equal(run.tasks.T1.state, 'ORPHANED_UNKNOWN');
    assert.equal(run.abandonment?.forced, true);
    assert.deepEqual(run.abandonment?.unresolvedOperations, ['old-interrupted-operation']);
    assert.equal(await readFile(join(task.path, 'T1.txt'), 'utf8'), 'unfinished work\n');
    await f.engine.create(f.root, run.config, 'codex', join(f.dir, 'managed'), hash(run.config.quality.commands));
    await assert.rejects(f.engine.reconcile(f.created.runId, 'old-interrupted-operation', true), /LOCK_OWNERSHIP_MISMATCH/);
  } finally { await f.close(); }
});

test('force never releases a foreign run lock or breaks its operation mutex', async () => {
  const f = await runtimeFixture();
  try {
    const { mkdir, writeFile, stat } = await import('node:fs/promises');
    const lock = join(f.root, '.git/orch/locks/write.json'), mutex = join(f.root, '.git/orch/locks/operation');
    const foreign = JSON.stringify({ runId: 'different-run', origin: f.root });
    await writeFile(lock, foreign); await mkdir(mutex);
    await assert.rejects(f.engine.abandon(f.created.runId, 'foreign-force', f.engine.status(f.created.runId).version, { ...confirmation, force: true }), /RUN_LOCK_OWNERSHIP_MISMATCH/);
    assert.equal(await readFile(lock, 'utf8'), foreign);
    assert.equal((await stat(mutex)).isDirectory(), true);
    assert.equal(f.engine.status(f.created.runId).data.abandonment, undefined);
  } finally { await f.close(); }
});

test('authenticated MCP abandonment validates the full envelope before changing state', async () => {
  const f = await runtimeFixture();
  const { createServer } = await import('../../packages/mcp-server/src/server.ts');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const tokenPath = join(f.dir, 'coordinator.token');
  const server = await createServer(f.root, 'codex', join(f.dir, 'managed'), tokenPath);
  const client = new Client({ name: 'abandon-envelope-regression', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a); await client.connect(b);
    const before = f.engine.status(f.created.runId);
    const result = await client.callTool({ name: 'orch_run_abandon', arguments: { protocol_version: 1, run_id: f.created.runId, operation_id: 'malformed-abandon', expected_state_version: before.version, coordinator_token: await readFile(tokenPath, 'utf8'), lease_id: 'unpaired', input: confirmation } });
    assert.equal(result.isError, true);
    assert.deepEqual(f.engine.status(f.created.runId), before);
  } finally { await client.close(); await server.close(); await f.close(); }
});
