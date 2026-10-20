import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { resolveExecutable } from '../../core/src/process/executable.ts';
const exec = promisify(execFile);
// Optional daemon diagnostic only; current-conversation native Agent dispatch does not require this socket.
export async function inspectCodexNativeControl(executable?: string, timeout = 5000) {
  const base = { status: 'BLOCKED_CAPABILITY' as const, executionReady: false as const, contextMatches: false as const,
    checkedAt: new Date().toISOString(), evidence: 'codex app-server daemon version',
    definitionReload: { status: 'unknown' as const, onDefinitionChange: 'NEEDS_RELOAD' as const } };
  try {
    const resolved = await resolveExecutable('codex', { trustedExecutable: executable });
    await exec(resolved.command, [...resolved.args, 'app-server', 'daemon', 'version'], { env: resolved.env, timeout, killSignal: 'SIGKILL', maxBuffer: 16384, windowsHide: true });
    return { ...base, controlSocket: 'unknown' as const, reason: 'NATIVE_CONTROL_CONTEXT_UNVERIFIED' };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
    const reason = failure.code === 'ENOENT' || (error instanceof Error && error.message === 'EXECUTABLE_UNAVAILABLE') ? 'HOST_EXECUTABLE_UNAVAILABLE'
      : failure.killed ? 'NATIVE_CONTROL_PROBE_TIMEOUT'
      : failure.stderr?.includes('failed to connect to') && /No such file or directory|Connection refused/.test(failure.stderr)
        ? 'NATIVE_CONTROL_SOCKET_UNAVAILABLE' : 'NATIVE_CONTROL_PROBE_UNSUPPORTED_OR_FAILED';
    return { ...base, controlSocket: reason === 'NATIVE_CONTROL_SOCKET_UNAVAILABLE' ? 'unavailable' as const : 'unknown' as const, reason };
  }
}
