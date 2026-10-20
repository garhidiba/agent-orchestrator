import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { hash } from '../../core/src/state/store.ts';
import { git } from '../../core/src/git/repository.ts';
import { createServer } from './server.ts';
const { values } = parseArgs({ options: { host: { type: 'string' }, origin: { type: 'string' } } });
if (values.host !== 'codex' && values.host !== 'claude') throw new Error('HOST_REQUIRED');
const invocation = await realpath(resolve(values.origin ?? process.cwd()));
let origin: string | null;
try { origin = await realpath(await git(invocation, 'rev-parse', '--show-toplevel')); }
catch (error) {
  const failure = error as { code?: number; stderr?: string };
  if (failure.code !== 128 || !failure.stderr?.includes('not a git repository')) throw new Error('GIT_INSPECTION_FAILED');
  origin = null;
}
const localState = join(homedir(), '.local', 'state', 'orch');
const token = join(localState, 'coordinators', `${hash([values.host, origin ?? invocation])}.token`);
const server = await createServer(origin, values.host, join(homedir(), '.local', 'share', 'orch', 'worktrees'), token);
await server.connect(new StdioServerTransport());
