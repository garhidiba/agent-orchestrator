import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { safeStateDirectory } from '../state/artifacts.ts';
import { id, requireCondition as check } from '../../../protocol/src/runtime.ts';

export type ServiceAddress = { host: string; port: number };
export type AttemptResources = { service?: ServiceAddress; root: string; tmp: string; db: string; build: string; envFile: string; environment: Record<string, string> };
export async function allocateAttemptResources(origin: string, runId: string, attemptId: string, service?: ServiceAddress): Promise<AttemptResources> {
  id.parse(attemptId);
  check(!service || service.host === '127.0.0.1' && Number.isInteger(service.port) && service.port > 0 && service.port <= 65535, 'SERVICE_ADDRESS_INVALID');
  const run = await safeStateDirectory(origin, runId), attempts = join(run, 'attempts');
  try { await mkdir(attempts, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const stat = await lstat(attempts);
  check(stat.isDirectory() && !stat.isSymbolicLink() && await realpath(attempts) === attempts, 'STATE_PATH_UNSAFE');
  const root = join(attempts, attemptId);
  await mkdir(root, { mode: 0o700 }).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('RESOURCE_ALREADY_ALLOCATED');
    throw error;
  });
  const tmp = join(root, 'tmp'), db = join(root, 'db'), build = join(root, 'build'), envFile = join(root, 'environment.env');
  for (const directory of [tmp, db, build]) await mkdir(directory, { mode: 0o700 });
  // These are isolation directives; a gate must honor them rather than use a developer's configured database/output.
  const environment: Record<string, string> = { TMPDIR: tmp, TMP: tmp, TEMP: tmp, DATABASE_URL: `file:${join(db, 'test.db')}`,
    ORCH_TMP_DIR: tmp, ORCH_DATABASE_PATH: join(db, 'test.db'), ORCH_BUILD_DIR: build, ORCH_ENV_FILE: envFile };
  if (service) { environment.ORCH_SERVICE_HOST = service.host; environment.ORCH_SERVICE_PORT = String(service.port); }
  await writeFile(envFile, Object.entries(environment).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
  return { root, tmp, db, build, envFile, environment, ...(service ? { service: { ...service } } : {}) };
}

export async function reservePort() {
  const server = createServer(socket => socket.destroy());
  const host = '127.0.0.1';
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host, port: 0, exclusive: true }, resolve);
  });
  server.unref();
  const address = server.address();
  check(address && typeof address !== 'string', 'PORT_RESERVATION_FAILED');
  let state: 'reserved' | 'released_for_claim' | 'released' = 'reserved';
  const close = async () => { if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); };
  return {
    host, port: address.port,
    get state() { return state; },
    // Closing a socket cannot transfer ownership atomically; the service must confirm its own bind.
    async releaseForClaim() {
      check(state === 'reserved', 'PORT_NOT_RESERVED');
      await close(); state = 'released_for_claim';
      return { host, port: address.port, reserved: false as const };
    },
    async release() { await close(); state = 'released'; },
  };
}
