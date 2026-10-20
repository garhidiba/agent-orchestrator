import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, lstat, realpath, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { runtimeFixture } from '../fixtures/runtime.ts';
import { git } from '../../packages/core/src/git/repository.ts';

async function nodeFixture(ignore: boolean | string = true) {
  const f = await runtimeFixture(true, { quality: { commands: [{ id: 'unit', executable: process.execPath,
    args: ['-e', 'if (require("orch-disposable-dependency") !== 42) process.exit(1)'], cwd: '.',
    stages: ['baseline', 'task', 'integration', 'final'], required: true, timeout_seconds: 5 }] } });
  await writeFile(join(f.root, '.gitignore'), `.orch/state/\n${typeof ignore === 'string' ? ignore : ignore ? 'node_modules\n' : ''}`);
  await writeFile(join(f.root, 'package.json'), '{"dependencies":{"orch-disposable-dependency":"1.0.0"}}');
  await writeFile(join(f.root, 'package-lock.json'), '{"lockfileVersion":3}');
  await mkdir(join(f.root, 'packages', 'child'), { recursive: true });
  await writeFile(join(f.root, 'packages', 'child', 'package.json'), '{"name":"child"}');
  await git(f.root, 'add', '.gitignore', 'package.json', 'package-lock.json', 'packages');
  await git(f.root, 'commit', '-m', 'node fixture');
  await mkdir(join(f.root, 'node_modules', 'orch-disposable-dependency'), { recursive: true });
  await writeFile(join(f.root, 'node_modules', 'orch-disposable-dependency', 'index.js'), 'module.exports = 42;');
  await f.change({ action: 'plan' }, async run => {
    run.targetBase = await git(f.root, 'rev-parse', 'HEAD'); run.integrationSha = run.targetBase;
    return f.engine.plan(run, f.plan, true);
  });
  return f;
}

test('prepare readies ignored Node dependencies before real task and integration gates', async () => {
  const f = await nodeFixture();
  try {
    const prepared = await f.change({ action: 'prepare' }, run => f.engine.prepare(run, 'T1'));
    const task = f.engine.status(f.created.runId).data.tasks.T1;
    const gate = await f.change({ action: 'gate' }, run => f.engine.gate(run, 'task', task.path, 'T1'));
    const log = await readFile(gate.result.details![0].logRef, 'utf8');
    assert.equal(gate.result.status, 'passed', log);
    assert.equal(await realpath(join(task.path, 'node_modules')), await realpath(join(f.root, 'node_modules')));
    assert.equal((await lstat(join(task.path, 'node_modules'))).isSymbolicLink(), true);
    assert.equal(prepared.result.dependencySetup?.method, 'shared_origin_symlink');
    assert.equal(prepared.result.dependencySetup?.mutationPolicy, 'preserve_source_dependencies');
    const integration = await f.change({ action: 'integration-gate' }, run => f.engine.gate(run, 'integration', run.integrationPath));
    assert.equal(integration.result.status, 'passed');
    assert.equal(await git(task.path, 'status', '--porcelain'), '');
    assert.equal(await git(f.root, 'status', '--porcelain'), '');
  } finally { await f.close(); }
});

for (const input of ['package-lock.json', 'packages/child/package.json']) {
  test(`prepare blocks differing ${input} before leasing a worker`, async () => {
    const f = await nodeFixture();
    try {
      await writeFile(join(f.root, input), '{}');
      await assert.rejects(f.change({ action: 'prepare' }, run => f.engine.prepare(run, 'T1')), /BLOCKED_DEPENDENCY_SETUP_INPUT_MISMATCH/);
      assert.equal(f.engine.status(f.created.runId).data.tasks.T1.state, 'PENDING');
      assert.equal(f.engine.store.pending(f.created.runId).length, 0);
    } finally { await f.close(); }
  });
}

test('later gates block drift after a shared dependency link was prepared', async () => {
  const f = await nodeFixture();
  try {
    await f.change({ action: 'prepare' }, run => f.engine.prepare(run, 'T1'));
    const task = f.engine.status(f.created.runId).data.tasks.T1;
    await writeFile(join(task.path, 'package-lock.json'), '{}');
    await assert.rejects(f.change({ action: 'gate' }, run => f.engine.gate(run, 'task', task.path, 'T1')), /BLOCKED_DEPENDENCY_SETUP_INPUT_MISMATCH/);
    assert.equal((await lstat(join(task.path, 'node_modules'))).isSymbolicLink(), true);
  } finally { await f.close(); }
});

test('prepare refuses dependency links without a matching ignore rule', async () => {
  const f = await nodeFixture(false);
  try {
    await assert.rejects(f.change({ action: 'prepare' }, run => f.engine.prepare(run, 'T1')), /BLOCKED_DEPENDENCY_SETUP_IGNORE_REQUIRED/);
    const integration = f.engine.status(f.created.runId).data.integrationPath;
    await assert.rejects(lstat(join(integration, 'node_modules')), { code: 'ENOENT' });
  } finally { await f.close(); }
});

test('directory-only ignore rules cannot hide the generated symlink', async () => {
  const f = await nodeFixture('node_modules/\n');
  try {
    await assert.rejects(f.change({ action: 'prepare' }, run => f.engine.prepare(run, 'T1')), /BLOCKED_DEPENDENCY_SETUP_IGNORE_REQUIRED/);
    assert.equal(f.engine.status(f.created.runId).data.tasks.T1.state, 'PENDING');
  } finally { await f.close(); }
});

test('prepare reports missing origin dependencies instead of leasing an unready worker', async () => {
  const f = await nodeFixture();
  try {
    await rm(join(f.root, 'node_modules'), { recursive: true });
    await assert.rejects(f.change({ action: 'prepare' }, run => f.engine.prepare(run, 'T1')), /BLOCKED_DEPENDENCY_SETUP_ORIGIN_MISSING/);
    assert.equal(f.engine.status(f.created.runId).data.tasks.T1.state, 'PENDING');
  } finally { await f.close(); }
});

test('gates report an origin dependency directory removed after preparation', async () => {
  const f = await nodeFixture();
  try {
    await f.change({ action: 'prepare' }, run => f.engine.prepare(run, 'T1'));
    const task = f.engine.status(f.created.runId).data.tasks.T1;
    await rm(join(f.root, 'node_modules'), { recursive: true });
    await assert.rejects(f.change({ action: 'gate' }, run => f.engine.gate(run, 'task', task.path, 'T1')), /BLOCKED_DEPENDENCY_SETUP_ORIGIN_MISSING/);
  } finally { await f.close(); }
});

for (const kind of ['directory', 'symlink', 'dangling-symlink']) {
  test(`gates preserve a user-owned dependency ${kind}`, async () => {
    const f = await nodeFixture();
    try {
      await f.change({ action: 'prepare' }, run => f.engine.prepare(run, 'T1'));
      const task = f.engine.status(f.created.runId).data.tasks.T1;
      const target = join(task.path, 'node_modules'), user = kind === 'directory' ? target : join(f.dir, 'user-dependencies');
      await rm(target);
      if (kind !== 'dangling-symlink') {
        await mkdir(join(user, 'orch-disposable-dependency'), { recursive: true });
        await writeFile(join(user, 'orch-disposable-dependency', 'index.js'), 'module.exports = 42;');
      }
      if (kind !== 'directory') await symlink(user, target, process.platform === 'win32' ? 'junction' : 'dir');
      await writeFile(join(f.root, 'package-lock.json'), '{}');
      const gate = await f.change({ action: 'gate' }, run => f.engine.gate(run, 'task', task.path, 'T1'));
      assert.equal(gate.result.status, kind === 'dangling-symlink' ? 'failed' : 'passed');
      assert.equal((await lstat(target)).isSymbolicLink(), kind !== 'directory');
      if (kind !== 'dangling-symlink') assert.equal(await realpath(target), await realpath(user));
    } finally { await f.close(); }
  });
}
