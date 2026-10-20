import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs, { writeFile, mkdir, rm, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runtimeFixture as fixture } from '../fixtures/runtime.ts';
import { git } from '../../packages/core/src/git/repository.ts';
import { hash } from '../../packages/core/src/state/store.ts';

// This test file owns its environment; host Git configuration and identities are not fixtures.
const environmentKeys = [...new Set([...Object.keys(process.env).filter(key => key.startsWith('GIT_')),
  'HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'EMAIL', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM'])];
const inheritedEnvironment = new Map(environmentKeys.map(key => [key, process.env[key]]));
let environmentRoot = '';
before(async () => {
  environmentRoot = await mkdtemp(join(tmpdir(), 'orch-preflight-env-'));
  const configPath = join(environmentRoot, 'gitconfig'); await writeFile(configPath, '');
  for (const key of environmentKeys) delete process.env[key];
  Object.assign(process.env, { HOME: environmentRoot, USERPROFILE: environmentRoot, XDG_CONFIG_HOME: environmentRoot,
    GIT_CONFIG_GLOBAL: configPath, GIT_CONFIG_SYSTEM: configPath, GIT_CONFIG_NOSYSTEM: '1' });
});
after(async () => {
  for (const [key, value] of inheritedEnvironment) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  if (environmentRoot) await rm(environmentRoot, { recursive: true, force: true });
});

// Engine.create is the public seam: unsafe repositories must not acquire a new run lock.
async function retryCreate(f: Awaited<ReturnType<typeof fixture>>) {
  const run = f.engine.status(f.created.runId).data;
  await rm(join(run.commonDir, 'orch/locks/write.json'));
  return () => f.engine.create(f.root, run.config, 'codex', join(f.dir, 'managed'), hash(run.config.quality.commands));
}

for (const marker of ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD']) test(`run creation rejects unfinished ${marker}`, async () => {
  const f = await fixture();
  try {
    const create = await retryCreate(f), common = f.engine.status(f.created.runId).data.commonDir;
    if (marker.startsWith('rebase')) await mkdir(join(common, marker));
    else await writeFile(join(common, marker), `${await git(f.root, 'rev-parse', 'HEAD')}\n`);
    await assert.rejects(create(), /GIT_OPERATION_IN_PROGRESS/);
    await assert.rejects(fs.stat(join(common, 'orch/locks/write.json')), { code: 'ENOENT' });
  } finally { await f.close(); }
});

for (const identity of ['user.name', 'user.email']) test(`run creation rejects empty ${identity}`, async () => {
  const f = await fixture();
  try {
    const create = await retryCreate(f);
    await git(f.root, 'config', identity, '');
    await assert.rejects(create(), /GIT_IDENTITY_REQUIRED/);
  } finally { await f.close(); }
});

test('run creation rejects enabled signing without invoking a signing program', async () => {
  const f = await fixture();
  try {
    const create = await retryCreate(f);
    await git(f.root, 'config', 'commit.gpgsign', 'true');
    await git(f.root, 'config', 'gpg.program', join(f.dir, 'must-not-run'));
    await assert.rejects(create(), /SIGNING_POLICY_UNVERIFIED/);
  } finally { await f.close(); }
});

for (const kind of ['manifest', 'gitlink', 'lfs', 'lfs-config']) test(`run creation rejects unverified ${kind} checkout`, async () => {
  const f = await fixture();
  try {
    const create = await retryCreate(f);
    if (kind === 'gitlink') {
      const nested = join(f.root, 'nested'); await mkdir(nested);
      await git(nested, 'init'); await git(nested, 'config', 'user.name', 'Nested fixture'); await git(nested, 'config', 'user.email', 'nested@example.invalid');
      await git(nested, 'commit', '--allow-empty', '-m', 'nested fixture');
      await git(f.root, 'update-index', '--add', '--cacheinfo', `160000,${await git(nested, 'rev-parse', 'HEAD')},nested`);
    }
    else {
      const name = kind === 'manifest' ? '.gitmodules' : kind === 'lfs-config' ? '.lfsconfig' : '.gitattributes';
      await writeFile(join(f.root, name), kind === 'lfs' ? 'base filter=lfs\n' : '');
      await git(f.root, 'add', name);
    }
    await git(f.root, 'commit', '-m', 'unsupported checkout');
    await assert.rejects(create(), kind.startsWith('lfs') ? /LFS_UNSUPPORTED/ : /SUPERPROJECT_SUBMODULES_UNSUPPORTED/);
  } finally { await f.close(); }
});

test('run creation checks available space on both Git storage and managed worktree filesystem', async () => {
  const f = await fixture();
  try {
    const create = await retryCreate(f), managed = await fs.realpath(join(f.dir, 'managed'));
    const original = fs.statfs;
    const checked: string[] = [];
    const stub = mock.method(fs, 'statfs', async (path: string, options: { bigint: true }) => {
      checked.push(path);
      const disk = await original(path, options);
      return path === managed ? { ...disk, bavail: 0n } : disk;
    });
    try {
      await assert.rejects(create(), /DISK_SPACE_UNAVAILABLE/);
      assert.deepEqual(checked, [await fs.realpath(f.root), f.engine.status(f.created.runId).data.commonDir, managed]);
    } finally { stub.mock.restore(); }
  } finally { await f.close(); }
});

test('plain unsigned checkout still starts and leaves original HEAD unchanged', async () => {
  const f = await fixture();
  try {
    const create = await retryCreate(f), before = await git(f.root, 'rev-parse', 'HEAD');
    const created = await create();
    assert.equal(f.engine.status(created.runId).data.state, 'PREFLIGHT');
    assert.equal(await git(f.root, 'rev-parse', 'HEAD'), before);
  } finally { await f.close(); }
});
