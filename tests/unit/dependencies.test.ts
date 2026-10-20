import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, lstat, realpath, rm, rename, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { runtimeFixture, fixtureTaskResult } from '../fixtures/runtime.ts';
import { git } from '../../packages/core/src/git/repository.ts';

async function nodeFixture(ignore: boolean | string = true, manifest: object = { dependencies: { 'orch-disposable-dependency': '1.0.0' } }) {
  const f = await runtimeFixture(true, { quality: { commands: [{ id: 'unit', executable: process.execPath,
    args: ['-e', 'if (require("orch-disposable-dependency") !== 42) process.exit(1)'], cwd: '.',
    stages: ['baseline', 'task', 'integration', 'final'], required: true, timeout_seconds: 5 }] } });
  await writeFile(join(f.root, '.gitignore'), `.orch/state/\n${typeof ignore === 'string' ? ignore : ignore ? 'node_modules\n' : ''}`);
  await writeFile(join(f.root, 'package.json'), JSON.stringify(manifest));
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

for (const manifest of [{ workspaces: ['packages/*'] }, ...['workspace:*', 'file:packages/child', 'link:packages/child'].map(version => ({ dependencies: { child: version } }))]) {
  test(`prepare rejects local source dependency declarations ${JSON.stringify(manifest)}`, async () => {
    const f = await nodeFixture(true, manifest);
    try {
      await assert.rejects(f.change({ action: 'prepare' }, run => f.engine.prepare(run, 'T1')), /BLOCKED_DEPENDENCY_SETUP_LOCAL_SOURCE/);
      assert.equal(f.engine.status(f.created.runId).data.tasks.T1.state, 'PENDING');
    } finally { await f.close(); }
  });
}

test('prepare rejects installed dependency links to origin workspace code', async () => {
  const f = await nodeFixture();
  try {
    await writeFile(join(f.root, 'packages', 'child', 'index.js'), 'module.exports = 42;');
    await symlink(join(f.root, 'packages', 'child'), join(f.root, 'node_modules', 'orch-local-source'), process.platform === 'win32' ? 'junction' : 'dir');
    await writeFile(join(f.root, 'node_modules', 'orch-disposable-dependency', 'index.js'), 'module.exports = require("orch-local-source");');
    await assert.rejects(f.change({ action: 'prepare' }, run => f.engine.prepare(run, 'T1')), /BLOCKED_DEPENDENCY_SETUP_EXTERNAL_LINK/);
  } finally { await f.close(); }
});

test('prepare accepts dependency links contained within the installed dependency root', async () => {
  const f = await nodeFixture();
  try {
    const installed = join(f.root, 'node_modules'), stored = join(installed, '.store', 'orch-disposable-dependency');
    await mkdir(join(installed, '.store'));
    await rename(join(installed, 'orch-disposable-dependency'), stored);
    await symlink(stored, join(installed, 'orch-disposable-dependency'), process.platform === 'win32' ? 'junction' : 'dir');
    await f.change({ action: 'prepare' }, run => f.engine.prepare(run, 'T1'));
    const task = f.engine.status(f.created.runId).data.tasks.T1;
    const gate = await f.change({ action: 'gate' }, run => f.engine.gate(run, 'task', task.path, 'T1'));
    assert.equal(gate.result.status, 'passed');
  } finally { await f.close(); }
});

test('gates block a shared dependency link when the origin dependency alias loses its target', async () => {
  const f = await nodeFixture();
  try {
    const dependencies = join(f.dir, 'installed-dependencies');
    await rename(join(f.root, 'node_modules'), dependencies);
    await symlink(dependencies, join(f.root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    await f.change({ action: 'prepare' }, run => f.engine.prepare(run, 'T1'));
    const task = f.engine.status(f.created.runId).data.tasks.T1;
    await rm(dependencies, { recursive: true });
    await assert.rejects(f.change({ action: 'gate' }, run => f.engine.gate(run, 'task', task.path, 'T1')), /BLOCKED_DEPENDENCY_SETUP_ORIGIN_MISSING/);
    await assert.rejects(f.change({ action: 'integration-gate' }, run => f.engine.gate(run, 'integration', run.integrationPath)), /BLOCKED_DEPENDENCY_SETUP_ORIGIN_MISSING/);
  } finally { await f.close(); }
});

test('gates reject a previously shared canonical link when the origin installation changes', async () => {
  const f = await nodeFixture();
  try {
    const previous = join(f.dir, 'previous');
    await rename(join(f.root, 'node_modules'), previous);
    await symlink(previous, join(f.root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    await f.change({ action: 'prepare' }, run => f.engine.prepare(run, 'T1'));
    const task = f.engine.status(f.created.runId).data.tasks.T1;
    await rm(join(task.path, 'node_modules'));
    await symlink(task.dependencySetup!.source, join(task.path, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const replacement = join(f.dir, 'replacement');
    await mkdir(replacement);
    await rm(join(f.root, 'node_modules'));
    await symlink(replacement, join(f.root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(f.change({ action: 'gate' }, run => f.engine.gate(run, 'task', task.path, 'T1')), /BLOCKED_DEPENDENCY_SETUP_SOURCE_CHANGED/);
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

for (const drift of ['dependency-content', 'dependency-retarget', 'environment']) {
  test(`commit rejects validation after ${drift} changes`, async () => {
    const f = await nodeFixture();
    const previous = process.env.ORCH_FRESHNESS_TEST;
    try {
      await f.change({}, run => f.engine.prepare(run, 'T1'));
      const task = f.engine.status(f.created.runId).data.tasks.T1;
      await f.change({}, run => f.engine.bind(run, 'T1', task.lease, task.attempt, 'native-T1', 'fixture-model', 'high'));
      await writeFile(join(task.path, 'T1.txt'), 'feature');
      if (drift === 'environment') process.env.ORCH_FRESHNESS_TEST = 'initial-secret-value';
      await f.change({}, run => f.engine.validate(run, 'T1', task.lease, task.attempt));
      assert.ok(!JSON.stringify(f.engine.status(f.created.runId)).includes('initial-secret-value'));
      if (drift === 'environment') process.env.ORCH_FRESHNESS_TEST = 'changed-secret-value';
      else if (drift === 'dependency-content') await writeFile(join(f.root, 'node_modules', 'orch-disposable-dependency', 'index.js'), 'module.exports = 24;');
      else {
        const replacement = join(f.dir, 'replacement');
        await mkdir(join(replacement, 'orch-disposable-dependency'), { recursive: true });
        await writeFile(join(replacement, 'orch-disposable-dependency', 'index.js'), 'module.exports = 42;');
        await rm(join(task.path, 'node_modules'));
        await symlink(replacement, join(task.path, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
      }
      await assert.rejects(f.change({}, run => f.engine.commit(run, 'T1', task.lease, task.attempt, 'U1')), /VALIDATION_STALE/);
    } finally {
      if (previous === undefined) delete process.env.ORCH_FRESHNESS_TEST;
      else process.env.ORCH_FRESHNESS_TEST = previous;
      await f.close();
    }
  });
}

test('completion rejects installed dependency drift after a validated commit', async () => {
  const f = await nodeFixture();
  try {
    await f.change({}, run => f.engine.prepare(run, 'T1'));
    const task = f.engine.status(f.created.runId).data.tasks.T1;
    await f.change({}, run => f.engine.bind(run, 'T1', task.lease, task.attempt, 'native-T1', 'fixture-model', 'high'));
    await writeFile(join(task.path, 'T1.txt'), 'feature');
    await f.change({}, run => f.engine.validate(run, 'T1', task.lease, task.attempt));
    await f.change({}, run => f.engine.commit(run, 'T1', task.lease, task.attempt, 'U1'));
    await writeFile(join(f.root, 'node_modules', 'orch-disposable-dependency', 'index.js'), 'module.exports = 24;');
    await assert.rejects(f.change({}, async run => f.engine.complete(run, 'T1', task.lease, task.attempt, true, await fixtureTaskResult(run, 'T1'))), /VALIDATION_STALE/);
  } finally { await f.close(); }
});

test('gate refuses dependency mutation during execution and tolerates internal symlink cycles', async () => {
  const f = await nodeFixture();
  try {
    await symlink('.', join(f.root, 'node_modules', 'cycle'), process.platform === 'win32' ? 'junction' : 'dir');
    await f.change({}, run => f.engine.prepare(run, 'T1'));
    const gate = await f.change({}, run => {
      run.config.quality.commands[0].args = ['-e', 'require("node:fs").writeFileSync("node_modules/orch-disposable-dependency/index.js", "module.exports = 24;")'];
      return f.engine.gate(run, 'task', run.tasks.T1.path, 'T1');
    });
    assert.equal(gate.result.status, 'source_changed');
  } finally { await f.close(); }
});

test('gates reject user-owned dependency links outside the installation root', async () => {
  const f = await nodeFixture();
  try {
    await f.change({}, run => f.engine.prepare(run, 'T1'));
    const task = f.engine.status(f.created.runId).data.tasks.T1;
    await rm(join(task.path, 'node_modules'));
    await mkdir(join(task.path, 'node_modules'));
    await symlink(f.root, join(task.path, 'node_modules', 'external'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(f.change({}, run => f.engine.gate(run, 'task', task.path, 'T1')), /BLOCKED_DEPENDENCY_EXTERNAL_LINK/);
  } finally { await f.close(); }
});
