import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, inspectRepository, owns, overlaps, changedPaths, sourceFingerprint } from '../../packages/core/src/git/repository.ts';
test('Git identity, dirty state, untracked changes and fingerprints use a real isolated repository', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orch-git-'));
  try {
    await git(root, 'init'); await git(root, 'config', 'user.name', 'ORCH Test'); await git(root, 'config', 'user.email', 'test@example.invalid');
    await writeFile(join(root, 'file.txt'), 'base'); await git(root, 'add', 'file.txt'); await git(root, 'commit', '-m', 'base');
    const identity = await inspectRepository(root); assert.equal(identity.dirty, false);
    const before = await sourceFingerprint(root);
    await writeFile(join(root, 'new file.txt'), 'new');
    assert.equal((await inspectRepository(root)).dirty, true);
    assert.deepEqual(await changedPaths(root), ['new file.txt']);
    assert.notEqual(await sourceFingerprint(root), before);
    assert.equal(owns(['src/**'], 'src/a.ts'), true); assert.equal(owns(['src/**'], 'src-other/a.ts'), false);
    assert.equal(overlaps(['src/**'], ['src/a.ts']), true);
    assert.equal(overlaps(['a.ts'], ['b.ts']), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
