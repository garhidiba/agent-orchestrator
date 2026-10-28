import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runtimeFixture, fixtureTaskResult } from '../fixtures/runtime.ts';
import { git } from '../../packages/core/src/git/repository.ts';

async function queuedFixture() {
  const f = await runtimeFixture(true, { quality: { commands: [{ id: 'unit', executable: process.execPath,
    args: ['-e', "const fs=require('node:fs');fs.appendFileSync(process.env.ORCH_QUEUED_COUNTER,'ran\\n');if(process.env.ORCH_QUEUED_OUTCOME==='fail')process.exit(7);if(process.env.ORCH_QUEUED_OUTCOME==='source-change')fs.writeFileSync('T1.txt','changed during gate\\n');"],
    cwd: '.', stages: ['baseline', 'task', 'integration', 'final'], required: true, timeout_seconds: 5 }] } });
  const counter = join(f.dir, 'gate-counter.log');
  const previous = { ORCH_QUEUED_COUNTER: process.env.ORCH_QUEUED_COUNTER, ORCH_QUEUED_OUTCOME: process.env.ORCH_QUEUED_OUTCOME };
  process.env.ORCH_QUEUED_COUNTER = counter; process.env.ORCH_QUEUED_OUTCOME = 'initial';
  const close = async () => {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await f.close();
  };
  try {
    await f.change({}, run => f.engine.plan(run, f.plan, true));
    const prepared = await f.change({}, run => f.engine.prepare(run, 'T1'));
    const { leaseId, fencingToken, worktreePath } = prepared.result;
    await f.change({}, run => f.engine.bind(run, 'T1', leaseId, fencingToken, 'stopped-worker', null, null));
    await writeFile(join(worktreePath, 'T1.txt'), 'completed feature\n');
    await f.change({}, run => f.engine.validate(run, 'T1', leaseId, fencingToken));
    await f.change({}, run => f.engine.commit(run, 'T1', leaseId, fencingToken, 'U1'));
    await f.change({}, async run => f.engine.complete(run, 'T1', leaseId, fencingToken, true, await fixtureTaskResult(run, 'T1')));
    await f.change({}, async run => { run.tasks.T1.expires = 0; run.tasks.T1.deadline = 1; });
    return { ...f, close, executions: async () => (await readFile(counter, 'utf8')).trim().split('\n').length };
  } catch (error) { await close(); throw error; }
}

test('integrating a stopped stale queued result reruns its real trusted gate without renewing its expired lease', async () => {
  const f = await queuedFixture();
  try {
    const before = f.engine.status(f.created.runId), count = await f.executions();
    process.env.ORCH_QUEUED_OUTCOME = 'new-host-environment';
    await f.change({}, run => f.engine.integrate(run, 'T1', run.integrationSha!));
    const after = f.engine.status(f.created.runId).data;
    assert.equal(after.tasks.T1.state, 'INTEGRATED');
    assert.equal(await f.executions(), count + 1);
    assert.equal(after.gates.at(-1)!.status, 'passed');
    assert.deepEqual(after.gates.slice(0, before.data.gates.length), before.data.gates);
    assert.equal(after.tasks.T1.expires, 0);
    assert.equal(after.tasks.T1.deadline, 1);
    assert.equal(after.tasks.T1.attempt, before.data.tasks.T1.attempt);
  } finally { await f.close(); }
});

for (const outcome of ['fail', 'source-change'] as const) test(`a queued refresh ${outcome} retains gate evidence and never merges`, async () => {
  const f = await queuedFixture();
  try {
    if (outcome === 'fail') await f.change({}, run => f.engine.waiveGate(run, 'task', 'unit', 'T1', 'existing scoped waiver must not replace a real refresh', true));
    const before = f.engine.status(f.created.runId), count = await f.executions();
    process.env.ORCH_QUEUED_OUTCOME = outcome;
    await f.change({}, run => f.engine.integrate(run, 'T1', run.integrationSha!));
    const after = f.engine.status(f.created.runId).data, gate = after.gates.at(-1)!;
    assert.equal(gate.status, outcome === 'fail' ? 'failed' : 'source_changed');
    assert.equal(await f.executions(), count + 1);
    assert.equal(after.tasks.T1.state, 'MERGE_QUEUED');
    assert.equal(after.tasks.T1.expires, 0);
    assert.equal(after.tasks.T1.deadline, 1);
    assert.deepEqual(after.gates.slice(0, before.data.gates.length), before.data.gates);
    assert.equal(await git(after.integrationPath, 'rev-parse', 'HEAD'), before.data.integrationSha);
    assert.deepEqual(after.candidates, before.data.candidates);
    if (outcome === 'fail') {
      assert.equal(gate.details![0].exitCode, 7);
      assert.equal(gate.details![0].status, 'failed');
      assert.equal(gate.details![0].waiverReason, null);
    }
  } finally { await f.close(); }
});

for (const invalid of ['dirty', 'foreign'] as const) test(`a ${invalid} queued result fails before any refresh command executes`, async () => {
  const f = await queuedFixture();
  try {
    const before = f.engine.status(f.created.runId), task = before.data.tasks.T1, count = await f.executions();
    await writeFile(join(task.path, 'T1.txt'), 'unapproved modification\n');
    if (invalid === 'foreign') {
      await git(task.path, 'add', 'T1.txt'); await git(task.path, 'commit', '-m', 'foreign commit');
    }
    process.env.ORCH_QUEUED_OUTCOME = 'changed-environment';
    await assert.rejects(f.change({}, run => f.engine.integrate(run, 'T1', run.integrationSha!)), invalid === 'dirty' ? /DIRTY_CHECKOUT/ : /UNTRACKED_COMMIT/);
    assert.equal(await f.executions(), count);
    assert.deepEqual(f.engine.status(f.created.runId), before);
    assert.equal(await git(before.data.integrationPath, 'rev-parse', 'HEAD'), before.data.integrationSha);
  } finally { await f.close(); }
});

test('a fresh queued result integrates without another task gate even after its worker lease expires', async () => {
  const f = await queuedFixture();
  try {
    const before = f.engine.status(f.created.runId), count = await f.executions();
    await f.change({}, run => f.engine.integrate(run, 'T1', run.integrationSha!));
    const after = f.engine.status(f.created.runId).data;
    assert.equal(after.tasks.T1.state, 'INTEGRATED');
    assert.equal(await f.executions(), count);
    assert.deepEqual(after.gates, before.data.gates);
  } finally { await f.close(); }
});

for (const invalid of ['wrong-sha', 'dirty', 'branch'] as const) test(`a stale queued gate rejects ${invalid} integration without commands or pending operations`, async () => {
  const f = await queuedFixture();
  try {
    const before = f.engine.status(f.created.runId), count = await f.executions();
    if (invalid === 'dirty') await writeFile(join(before.data.integrationPath, 'unapproved.txt'), 'dirty integration\n');
    if (invalid === 'branch') await git(before.data.integrationPath, 'switch', '-c', 'unowned-integration');
    process.env.ORCH_QUEUED_OUTCOME = 'new-host-environment';
    const expected = invalid === 'wrong-sha' ? '0'.repeat(40) : before.data.integrationSha!;
    await assert.rejects(f.change({}, run => f.engine.integrate(run, 'T1', expected)), invalid === 'dirty' ? /DIRTY_CHECKOUT/ : /INTEGRATION_DRIFT/);
    assert.equal(await f.executions(), count);
    assert.deepEqual(f.engine.status(f.created.runId), before);
    assert.equal(f.engine.store.pending(f.created.runId).length, 0);
  } finally { await f.close(); }
});
