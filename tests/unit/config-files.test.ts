import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { globalConfigPath, loadConfig } from '../../packages/core/src/config/index.ts';

test('global config path follows explicit, Windows, XDG and home precedence', () => {
  assert.equal(globalConfigPath({ ORCH_CONFIG_HOME: '/explicit', XDG_CONFIG_HOME: '/xdg' }, 'linux', '/home/user'), '/explicit/config.yaml');
  assert.equal(globalConfigPath({ XDG_CONFIG_HOME: '/xdg' }, 'linux', '/home/user'), '/xdg/orch/config.yaml');
  assert.equal(globalConfigPath({}, 'darwin', '/home/user'), '/home/user/.config/orch/config.yaml');
  assert.equal(globalConfigPath({ APPDATA: 'C:\\Users\\user\\AppData\\Roaming' }, 'win32'), 'C:\\Users\\user\\AppData\\Roaming\\orch\\config.yaml');
  assert.throws(() => globalConfigPath({}, 'win32'), /APPDATA/);
});

test('file loading keeps origin scope, records paths, and never changes settings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orch-config-'));
  try {
    const global = join(dir, 'global.yaml');
    const project = join(dir, '.orch', 'config.yaml');
    await mkdir(join(dir, '.orch'));
    await writeFile(global, 'model_selection: {profile: economy}\nhosts: {codex: {roles: {coder: {model: pinned-model}}}}\n');
    const projectText = 'model_selection: {profile: quality}\n';
    await writeFile(project, projectText);
    const result = await loadConfig(dir, global);
    assert.equal(result.config.model_selection.profile, 'quality');
    assert.equal(result.config.hosts.codex.roles.coder.model, 'pinned-model');
    assert.equal(result.sources['model_selection.profile'], 'project');
    assert.equal(result.files.project, project);
    assert.equal(await readFile(project, 'utf8'), projectText);
    assert.equal((await loadConfig(null, global)).config.model_selection.profile, 'economy');
    assert.equal((await loadConfig(null, join(dir, 'absent'))).config.model_selection.profile, 'balanced');
    await writeFile(project, 'private: sensitive-value\n');
    await assert.rejects(loadConfig(dir, global), error => error instanceof Error && error.message.includes('CONFIG_INVALID') && !error.message.includes('sensitive-value'));
    await assert.rejects(loadConfig(null, dir), error => (error as NodeJS.ErrnoException).code === 'EISDIR');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolved file layers carry hashes of that read with distinct missing scope semantics', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orch-config-hash-'));
  try {
    const global = join(dir, 'global.yaml'), project = join(dir, '.orch', 'config.yaml');
    const source = '# retained bytes\nmodel_selection: {profile: economy}\n';
    const { configHash } = await import('../../packages/core/src/config/hash.ts');
    const { configHash: compatibilityHash, patchConfig } = await import('../../packages/core/src/config/write.ts');
    assert.equal(configHash, compatibilityHash);
    const missing = await loadConfig(dir, global);
    assert.deepEqual(missing.hashes, { global: configHash(null), project: configHash(null) });
    const outside = await loadConfig(null, global);
    assert.equal(outside.hashes.project, null);
    assert.equal(outside.hashes.global, configHash(null));
    await writeFile(global, source); await mkdir(join(dir, '.orch')); await writeFile(project, '');
    const loaded = await loadConfig(dir, global);
    assert.deepEqual(loaded.hashes, { global: configHash(source), project: configHash('') });
    assert.equal(loaded.config.model_selection.profile, 'economy');
    await writeFile(global, 'model_selection: {profile: fast}\n');
    assert.equal(loaded.hashes.global, configHash(source));
    assert.equal(loaded.config.model_selection.profile, 'economy');
    await assert.rejects(patchConfig(global, loaded.hashes.global, [{ path: ['model_selection', 'profile'], value: 'quality' }], [], { scope: 'global', layers: loaded.layers }), /CONFIG_CONFLICT/);
    const changed = await loadConfig(dir, global);
    assert.notEqual(changed.hashes.global, loaded.hashes.global);
    assert.equal(changed.config.model_selection.profile, 'fast');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
