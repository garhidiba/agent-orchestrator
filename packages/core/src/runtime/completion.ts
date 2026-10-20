import type { Run } from './engine.ts';
import { hash } from '../state/store.ts';

export function findingBlocks(run: Run, finding: Run['findings'][number]) {
  const disposition = finding.dispositions?.at(-1);
  const resolved = finding.lifecycle === 'VERIFIED_FIXED' || ['ACCEPTED_RISK', 'NOT_A_BUG'].includes(finding.lifecycle) && disposition?.sha === (run.integrationSha ?? null) && disposition?.status === finding.lifecycle && disposition.actor === 'user' && disposition.reason.trim();
  return !resolved && (run.config.review.block_on.includes(finding.severity) || finding.acceptance_ids.length > 0);
}

export function completionEvidence(run: Run, actualFinalSha: string | null, options: { beforeFinalGate?: boolean; beforeTarget?: boolean } = {}) {
  const currentSha = run.integrationSha ?? null;
  const gatePassed = (stage: string) => {
    const gate = run.gates.filter(item => item.stage === stage && item.task === null).at(-1);
    const required = run.config.quality.commands.filter(command => command.required && command.stages.includes(stage as 'final'));
    return !!gate && !!currentSha && gate.sha === currentSha && gate.status === 'passed' && gate.commands === hash(run.config.quality.commands) && required.length > 0 && required.every(command => gate.results.some(result => result.id === command.id && result.status === 'passed' && result.exitCode === 0));
  };
  const reviews: Run['reviews'] = run.reviews;
  const finalReview = reviews.filter(review => review.final).at(-1);
  const review = reviews.filter(item => !item.final).at(-1);
  const independent = (reviewer: string) => !run.implementers?.includes(reviewer) && !Object.values(run.tasks).some(task => task.nativeId === reviewer);
  const blockingFindings = run.findings.filter(finding => findingBlocks(run, finding));
  const blockers: string[] = [];
  if (run.hostEvidence?.source === 'coordinator_native_receipt') {
    for (const item of [review, finalReview]) if (!item || !Object.values(run.reviewDispatches ?? {}).some(dispatch => dispatch.nativeId === item.reviewer && dispatch.sha === currentSha && dispatch.role === (item.final ? 'final_auditor' : 'reviewer') && dispatch.state === 'COMPLETED')) blockers.push('REVIEW_DISPATCH_UNVERIFIED');
  }
  if (Object.values(run.reviewDispatches ?? {}).some(dispatch => !['COMPLETED', 'STOPPED'].includes(dispatch.state))) blockers.push('ACTIVE_REVIEW_LEASES');
  if (!gatePassed('integration')) blockers.push('INTEGRATION_GATE_UNVERIFIED');
  if (!options.beforeFinalGate && !gatePassed('final')) blockers.push('FINAL_GATE_UNVERIFIED');
  if (!review || review.sha !== currentSha || review.decision !== 'approved' || review.limitations?.length !== 0 || !independent(review.reviewer)) blockers.push('REVIEW_UNVERIFIED');
  if (!finalReview || finalReview.sha !== currentSha || finalReview.decision !== 'approved' || finalReview.limitations?.length !== 0 || !independent(finalReview.reviewer) || finalReview.reviewer === review?.reviewer) blockers.push('FINAL_REVIEW_UNVERIFIED');
  if (!options.beforeFinalGate && run.gates.filter(gate => gate.stage === 'final' && gate.task === null).at(-1)?.source !== run.gates.filter(gate => gate.stage === 'integration' && gate.task === null).at(-1)?.source) blockers.push('GATE_SOURCE_MISMATCH');
  if (Object.values(run.tasks).some(task => task.state !== 'INTEGRATED')) blockers.push('TASKS_UNINTEGRATED');
  if (!options.beforeTarget && (actualFinalSha === null || actualFinalSha !== currentSha)) blockers.push('FINAL_SHA_UNVERIFIED');
  if (Object.values(run.tasks).some(task => ['LEASED', 'RUNNING', 'ORPHANED_UNKNOWN'].includes(task.state))) blockers.push('ACTIVE_WRITER_LEASES');
  if (blockingFindings.length) blockers.push('BLOCKING_FINDINGS');
  const acceptance = (run.plan?.acceptance ?? []).map(criterion => {
    const assigned = Object.values(run.tasks).filter(task => task.spec.acceptance_ids.includes(criterion.id));
    const evidenceRefs = Object.values(run.tasks).flatMap(task => (task.acceptanceEvidence ?? []).filter(item => item.acceptanceId === criterion.id).flatMap(item => item.evidenceRefs));
    const implemented = assigned.length > 0 && assigned.every(task => task.state === 'INTEGRATED' && task.spec.commit_units.every(unit => task.units[unit.id]) && task.acceptanceEvidence?.some(item => item.acceptanceId === criterion.id && item.evidenceRefs.length > 0));
    const covered = finalReview?.sha === currentSha && finalReview.decision === 'approved' && finalReview.acceptanceIds?.includes(criterion.id) && finalReview.limitations?.length === 0 && evidenceRefs.length > 0;
    const blocked = blockingFindings.some(finding => finding.acceptance_ids.includes(criterion.id));
    return { ...criterion, implementation: implemented ? 'integrated' : 'pending', status: blocked ? 'blocked' : implemented && covered && blockers.length === 0 ? 'verified' : 'unknown', evidenceRefs };
  });
  if (!acceptance.length || acceptance.some(item => item.status !== 'verified')) blockers.push('ACCEPTANCE_UNVERIFIED');
  return { blockers, acceptance };
}
