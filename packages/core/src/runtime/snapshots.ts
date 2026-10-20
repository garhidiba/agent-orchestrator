import { Store } from '../state/store.ts';
import { redactEvidence } from '../state/evidence.ts';
import { writeStateArtifact } from '../state/artifacts.ts';

export async function exportRunEvidence(store: Store, origin: string, runId: string) {
  store.db.exec('BEGIN');
  type RequestState = { origin?: string; requirements?: { goals: string[]; in_scope: string[]; out_of_scope: string[] }; plan?: unknown };
  let evidence: { version: number; data: RequestState; snapshots: ReturnType<Store['snapshots']>; events: ReturnType<Store['events']> };
  try {
    const current = store.get<RequestState>(runId);
    evidence = { ...current, snapshots: store.snapshots(runId), events: store.events(runId) };
    store.db.exec('COMMIT');
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
  // Exports are derived views. SQLite records, not these replaceable files, remain authoritative.
  const json = (value: unknown) => JSON.stringify(redactEvidence(value), null, 2) + '\n';
  const events = await writeStateArtifact(origin, runId, 'events.jsonl', evidence.events.map(event => JSON.stringify(redactEvidence({ runId, ...event }))).join('\n') + '\n');
  const snapshots = await writeStateArtifact(origin, runId, 'snapshots.json', json({ schemaVersion: 1, runId, version: evidence.version, snapshots: evidence.snapshots }));
  const config = evidence.snapshots.filter(snapshot => snapshot.kind === 'config').at(-1);
  const resolvedConfig = config ? await writeStateArtifact(origin, runId, 'resolved-config.json', json(config.value)) : null;
  const plan = evidence.data.plan ? await writeStateArtifact(origin, runId, 'plan.json', json(evidence.data.plan)) : null;
  const request = evidence.data.requirements ? await writeStateArtifact(origin, runId, 'request.md', `# Structured request summary\n\nSource: persisted requirements. Raw prompt is not collected.\n\n<pre>${json(evidence.data.requirements).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>\n`) : null;
  return { version: evidence.version, events, snapshots, resolvedConfig, plan, request };
}
