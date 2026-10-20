import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { configPatchSchema, configSchema } from './config.ts';

import { requirementsSchema, taskSchema, planSchema, planAmendmentSchema, taskResultSchema, gateResultSchema, reviewSchema, recommendationSchema, envelopeSchema, hostHeartbeatSchema, findingDispositionSchema } from './runtime.ts';

for (const [name, schema] of [['config', configPatchSchema], ['effective-config', configSchema],
  ['requirements', requirementsSchema], ['task', taskSchema], ['plan', planSchema], ['plan-amendment', planAmendmentSchema],
  ['task-result', taskResultSchema], ['gate-result', gateResultSchema], ['review', reviewSchema],
  ['recommendation', recommendationSchema], ['write-envelope', envelopeSchema],
  ['host-heartbeat', hostHeartbeatSchema], ['finding-disposition', findingDispositionSchema]] as const) {
  await writeFile(new URL(`../schemas/${name}.schema.json`, import.meta.url), `${JSON.stringify(z.toJSONSchema(schema), null, 2)}\n`);
}
