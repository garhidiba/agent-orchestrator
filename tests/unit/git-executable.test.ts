import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { git, inspectRepository } from '../../packages/core/src/git/repository.ts';

test('repository-local PATH executables cannot impersonate Git from a nested checkout', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orch-git-bin-')), root = join(dir, 'repo'), bin = join(root, 'bin'), nested = join(root, 'nested');
  try {
    await mkdir(bin, { recursive: true }); await mkdir(nested); await mkdir(join(root, '.git'));
    await writeFile(join(bin, 'git'), '#!/bin/sh\necho SPOOFED_GIT\n', { mode: 0o700 });
    const module = new URL('../../packages/core/src/git/repository.ts', import.meta.url).href;
    const script = `import {git} from ${JSON.stringify(module)}; process.stdout.write(await git(${JSON.stringify(nested)}, '--version'));`;
    const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` } });
    assert.match(result.stdout, /^git version /);
    assert.equal(result.stdout.includes('SPOOFED_GIT'), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Git root identity preserves legal trailing spaces in directory names', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orch-git-space-')), root = join(dir, 'repo ');
  try {
    await mkdir(root); await git(root, 'init'); await git(root, 'config', 'user.name', 'Fixture'); await git(root, 'config', 'user.email', 'fixture@example.invalid');
    await writeFile(join(root, 'file'), 'base'); await git(root, 'add', 'file'); await git(root, 'commit', '-m', 'base');
    assert.equal((await inspectRepository(root)).root.endsWith('repo '), true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
