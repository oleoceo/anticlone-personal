import { approvedDestination } from './page-redirect.js';

// Public campaign labels only: neither arbitrary browser values nor click IDs are propagated.
export function attributionRules(projectId: string, pageId: string, original: string): Record<string, Record<string, string[]>> {
  try {
    const raw = process.env.ATTRIBUTION_ALLOWLIST;
    if (!raw || raw.length > 32768) return {};
    const config: unknown = JSON.parse(raw);
    if (!config || typeof config !== 'object' || Array.isArray(config)) return {};
    const projectConfig = (config as Record<string, unknown>)[projectId];
    if (!projectConfig || typeof projectConfig !== 'object' || Array.isArray(projectConfig)) return {};
    const project = (projectConfig as Record<string, unknown>)[pageId];
    if (!project || typeof project !== 'object' || Array.isArray(project) || Object.keys(project).length > 100) return {};
    const result: Record<string, Record<string, string[]>> = Object.create(null);
    for (const [destination, rules] of Object.entries(project)) {
      if (approvedDestination(destination, original) !== destination || !rules || typeof rules !== 'object' || Array.isArray(rules) || Object.keys(rules).length > 5) return {};
      const allowed: Record<string, string[]> = Object.create(null);
      for (const [key, values] of Object.entries(rules)) {
        if (!['utm_source','utm_medium','utm_campaign','utm_content','utm_term'].includes(key) || !Array.isArray(values) || values.length > 32 || values.some(value => typeof value !== 'string' || !/^[a-z0-9_-]{1,40}$/.test(value))) return {};
        allowed[key] = values;
      }
      result[destination] = allowed;
    }
    return result;
  } catch { return {}; }
}

export function withAttribution<T extends {action: string}>(decision: T, projectId: string, pageId: string, original: string): T & {attribution?: Record<string, Record<string, string[]>>} {
  if (decision.action !== 'PAGE_REDIRECT' && decision.action !== 'REPLACE_CONVERSION') return decision;
  const all = attributionRules(projectId, pageId, original);
  const value = decision as T & {destination?: unknown; mappings?: {destination?: unknown}[]};
  const destinations = value.action === 'PAGE_REDIRECT' ? [value.destination] : Array.isArray(value.mappings) ? value.mappings.map(row => row.destination) : [];
  const attribution: Record<string, Record<string, string[]>> = Object.create(null);
  for (const destination of destinations) if (typeof destination === 'string' && Object.hasOwn(all, destination)) attribution[destination] = all[destination];
  return Object.keys(attribution).length ? {...decision, attribution} : decision;
}
