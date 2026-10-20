import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionConfig } from '../../packages/core/src/config/session.ts';
import { loadConfig } from '../../packages/core/src/config/index.ts';

test('session config instances apply highest-priority overrides and unset without file writes or shared state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orch-session-config-'));
  try {
    const globalFile = join(dir, 'global.yaml'), projectFile = join(dir, '.orch', 'config.yaml');
    const globalText = 'model_selection: {profile: economy}\nhosts: {codex: {roles: {coder: {model: existing-pin}}}}\n';
    const projectText = 'execution: {max_parallel_workers: 2}\n';
    await mkdir(join(dir, '.orch')); await writeFile(globalFile, globalText); await writeFile(projectFile, projectText);
    const { layers } = await loadConfig(dir, globalFile), original = structuredClone(layers);
    const session = createSessionConfig(), other = createSessionConfig();
    const before = session.snapshot(layers);
    const applied = session.patch(before.hash, [{ path: ['model_selection', 'profile'], value: 'quality' }], [], { layers });
    assert.equal(applied.applied, true); assert.equal(applied.current.revision, 1);
    assert.equal(applied.current.hash, applied.proposal.hash);
    const snapshot = session.snapshot(layers);
    assert.equal(snapshot.effective.model_selection.profile, 'quality');
    assert.equal(snapshot.effective.hosts.codex.roles.coder.model, 'existing-pin');
    assert.equal(snapshot.effective.execution.max_parallel_workers, 2);
    assert.equal(snapshot.sources['model_selection.profile'], 'session');
    assert.equal(other.snapshot(layers).effective.model_selection.profile, 'economy');
    snapshot.config.model_selection!.profile = 'fast';
    assert.equal(session.snapshot(layers).effective.model_selection.profile, 'quality');
    session.patch(snapshot.hash, [{ path: ['model_selection', 'profile'], remove: true }], [], { layers });
    assert.equal(session.snapshot(layers).effective.model_selection.profile, 'economy');
    assert.deepEqual(layers, original);
    assert.equal(await readFile(globalFile, 'utf8'), globalText); assert.equal(await readFile(projectFile, 'utf8'), projectText);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('session dry-run preserves hash and revision; stale hashes and invalid patches never commit', () => {
  const session = createSessionConfig(), initial = session.snapshot();
  const patches = [{ path: ['execution', 'max_parallel_workers'], value: 3 }];
  const dry = session.patch(initial.hash, patches, [], { dryRun: true });
  assert.equal(dry.applied, false); assert.equal(dry.proposal.effective.execution.max_parallel_workers, 3);
  assert.deepEqual(dry.current, { hash: initial.hash, revision: 0 }); assert.notEqual(dry.proposal.hash, initial.hash);
  assert.deepEqual(session.snapshot(), initial);
  session.patch(initial.hash, patches);
  assert.throws(() => session.patch(initial.hash, patches), /CONFIG_CONFLICT/);
  const committed = session.snapshot();
  for (const patch of [{ path: ['__proto__', 'x'], value: true }, { path: ['execution', 'max_parallel_workers'], value: 'invalid' }, { path: ['hosts', 'codex', 'roles', 'coder', 'model'], value: 'unverified' }]) {
    assert.throws(() => session.patch(committed.hash, [patch]), /CONFIG_PATH_INVALID|CONFIG_INVALID|MODEL_NOT_SUPPORTED/);
    assert.deepEqual(session.snapshot(), committed);
  }
});
