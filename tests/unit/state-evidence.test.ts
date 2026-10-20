import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../packages/core/src/state/store.ts';

test('config, catalog and attempt snapshots are immutable across mutations and reopening', () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-snapshots-'));
  let store = new Store(join(root, 'state.db'));
  try {
    store.create('run', { state: 'EXECUTING' });
    const config = { model: 'specific', roles: { coder: 'high' } };
    const receipt = store.snapshot('run', 'config', 'revision-1', config);
    store.snapshot('run', 'catalog', 'catalog-1', { models: ['specific'], access: 'unknown' });
    store.snapshot('run', 'attempt', 'task-1', { configHash: receipt.hash, nativeId: null });
    config.roles.coder = 'low';
    assert.equal((store.snapshots('run')[0]?.value as typeof config).roles.coder, 'high');
    assert.throws(() => store.snapshot('run', 'config', 'revision-1', config), /SNAPSHOT_CONFLICT/);
    assert.equal(store.snapshot('run', 'config', 'revision-1', { roles: { coder: 'high' }, model: 'specific' }).hash, receipt.hash);
    assert.throws(() => store.snapshot('missing', 'config', 'revision-1', config), /RUN_NOT_FOUND/);
    store.close(); store = new Store(join(root, 'state.db'));
    assert.equal(store.snapshots('run').length, 3);
    assert.equal(store.snapshots('run')[0]?.hash, receipt.hash);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('semantic events commit with the state and failed writes leave no partial event trail', () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-events-')), store = new Store(join(root, 'state.db'));
  try {
    const initial = { state: 'EXECUTING', configRevision: 1, tasks: { task: { state: 'LEASED', attempt: 1, nativeId: null as string | null, units: {} as Record<string, string>, modelResolution: { resolvedModel: 'specific', resolvedEffort: 'high' } } }, reviews: [] as { reviewer: string; sha: string; final: boolean }[], findings: [] as { id: string; lifecycle: string }[], gates: [] as { status: string; task: string | null }[] };
    store.create('run', initial);
    const next = structuredClone(initial);
    next.configRevision = 2; next.tasks.task.state = 'RUNNING'; next.tasks.task.nativeId = 'native-1';
    next.tasks.task.units.unit = 'abc';
    next.reviews.push({ reviewer: 'reviewer-1', sha: 'abc', final: false });
    next.findings.push({ id: 'finding-1', lifecycle: 'OPEN' });
    next.gates.push({ status: 'failed', task: 'task' });
    store.intent('run', 'bind', {});
    store.save('run', 0, next, 'run.changed', 'bind', {});
    const types = store.events('run').map(event => event.type);
    for (const expected of ['config.changed', 'task.started', 'model.observed', 'task.committed', 'review.completed', 'finding.opened', 'task.validation_failed']) assert.ok(types.includes(expected), expected);
    const before = store.events('run');
    assert.throws(() => store.save('run', 1, { ...next, state: 'BLOCKED_TESTS' }, 'run.changed', 'missing', {}), /OPERATION_NOT_PENDING/);
    assert.deepEqual(store.events('run'), before);
    assert.equal(store.get<{ state: string }>('run').data.state, 'EXECUTING');
    assert.ok(before.every((event, index) => index === 0 || event.sequence > before[index - 1]!.sequence));
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('immutable snapshots retain source identity while excluding secrets and raw prompt fields', () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-secret-snapshot-')), store = new Store(join(root, 'state.db'));
  try {
    store.create('run', { state: 'EXECUTING' });
    const result = store.snapshot('run', 'config', 'revision-1', { args: ['--token', 'private-value', '--flag'], api_key: 'other-secret', fencingToken: 3, rawPrompt: 'uncollected transcript' });
    assert.equal(result.redacted, true);
    assert.deepEqual(result.value, { args: ['--token', '[REDACTED]', '--flag'], api_key: '[REDACTED]', fencingToken: 3, rawPrompt: '[NOT COLLECTED]' });
    assert.throws(() => store.snapshot('run', 'config', 'revision-1', { args: ['--token', 'changed-private-value', '--flag'], api_key: 'other-secret', fencingToken: 3, rawPrompt: 'uncollected transcript' }), /SNAPSHOT_CONFLICT/);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});


test('additive snapshots keep the version-two consumer format writable without losing evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-v2-consumer-')), path = join(root, 'state.db');
  let store = new Store(path);
  try {
    store.create('run', { state: 'EXECUTING', runtimeRoot: '/immutable/old-bundle' });
    const snapshot = store.snapshot('run', 'config', 'revision-1', { model: 'pinned' });
    store.close();
    const legacy = new DatabaseSync(path);
    try {
      // The baseline bundle refuses newer metadata before executing these unchanged SQL contracts.
      assert.ok((legacy.prepare('SELECT version FROM metadata').get()!.version as number) <= 2);
      const row = legacy.prepare('SELECT version,data FROM runs WHERE id=?').get('run')!;
      const data = JSON.parse(row.data as string); data.state = 'PAUSED';
      legacy.prepare('UPDATE runs SET version=version+1,data=? WHERE id=? AND version=?').run(JSON.stringify(data), 'run', row.version!);
      legacy.exec('UPDATE metadata SET version=2');
    } finally { legacy.close(); }
    store = new Store(path);
    assert.equal(store.get<{ state: string }>('run').data.state, 'PAUSED');
    assert.deepEqual(store.snapshots('run'), [snapshot]);
  } finally { if (store.db.isOpen) store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('known additive version-three state normalizes to two while retaining every stored row and extension table', () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-v3-compatible-')), path = join(root, 'state.db');
  let store = new Store(path);
  try {
    store.create('run', { state: 'EXECUTING' });
    const snapshot = store.snapshot('run', 'attempt', 'attempt-1', { nativeId: null });
    store.intent('run', 'pending-operation', { task: 'T1' });
    store.db.exec("CREATE TABLE extension(value TEXT); INSERT INTO extension VALUES('keep'); UPDATE metadata SET version=3");
    const events = store.events('run'), pending = store.pending('run');
    store.close(); store = new Store(path);
    assert.equal(store.db.prepare('SELECT version FROM metadata').get()!.version, 2);
    assert.deepEqual(store.snapshots('run'), [snapshot]);
    assert.deepEqual(store.events('run'), events); assert.deepEqual(store.pending('run'), pending);
    assert.equal(store.get<{ state: string }>('run').data.state, 'EXECUTING');
    assert.equal(store.db.prepare('SELECT value FROM extension').get()!.value, 'keep');
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
