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

test('config dry-run leaves no files and preserves inherited pins during unrelated changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orch-patch-')), file = join(dir, 'absent', 'config.yaml');
  try {
    const layers = { global: { hosts: { codex: { roles: { coder: { model: 'user-pin' } } } } } };
    const result = await patchConfig(file, configHash(null), [{ path: ['model_selection', 'profile'], value: 'quality' }], [], { layers, dryRun: true });
    assert.equal(result.effective?.hosts.codex.roles.coder.model, 'user-pin');
    await assert.rejects(readFile(file), { code: 'ENOENT' });
    await assert.rejects(readFile(`${file}.orch-lock`), { code: 'ENOENT' });
    await writeFile(join(dir, 'config.yaml'), 'hosts: {codex: {roles: {coder: {model: auto}}}}\n');
    const source = await readFile(join(dir, 'config.yaml'), 'utf8');
    await assert.rejects(patchConfig(join(dir, 'config.yaml'), configHash(source), [{ path: ['hosts', 'codex', 'roles', 'coder', 'model'], remove: true }], [], { layers }), /MODEL_NOT_SUPPORTED/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('pure proposals preserve session pins and reveal lower fields on unset without mutating inputs', async () => {
  const { proposeConfig } = await import('../../packages/core/src/config/write.ts');
  const source = '# session note\nhosts: {codex: {roles: {coder: {model: session-pin}}}}\nmodel_selection: {profile: quality}\n';
  const layers = { global: { model_selection: { profile: 'economy' }, hosts: { codex: { roles: { reviewer: { model: 'global-pin' } } } } }, project: { execution: { max_parallel_workers: 3 } }, session: { model_selection: { profile: 'fast' } } };
  const snapshot = structuredClone(layers);
  const first = proposeConfig(source, [{ path: ['execution', 'max_parallel_test_jobs'], value: 2 }], [], { scope: 'session', layers });
  assert.match(first.text, /# session note/);
  assert.equal(first.effective.hosts.codex.roles.coder.model, 'session-pin');
  assert.equal(first.effective.hosts.codex.roles.reviewer.model, 'global-pin');
  assert.equal(first.effective.model_selection.profile, 'quality');
  assert.equal(first.effective.execution.max_parallel_workers, 3);
  assert.equal(first.effective.execution.max_parallel_test_jobs, 2);
  const unset = proposeConfig(first.text, [{ path: ['model_selection', 'profile'], remove: true }], [], { scope: 'session', layers });
  assert.equal(unset.config.model_selection?.profile, undefined);
  assert.equal(unset.effective.model_selection.profile, 'economy');
  assert.equal(unset.effective.hosts.codex.roles.coder.model, 'session-pin');
  assert.equal(unset.effective.execution.max_parallel_test_jobs, 2);
  assert.deepEqual(layers, snapshot);
  assert.match(source, /profile: quality/);
});

test('pure proposals reject invalid paths, types and new unverified pins without changing source or layers', async () => {
  const { proposeConfig } = await import('../../packages/core/src/config/write.ts');
  const source = 'model_selection: {profile: quality}\n';
  const layers = { global: { execution: { max_parallel_workers: 2 } } }, snapshot = structuredClone(layers);
  for (const path of [[], ['__proto__', 'x'], ['constructor'], ['execution.max_parallel_workers']]) {
    assert.throws(() => proposeConfig(source, [{ path, value: 1 }], [], { scope: 'session', layers }), /CONFIG_PATH_INVALID/);
  }
  assert.throws(() => proposeConfig(source, [{ path: ['execution', 'max_parallel_workers'], value: 'two' }], [], { scope: 'session', layers }), /CONFIG_INVALID/);
  assert.throws(() => proposeConfig(source, [{ path: ['hosts', 'codex', 'roles', 'coder', 'model'], value: 'unverified-new-pin' }], [], { scope: 'session', layers }), /MODEL_NOT_SUPPORTED/);
  assert.throws(() => proposeConfig('unknown: secret\n', [], [], { scope: 'session', layers }), error => error instanceof Error && error.message.includes('CONFIG_INVALID') && !error.message.includes('secret'));
  assert.deepEqual(layers, snapshot); assert.equal(source, 'model_selection: {profile: quality}\n');
  assert.equal(proposeConfig(null, [{ path: ['execution', 'max_parallel_workers'], value: 1 }], [], { scope: 'session', layers }).effective.execution.max_parallel_workers, 1);
});

test('higher layers cannot hide a new invalid model or effort in the changed scope', async () => {
  const { proposeConfig } = await import('../../packages/core/src/config/write.ts');
  const override = { hosts: { codex: { roles: { coder: { model: 'auto', effort: 'auto' } } } } };
  for (const scope of ['global', 'project'] as const) {
    const layers = scope === 'global' ? { project: override, session: override } : { session: override };
    assert.throws(() => proposeConfig(null, [{ path: ['hosts', 'codex', 'roles', 'coder', 'model'], value: 'unverified-new-pin' }], [], { scope, layers }), /MODEL_NOT_SUPPORTED/);
    const source = 'hosts: {codex: {roles: {coder: {model: existing-pin}}}}\n';
    const kept = proposeConfig(source, [{ path: ['model_selection', 'profile'], value: 'quality' }], [], { scope, layers });
    assert.equal(kept.config.hosts?.codex?.roles?.coder?.model, 'existing-pin');
    assert.equal(kept.effective.hosts.codex.roles.coder.model, 'auto');
    const model = { host: 'codex' as const, id: 'existing-pin', displayName: 'fixture', resolvedId: null, family: 'openai' as const,
      support: 'advertised' as const, access: 'unknown' as const, availability: 'unknown' as const, efforts: ['high'], defaultEffort: 'high',
      hidden: false, source: 'fixture', sourceVersion: null, fetchedAt: new Date().toISOString(), expiresAt: null, evidence: [] };
    assert.throws(() => proposeConfig(source, [{ path: ['hosts', 'codex', 'roles', 'coder', 'effort'], value: 'unsupported' }], [model], { scope, layers }), /EFFORT_NOT_SUPPORTED/);
  }
  const dir = await mkdtemp(join(tmpdir(), 'orch-hidden-pin-')), file = join(dir, 'config.yaml');
  try {
    await writeFile(file, '');
    await assert.rejects(patchConfig(file, configHash(''), [{ path: ['hosts', 'codex', 'roles', 'coder', 'model'], value: 'new-unverified-pin' }], [], { scope: 'project', layers: { session: override } }), /MODEL_NOT_SUPPORTED/);
    assert.equal(await readFile(file, 'utf8'), '');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
