import { selected, validateAllocation } from './allocation.js';
import { configuredOrigin } from './detection.js';
import { isIP } from 'node:net';

// Private owner configuration: exact URLs, grouped by project origin. No wildcard hosts.
export function externalDestinations(projectOrigin: string): string[] {
  const raw = process.env.PROTECTION_APPROVED_EXTERNAL_URLS;
  if (!raw) return [];
  if (raw.length > 65536) throw Error('invalid external destination configuration');
  const config: unknown = JSON.parse(raw);
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw Error('invalid external destination configuration');
  const values = (config as Record<string, unknown>)[configuredOrigin(projectOrigin)];
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > 100) throw Error('invalid external destination configuration');
  return values.map(value => {
    if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\\]/.test(value)) throw Error('invalid external destination');
    const url = new URL(value), host = url.hostname;
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || isIP(host) || host.includes(':') || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(host) || /\.(localhost|local|internal|invalid)$/.test(host)) throw Error('invalid external destination');
    return url.href;
  });
}

// Same-origin destinations or an exact URL in the owner's private allowlist.
export function approvedDestination(value: string, projectOrigin: string): string {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\\]/.test(value)) throw new Error('invalid destination');
  const url = new URL(value);
  if (url.username || url.password || url.hash || (url.origin !== configuredOrigin(projectOrigin) && !externalDestinations(projectOrigin).includes(url.href))) throw new Error('invalid destination');
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('invalid destination');
  return url.href;
}

export function entryDecision(policy: {version: number; enabled: boolean; approved_destination: string; allocation: unknown} | undefined, original: string, origin: string, controlledOrigin: string | undefined, risk: string | undefined, session: unknown, trafficClass: string) {
  if (origin === original || !controlledOrigin || origin !== controlledOrigin || risk !== 'LOW' || !policy || policy.enabled !== true || !Number.isSafeInteger(policy.version) || policy.version < 1) return { action: 'OBSERVE_ONLY' };
  try { if (!selected(session, 'PAGE_REDIRECT', policy.version, validateAllocation(policy.allocation), trafficClass)) return { action: 'OBSERVE_ONLY' }; return { action: 'PAGE_REDIRECT', version: policy.version, destination: approvedDestination(policy.approved_destination, original) }; }
  catch { return { action: 'OBSERVE_ONLY' }; }
}
