import { spawn } from 'node:child_process';
import type { Model } from '../../core/src/model-registry/index.ts';
import { requireCondition as check } from '../../protocol/src/runtime.ts';

type Entry = { id: string; model?: string; displayName?: string; hidden?: boolean; defaultReasoningEffort?: string; supportedReasoningEfforts?: { reasoningEffort: string }[] };
export function discoverCodexModels(executable = 'codex', timeout = 10000): Promise<{ models: Model[]; contextMatches: false }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let buffer = '', bytes = 0, request = 0, done = false;
    const models = new Map<string, Model>(), cursors = new Set<string>();
    const timer = setTimeout(() => finish(new Error('CATALOG_TIMEOUT')), timeout);
    function finish(error?: Error) {
      if (done) return; done = true; clearTimeout(timer); child.stdin.end(); child.kill('SIGKILL');
      if (error) reject(error); else resolve({ models: [...models.values()], contextMatches: false });
    }
    function send(method: string, params: object, notification = false) {
      child.stdin.write(`${JSON.stringify({ method, params, ...(!notification ? { id: ++request } : {}) })}\n`);
    }
    child.on('error', () => finish(new Error('CATALOG_PROCESS_FAILED')));
    child.on('close', () => { if (!done) finish(new Error('CATALOG_PROCESS_CLOSED')); });
    child.stdin.on('error', () => finish(new Error('CATALOG_PROCESS_FAILED')));
    child.stderr.on('data', () => {});
    child.stdout.on('data', (chunk: Buffer) => {
      try {
        bytes += chunk.length; check(bytes <= 4 * 1024 * 1024, 'CATALOG_RESPONSE_TOO_LARGE');
        buffer += chunk.toString('utf8');
        let line: number;
        while ((line = buffer.indexOf('\n')) >= 0) {
          const raw = buffer.slice(0, line); buffer = buffer.slice(line + 1); if (!raw.trim()) continue;
          const message = JSON.parse(raw) as { id?: number; error?: unknown; result?: { data?: Entry[]; nextCursor?: string | null } };
          if (message.id !== request) continue;
          check(!message.error && message.result, 'CATALOG_RPC_FAILED');
          if (request === 1) { send('initialized', {}, true); send('model/list', { limit: 100, includeHidden: true }); continue; }
          check(Array.isArray(message.result.data), 'CATALOG_INVALID');
          for (const entry of message.result.data) {
            check(typeof entry.id === 'string' && entry.id.length && (!entry.supportedReasoningEfforts || entry.supportedReasoningEfforts.every(item => typeof item.reasoningEffort === 'string')), 'CATALOG_INVALID');
            const fetchedAt = new Date().toISOString();
            models.set(entry.id, { host: 'codex', id: entry.id, displayName: entry.displayName ?? entry.id, resolvedId: entry.model ?? null,
              family: 'unknown', support: 'advertised', access: 'unknown', availability: 'unknown',
              efforts: entry.supportedReasoningEfforts?.map(item => item.reasoningEffort) ?? null, defaultEffort: entry.defaultReasoningEffort ?? null,
              hidden: entry.hidden ?? false, source: 'codex app-server model/list', sourceVersion: null, fetchedAt, expiresAt: new Date(Date.parse(fetchedAt) + 86400000).toISOString(), evidence: [] });
          }
          const cursor = message.result.nextCursor;
          if (cursor == null) { finish(); return; }
          check(typeof cursor === 'string' && !cursors.has(cursor) && cursors.size < 1000, 'CATALOG_PAGINATION_LOOP');
          cursors.add(cursor); send('model/list', { cursor, limit: 100, includeHidden: true });
        }
      } catch { finish(new Error('CATALOG_INVALID_OR_RPC_FAILED')); }
    });
    send('initialize', { clientInfo: { name: 'orch-metadata', title: 'ORCH metadata probe', version: '0.1.0' } });
  });
}
