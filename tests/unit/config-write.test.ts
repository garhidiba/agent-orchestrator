import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { patchConfig, configHash } from '../../packages/core/src/config/write.ts';

test('atomic config edits preserve comments, unset overrides and reject stale writes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orch-patch-')), file = join(dir, 'config.yaml');
  try {
    const original = '# user note\nmodel_selection:\n  profile: balanced\n'; await writeFile(file, original);
    const updated = await patchConfig(file, configHash(original), [{ path: ['model_selection', 'profile'], value: 'quality' }]);
    assert.match(await readFile(file, 'utf8'), /# user note/);
    assert.equal(updated.config.model_selection?.profile, 'quality');
    await assert.rejects(patchConfig(file, configHash(original), [{ path: ['model_selection', 'profile'], value: 'fast' }]), /CONFIG_CONFLICT/);
    const unset = await patchConfig(file, updated.hash, [{ path: ['model_selection', 'profile'], remove: true }]);
    assert.equal(unset.config.model_selection?.profile, undefined);
    const before = await readFile(file, 'utf8');
    await assert.rejects(patchConfig(file, unset.hash, [{ path: ['hosts', 'codex', 'roles', 'coder', 'model'], value: 'imaginary' }]), /MODEL_NOT_SUPPORTED/);
    assert.equal(await readFile(file, 'utf8'), before);
    await assert.rejects(patchConfig(file, unset.hash, [{ path: ['__proto__', 'x'], value: true }]), /CONFIG_PATH_INVALID/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
