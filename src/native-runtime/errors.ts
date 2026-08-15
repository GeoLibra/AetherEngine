import type { NativeHandshakeDifference } from './types';

export class NativeHandshakeError extends Error {
  readonly differences: readonly NativeHandshakeDifference[];

  constructor(differences: readonly NativeHandshakeDifference[]) {
    const frozen = Object.freeze(differences.map((difference) => Object.freeze({ ...difference })));
    super(`Native handshake failed: ${frozen.map(describeDifference).join('; ')}.`);
    this.name = 'NativeHandshakeError';
    this.differences = frozen;
  }
}

function describeDifference(difference: NativeHandshakeDifference): string {
  if (difference.kind === 'module') {
    return `module=${difference.module} required=${difference.required} actual=${difference.actual ?? 'missing'}`;
  }
  if (difference.kind === 'array-buffer') {
    return `array-buffer=${difference.capability} required=true actual=${difference.actual}`;
  }
  return `${difference.kind} required=${difference.required} actual=${difference.actual}`;
}
