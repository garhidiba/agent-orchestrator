import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export type HostKind = 'codex' | 'claude';

// A version response establishes installation only; native execution needs M0 evidence.
export async function detectHost(host: HostKind, executable = host as string, timeout = 5000) {
  const capabilities = {
    nativeSubagents: 'unknown', perAgentModel: 'unknown', perAgentEffort: 'unknown',
    modelCatalog: 'unknown', modelObservation: 'unknown', effortObservation: 'unknown',
    existingWorktreeBinding: 'unknown', nativeWorktreeIsolation: 'unknown',
    agentDefinitionReload: 'unknown', nativeAgentResume: 'unknown',
    nativeAgentCancel: 'unknown', eventHooks: 'unknown',
  } as const;
  const base = { host, executable, capabilities, executionReady: false, checkedAt: new Date().toISOString() };
  try {
    const { stdout } = await exec(executable, ['--version'], {
      timeout, killSignal: 'SIGKILL', maxBuffer: 16 * 1024, windowsHide: true,
    });
    const version = stdout.trim();
    return { ...base, status: version ? 'detected' : 'failed', version: version || null };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { killed?: boolean };
    return {
      ...base,
      status: failure.code === 'ENOENT' ? 'not_found' : failure.killed ? 'timed_out' : 'failed',
      version: null,
    };
  }
}
