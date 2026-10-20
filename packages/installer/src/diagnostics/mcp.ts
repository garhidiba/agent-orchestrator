import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Probe only initialize/list in a disposable HOME: the server's coordinator token is not a user mutation.
export async function probeMcp(options: { command: string; args: string[]; timeout?: number }) {
  const home = await mkdtemp(join(tmpdir(), 'orch-mcp-probe-'));
  const client = new Client({ name: 'orch-doctor', version: '1' });
  const transport = new StdioClientTransport({ command: options.command, args: options.args, cwd: home,
    env: { HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData/Roaming'), LOCALAPPDATA: join(home, 'AppData/Local'),
      ORCH_CONFIG_HOME: join(home, 'config'), XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'),
      XDG_STATE_HOME: join(home, 'state'), PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '',
      TMPDIR: home, TEMP: home, TMP: home }, stderr: 'pipe' });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let tools: string[] = [];
  try {
    await Promise.race([(async () => {
      await client.connect(transport);
      const inventory = await client.listTools(); tools = inventory.tools.map(tool => tool.name);
      if (client.getServerVersion()?.name !== 'orch' || !tools.includes('orch_environment')) throw new Error('MCP_IDENTITY_MISMATCH');
    })(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('MCP_TIMEOUT')), options.timeout ?? 10000); })]);
    return { status: 'verified' as const, inference: 'NOT_RUN' as const, server: client.getServerVersion(), capabilities: client.getServerCapabilities(), tools };
  } catch { return { status: 'failed' as const, inference: 'NOT_RUN' as const }; }
  finally { clearTimeout(timer); await transport.close().catch(() => {}); await rm(home, { recursive: true, force: true }); }
}
