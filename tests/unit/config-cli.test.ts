import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile), cli = fileURLToPath(new URL('../../packages/installer/src/cli.ts', import.meta.url));
test('developer CLI config mutation and configure dry-run preserve pins and reveal inheritance', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orch-cli-config-')), root = join(dir, 'repo');
  await mkdir(root);
  try {
    await exec('git', ['init', root]);
    await writeFile(join(dir, 'claude'), `#!${process.execPath}\nconsole.log('fixture-claude 1');`, { mode: 0o700 });
    const global = join(dir, 'global'); await mkdir(global);
    await writeFile(join(global, 'config.yaml'), 'model_selection: {profile: economy}\nhosts: {codex: {roles: {coder: {model: user-pin}}}}\n');
    const options = { cwd: root, env: { ...process.env, ORCH_CONFIG_HOME: global, PATH: `${dir}:${process.env.PATH}` } };
    const run = async (...args: string[]) => JSON.parse((await exec(process.execPath, [cli, ...args], options)).stdout);
    const dry = await run('configure', '--profile', 'quality', '--dry-run');
    assert.equal(dry.effective.hosts.codex.roles.coder.model, 'user-pin');
    await assert.rejects(readFile(join(root, '.orch', 'config.yaml')), { code: 'ENOENT' });
    await run('config', 'set', 'model_selection.profile', 'fast');
    assert.equal((await run('config', '--effective')).config.model_selection.profile, 'fast');
    await run('config', 'unset', 'model_selection.profile');
    assert.equal((await run('config', '--effective')).config.model_selection.profile, 'economy');
    const roles = await run('models', '--host', 'codex');
    assert.equal(roles.coder.requested.model, 'user-pin');
    assert.equal(roles.coder.observed, null);
    assert.equal(roles.coder.source.model, 'global');
    assert.equal((await run('models', 'available', '--host', 'claude')).status, 'partial');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
