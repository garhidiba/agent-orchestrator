import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectCodexNativeControl } from '../../packages/host-codex/src/capabilities.ts';

test('native control probe reports actual read-only outcome without promoting reachable sockets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orch-control-')), executable = join(dir, 'host');
  try {
    await writeFile(executable, `#!${process.execPath}\nif(process.argv.slice(2).join(' ')!=='app-server daemon version')process.exit(3);console.error('Error: failed to connect to fixture.sock: No such file or directory');process.exit(1);`, { mode: 0o700 });
    assert.equal((await inspectCodexNativeControl(executable)).reason, 'NATIVE_CONTROL_SOCKET_UNAVAILABLE');
    await writeFile(executable, `#!${process.execPath}\nconsole.log('{}');`, { mode: 0o700 });
    const reachable = await inspectCodexNativeControl(executable);
    assert.equal(reachable.status, 'BLOCKED_CAPABILITY'); assert.equal(reachable.reason, 'NATIVE_CONTROL_CONTEXT_UNVERIFIED');
    assert.equal(reachable.contextMatches, false); assert.equal(reachable.definitionReload.onDefinitionChange, 'NEEDS_RELOAD');
    assert.equal((await inspectCodexNativeControl(join(dir, 'absent'))).reason, 'HOST_EXECUTABLE_UNAVAILABLE');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
