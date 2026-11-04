/** Stopped-file transactions participate in the same claims as every managed Pi. */
import { randomUUID } from 'node:crypto';
import { acquireClaim, reconcileClaim, releaseClaim } from '@phimacs/pimux/ownership';
import { readProcessIdentity } from '@phimacs/pimux/process-identity';

export async function withStoppedSessionLease<T>(file: string, action: () => T | Promise<T>): Promise<T> {
  const identity = readProcessIdentity(process.pid);
  if (!identity) throw new Error('Cannot establish the session mutation identity');
  const claim = acquireClaim(file, { id: randomUUID(), kind: 'lease', wrapper: identity, pi: null });
  try {
    reconcileClaim(claim);
    return await action();
  } finally {
    // Never release a claim whose path was retargeted while the transaction ran.
    reconcileClaim(claim);
    releaseClaim(claim);
  }
}
