import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeStateDirectory, writeStateArtifact } from '../../packages/core/src/state/artifacts.ts';

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-artifacts-')));
  const origin = join(root, 'repo'), outside = join(root, 'outside');
  await mkdir(origin); await mkdir(outside);
  return { root, origin, outside };
}
test('state artifacts use fixed run paths and atomically replace regular files', async () => {
  const f = await fixture();
  try {
    const directory = await safeStateDirectory(f.origin, 'run-1', 'logs');
    assert.equal(directory, join(f.origin, '.orch/state/runs/run-1/logs'));
    const file = await writeStateArtifact(f.origin, 'run-1', 'unit.log', 'first', 'logs');
    await writeStateArtifact(f.origin, 'run-1', 'unit.log', 'second', 'logs');
    assert.equal(await readFile(file, 'utf8'), 'second');
    assert.deepEqual(await readdir(directory), ['unit.log']);
    await assert.rejects(writeStateArtifact(f.origin, '../outside', 'unit.log', 'bad'));
    await assert.rejects(writeStateArtifact(f.origin, 'run-1', '../outside', 'bad'));
    await assert.rejects(safeStateDirectory(f.origin, 'run-1', '../outside' as 'logs'));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('every state directory component rejects symlinks without creating external paths', async () => {
  for (const tail of ['.orch', '.orch/state', '.orch/state/runs', '.orch/state/runs/run-1', '.orch/state/runs/run-1/logs']) {
    const f = await fixture();
    try {
      const link = join(f.origin, tail);
      await mkdir(join(link, '..'), { recursive: true });
      await symlink(f.outside, link);
      await assert.rejects(writeStateArtifact(f.origin, 'run-1', 'marker.log', 'bad', 'logs'), /STATE_PATH_UNSAFE/);
      assert.deepEqual(await readdir(f.outside), []);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
});
test('artifact symlinks and directories cannot replace an external or unknown target', async () => {
  const f = await fixture();
  try {
    const directory = await safeStateDirectory(f.origin, 'run-1');
    const victim = join(f.outside, 'private'); await writeFile(victim, 'untouched');
    await symlink(victim, join(directory, 'requirements.json'));
    await assert.rejects(writeStateArtifact(f.origin, 'run-1', 'requirements.json', 'bad'), /STATE_PATH_UNSAFE/);
    assert.equal(await readFile(victim, 'utf8'), 'untouched');
    await mkdir(join(directory, 'requirements.md'));
    await assert.rejects(writeStateArtifact(f.origin, 'run-1', 'requirements.md', 'bad'), /STATE_PATH_UNSAFE/);
    const alias = join(f.root, 'alias'); await symlink(f.origin, alias);
    await assert.rejects(safeStateDirectory(alias, 'run-1'), /STATE_PATH_UNSAFE/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
