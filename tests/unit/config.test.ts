import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseConfig, resolveConfig } from '../../packages/core/src/config/index.ts';

test('PRD defaults validate while unsafe or malformed YAML is rejected', async () => {
  const defaults = parseConfig(await readFile(new URL('../../templates/defaults/config.yaml', import.meta.url), 'utf8'));
  assert.equal(defaults.hosts?.codex?.roles?.coordinator?.model, 'inherit');
  for (const input of [
    'schema_version: 2',
    'schema_version: 1\nschema_version: 1',
    'execution: {max_parallel_workers: 0}',
    'execution: {max_parallel_workers: "4"}',
    'model_selection: {allow_cross_host: true}',
    'unknown: true',
    'hosts: {codex: {roles: {imaginary: {model: auto}}}}',
    'hosts: {codex: {roles: {coder: {model: null}}}}',
    'observability: {telemetry: !secret token}',
    'git: {target_branch: &a main, integration_prefix: *a}',
    '__proto__: {polluted: true}',
    '[]',
  ]) assert.throws(() => parseConfig(input), /CONFIG_INVALID/);
});


test('AT-007: role fields inherit independently with accurate provenance', () => {
  const result = resolveConfig({
    global: { hosts: { codex: { roles: { coder: { model: 'verified-example' } } } } },
    project: { hosts: { codex: { roles: { coder: { effort: 'high' } } } } },
    session: { model_selection: { profile: 'quality' } },
  });
  assert.deepEqual(result.config.hosts.codex.roles.coder, { model: 'verified-example', effort: 'high' });
  assert.equal(result.sources['hosts.codex.roles.coder.model'], 'global');
  assert.equal(result.sources['hosts.codex.roles.coder.effort'], 'project');
  assert.equal(result.sources['model_selection.profile'], 'session');
  assert.equal(result.config.hosts.claude.roles.coordinator.model, 'inherit');
});

test('arrays replace, null stays a value, and resolving does not mutate caller overrides', () => {
  const global = { review: { block_on: ['critical', 'high', 'medium'] }, git: { target_branch: 'develop' } };
  const project = { review: { block_on: ['critical', 'high'] }, git: { target_branch: null } };
  const result = resolveConfig({ global, project });
  assert.deepEqual(result.config.review.block_on, ['critical', 'high']);
  assert.equal(result.config.git.target_branch, null);
  assert.equal(result.sources['git.target_branch'], 'project');
  assert.deepEqual(global.review.block_on, ['critical', 'high', 'medium']);
  result.config.review.block_on.push('low');
  assert.deepEqual(project.review.block_on, ['critical', 'high']);
  assert.equal(resolveConfig().config.model_selection.profile, 'balanced');
});

test('configured gate paths stay relative and duplicate IDs cannot hide commands', () => {
  const command = { id: 'unit', executable: 'npm', args: ['test'], cwd: '.', stages: ['task'], required: true, timeout_seconds: 30 };
  assert.equal(resolveConfig({ project: { quality: { commands: [command] } } }).config.quality.commands[0].id, 'unit');
  for (const cwd of ['../other', '/tmp', 'C:\\tmp', '\\server', 'a/../../other', 'a\\..\\other']) {
    assert.throws(() => parseConfig(JSON.stringify({ quality: { commands: [{ ...command, cwd }] } })), /CONFIG_INVALID/);
  }
  assert.throws(() => resolveConfig({ project: { quality: { commands: [command, command] } } }), /duplicate quality command IDs/);
});

test('layer inputs accept prototype-free data and reject inherited values and accessors', () => {
  const clean = Object.assign(Object.create(null), { model_selection: Object.assign(Object.create(null), { profile: 'economy' }) });
  assert.equal(resolveConfig({ global: clean }).config.model_selection.profile, 'economy');
  assert.throws(() => resolveConfig({ global: Object.create({ model_selection: { profile: 'economy' } }) }), /CONFIG_INVALID/);
  assert.throws(() => resolveConfig({ global: { model_selection: Object.create({ profile: 'economy' }) } }), /CONFIG_INVALID/);
  let invoked = false;
  const accessor = Object.defineProperty({}, 'model_selection', { enumerable: true, get() { invoked = true; return {}; } });
  assert.throws(() => resolveConfig({ global: accessor }), /CONFIG_INVALID/); assert.equal(invoked, false);
  for (const value of [null, [], { model_selection: { profile: 'private-invalid-value' } }]) {
    assert.throws(() => resolveConfig({ global: value }), error => error instanceof Error && error.message.includes('CONFIG_INVALID') && !error.message.includes('private-invalid-value'));
  }
});
