import { redact } from '../quality/redact.ts';

const sensitive = /api[_-]?key|token|password|secret|cookie|authorization|credential/i;
// Sanitize structured evidence before storage; a source hash still distinguishes different secret-bearing inputs.
export function redactEvidence(value: unknown): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((item: unknown, index) => {
    const previous = value[index - 1] as unknown;
    return typeof item === 'string' && typeof previous === 'string' && /^--?[^=]+$/.test(previous) && sensitive.test(previous)
      ? '[REDACTED]' : redactEvidence(item);
  });
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    /^(?:raw)?(?:prompt|transcript|reasoningtext|chainofthought)$/i.test(key.replace(/[_-]/g, '')) && typeof item !== 'number' ? '[NOT COLLECTED]' :
      sensitive.test(key) && typeof item === 'string' ? '[REDACTED]' : redactEvidence(item)]));
  return value;
}
