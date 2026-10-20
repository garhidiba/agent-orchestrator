import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const server = `import readline from 'node:readline';
for await (const line of readline.createInterface({input:process.stdin})) {
 const m=JSON.parse(line); if(m.id===undefined) continue;
 const result=m.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'orch',version:'fixture'}}:{tools:[{name:'orch_environment',inputSchema:{type:'object'}}]};
 console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));
}`;

test('MCP diagnostics verify protocol and tool inventory without invoking a tool or writing caller HOME', async () => {
  const { probeMcp } = await import('../../packages/installer/src/diagnostics/index.ts');
  const dir = await mkdtemp(join(tmpdir(), 'orch-diagnostic-'));
  try {
    const file = join(dir, 'server.mjs'); await writeFile(file, server);
    assert.equal((await probeMcp({ command: process.execPath, args: [file], timeout: 2000 })).status, 'verified');
    await writeFile(file, 'setInterval(()=>{},1000)');
    assert.equal((await probeMcp({ command: process.execPath, args: [file], timeout: 100 })).status, 'failed');
    assert.deepEqual(await readdir(dir), ['server.mjs']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('composite doctor refuses unowned configured commands and reports config failures without secret text', async () => {
  const { doctor } = await import('../../packages/installer/src/diagnostics/index.ts');
  const dir = await mkdtemp(join(tmpdir(), 'orch-doctor-'));
  try {
    await mkdir(join(dir, '.codex'));
    await writeFile(join(dir, '.codex/config.toml'), '[mcp_servers.orch]\ncommand="private-secret-command"\n');
    const result = await doctor(null, 'codex', { home: dir, executable: process.execPath, catalog: false });
    assert.equal(result.mcp.status, 'unowned');
    assert.equal(result.executionReady, false);
    assert.equal(JSON.stringify(result).includes('private-secret-command'), false);
    await writeFile(join(dir, '.codex/config.toml'), 'private-secret = invalid');
    const broken = await doctor(null, 'codex', { home: dir, executable: process.execPath, catalog: false });
    assert.equal(broken.hostConfig.status, 'invalid');
    assert.equal(JSON.stringify(broken).includes('private-secret'), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

async function diagnosticFixture(project = false) {
  const { packRelease } = await import('../../packages/installer/src/installation/index.ts');
  const dir = await mkdtemp(join(tmpdir(), 'orch-doctor-trust-'));
  const source = join(dir, 'source'), home = join(dir, 'home'), origin = project ? join(dir, 'project') : null;
  const root = origin ? join(origin, '.orch/installation') : join(dir, 'installed');
  for (const path of ['packages/mcp-server/src', 'skills/orch', 'skills/orch-configure', 'references', 'templates/defaults']) await mkdir(join(source, path), { recursive: true });
  await mkdir(home);
  if (origin) await mkdir(origin);
  await writeFile(join(source, 'package.json'), '{"type":"module","dependencies":{}}');
  await writeFile(join(source, 'skills/orch/SKILL.md'), '# ORCH\n');
  await writeFile(join(source, 'skills/orch-configure/SKILL.md'), '# Configure\n');
  await writeFile(join(source, 'templates/defaults/config.yaml'), 'schema_version: 1\n');
  const publish = async (runtime: string, script: string, version: string) => {
    await writeFile(join(source, 'packages/mcp-server/src/stdio.ts'), script);
    const bundle = join(root, 'versions', version); await mkdir(join(root, 'versions'), { recursive: true });
    const checksum = await packRelease(source, bundle, version);
    const entry = { command: runtime, args: [join(bundle, 'packages/mcp-server/src/stdio.ts'), '--host', 'claude', '--origin', origin ?? '.'] };
    await writeFile(origin ? join(origin, '.mcp.json') : join(home, '.claude.json'), JSON.stringify({ mcpServers: { orch: entry } }));
    await writeFile(join(root, 'installation.json'), JSON.stringify({ schema: 1, scope: origin ? 'project' : 'user', base: origin ?? home, releases: { [version]: checksum }, activeVersion: version, hosts: { claude: { version, files: {}, entry, runtime } } }));
    return bundle;
  };
  return { dir, source, home, root, origin, publish };
}

for (const kind of ['runtime', 'script']) test(`self-signed ${kind} bundle remains integrity-only and cannot execute`, async () => {
  const { doctor } = await import('../../packages/installer/src/diagnostics/index.ts');
  const { readFile } = await import('node:fs/promises');
  const f = await diagnosticFixture(true), marker = join(f.dir, 'executed');
  try {
    const runtime = kind === 'runtime' ? join(f.dir, 'counterfeit-node') : process.execPath;
    if (kind === 'runtime') await writeFile(runtime, `#!/bin/sh\nprintf ran > "${marker}"\nexit 0\n`, { mode: 0o700 });
    await f.publish(runtime, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)},'ran'); process.exit(0);`, `1.0.0-${kind}`);
    const result = await doctor(f.origin, 'claude', { home: f.home, executable: process.execPath, catalog: false });
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
    assert.equal(result.installation, 'integrity_verified');
    assert.equal(result.mcp.status, 'not_run_untrusted');
    assert.equal(result.mcp.protocol, null);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('doctor launched from the exact installed package can still probe its current runtime', async () => {
  const { cp, readFile, realpath, symlink } = await import('node:fs/promises');
  const { fileURLToPath, pathToFileURL } = await import('node:url');
  const f = await diagnosticFixture();
  try {
    const repo = fileURLToPath(new URL('../../', import.meta.url));
    await cp(join(repo, 'packages'), join(f.source, 'packages'), { recursive: true, force: true });
    // Only development dependency resolution is shared; the installed executable tree is a full copy.
    await symlink(await realpath(join(repo, 'node_modules')), join(f.dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const bundle = await f.publish(process.execPath, await readFile(join(repo, 'packages/mcp-server/src/stdio.ts'), 'utf8'), '1.0.0-current');
    const { doctor } = await import(pathToFileURL(join(bundle, 'packages/installer/src/diagnostics/index.ts')).href);
    const result = await doctor(null, 'claude', { home: f.home, root: f.root, executable: process.execPath, catalog: false });
    assert.equal(result.installation, 'verified');
    assert.equal(result.mcp.status, 'verified');
    assert.equal(result.mcp.protocol.server.name, 'orch');
    assert.equal(result.executionReady, false);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
