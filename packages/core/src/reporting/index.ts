import { writeStateArtifact } from '../state/artifacts.ts';
import { isAbsolute } from 'node:path';
import type { Run } from '../runtime/engine.ts';
import type { GateResult } from '../../../protocol/src/runtime.ts';
import { completionEvidence } from '../runtime/completion.ts';
import { id, sha, requireCondition as check } from '../../../protocol/src/runtime.ts';

// Render all project/reviewer text as inert data, including Markdown link/control syntax.
const data = (value: unknown) => JSON.stringify(value, null, 2).replace(/[&<>`\[\]\\]/g, character => character === '<' ? '&lt;' : character === '>' ? '&gt;' : character === '&' ? '&amp;' : `&#${character.charCodeAt(0)};`);
type ReviewEvidence = Run['reviews'][number] & { decision?: string; acceptanceIds?: string[]; limitations?: string[] };
type WorkEvidence = Run['tasks'][string] & { observedModel?: string | null; observedEffort?: string | null; selectedModel?: string | null; selectedEffort?: string | null; changedPaths?: string[]; acceptanceEvidence?: { acceptanceId: string; evidenceRefs: string[] }[] };

export function buildReport(run: Run, version: number, actualFinalSha: string | null) {
  id.parse(run.id); check(Number.isSafeInteger(version) && version >= 0, 'INVALID_REPORT_VERSION');
  if (actualFinalSha !== null) sha.parse(actualFinalSha);
  const currentSha = run.integrationSha ?? null;
  const { blockers, acceptance } = completionEvidence(run, actualFinalSha);
  const reviews: ReviewEvidence[] = run.reviews;
  const tasks = Object.values(run.tasks).map((work: WorkEvidence) => ({
    id: work.spec.id, title: work.spec.title, role: work.spec.role, state: work.state, attempt: work.attempt,
    configRevision: work.configRevision ?? null, nativeBinding: { agentId: work.nativeId, bootstrap: work.nativeBootstrap ?? null, source: run.hostEvidence?.source ?? null },
    requested: work.modelResolution ? { model: work.modelResolution.requestedModel, effort: work.modelResolution.requestedEffort } : run.config.hosts[run.host].roles[work.spec.role],
    selectedModel: work.modelResolution?.resolvedModel ?? work.selectedModel ?? null, selectedEffort: work.modelResolution?.resolvedEffort ?? work.selectedEffort ?? null,
    observedModel: work.observedModel ?? null, observedEffort: work.observedEffort ?? null,
    modelResolution: work.modelResolution ?? null, modelObservation: work.modelObservation ?? null, attempts: work.attempts ?? [],
    usage: null, cost: null, changedPaths: work.changedPaths ?? null,
    commitUnits: work.spec.commit_units.map(unit => ({ ...unit, sha: work.units[unit.id] ?? null })),
    acceptanceEvidence: work.acceptanceEvidence?.map(item => ({ acceptanceId: item.acceptanceId, evidenceRefs: [...item.evidenceRefs] })) ?? [],
  }));
  const resourceBranches = new Map([...Object.values(run.tasks), ...(run.candidates ?? []), { path: run.integrationPath, branch: run.integration }].map(item => [item.path, item.branch]));
  const cleanup = { status: run.cleanup.length === 0 ? 'not_requested' : run.cleanup.every(item => ['removed', 'absent'].includes(item.status)) ? 'complete' : 'partial', resources: run.cleanup.map(item => ({ ...item, branch: resourceBranches.get(item.path) ?? null })) };
  const completionVerified = run.state === 'COMPLETED' && blockers.length === 0;
  const finalizedWithApprovedExceptions = run.state === 'COMPLETED' && !completionVerified && completionEvidence(run, actualFinalSha, { allowApprovedWaivers: true }).blockers.length === 0;
  const nextActions = completionVerified || finalizedWithApprovedExceptions ? [] : run.state === 'READY_TO_FINALIZE' ? ['Approve finalization for the reviewed integration SHA.'] : ['Resolve the listed blockers and record acceptance evidence, independent final review and passing gates for the current SHA.'];
  const report = {
    schemaVersion: 1, runId: run.id, origin: run.origin, version, state: run.state, completionVerified, finalizedWithApprovedExceptions,
    targetBranch: run.target, targetBase: run.targetBase, integrationSha: currentSha, actualFinalSha,
    createdAt: run.createdAt, durationMs: run.finalizedAt ? Date.parse(run.finalizedAt) - Date.parse(run.createdAt) : null, activeTimeMs: run.activeTimeMs ?? null, pauseTimeMs: run.pauseTimeMs ?? null, reviewRound: run.reviewRound, host: run.host,
    models: Object.entries(run.config.hosts[run.host].roles).map(([role, requested]) => ({ role, requested, observations: [...tasks.filter(task => task.role === role).map(task => ({ taskId: task.id, selectedModel: task.selectedModel, selectedEffort: task.selectedEffort, observedModel: task.observedModel, observedEffort: task.observedEffort })), ...Object.entries(run.reviewDispatches ?? {}).filter(([, dispatch]) => dispatch.role === role).map(([dispatchId, dispatch]) => ({ taskId: null, dispatchId, selectedModel: dispatch.resolution.resolvedModel, selectedEffort: dispatch.resolution.resolvedEffort, observedModel: dispatch.observation?.observedModel ?? null, observedEffort: dispatch.observation?.observedEffort ?? null }))] })),
    hostEvidence: run.hostEvidence ?? null, tasks, acceptance, findings: run.findings.map(finding => ({ ...finding })),
    gates: run.gates.map((gate: Run['gates'][number] & { details?: GateResult[] }) => ({ stage: gate.stage, task: gate.task, sha: gate.sha, source: gate.source, commands: gate.commands, status: gate.status, results: gate.results.map(result => ({ ...result })), details: gate.details ?? null, logRefs: gate.details?.map(detail => detail.logRef) ?? null })),
    reviewDispatches: run.reviewDispatches ?? {},
    reviews: reviews.map(review => ({ sha: review.sha, reviewer: review.reviewer, final: review.final, decision: review.decision ?? null, acceptanceIds: review.acceptanceIds ?? null, limitations: review.limitations ?? null })),
    cleanup, blockers, nextActions, abandonment: run.abandonment ?? null, waivers: run.waivers ?? [], missingTestsWaiver: run.missingTestsWaiver ?? null, repairAnalyses: run.repairAnalyses ?? [], usage: null, cost: null,
    limitations: ['Native receipts are authenticated coordinator attestations, not signed host, account or model evidence.', 'Unrecorded model selection, observations, changed paths, duration, logs, usage and billing remain unknown.', 'Gate command IDs reference configured commands; raw arguments, prompts, environment and transcripts are not collected.'],
  };
  const sections = [
    ['Result', { state: report.state, completionVerified, finalizedWithApprovedExceptions, abandonment: report.abandonment, blockers, nextActions }],
    ['Acceptance', acceptance], ['Code', { targetBranch: run.target, targetBase: run.targetBase, integrationSha: currentSha, actualFinalSha, tasks }],
    ['Models and execution', { host: run.host, models: report.models, tasks, createdAt: run.createdAt, durationMs: run.finalizedAt ? Date.parse(run.finalizedAt) - Date.parse(run.createdAt) : null, activeTimeMs: run.activeTimeMs ?? null, pauseTimeMs: run.pauseTimeMs ?? null, reviewRound: run.reviewRound, usage: null, cost: null }],
    ['Verification', { gates: report.gates, waivers: report.waivers, missingTestsWaiver: report.missingTestsWaiver }], ['Review and findings', { reviews: report.reviews, dispatches: report.reviewDispatches, findings: report.findings }], ['Cleanup', cleanup], ['Limitations', report.limitations],
  ];
  return { ...report, summary: `# ORCH run report\n\nRun: ${data(run.id)}; state version: ${version}\n\n${sections.map(([title, value]) => `## ${title}\n\n<pre>${data(value)}</pre>`).join('\n\n')}\n` };
}
export type RunReport = ReturnType<typeof buildReport>;

export async function writeReport(run: Run, report: RunReport) {
  id.parse(run.id);
  check(report.runId === run.id && report.origin === run.origin, 'REPORT_RUN_MISMATCH');
  check(isAbsolute(run.origin), 'REPORT_ORIGIN_UNSAFE');
  const artifacts = { summary: '', findings: '', acceptance: '', cleanup: '' };
  const contents = { summary: report.summary, findings: JSON.stringify({ runId: run.id, version: report.version, findings: report.findings }, null, 2), acceptance: JSON.stringify({ runId: run.id, version: report.version, completionVerified: report.completionVerified, blockers: report.blockers, acceptance: report.acceptance }, null, 2), cleanup: JSON.stringify({ runId: run.id, version: report.version, ...report.cleanup }, null, 2) };
  try {
    for (const key of ['summary', 'findings', 'acceptance', 'cleanup'] as const) {
      artifacts[key] = await writeStateArtifact(run.origin, run.id, key === 'summary' ? 'summary.md' : `${key}.json`, `${contents[key]}\n`, 'reports');
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'STATE_PATH_UNSAFE') throw new Error('REPORT_PATH_UNSAFE');
    throw error;
  }
  return artifacts;
}
