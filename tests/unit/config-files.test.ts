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
