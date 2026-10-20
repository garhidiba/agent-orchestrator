import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../../packages/installer/src/cli.ts', import.meta.url));

test('CLI resolves the invocation repo from a nested Korean path without editing config', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orch-cli-'));
  try {
    const root = join(dir, '한글 project');
    const nested = join(root, 'nested');
    const config = join(root, '.orch', 'config.yaml');
    await mkdir(nested, { recursive: true });
    await mkdir(join(root, '.orch'));
    await exec('git', ['init', root]);
    const source = 'hosts: {codex: {roles: {coder: {effort: high}}}}\n';
    await writeFile(config, source);
    const env = { ...process.env, ORCH_CONFIG_HOME: join(dir, 'global') };
    const { stdout } = await exec(process.execPath, [cli, 'config', '--effective'], { cwd: nested, env });
    const result = JSON.parse(stdout);
    assert.equal(result.config.hosts.codex.roles.coder.effort, 'high');
    assert.equal(result.sources['hosts.codex.roles.coder.effort'], 'project');
    assert.equal(await readFile(config, 'utf8'), source);
    const outside = await exec(process.execPath, [cli, 'config', '--effective'], { cwd: dir, env });
    assert.equal(JSON.parse(outside.stdout).files.project, null);
    assert.equal(JSON.parse(outside.stdout).config.hosts.codex.roles.coder.effort, 'auto');
    await writeFile(config, 'unknown: private-value\n');
    await assert.rejects(exec(process.execPath, [cli, 'config', '--effective'], { cwd: root, env }), error => {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      assert.equal(failure.code, 1);
      assert.equal(failure.stdout, '');
      assert.match(failure.stderr!, /CONFIG_INVALID/);
      assert.equal(failure.stderr!.includes('private-value'), false);
      return true;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CLI help describes implemented commands and rejects unsupported commands', async () => {
  const help = await exec(process.execPath, [cli, '--help']);
  assert.match(help.stdout, /doctor --host/);
  assert.match(help.stdout, /config --effective/);
  for (const args of [['doctor'], ['doctor', '--host', 'other'], ['run'], ['config', '--effective', '--host', 'codex']]) {
    await assert.rejects(exec(process.execPath, [cli, ...args]), error => (error as { code?: number }).code === 1);
  }
});
