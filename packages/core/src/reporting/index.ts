import { writeStateArtifact } from '../state/artifacts.ts';
import { isAbsolute } from 'node:path';
import type { Run } from '../runtime/engine.ts';
import type { GateResult } from '../../../protocol/src/runtime.ts';
import { hash } from '../state/store.ts';
import { id, sha, requireCondition as check } from '../../../protocol/src/runtime.ts';

// Render all project/reviewer text as inert data, including Markdown link/control syntax.
const data = (value: unknown) => JSON.stringify(value, null, 2).replace(/[&<>`\[\]\\]/g, character => character === '<' ? '&lt;' : character === '>' ? '&gt;' : character === '&' ? '&amp;' : `&#${character.charCodeAt(0)};`);
type ReviewEvidence = Run['reviews'][number] & { decision?: string; acceptanceIds?: string[]; limitations?: string[] };
type WorkEvidence = Run['tasks'][string] & { observedModel?: string | null; observedEffort?: string | null; selectedModel?: string | null; selectedEffort?: string | null; changedPaths?: string[]; acceptanceEvidence?: { acceptanceId: string; evidenceRefs: string[] }[] };

export function buildReport(run: Run, version: number, actualFinalSha: string | null) {
  id.parse(run.id); check(Number.isSafeInteger(version) && version >= 0, 'INVALID_REPORT_VERSION');
  if (actualFinalSha !== null) sha.parse(actualFinalSha);
  const currentSha = run.integrationSha ?? null;
  const gatePassed = (stage: string) => {
    const gate = run.gates.filter(item => item.stage === stage && item.task === null).at(-1);
    const required = run.config.quality.commands.filter(command => command.required && command.stages.includes(stage as 'final'));
    return !!gate && !!currentSha && gate.sha === currentSha && gate.status === 'passed' && gate.commands === hash(run.config.quality.commands) && required.length > 0 && required.every(command => gate.results.some(result => result.id === command.id && result.status === 'passed' && result.exitCode === 0));
  };
  const reviews: ReviewEvidence[] = run.reviews;
  const finalReview = reviews.filter(review => review.final).at(-1);
  const review = reviews.filter(item => !item.final).at(-1);
  const independent = (reviewer: string) => !run.implementers?.includes(reviewer) && !Object.values(run.tasks).some(task => task.nativeId === reviewer);
  const blockingFindings = run.findings.filter(finding => finding.lifecycle !== 'VERIFIED_FIXED' && run.config.review.block_on.includes(finding.severity));
  const blockers: string[] = [];
  if (!gatePassed('integration')) blockers.push('INTEGRATION_GATE_UNVERIFIED');
  if (!gatePassed('final')) blockers.push('FINAL_GATE_UNVERIFIED');
  if (!review || review.sha !== currentSha || review.decision !== 'approved' || !independent(review.reviewer)) blockers.push('REVIEW_UNVERIFIED');
  if (!finalReview || finalReview.sha !== currentSha || finalReview.decision !== 'approved' || !independent(finalReview.reviewer) || finalReview.reviewer === review?.reviewer) blockers.push('FINAL_REVIEW_UNVERIFIED');
  if (Object.values(run.tasks).some(task => task.state !== 'INTEGRATED')) blockers.push('TASKS_UNINTEGRATED');
  if (actualFinalSha === null || actualFinalSha !== currentSha) blockers.push('FINAL_SHA_UNVERIFIED');
  if (blockingFindings.length) blockers.push('BLOCKING_FINDINGS');
  const tasks = Object.values(run.tasks).map((work: WorkEvidence) => ({
    id: work.spec.id, title: work.spec.title, role: work.spec.role, state: work.state, attempt: work.attempt,
    configRevision: work.configRevision ?? null, nativeBinding: { agentId: work.nativeId, bootstrap: work.nativeBootstrap ?? null, source: run.hostEvidence?.source ?? null },
    requested: work.modelResolution ? { model: work.modelResolution.requestedModel, effort: work.modelResolution.requestedEffort } : run.config.hosts[run.host].roles[work.spec.role],
    selectedModel: work.modelResolution?.resolvedModel ?? work.selectedModel ?? null, selectedEffort: work.modelResolution?.resolvedEffort ?? work.selectedEffort ?? null,
    observedModel: work.observedModel ?? null, observedEffort: work.observedEffort ?? null,
    usage: null, cost: null, changedPaths: work.changedPaths ?? null,
    commitUnits: work.spec.commit_units.map(unit => ({ ...unit, sha: work.units[unit.id] ?? null })),
    acceptanceEvidence: work.acceptanceEvidence?.map(item => ({ acceptanceId: item.acceptanceId, evidenceRefs: [...item.evidenceRefs] })) ?? [],
  }));
  const acceptance = (run.plan?.acceptance ?? []).map(criterion => {
    const assigned = Object.values(run.tasks).filter(task => task.spec.acceptance_ids.includes(criterion.id));
    const evidenceRefs = tasks.flatMap(task => task.acceptanceEvidence.filter(item => item.acceptanceId === criterion.id).flatMap(item => item.evidenceRefs));
    const implemented = assigned.length > 0 && assigned.every(task => task.state === 'INTEGRATED' && task.spec.commit_units.every(unit => task.units[unit.id]));
    const covered = finalReview?.sha === currentSha && finalReview.decision === 'approved' && finalReview.acceptanceIds?.includes(criterion.id) && finalReview.limitations?.length === 0 && evidenceRefs.length > 0;
    const blocked = blockingFindings.some(finding => finding.acceptance_ids.includes(criterion.id));
    return { ...criterion, implementation: implemented ? 'integrated' : 'pending', status: blocked ? 'blocked' : implemented && covered && blockers.length === 0 ? 'verified' : 'unknown', evidenceRefs };
  });
  if (!acceptance.length || acceptance.some(item => item.status !== 'verified')) blockers.push('ACCEPTANCE_UNVERIFIED');
  const resourceBranches = new Map([...Object.values(run.tasks), ...(run.candidates ?? []), { path: run.integrationPath, branch: run.integration }].map(item => [item.path, item.branch]));
  const cleanup = { status: run.cleanup.length === 0 ? 'not_requested' : run.cleanup.every(item => ['removed', 'absent'].includes(item.status)) ? 'complete' : 'partial', resources: run.cleanup.map(item => ({ ...item, branch: resourceBranches.get(item.path) ?? null })) };
  const completionVerified = run.state === 'COMPLETED' && blockers.length === 0;
  const nextActions = completionVerified ? [] : run.state === 'READY_TO_FINALIZE' ? ['Approve finalization for the reviewed integration SHA.'] : ['Resolve the listed blockers and record acceptance evidence, independent final review and passing gates for the current SHA.'];
  const report = {
    schemaVersion: 1, runId: run.id, origin: run.origin, version, state: run.state, completionVerified,
    targetBranch: run.target, targetBase: run.targetBase, integrationSha: currentSha, actualFinalSha,
    createdAt: run.createdAt, durationMs: run.finalizedAt ? Date.parse(run.finalizedAt) - Date.parse(run.createdAt) : null, activeTimeMs: run.activeTimeMs ?? null, pauseTimeMs: run.pauseTimeMs ?? null, reviewRound: run.reviewRound, host: run.host,
    models: Object.entries(run.config.hosts[run.host].roles).map(([role, requested]) => ({ role, requested, observations: tasks.filter(task => task.role === role).map(task => ({ taskId: task.id, selectedModel: task.selectedModel, selectedEffort: task.selectedEffort, observedModel: task.observedModel, observedEffort: task.observedEffort })) })),
    hostEvidence: run.hostEvidence ?? null, tasks, acceptance, findings: run.findings.map(finding => ({ ...finding })),
    gates: run.gates.map((gate: Run['gates'][number] & { details?: GateResult[] }) => ({ stage: gate.stage, task: gate.task, sha: gate.sha, source: gate.source, commands: gate.commands, status: gate.status, results: gate.results.map(result => ({ ...result })), details: gate.details ?? null, logRefs: gate.details?.map(detail => detail.logRef) ?? null })),
    reviews: reviews.map(review => ({ sha: review.sha, reviewer: review.reviewer, final: review.final, decision: review.decision ?? null, acceptanceIds: review.acceptanceIds ?? null, limitations: review.limitations ?? null })),
    cleanup, blockers, nextActions, waivers: run.waivers ?? [], missingTestsWaiver: run.missingTestsWaiver ?? null, repairAnalyses: run.repairAnalyses ?? [], usage: null, cost: null,
    limitations: ['Native receipts are authenticated coordinator attestations, not signed host, account or model evidence.', 'Unrecorded model selection, observations, changed paths, duration, logs, usage and billing remain unknown.', 'Gate command IDs reference configured commands; raw arguments, prompts, environment and transcripts are not collected.'],
  };
  const sections = [
    ['Result', { state: report.state, completionVerified, blockers, nextActions }],
    ['Acceptance', acceptance], ['Code', { targetBranch: run.target, targetBase: run.targetBase, integrationSha: currentSha, actualFinalSha, tasks }],
    ['Models and execution', { host: run.host, models: report.models, tasks, createdAt: run.createdAt, durationMs: run.finalizedAt ? Date.parse(run.finalizedAt) - Date.parse(run.createdAt) : null, activeTimeMs: run.activeTimeMs ?? null, pauseTimeMs: run.pauseTimeMs ?? null, reviewRound: run.reviewRound, usage: null, cost: null }],
    ['Verification', { gates: report.gates, waivers: report.waivers, missingTestsWaiver: report.missingTestsWaiver }], ['Review and findings', { reviews: report.reviews, findings: report.findings }], ['Cleanup', cleanup], ['Limitations', report.limitations],
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
