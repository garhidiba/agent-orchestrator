import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../packages/core/src/state/store.ts';

test('state survives reopening, rejects stale writes and journals duplicate operations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-state-'));
  let store = new Store(join(dir, 'state.db'));
  try {
    store.create('run', { state: 'CREATED' });
    assert.equal(store.intent('run', 'op', { state: 'PAUSED' }), null);
    assert.equal(store.intent('run', 'op', { state: 'PAUSED' })?.status, 'pending');
    assert.throws(() => store.intent('run', 'op', { state: 'FAILED' }), /IDEMPOTENCY_CONFLICT/);
    store.save('run', 0, { state: 'PAUSED' }, 'run.paused', 'op', { version: 1 });
    assert.throws(() => store.save('run', 0, {}, 'invalid', 'op', {}), /STATE_CONFLICT/);
    assert.deepEqual(store.intent('run', 'op', { state: 'PAUSED' })?.result, { version: 1 });
    store.close(); store = new Store(join(dir, 'state.db'));
    assert.deepEqual(store.get('run'), { version: 1, data: { state: 'PAUSED' } });
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM events').get()?.n, 2);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('idempotency fingerprints ignore JSON property order and missing intents cannot commit state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-state-'));
  const store = new Store(join(dir, 'state.db'));
  try {
    store.create('run', { state: 'CREATED' });
    store.intent('run', 'op', { a: 1, nested: { b: 2, c: 3 } });
    assert.equal(store.intent('run', 'op', { nested: { c: 3, b: 2 }, a: 1 })?.status, 'pending');
    assert.throws(() => store.save('run', 0, { state: 'FAILED' }, 'invalid', 'unknown', {}), /OPERATION_NOT_PENDING/);
    assert.equal(store.get<{ state: string }>('run').data.state, 'CREATED');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
