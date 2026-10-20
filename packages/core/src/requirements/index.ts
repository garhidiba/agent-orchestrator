import { requirementsSchema } from '../../../protocol/src/runtime.ts';
import { writeStateArtifact } from '../state/artifacts.ts';

function markdownText(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*_{}\[\]()#+.!|\-]/g, '\\$&').replace(/\r?\n/g, '\n  ');
}
export async function writeRequirements(origin: string, runId: string, input: unknown) {
  const requirements = requirementsSchema.parse(input);
  const sections: [string, string[]][] = [
    ['Goals', requirements.goals], ['In scope', requirements.in_scope], ['Out of scope', requirements.out_of_scope],
    ['Acceptance criteria', requirements.acceptance.map(item => `${item.id}: ${item.text}`)],
    ['Constraints', requirements.constraints], ['Assumptions', requirements.assumptions], ['Risks', requirements.risks],
    ['Verification plan', requirements.verification_plan.map(item => `${item.acceptance_id}: ${item.method}`)],
  ];
  const markdown = `# Requirements\n\n${sections.map(([title, items]) => `## ${title}\n\n${items.length ? items.map(item => `- ${markdownText(item)}`).join('\n') : 'None.'}\n`).join('\n')}`;
  const json = await writeStateArtifact(origin, runId, 'requirements.json', `${JSON.stringify(requirements, null, 2)}\n`);
  const readable = await writeStateArtifact(origin, runId, 'requirements.md', markdown);
  return { requirements, refs: { json, markdown: readable } };
}
