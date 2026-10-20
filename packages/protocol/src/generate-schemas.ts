import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { configPatchSchema, configSchema } from './config.ts';

for (const [name, schema] of [['config', configPatchSchema], ['effective-config', configSchema]] as const) {
  await writeFile(new URL(`../schemas/${name}.schema.json`, import.meta.url), `${JSON.stringify(z.toJSONSchema(schema), null, 2)}\n`);
}
