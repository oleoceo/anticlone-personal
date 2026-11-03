import { selected, validateAllocation } from './allocation.js';
import { configuredOrigin } from './detection.js';

// The destination is pre-approved by the owner and constrained to the project origin.
export function approvedDestination(value: string, projectOrigin: string): string {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\\]/.test(value)) throw new Error('invalid destination');
  const url = new URL(value);
  if (url.username || url.password || url.origin !== configuredOrigin(projectOrigin) || url.hash) throw new Error('invalid destination');
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('invalid destination');
  return url.href;
}

export function entryDecision(policy: {version: number; enabled: boolean; approved_destination: string; allocation: unknown} | undefined, original: string, origin: string, controlledOrigin: string | undefined, risk: string | undefined, session: unknown, trafficClass: string) {
  if (origin === original || !controlledOrigin || origin !== controlledOrigin || risk !== 'LOW' || !policy || policy.enabled !== true || !Number.isSafeInteger(policy.version) || policy.version < 1) return { action: 'OBSERVE_ONLY' };
  try { if (!selected(session, 'PAGE_REDIRECT', policy.version, validateAllocation(policy.allocation), trafficClass)) return { action: 'OBSERVE_ONLY' }; return { action: 'PAGE_REDIRECT', version: policy.version, destination: approvedDestination(policy.approved_destination, original) }; }
  catch { return { action: 'OBSERVE_ONLY' }; }
}
