import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { hash } from '../../core/src/state/store.ts';
import { git } from '../../core/src/git/repository.ts';
import { createServer } from './server.ts';
const { values } = parseArgs({ options: { host: { type: 'string' }, origin: { type: 'string' } } });
if (values.host !== 'codex' && values.host !== 'claude' && values.host !== 'hermes') throw new Error('HOST_REQUIRED');
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
// Linked worktrees live inside the project (`<repo>/.orch/worktrees`, git-ignored automatically) unless ORCH_WORKTREE_ROOT
// points elsewhere (absolute, or relative to the repository). Outside a Git repository the legacy per-user location is kept.
const worktreeRoot = process.env.ORCH_WORKTREE_ROOT
  ? resolve(origin ?? invocation, process.env.ORCH_WORKTREE_ROOT)
  : origin ? join(origin, '.orch', 'worktrees') : join(homedir(), '.local', 'share', 'orch', 'worktrees');
const server = await createServer(origin, values.host, worktreeRoot, token);
await server.connect(new StdioServerTransport());
