import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../packages/core/src/state/store.ts';
import { exportRunEvidence } from '../../packages/core/src/runtime/snapshots.ts';

test('audit artifacts are regenerated from a consistent persisted run and preserve historical revisions', async () => {
  const origin = await realpath(await mkdtemp(join(tmpdir(), 'orch-evidence-'))), store = new Store(join(origin, '.orch/state/state.db'));
  try {
    store.create('run-1', { state: 'EXECUTING', requirements: { goals: ['ship the change'], in_scope: ['one path'], out_of_scope: ['provider runs'] }, plan: { tasks: [{ id: 'task-1', title: 'implement' }] } });
    store.snapshot('run-1', 'config', 'revision-1', { model: 'first' });
    store.snapshot('run-1', 'config', 'revision-2', { model: 'second' });
    const first = await exportRunEvidence(store, origin, 'run-1');
    assert.deepEqual(JSON.parse(await readFile(first.resolvedConfig!, 'utf8')), { model: 'second' });
    assert.equal(JSON.parse(await readFile(first.snapshots, 'utf8')).snapshots.length, 2);
    const event = JSON.parse((await readFile(first.events, 'utf8')).trim());
    assert.equal(event.type, 'run.created'); assert.equal(event.runId, 'run-1');
    store.intent('run-1', 'pause', {}); store.save('run-1', 0, { state: 'PAUSED' }, 'run.paused', 'pause', {});
    const second = await exportRunEvidence(store, origin, 'run-1');
    assert.equal(second.version, 1);
    assert.equal((await readFile(second.events, 'utf8')).trim().split('\n').length, 3);
    assert.equal(store.snapshots('run-1').length, 2);
    assert.match(await readFile(first.request!, 'utf8'), /Structured request summary/);
    assert.match(await readFile(first.request!, 'utf8'), /ship the change/);
    assert.deepEqual(JSON.parse(await readFile(first.plan!, 'utf8')), { tasks: [{ id: 'task-1', title: 'implement' }] });
  } finally { store.close(); await rm(origin, { recursive: true, force: true }); }
});
