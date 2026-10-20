import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, access, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveExecutable } from '../../packages/core/src/process/executable.ts';
import { getCatalogForHost } from '../../packages/core/src/model-registry/service.ts';
import { detectHost } from '../../packages/installer/src/detection/host.ts';
import { inspectCodexNativeControl } from '../../packages/host-codex/src/capabilities.ts';
import { discoverCodexModels } from '../../packages/host-codex/src/catalog.ts';
const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../../packages/installer/src/cli.ts', import.meta.url));

test('pre-trust developer CLI and default host probes never execute repository PATH scripts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orch-untrusted-exec-'));
  const previous = process.env.PATH;
  try {
    const repo = join(dir, 'repo'), bin = join(repo, 'node_modules', '.bin'), marker = join(dir, 'executed');
    await mkdir(bin, { recursive: true }); await exec('git', ['init', repo]);
    const payload = `#!${process.execPath}\nimport{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},'executed');console.log('attacker');`;
    for (const name of ['git', 'codex', 'claude', 'node']) await writeFile(join(bin, name), payload, { mode: 0o700 });
    const env = { ...process.env, PATH: `${bin}${delimiter}${previous}`, HOME: dir, ORCH_CONFIG_HOME: join(dir, 'global') };
    await exec(process.execPath, [cli, 'config', '--effective'], { cwd: repo, env });
    await assert.rejects(access(marker), { code: 'ENOENT' });
    process.env.PATH = bin;
    await detectHost('codex'); await inspectCodexNativeControl();
    await discoverCodexModels(undefined, 100).catch(() => {});
    await getCatalogForHost(repo, 'codex', { env: { ...env, PATH: bin }, timeout: 100 });
    await assert.rejects(access(marker), { code: 'ENOENT' });
  } finally { process.env.PATH = previous; await rm(dir, { recursive: true, force: true }); }
});

test('resolver rejects repository ancestors, canonical targets and relative PATH while preserving external user installs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orch-resolver-boundary-'));
  try {
    const repo = join(dir, 'repo'), bin = join(repo, 'bin'), external = join(dir, 'user', '.local', 'bin'), marker = join(dir, 'marker');
    await mkdir(bin, { recursive: true }); await mkdir(external, { recursive: true }); await mkdir(join(repo, '.git'));
    const attacker = `#!${process.execPath}\nimport{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},'attacker');`;
    await writeFile(join(bin, 'fixturehost'), attacker, { mode: 0o700 });
    await writeFile(join(bin, 'node'), attacker, { mode: 0o700 });
    await symlink(join(bin, 'fixturehost'), join(external, 'fixturehost'));
    await assert.rejects(resolveExecutable('fixturehost', { env: { PATH: `${bin}${delimiter}${external}` }, cwd: repo }), /EXECUTABLE_UNAVAILABLE/);
    await assert.rejects(resolveExecutable('fixturehost', { env: { PATH: `.${delimiter}bin${delimiter}` }, cwd: repo }), /EXECUTABLE_UNAVAILABLE/);
    await rm(join(external, 'fixturehost'));
    await writeFile(join(external, 'fixturehost'), '#!/usr/bin/env node\nconsole.log(process.env.FIXTURE_SENTINEL);', { mode: 0o700 });
    const resolved = await resolveExecutable('fixturehost', { cwd: repo, env: { PATH: `${bin}${delimiter}${external}`, FIXTURE_SENTINEL: 'external-user-host' } });
    assert.equal((await exec(resolved.command, resolved.args, { env: resolved.env, cwd: repo })).stdout.trim(), 'external-user-host');
    assert.equal(resolved.env.PATH.includes(bin), false);
    await assert.rejects(access(marker), { code: 'ENOENT' });
    // Explicit developer fixture injection is separate from all production default discovery paths.
    const fixture = await resolveExecutable('fixturehost', { trustedExecutable: join(bin, 'fixturehost') });
    await exec(fixture.command, fixture.args, { env: fixture.env }); await access(marker);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('catalog helper receives the supplied environment and fingerprints its sanitized form', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orch-catalog-env-'));
  try {
    const executable = join(dir, 'fixturehost');
    await writeFile(executable, `#!${process.execPath}\nimport{createInterface}from'node:readline';if(process.argv[2]==='--version'){console.log('fixture 1');process.exit(0)}createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(m.id)console.log(JSON.stringify({id:m.id,result:m.method==='initialize'?{}:{data:[{id:process.env.FIXTURE_SENTINEL}]}}))});`, { mode: 0o700 });
    const options = { executable, env: { PATH: '', HOME: dir, ORCH_CONFIG_HOME: join(dir, 'global'), FIXTURE_SENTINEL: 'provided-env' } };
    const result = await getCatalogForHost(dir, 'codex', options);
    assert.equal(result.models[0].id, 'provided-env'); assert.equal(result.contextMatches, false);
    const changed = await getCatalogForHost(dir, 'codex', { ...options, env: { ...options.env, FIXTURE_SENTINEL: 'changed-env' } });
    assert.equal(changed.models[0].id, 'changed-env'); assert.notEqual(changed.cacheKey, result.cacheKey);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('external Git-managed global npm installs remain valid through their public bin', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orch-global-host-'));
  try {
    const repo = join(dir, 'origin'), install = join(dir, 'homebrew'), bin = join(install, 'bin');
    const target = join(install, 'lib', 'node_modules', 'fixture', 'cli');
    await mkdir(join(repo, '.git'), { recursive: true }); await mkdir(join(install, '.git'), { recursive: true });
    await mkdir(bin); await mkdir(join(install, 'lib', 'node_modules', 'fixture'), { recursive: true });
    await writeFile(target, '#!/usr/bin/env node\nconsole.log("external-npm-host");', { mode: 0o700 });
    await symlink(target, join(bin, 'fixturehost'));
    const resolved = await resolveExecutable('fixturehost', { cwd: repo, env: { PATH: bin } });
    assert.equal((await exec(resolved.command, resolved.args, { env: resolved.env })).stdout.trim(), 'external-npm-host');
    const outside = await resolveExecutable('fixturehost', { cwd: dir, env: { PATH: bin } });
    assert.equal(outside.path, resolved.path);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
