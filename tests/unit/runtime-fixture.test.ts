import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runtimeFixture } from '../fixtures/runtime.ts';

test('runtime fixture cleans only its owned resources on setup failure and normal teardown', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'orch-harness-parent-'));
  try {
    await assert.rejects(runtimeFixture(true, { execution: { max_parallel_workers: 0 } }, parent));
    assert.deepEqual(await readdir(parent), []);
    const fixture = await runtimeFixture(false, {}, parent);
    assert.equal(fixture.backend, 'unverified'); await fixture.close();
    assert.deepEqual(await readdir(parent), []);
  } finally { await rm(parent, { recursive: true, force: true }); }
});
