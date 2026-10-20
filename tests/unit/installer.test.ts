import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packRelease, install } from '../../packages/installer/src/installation/index.ts';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'orch 설치 space-'));
  const source = join(dir, 'source'), bundle = join(dir, 'bundle'), home = join(dir, 'home'), root = join(dir, 'installed');
  for (const path of ['packages/mcp-server/src', 'skills/orch', 'skills/orch-configure', 'references', 'templates/defaults']) await mkdir(join(source, path), { recursive: true });
  await writeFile(join(source, 'package.json'), '{"type":"module","dependencies":{}}');
  await writeFile(join(source, 'packages/mcp-server/src/stdio.ts'), `import readline from 'node:readline';
for await (const line of readline.createInterface({input:process.stdin})) {
 const m=JSON.parse(line); if(m.id===undefined) continue;
 const result=m.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'orch',version:'fixture'}}:{tools:[{name:'orch_environment',inputSchema:{type:'object'}}]};
 console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));
}`);
  await writeFile(join(source, 'skills/orch/SKILL.md'), '# ORCH\n');
  await writeFile(join(source, 'skills/orch-configure/SKILL.md'), '# Configure\n');
  await writeFile(join(source, 'references/workflow.md'), '# Workflow\n');
  await writeFile(join(source, 'templates/defaults/config.yaml'), 'schema_version: 1\n');
  await mkdir(join(home, '.codex'), { recursive: true });
  await writeFile(join(home, '.codex/config.toml'), 'model = "user-model"\n[mcp_servers.other]\ncommand = "other"\n');
  const checksum = await packRelease(source, bundle, '0.1.0');
  return { dir, source, bundle, home, root, checksum };
}

test('AT-047: verified immutable install is idempotent and preserves other host configuration', async () => {
  const f = await fixture();
  try {
    const options = { ...f, hosts: ['codex', 'claude'] as const, scope: 'user' as const };
    const first = await install(options);
    const config = await readFile(join(f.home, '.codex/config.toml'), 'utf8');
    await install(options);
    assert.equal(await readFile(join(f.home, '.codex/config.toml'), 'utf8'), config);
    assert.match(config, /user-model/);
    assert.match(config, /mcp_servers.other/);
    assert.equal(first.execution, 'UNVERIFIED');
    assert.match(config, /--host/);
    assert.match(config, /--origin/);
    assert.equal(first.reload, 'NEEDS_RELOAD');
    const { doctor } = await import('../../packages/installer/src/diagnostics/index.ts');
    const project = join(f.dir, 'project');
    await mkdir(join(project, '.codex'), { recursive: true });
    await writeFile(join(project, '.codex/config.toml'), '[mcp_servers.other]\ncommand="other"\n');
    const diagnosis = await doctor(project, 'codex', { home: f.home, root: f.root, executable: process.execPath, catalog: false });
    assert.equal(diagnosis.installation, 'integrity_verified');
    assert.equal(diagnosis.mcp.status, 'not_run_untrusted');
    assert.equal(diagnosis.executionReady, false);
    assert.equal(await readFile(join(f.home, '.agents/skills/orch/references/workflow.md'), 'utf8'), '# Workflow\n');
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('AT-048: user skill or MCP entry is never overwritten, even with a valid release', async () => {
  const f = await fixture();
  try {
    const skill = join(f.home, '.agents/skills/orch'); await mkdir(skill, { recursive: true });
    await writeFile(join(skill, 'SKILL.md'), '# User skill');
    await assert.rejects(install({ ...f, hosts: ['codex'], scope: 'user' }), /INSTALL_CONFLICT/);
    assert.equal(await readFile(join(skill, 'SKILL.md'), 'utf8'), '# User skill');
    assert.equal(await readFile(join(f.home, '.codex/config.toml'), 'utf8'), 'model = "user-model"\n[mcp_servers.other]\ncommand = "other"\n');
    await rm(skill, { recursive: true });
    await writeFile(join(f.home, '.codex/config.toml'), '[mcp_servers.orch]\ncommand="user-tool"\n');
    await assert.rejects(install({ ...f, hosts: ['codex'], scope: 'user' }), /INSTALL_CONFLICT/);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('release checksum and content tampering fail before host writes; dry-run writes nothing', async () => {
  const f = await fixture();
  try {
    const options = { ...f, hosts: ['codex'] as const, scope: 'user' as const };
    await install({ ...options, dryRun: true });
    await assert.rejects(readFile(join(f.root, 'installation.json')), { code: 'ENOENT' });
    await assert.rejects(install({ ...options, checksum: '0'.repeat(64) }), /CHECKSUM/);
    await writeFile(join(f.bundle, 'skills/orch/SKILL.md'), 'tampered');
    await assert.rejects(install(options), /CONTENT/);
    await assert.rejects(readFile(join(f.home, '.agents/skills/orch/SKILL.md')), { code: 'ENOENT' });
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('AT-049/050: failed migration restores config and active version; one-host removal preserves other host and run data', async () => {
  const { update, uninstall, rollback } = await import('../../packages/installer/src/installation/index.ts');
  const f = await fixture();
  try {
    const options = { ...f, hosts: ['codex', 'claude'] as const, scope: 'user' as const };
    await install(options);
    const config = join(f.home, '.config/orch/config.yaml');
    await writeFile(config, 'schema_version: 1\nmodel_selection:\n  profile: quality\n');
    await mkdir(join(f.root, 'runs'), { recursive: true }); await writeFile(join(f.root, 'runs/pinned.txt'), '0.1.0');
    const bundle2 = join(f.dir, 'release2'), checksum2 = await packRelease(f.source, bundle2, '0.2.0');
    await assert.rejects(update({ ...options, bundle: bundle2, checksum: checksum2, migrate: async path => { await writeFile(path, 'broken: migration'); throw new Error('migration failed'); } }), /migration failed/);
    assert.match(await readFile(config, 'utf8'), /profile: quality/);
    assert.equal(JSON.parse(await readFile(join(f.root, 'installation.json'), 'utf8')).activeVersion, '0.1.0');
    await update({ ...options, bundle: bundle2, checksum: checksum2 });
    assert.equal(JSON.parse(await readFile(join(f.root, 'installation.json'), 'utf8')).activeVersion, '0.2.0');
    await rollback({ ...options, version: '0.1.0' });
    assert.equal(JSON.parse(await readFile(join(f.root, 'installation.json'), 'utf8')).activeVersion, '0.1.0');
    await uninstall({ ...options, hosts: ['codex'] });
    await uninstall({ ...options, hosts: ['codex'] });
    await assert.rejects(readFile(join(f.home, '.agents/skills/orch/SKILL.md')), { code: 'ENOENT' });
    assert.equal(await readFile(join(f.home, '.claude/skills/orch/SKILL.md'), 'utf8'), '# ORCH\n');
    assert.equal(await readFile(join(f.root, 'runs/pinned.txt'), 'utf8'), '0.1.0');
    assert.match(await readFile(config, 'utf8'), /profile: quality/);
    assert.match(await readFile(join(f.home, '.claude.json'), 'utf8'), /mcpServers/);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('uninstall preserves user-edited MCP keys, skill contents and user additions', async () => {
  const { uninstall } = await import('../../packages/installer/src/installation/index.ts');
  const f = await fixture();
  try {
    const options = { ...f, hosts: ['claude'] as const, scope: 'user' as const };
    await install(options);
    const skill = join(f.home, '.claude/skills/orch');
    await writeFile(join(skill, 'SKILL.md'), 'user edited');
    await writeFile(join(skill, 'user.txt'), 'keep');
    await mkdir(join(skill, 'user-empty-directory'));
    const config = join(f.home, '.claude.json');
    await writeFile(config, '{"mcpServers":{"orch":{"command":"user-edited"}},"other":true}');
    const result = await uninstall(options);
    assert.equal(result.preserved.length, 2);
    assert.equal(await readFile(join(skill, 'SKILL.md'), 'utf8'), 'user edited');
    assert.equal(await readFile(join(skill, 'user.txt'), 'utf8'), 'keep');
    assert.equal(JSON.parse(await readFile(config, 'utf8')).mcpServers.orch.command, 'user-edited');
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('project installs stay in the project, preserve instructions and require explicit scope', async () => {
  const f = await fixture();
  try {
    const project = join(f.dir, 'project 한글 path'); await mkdir(project);
    await writeFile(join(project, 'AGENTS.md'), '# User policy');
    await install({ ...f, hosts: ['codex'], scope: 'project', project });
    assert.equal(await readFile(join(project, 'AGENTS.md'), 'utf8'), '# User policy');
    assert.match(await readFile(join(project, '.codex/config.toml'), 'utf8'), /mcp_servers.orch/);
    await assert.rejects(readFile(join(f.home, '.agents/skills/orch/SKILL.md')), { code: 'ENOENT' });
    await assert.rejects(install({ ...f, hosts: ['codex'], scope: 'project' }), /PROJECT_REQUIRED/);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('AT-053/056: shell launcher installs copy assets from a space/Korean path without login or inference', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { chmod } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const f = await fixture();
  try {
    const bin = join(f.dir, 'bin'); await mkdir(bin);
    const host = join(bin, 'codex'); await writeFile(host, '#!/bin/sh\nif [ "$1" != "--version" ]; then exit 91; fi\necho "fixture-host"\n'); await chmod(host, 0o755);
    const script = fileURLToPath(new URL('../../scripts/install.sh', import.meta.url));
    const { stdout } = await promisify(execFile)('/bin/sh', [script, '--bundle', f.bundle, '--checksum', f.checksum, '--target', 'codex', '--root', f.root, '--yes'], {
      env: { ...process.env, HOME: f.home, PATH: `${bin}:${process.env.PATH}`, XDG_CONFIG_HOME: join(f.home, '.config'), ORCH_CONFIG_HOME: join(f.home, '.config/orch') },
    });
    const result = JSON.parse(stdout);
    assert.equal(result.authentication, 'NOT_CHECKED');
    assert.equal(result.execution, 'UNVERIFIED');
    assert.equal(result.mcp, 'HANDSHAKE_VERIFIED');
    assert.match(await readFile(join(f.home, '.codex/config.toml'), 'utf8'), /orch 설치 space/);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('uninstall shell entry through a linked checkout previews and removes both hosts while preserving data', { skip: process.platform === 'win32' }, async () => {
  const { symlink, access } = await import('node:fs/promises');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url');
  const f = await fixture();
  try {
    await install({ ...f, hosts: ['codex', 'claude'], scope: 'user' });
    await mkdir(join(f.root, 'runs')); await writeFile(join(f.root, 'runs/keep.txt'), 'keep');
    const linked = join(f.dir, 'linked checkout');
    await symlink(fileURLToPath(new URL('../../', import.meta.url)), linked);
    const config = await readFile(join(f.home, '.config/orch/config.yaml'));
    const manifest = await readFile(join(f.root, 'installation.json'));
    const run = async (...args: string[]) => JSON.parse((await promisify(execFile)('/bin/sh', [join(linked, 'scripts/uninstall.sh'), '--root', f.root, ...args], {
      cwd: f.dir, env: { ...process.env, HOME: f.home, USERPROFILE: f.home }, timeout: 10000,
    })).stdout);
    assert.deepEqual((await run('--dry-run')).removedHosts, ['codex', 'claude']);
    assert.deepEqual(await readFile(join(f.root, 'installation.json')), manifest);
    assert.deepEqual((await run()).removedHosts, ['codex', 'claude']);
    assert.deepEqual((await run()).removedHosts, []);
    for (const host of ['.agents', '.claude']) await assert.rejects(access(join(f.home, host, 'skills/orch/SKILL.md')), { code: 'ENOENT' });
    assert.doesNotMatch(await readFile(join(f.home, '.codex/config.toml'), 'utf8'), /mcp_servers\.orch/);
    assert.equal(JSON.parse(await readFile(join(f.home, '.claude.json'), 'utf8')).mcpServers.orch, undefined);
    assert.match(await readFile(join(f.home, '.codex/config.toml'), 'utf8'), /user-model/);
    assert.deepEqual(await readFile(join(f.home, '.config/orch/config.yaml')), config);
    assert.equal(await readFile(join(f.root, 'runs/keep.txt'), 'utf8'), 'keep');
    await access(join(f.root, 'versions/0.1.0/release.json'));
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('installer rejects symlinked host settings instead of writing through them', async () => {
  const { symlink } = await import('node:fs/promises');
  const f = await fixture();
  try {
    const outside = join(f.dir, 'outside.toml'); await writeFile(outside, 'model="outside"\n');
    const config = join(f.home, '.codex/config.toml'); await rm(config); await symlink(outside, config);
    await assert.rejects(install({ ...f, hosts: ['codex'], scope: 'user' }), /SYMLINK/);
    assert.equal(await readFile(outside, 'utf8'), 'model="outside"\n');
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

async function productionFixture() {
  const { symlink } = await import('node:fs/promises');
  const f = await fixture(), modules = join(f.dir, 'shared-modules');
  await mkdir(join(modules, 'required'), { recursive: true });
  await mkdir(join(modules, 'extraneous'), { recursive: true });
  await writeFile(join(modules, 'required/package.json'), '{"name":"required","version":"1.0.0"}');
  await writeFile(join(modules, 'extraneous/private.txt'), 'not a release asset');
  await symlink(modules, join(f.source, 'node_modules'));
  await writeFile(join(f.source, 'package.json'), '{"type":"module","dependencies":{"required":"1.0.0"}}');
  await writeFile(join(f.source, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {
    '': { dependencies: { required: '1.0.0' } },
    'node_modules/required': { version: '1.0.0', resolved: 'https://registry.npmjs.org/required/-/required-1.0.0.tgz', integrity: 'sha512-fixture', dependencies: {} },
  } }));
  return { ...f, modules, output: join(f.dir, 'production-release') };
}

test('packaging follows the pinned production closure through a shared root and excludes extraneous modules', async () => {
  const f = await productionFixture();
  try {
    await packRelease(f.source, f.output, '0.2.0');
    assert.equal(JSON.parse(await readFile(join(f.output, 'node_modules/required/package.json'), 'utf8')).version, '1.0.0');
    await assert.rejects(readFile(join(f.output, 'node_modules/extraneous/private.txt')), { code: 'ENOENT' });
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('packaging rejects a package-internal symlink without activating a release', async () => {
  const { symlink } = await import('node:fs/promises');
  const f = await productionFixture();
  try {
    const privateFile = join(f.dir, 'private.txt'); await writeFile(privateFile, 'private data');
    await symlink(privateFile, join(f.modules, 'required/leak.txt'));
    await assert.rejects(packRelease(f.source, f.output, '0.2.0'), /UNSAFE_FILE/);
    await assert.rejects(readFile(join(f.output, 'release.json')), { code: 'ENOENT' });
    assert.equal(await readFile(privateFile, 'utf8'), 'private data');
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('packaging honors declared nested lock entries and records absent optional packages', async () => {
  const f = await productionFixture();
  try {
    const lockFile = join(f.source, 'package-lock.json'), lock = JSON.parse(await readFile(lockFile, 'utf8'));
    lock.packages['node_modules/required'].dependencies = { nested: '2.0.0' };
    lock.packages['node_modules/required'].optionalDependencies = { platformOptional: '1.0.0' };
    lock.packages['node_modules/required/node_modules/nested'] = { version: '2.0.0', resolved: 'https://registry.npmjs.org/nested/-/nested-2.0.0.tgz', integrity: 'sha512-fixture' };
    lock.packages['node_modules/platformOptional'] = { version: '1.0.0', optional: true, os: ['!'+process.platform], resolved: 'https://registry.npmjs.org/platformOptional/-/platformOptional-1.0.0.tgz', integrity: 'sha512-fixture' };
    await writeFile(lockFile, JSON.stringify(lock));
    await mkdir(join(f.modules, 'required/node_modules/nested'), { recursive: true });
    await mkdir(join(f.modules, 'required/node_modules/extraneous'), { recursive: true });
    await writeFile(join(f.modules, 'required/node_modules/nested/package.json'), '{"version":"2.0.0"}');
    await writeFile(join(f.modules, 'required/node_modules/extraneous/private.txt'), 'not declared');
    await packRelease(f.source, f.output, '0.2.0');
    assert.equal(JSON.parse(await readFile(join(f.output, 'node_modules/required/node_modules/nested/package.json'), 'utf8')).version, '2.0.0');
    await assert.rejects(readFile(join(f.output, 'node_modules/required/node_modules/extraneous/private.txt')), { code: 'ENOENT' });
    assert.deepEqual(JSON.parse(await readFile(join(f.output, 'release.json'), 'utf8')).skippedOptionalPackages, ['node_modules/platformOptional:not-installed']);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('packaging requires a matching lock and all installed required packages, and rejects external entries', async () => {
  const f = await productionFixture();
  try {
    const lockFile = join(f.source, 'package-lock.json'), original = await readFile(lockFile);
    await rm(lockFile);
    await assert.rejects(packRelease(f.source, f.output, '0.2.0'), /LOCK_REQUIRED/);
    const lock = JSON.parse(original.toString()); lock.packages['node_modules/required'].resolved = 'file:../private';
    await writeFile(lockFile, JSON.stringify(lock));
    await assert.rejects(packRelease(f.source, f.output, '0.2.0'), /EXTERNAL_DEPENDENCY/);
    await writeFile(lockFile, original); await rm(join(f.modules, 'required'), { recursive: true });
    await assert.rejects(packRelease(f.source, f.output, '0.2.0'), /DEPENDENCY_MISSING/);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('management Git probes ignore repository node_modules PATH shadows for current and explicit project roots', { skip: process.platform === 'win32' }, async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { delimiter } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { git } = await import('../../packages/core/src/git/repository.ts');
  const dir = await mkdtemp(join(tmpdir(), 'orch-manage-git-')), project = join(dir, 'project '), home = join(dir, 'home');
  const bin = join(project, 'node_modules/.bin'), marker = join(dir, 'untrusted-git-ran');
  try {
    await mkdir(bin, { recursive: true }); await mkdir(home); await git(project, 'init');
    await writeFile(join(bin, 'git'), '#!/bin/sh\n: > "$ORCH_TEST_MARKER"\nif [ "$1" = "--version" ]; then echo "git version 9.9.9"; else printf "%s\\n" "$ORCH_TEST_ROOT"; fi\n', { mode: 0o700 });
    const cli = fileURLToPath(new URL('../../packages/installer/src/manage.ts', import.meta.url));
    const env = { ...process.env, HOME: home, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, ORCH_CONFIG_HOME: join(home, 'config'), ORCH_TEST_MARKER: marker, ORCH_TEST_ROOT: project };
    for (const scope of ['user', 'project']) {
      const args = [cli, 'uninstall', '--scope', scope, '--target', 'auto', '--root', join(dir, 'install'), '--dry-run'];
      if (scope === 'project') args.push('--project', project);
      const result = await promisify(execFile)(process.execPath, args, { cwd: scope === 'user' ? project : dir, env });
      assert.equal(JSON.parse(result.stdout).dryRun, true);
      await assert.rejects(readFile(marker), { code: 'ENOENT' });
    }
    await assert.rejects(promisify(execFile)(process.execPath, [cli, 'uninstall', '--scope', 'project', '--project', bin, '--dry-run'], { cwd: dir, env }), /PROJECT_MUST_BE_GIT_ROOT/);
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('one installer command builds, verifies and installs locally without bundle arguments', { skip: process.platform === 'win32' }, async () => {
  const { cp, symlink, realpath, readdir } = await import('node:fs/promises');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url');
  const f = await fixture(), repo = fileURLToPath(new URL('../../', import.meta.url));
  try {
    for (const name of ['packages', 'scripts', 'skills', 'references', 'templates', 'package.json', 'package-lock.json']) await cp(join(repo, name), join(f.source, name), { recursive: true, force: true });
    await symlink(join(repo, 'node_modules'), join(f.source, 'node_modules'));
    const bin = join(f.dir, 'bin'), temporary = join(f.dir, 'tmp'); await mkdir(bin); await mkdir(temporary);
    await symlink(process.execPath, join(bin, 'node'));
    await writeFile(join(bin, 'codex'), '#!/bin/sh\nif [ "$1" != "--version" ]; then exit 91; fi\necho fixture-host\n', { mode: 0o755 });
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: f.home, PATH: `${bin}:/usr/bin:/bin`, XDG_DATA_HOME: join(f.dir, 'data'), XDG_CONFIG_HOME: join(f.home, '.config'), ORCH_CONFIG_HOME: join(f.home, '.config/orch'), TMPDIR: temporary };
    const script = await realpath(join(f.source, 'scripts/install.sh')), exec = promisify(execFile);
    const run = async (...args: string[]) => JSON.parse((await exec('/bin/sh', [script, ...args], { cwd: f.dir, env, timeout: 60000, maxBuffer: 1024 * 1024 })).stdout);
    const preview = await run('--dry-run');
    assert.equal(preview.dryRun, true);
    const root = join(f.dir, 'data/orch');
    await assert.rejects(readFile(join(root, 'installation.json')), { code: 'ENOENT' });
    const first = await run();
    assert.deepEqual(first.hosts, ['codex']); assert.match(first.version, /^0\.1\.0-local\.[a-f0-9]+$/);
    assert.equal(first.authentication, 'NOT_CHECKED');
    const config = await readFile(join(f.home, '.codex/config.toml'), 'utf8');
    assert.match(config, /user-model/); assert.match(config, /mcp_servers.orch/);
    const again = await run();
    assert.equal(again.version, first.version);
    assert.equal(await readFile(join(f.home, '.codex/config.toml'), 'utf8'), config);
    assert.deepEqual(await readdir(join(root, 'versions')), [first.version]);
    assert.deepEqual(await readdir(temporary), []);
    // The npm executable is a process-boundary fixture; no registry or user installation is used.
    await rm(join(f.source, 'node_modules'));
    await writeFile(join(bin, 'npm'), '#!/bin/sh\n[ "$*" = "ci --ignore-scripts --no-audit --no-fund" ] || exit 92\n: > "$ORCH_TEST_NPM_MARKER"\nln -s "$ORCH_TEST_MODULES" node_modules\n', { mode: 0o755 });
    const marker = join(f.dir, 'npm-invoked');
    env.ORCH_TEST_NPM_MARKER = marker; env.ORCH_TEST_MODULES = join(repo, 'node_modules');
    await run('--dry-run');
    assert.equal(await readFile(marker, 'utf8'), '');
    assert.deepEqual(await readdir(temporary), []);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('renaming entry skills migrates owned installs, supports rollback and preserves edited legacy skills', async () => {
  const { rename, access } = await import('node:fs/promises');
  const { rollback, uninstall } = await import('../../packages/installer/src/installation/index.ts');
  const f = await fixture(), options = { ...f, hosts: ['codex', 'claude'] as const, scope: 'user' as const };
  try {
    await install(options);
    await rename(join(f.source, 'skills/orch'), join(f.source, 'skills/agent-orch'));
    await rename(join(f.source, 'skills/orch-configure'), join(f.source, 'skills/agent-orch-configure'));
    const bundle = join(f.dir, 'renamed-bundle'), checksum = await packRelease(f.source, bundle, '0.2.0');
    const next = { ...options, bundle, checksum };
    await install(next);
    for (const host of ['.agents', '.claude']) {
      await access(join(f.home, host, 'skills/agent-orch/SKILL.md'));
      await access(join(f.home, host, 'skills/agent-orch-configure/SKILL.md'));
      await assert.rejects(access(join(f.home, host, 'skills/orch')), { code: 'ENOENT' });
      await assert.rejects(access(join(f.home, host, 'skills/orch-configure')), { code: 'ENOENT' });
    }
    await rollback({ ...options, version: '0.1.0' });
    await access(join(f.home, '.agents/skills/orch/SKILL.md'));
    await assert.rejects(access(join(f.home, '.agents/skills/agent-orch')), { code: 'ENOENT' });
    await install(next); await uninstall(options);
    await assert.rejects(access(join(f.home, '.agents/skills/agent-orch')), { code: 'ENOENT' });
    await rollback({ ...options, version: '0.1.0' });
    const edited = join(f.home, '.agents/skills/orch/SKILL.md'); await writeFile(edited, 'user-owned edits');
    const config = await readFile(join(f.home, '.codex/config.toml'), 'utf8');
    await assert.rejects(install(next), /INSTALL_CONFLICT/);
    assert.equal(await readFile(edited, 'utf8'), 'user-owned edits');
    assert.equal(await readFile(join(f.home, '.codex/config.toml'), 'utf8'), config);
    await assert.rejects(access(join(f.home, '.agents/skills/agent-orch')), { code: 'ENOENT' });
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('a broken staged MCP release cannot activate or change existing host files', async () => {
  const f = await fixture();
  try {
    const options = { ...f, hosts: ['codex'] as const, scope: 'user' as const };
    await install(options);
    const before = await readFile(join(f.home, '.codex/config.toml'));
    await writeFile(join(f.source, 'packages/mcp-server/src/stdio.ts'), 'process.exit(3)');
    const bundle = join(f.dir, 'broken'), checksum = await packRelease(f.source, bundle, '0.2.0');
    await assert.rejects(install({ ...options, bundle, checksum }), /INSTALL_MCP_VERIFICATION_FAILED/);
    assert.deepEqual(await readFile(join(f.home, '.codex/config.toml')), before);
    assert.equal(JSON.parse(await readFile(join(f.root, 'installation.json'), 'utf8')).activeVersion, '0.1.0');
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('packaged plugin is self-contained and deterministic after source removal', async () => {
  const { cp } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const f = await fixture();
  try {
    const repo = fileURLToPath(new URL('../../', import.meta.url));
    await cp(join(repo, 'templates/claude'), join(f.source, 'templates/claude'), { recursive: true });
    await mkdir(join(f.source, 'scripts'));
    await cp(join(repo, 'scripts/claude-session.mjs'), join(f.source, 'scripts/claude-session.mjs'));
    const { rename } = await import('node:fs/promises');
    await rename(join(f.source, 'skills/orch'), join(f.source, 'skills/agent-orch'));
    await rename(join(f.source, 'skills/orch-configure'), join(f.source, 'skills/agent-orch-configure'));
    const first = join(f.dir, 'plugin-one'), second = join(f.dir, 'plugin-two');
    const checksum = await packRelease(f.source, first, '0.3.0');
    assert.equal(await packRelease(f.source, second, '0.3.0'), checksum);
    await rm(f.source, { recursive: true, force: true });
    const manifest = JSON.parse(await readFile(join(first, '.claude-plugin/plugin.json'), 'utf8'));
    assert.equal(manifest.name, 'agent-orch');
    assert.equal(await readFile(join(first, 'skills/agent-orch/references/workflow.md'), 'utf8'), '# Workflow\n');
    const { parse } = await import('yaml');
    const initSkill = await readFile(join(first, 'templates/claude/plugin/skills/init/SKILL.md'), 'utf8');
    assert.equal(parse(initSkill.split('---')[1]).name, 'init');
    assert.equal(manifest.version, '0.3.0');
    const config = JSON.parse(await readFile(join(first, '.mcp.json'), 'utf8'));
    assert.deepEqual(config.mcpServers.orch.args, ['${CLAUDE_PLUGIN_ROOT}/packages/mcp-server/src/stdio.ts', '--host', 'claude']);
    assert.equal(config.mcpServers.orch.command, 'node');
    assert.match(await readFile(join(first, 'templates/claude/plugin/skills/run/SKILL.md'), 'utf8'), /CLAUDE_PLUGIN_ROOT/);
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const hook = JSON.parse((await promisify(execFile)(process.execPath, [join(first, 'scripts/claude-session.mjs')])).stdout);
    assert.equal(hook.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.equal(manifest.agents.length, 8);
    assert.equal(await readFile(join(first, 'skills/agent-orch/SKILL.md'), 'utf8'), '# ORCH\n');
    assert.match(await readFile(join(first, 'templates/claude/plugin/agents/orch-reviewer.md'), 'utf8'), /tools: Read, Grep, Glob/);
    await install({ ...f, bundle: first, checksum, hosts: ['claude'], scope: 'user' });
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
