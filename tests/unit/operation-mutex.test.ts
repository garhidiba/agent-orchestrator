import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, rm, rmdir, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Engine } from '../../packages/core/src/runtime/engine.ts';
import { hash } from '../../packages/core/src/state/store.ts';
import { runtimeFixture, fixtureTaskResult } from '../fixtures/runtime.ts';

const exec = promisify(execFile);
const approval = { approved: true, reason: 'Disposable stopped coordinator', previous_coordinator_stopped: true, stopped_agents: [], never_started_tasks: [], never_started_reviews: [] };

async function readyToFinalize(f: Awaited<ReturnType<typeof runtimeFixture>>) {
  f.plan.tasks = [f.plan.tasks[0]];
  await f.change({}, run => f.engine.plan(run, f.plan, true));
  await f.change({}, run => f.engine.prepare(run, 'T1'));
  const task = f.engine.status(f.created.runId).data.tasks.T1;
  await f.change({}, run => f.engine.bind(run, 'T1', task.lease, task.attempt, 'fixture-worker', null, null));
  await writeFile(join(task.path, 'T1.txt'), 'completed\n');
  await f.change({}, run => f.engine.validate(run, 'T1', task.lease, task.attempt));
  await f.change({}, run => f.engine.commit(run, 'T1', task.lease, task.attempt, 'U1'));
  await f.change({}, async run => f.engine.complete(run, 'T1', task.lease, task.attempt, true, await fixtureTaskResult(run, 'T1')));
  await f.change({}, run => f.engine.integrate(run, 'T1', run.integrationSha!));
  await f.change({}, run => f.engine.verify(run));
  for (const final of [false, true]) await f.change({}, run => f.engine.review(run, { schema_version: 1, reviewed_sha: run.integrationSha, reviewer_id: final ? 'audit' : 'review', decision: 'approved', findings: [], reviewed_areas: ['T1.txt'], limitations: [], acceptance_ids: ['AC-1'] }, final));
}

for (const kind of ['finalize', 'cancel', 'abandon', 'force'] as const) test(`durable ${kind} recovers across runtime upgrades after process exit without replaying effects`, async () => {
  const f = await runtimeFixture();
  try {
    if (kind === 'finalize') await readyToFinalize(f);
    if (kind === 'force') f.engine.store.intent(f.created.runId, 'older-pending', { tool: 'orch_task_commit' });
    const before = f.engine.status(f.created.runId), operation = `crashed-${kind}`;
    const child = `import { Engine } from ${JSON.stringify(new URL('../../packages/core/src/runtime/engine.ts', import.meta.url).href)};
      const e = new Engine(process.argv[1]); const save = e.store.save.bind(e.store);
      e.store.save = (...args) => { save(...args); process.exit(86); };
      const [run, op, version, kind, approval] = process.argv.slice(2);
      if (kind === 'abandon' || kind === 'force') await e.abandon(run, op, Number(version), { ...JSON.parse(approval), force: kind === 'force' });
      else await e.change(run, op, Number(version), { tool: kind === 'finalize' ? 'orch_finalize' : 'orch_control' }, data => kind === 'finalize' ? e.finalize(data, true, data.targetBase) : e.control(data, 'cancel'));`;
    await assert.rejects(exec(process.execPath, ['--input-type=module', '-e', child, join(f.root, '.orch/state/state.db'), f.created.runId, operation, String(before.version), kind, JSON.stringify(approval)]), (error: unknown) => (error as { code: number }).code === 86);
    const committed = f.engine.status(f.created.runId);
    const events = f.engine.store.events(f.created.runId);
    const cached = JSON.parse(f.engine.store.operation(f.created.runId, operation)!.result as string) as unknown;
    assert.equal(committed.data.state, kind === 'finalize' ? 'COMPLETED' : 'CANCELLED');
    await assert.rejects(f.engine.reconcile(f.created.runId, operation, false), /COORDINATOR_STOP_UNCONFIRMED/);
    const runtime = f.engine.runtimeRoot;
    f.engine.runtimeRoot = '/different-runtime/';
    // Empty legacy mutexes remain recoverable when the target still owns write.json.
    if (kind === 'cancel') {
      const mutex = join(f.root, '.git/orch/locks/operation');
      for (const marker of await readdir(mutex)) await rmdir(join(mutex, marker));
    }
    const result = await f.engine.reconcile(f.created.runId, operation, true);
    f.engine.runtimeRoot = runtime;
    assert.deepEqual(result, cached);
    assert.deepEqual(f.engine.store.events(f.created.runId), events);
    assert.equal(result.version, committed.version);
    assert.deepEqual(f.engine.status(f.created.runId), committed);
    await assert.rejects(stat(join(f.root, '.git/orch/locks/operation')), { code: 'ENOENT' });
    const newer = await f.engine.create(f.root, committed.data.config, 'codex', join(f.dir, 'managed'), hash(committed.data.config.quality.commands));
    assert.notEqual(newer.runId, f.created.runId);
    const newerLock = await readFile(join(f.root, '.git/orch/locks/write.json'), 'utf8');
    assert.deepEqual(await f.engine.reconcile(f.created.runId, operation, true), result);
    assert.equal(await readFile(join(f.root, '.git/orch/locks/write.json'), 'utf8'), newerLock);
    if (kind === 'force') assert.deepEqual(f.engine.store.pending(f.created.runId).map(item => item.id), ['older-pending']);
  } finally { await f.close(); }
});

test('old cleanup reconciliation preserves a newer live operation and legacy foreign mutex', async () => {
  const f = await runtimeFixture();
  let next: Engine | undefined, release: (() => void) | undefined;
  try {
    await readyToFinalize(f);
    await f.change({}, run => f.engine.finalize(run, true, run.targetBase));
    const old = f.engine.status(f.created.runId), save = f.engine.store.save.bind(f.engine.store);
    f.engine.store.save = () => { throw new Error('BEFORE_SAVE'); };
    await assert.rejects(f.engine.change(f.created.runId, 'old-cleanup', old.version, { tool: 'orch_cleanup', input: { dry_run: false } }, run => f.engine.cleanup(run, false)), /BEFORE_SAVE/);
    f.engine.store.save = save;
    const newer = await f.engine.create(f.root, old.data.config, 'codex', join(f.dir, 'managed'), hash(old.data.config.quality.commands));
    const lock = join(f.root, '.git/orch/locks/write.json'), mutex = join(f.root, '.git/orch/locks/operation'), owner = await readFile(lock, 'utf8');
    next = new Engine(join(f.root, '.orch/state/state.db'));
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    const live = next.change(newer.runId, 'live-operation', newer.version, {}, async () => { entered(); await held; return 'finished'; });
    try {
      await started;
      await assert.rejects(f.engine.reconcile(f.created.runId, 'old-cleanup', true), /OPERATION_LOCKED/);
      assert.equal((await stat(mutex)).isDirectory(), true);
      assert.equal(await readFile(lock, 'utf8'), owner);
    } finally { release!(); await live; }
    await mkdir(mutex);
    await assert.rejects(f.engine.reconcile(f.created.runId, 'old-cleanup', true), /OPERATION_LOCKED/);
    assert.equal((await stat(mutex)).isDirectory(), true);
    assert.equal(await readFile(lock, 'utf8'), owner);
  } finally { release?.(); next?.store.close(); await f.close(); }
});

test('forced disposal cannot break a foreign marked mutex even when the target owns write.json', async () => {
  const f = await runtimeFixture();
  try {
    const mutex = join(f.root, '.git/orch/locks/operation');
    await mkdir(mutex);
    const foreign = `owner-${hash('foreign-run')}-${hash('foreign-operation')}-00000000-0000-0000-0000-000000000000`;
    await mkdir(join(mutex, foreign));
    await assert.rejects(f.engine.abandon(f.created.runId, 'force-disposal', f.engine.status(f.created.runId).version, { ...approval, force: true }), /OPERATION_LOCKED/);
    assert.deepEqual(await readdir(mutex), [foreign]);
    assert.equal(f.engine.status(f.created.runId).data.abandonment, undefined);
  } finally { await f.close(); }
});

test('process exit while removing the released owner marker never leaves the global mutex blocked', async () => {
  const f = await runtimeFixture();
  try {
    const before = f.engine.status(f.created.runId);
    const child = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module'; import { basename } from 'node:path';
      import { Engine } from ${JSON.stringify(new URL('../../packages/core/src/runtime/engine.ts', import.meta.url).href)};
      for (const method of ['rm', 'rmdir']) {
        const remove = fs.promises[method];
        fs.promises[method] = async (path, ...args) => { const result = await remove(path, ...args); if (basename(path).startsWith('owner')) process.exit(86); return result; };
      }
      syncBuiltinESMExports();
      const e = new Engine(process.argv[1]);
      await e.change(process.argv[2], 'release-crash', Number(process.argv[3]), { tool: 'orch_control' }, run => e.control(run, 'cancel'));`;
    await assert.rejects(exec(process.execPath, ['--input-type=module', '-e', child, join(f.root, '.orch/state/state.db'), f.created.runId, String(before.version)]), (error: unknown) => (error as { code: number }).code === 86);
    assert.equal(f.engine.status(f.created.runId).data.state, 'CANCELLED');
    await assert.rejects(stat(join(f.root, '.git/orch/locks/write.json')), { code: 'ENOENT' });
    await f.engine.reconcile(f.created.runId, 'release-crash', true);
    const created = await f.engine.create(f.root, before.data.config, 'codex', join(f.dir, 'managed'), hash(before.data.config.quality.commands));
    const changed = await f.engine.change(created.runId, 'new-operation', created.version, {}, async () => 'finished');
    assert.equal(changed.result, 'finished');
  } finally { await f.close(); }
});

test('ordinary pending recovery remains pinned across runtime upgrades', async () => {
  const f = await runtimeFixture();
  try {
    const before = f.engine.status(f.created.runId);
    f.engine.store.intent(f.created.runId, 'pending-ordinary', { tool: 'orch_task_commit' }, before);
    const pending = f.engine.store.pending(f.created.runId);
    const lock = join(f.root, '.git/orch/locks/write.json'), owner = await readFile(lock, 'utf8');
    f.engine.runtimeRoot = '/different-runtime/';
    await assert.rejects(f.engine.reconcile(f.created.runId, 'pending-ordinary', true), /RUNTIME_VERSION_PINNED/);
    assert.deepEqual(f.engine.status(f.created.runId), before);
    assert.deepEqual(f.engine.store.pending(f.created.runId), pending);
    assert.equal(await readFile(lock, 'utf8'), owner);
  } finally { await f.close(); }
});

for (const stage of ['mutex retirement', 'write-lock release'] as const) test(`duplicate recovery cannot replace ownership during ${stage}`, async () => {
  const f = await runtimeFixture(), rename = fs.rename, remove = fs.rm;
  let release: (() => void) | undefined, second: Engine | undefined;
  let earlier: Promise<unknown> | undefined;
  try {
    const before = f.engine.status(f.created.runId);
    const child = `import { Engine } from ${JSON.stringify(new URL('../../packages/core/src/runtime/engine.ts', import.meta.url).href)};
      const e = new Engine(process.argv[1]), save = e.store.save.bind(e.store);
      e.store.save = (...args) => { save(...args); process.exit(86); };
      await e.abandon(process.argv[2], 'duplicate-recovery', Number(process.argv[3]), JSON.parse(process.argv[4]));`;
    await assert.rejects(exec(process.execPath, ['--input-type=module', '-e', child, join(f.root, '.orch/state/state.db'), f.created.runId, String(before.version), JSON.stringify(approval)]), (error: unknown) => (error as { code: number }).code === 86);
    const mutex = join(f.engine.status(f.created.runId).data.commonDir, 'orch/locks/operation');
    let entered!: () => void, first = true;
    const paused = new Promise<void>(resolve => { entered = resolve; }), hold = new Promise<void>(resolve => { release = resolve; });
    fs.rename = async (source, target) => {
      if (stage === 'mutex retirement' && first && source === mutex) { first = false; entered(); await hold; }
      return rename(source, target);
    };
    const writeLock = join(f.engine.status(f.created.runId).data.commonDir, 'orch/locks/write.json');
    fs.rm = async (path, options) => {
      if (stage === 'write-lock release' && first && path === writeLock) { first = false; entered(); await hold; }
      return remove(path, options);
    };
    syncBuiltinESMExports();
    earlier = f.engine.reconcile(f.created.runId, 'duplicate-recovery', true);
    await Promise.race([paused, earlier.then(() => { throw new Error('RETIRE_BARRIER_NOT_REACHED'); })]);
    second = new Engine(join(f.root, '.orch/state/state.db'));
    await assert.rejects(second.reconcile(f.created.runId, 'duplicate-recovery', true), /OPERATION_LOCKED/);
    const markers = await readdir(mutex);
    assert.equal(markers.length, 1);
    assert.equal(JSON.parse(await readFile(join(f.root, '.git/orch/locks/write.json'), 'utf8')).runId, f.created.runId);
    release!(); await earlier;
    const old = f.engine.status(f.created.runId);
    const created = await second.create(f.root, old.data.config, 'codex', join(f.dir, 'managed'), hash(old.data.config.quality.commands));
    const newOwner = await readFile(writeLock, 'utf8');
    assert.equal((await second.change(created.runId, 'new-operation', created.version, {}, async () => 'finished')).result, 'finished');
    assert.equal(await readFile(writeLock, 'utf8'), newOwner);
  } finally {
    fs.rename = rename; fs.rm = remove; syncBuiltinESMExports(); release?.();
    await earlier?.catch(() => {}); second?.store.close(); await f.close();
  }
});

test('mutex maintenance refuses an unowned guard database without altering run state', async () => {
  const f = await runtimeFixture();
  try {
    const guard = new DatabaseSync(join(f.root, '.git/orch/locks/operation-guard.db'));
    guard.exec('PRAGMA application_id=99'); guard.close();
    const before = f.engine.status(f.created.runId);
    await assert.rejects(f.change({}, run => f.engine.control(run, 'cancel')), /OPERATION_LOCK_UNSAFE/);
    assert.deepEqual(f.engine.status(f.created.runId), before);
  } finally { await f.close(); }
});

for (const kind of ['plan', 'commit'] as const) test(`durable ${kind} recovers mid-run after process exit and continues the same run`, async () => {
  const f = await runtimeFixture();
  try {
    if (kind === 'commit') {
      await f.change({}, run => f.engine.plan(run, f.plan, true));
      await f.change({}, run => f.engine.prepare(run, 'T1'));
      const task = f.engine.status(f.created.runId).data.tasks.T1;
      await f.change({}, run => f.engine.bind(run, 'T1', task.lease, task.attempt, 'fixture-worker', null, null));
      await writeFile(join(task.path, 'T1.txt'), 'committed work\n');
      await f.change({}, run => f.engine.validate(run, 'T1', task.lease, task.attempt));
    }
    const before = f.engine.status(f.created.runId), operation = `midrun-${kind}`;
    const child = `import { Engine } from ${JSON.stringify(new URL('../../packages/core/src/runtime/engine.ts', import.meta.url).href)};
      const e = new Engine(process.argv[1]), save = e.store.save.bind(e.store);
      e.store.save = (...args) => { save(...args); process.exit(86); };
      const [runId, operation, version, kind, plan] = process.argv.slice(2);
      await e.change(runId, operation, Number(version), { tool: kind === 'plan' ? 'orch_plan_submit' : 'orch_task_commit' }, async run => {
        if (kind === 'plan') return e.plan(run, JSON.parse(plan), true);
        const task = run.tasks.T1; return e.commit(run, 'T1', task.lease, task.attempt, 'U1');
      });`;
    await assert.rejects(exec(process.execPath, ['--input-type=module', '-e', child, join(f.root, '.orch/state/state.db'), f.created.runId, operation, String(before.version), kind, JSON.stringify(f.plan)]), (error: unknown) => (error as { code: number }).code === 86);
    const committed = f.engine.status(f.created.runId), record = f.engine.store.operation(f.created.runId, operation), events = f.engine.store.events(f.created.runId);
    assert.equal(committed.data.state, 'EXECUTING');
    const lock = join(f.root, '.git/orch/locks/write.json'), owner = await readFile(lock, 'utf8'), runtime = f.engine.runtimeRoot;
    f.engine.runtimeRoot = '/different-runtime/';
    assert.deepEqual(await f.engine.reconcile(f.created.runId, operation, true), JSON.parse(record!.result as string));
    assert.deepEqual(f.engine.status(f.created.runId), committed);
    assert.deepEqual(f.engine.store.operation(f.created.runId, operation), record);
    assert.deepEqual(f.engine.store.events(f.created.runId), events);
    assert.equal(await readFile(lock, 'utf8'), owner);
    await assert.rejects(f.engine.create(f.root, committed.data.config, 'codex', join(f.dir, 'managed'), hash(committed.data.config.quality.commands)), /REPOSITORY_RUN_LOCKED/);
    f.engine.runtimeRoot = runtime;
    await f.change({}, run => f.engine.prepare(run, 'T2'));
    assert.equal(f.engine.status(f.created.runId).data.tasks.T2.state, 'LEASED');
    assert.equal(JSON.parse(await readFile(lock, 'utf8')).runId, f.created.runId);
  } finally { await f.close(); }
});

test('owner release retries a briefly busy maintenance guard without replaying its mutation', async () => {
  const f = await runtimeFixture();
  let guard: DatabaseSync | undefined;
  try {
    const before = f.engine.status(f.created.runId);
    let mutations = 0, settled = false;
    const operation = f.change({}, async () => {
      mutations++;
      guard = new DatabaseSync(join(f.root, '.git/orch/locks/operation-guard.db'));
      guard.exec('BEGIN IMMEDIATE');
      return 'saved';
    }).finally(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(f.engine.status(f.created.runId).version, before.version + 1);
    assert.equal(settled, false);
    guard!.exec('ROLLBACK'); guard!.close(); guard = undefined;
    assert.equal((await operation).result, 'saved');
    assert.equal(mutations, 1);
    await f.change({}, async () => 'next operation');
  } finally { if (guard) { guard.exec('ROLLBACK'); guard.close(); } await f.close(); }
});

for (const dangling of [false, true]) test(`mutex maintenance rejects a ${dangling ? 'dangling' : 'resolved'} guard symlink before mutation`, async () => {
  const f = await runtimeFixture();
  try {
    const guard = join(f.root, '.git/orch/locks/operation-guard.db'), target = join(f.dir, 'foreign-guard');
    const bytes = 'foreign file must remain unchanged';
    if (!dangling) await writeFile(target, bytes);
    await rm(guard); await symlink(target, guard);
    const before = f.engine.status(f.created.runId), events = f.engine.store.events(f.created.runId);
    const lock = join(f.root, '.git/orch/locks/write.json'), owner = await readFile(lock, 'utf8');
    await assert.rejects(f.engine.change(f.created.runId, 'guard-symlink', before.version, {}, run => f.engine.control(run, 'cancel')), /OPERATION_LOCK_UNSAFE/);
    assert.deepEqual(f.engine.status(f.created.runId), before);
    assert.deepEqual(f.engine.store.events(f.created.runId), events);
    assert.equal(f.engine.store.operation(f.created.runId, 'guard-symlink'), undefined);
    assert.equal(await readFile(lock, 'utf8'), owner);
    if (dangling) await assert.rejects(stat(target), { code: 'ENOENT' });
    else assert.equal(await readFile(target, 'utf8'), bytes);
  } finally { await f.close(); }
});
