import { createHash } from 'node:crypto';

export const configHash = (source: string | null) => createHash('sha256').update(source === null ? 'missing' : `file:${source}`).digest('hex');
