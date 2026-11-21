import { permitsMitigation, type StealthPolicy } from './stealth.js';
import type { RiskAssessment } from './risk.js';
import { selected, validateAllocation } from './allocation.js';
import { configuredOrigin } from './detection.js';
import { isIP } from 'node:net';

// Administrative configuration grants no runtime eligibility or risk classification.
export function configurationOrigin(value: string): string {
  const origin = configuredOrigin(value), url = new URL(origin);
  if (!['localhost','127.0.0.1'].includes(url.hostname) && url.protocol !== 'https:') throw Error('HTTPS project required');
  return origin;
}

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

// Page destinations are confirmed in the admin policy. They are never fetched by the server.
export function pageDestination(value: unknown, legacyOrigin?: string): string {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(value) ||
      !/^https?:\/\/[^/?#]/i.test(value)) throw new TypeError('invalid redirect destination');
  const url = new URL(value);
  const laboratory = url.protocol === 'http:' && ['localhost','127.0.0.1'].includes(url.hostname) && url.origin === legacyOrigin;
  if ((!laboratory && url.protocol !== 'https:') || url.username || url.password || url.hash || url.href.length > 2048) {
    throw new TypeError('invalid redirect destination');
  }
  return url.href;
}

// Same-origin destinations or an exact URL in the owner's private allowlist.
export function approvedDestination(value: string, projectOrigin: string): string {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\\]/.test(value)) throw new Error('invalid destination');
  const url = new URL(value);
  if (url.username || url.password || url.hash || (url.origin !== configuredOrigin(projectOrigin) && !externalDestinations(projectOrigin).includes(url.href))) throw new Error('invalid destination');
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('invalid destination');
  return url.href;
}

type EntryPolicy = {version: number; enabled: boolean; approved_destination: string; allocation: unknown} & StealthPolicy;

export function evaluateEntryPolicy(policy: EntryPolicy | undefined, original: string, origin: string,
  controlledOrigin: string | undefined, risk: string | undefined, session: unknown, trafficClass: string, assessment?: RiskAssessment) {
  const observe = (reason: string) => ({decision:{action:'OBSERVE_ONLY'},reason});
  if (origin===original || !controlledOrigin || origin!==controlledOrigin) return observe('CONTEXT_EXCLUDED');
  if (!policy || !policy.enabled || !Number.isSafeInteger(policy.version) || policy.version<1) return observe('POLICY_INACTIVE');
  if (!permitsMitigation(policy,risk,assessment)) return observe('RISK_POLICY');
  try {
    if (!selected(session,'PAGE_REDIRECT',policy.version,validateAllocation(policy.allocation),trafficClass)) return observe('ALLOCATION');
    const destination=pageDestination(policy.approved_destination,original);
    if (new URL(destination).origin===origin) return observe('DESTINATION_LOOP');
    return {decision:{action:'PAGE_REDIRECT',...(policy.stealth_version===2 ? {stealthVersion:2} : {}),version:policy.version,destination},reason:'REDIRECT_SELECTED'};
  } catch { return observe('INVALID_POLICY'); }
}

export function entryDecision(...args: Parameters<typeof evaluateEntryPolicy>) {
  return evaluateEntryPolicy(...args).decision;
}
