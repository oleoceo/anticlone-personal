import type { RiskAssessment } from './risk.js';
export type StealthPolicy = {stealth?: boolean; stealth_version?: number | null};
// NULL preserves the published legacy contract, never implicit OFF.
export function validateStealth(value: StealthPolicy): void {
  if (value.stealth_version == null) { if (value.stealth === false) throw Error('explicit stealth version required'); return; }
  if (value.stealth_version !== 2 || typeof value.stealth !== 'boolean') throw Error('invalid stealth configuration');
}
export function permitsMitigation(policy: StealthPolicy, risk: string | undefined, assessment?: RiskAssessment): boolean {
  try { validateStealth(policy); } catch { return false; }
  if (policy.stealth_version == null) return risk === 'LOW';
  if (!policy.stealth) return true;
  // No operational source establishes operator likelihood in this release.
  // Strong evidence is demonstrated only with a server-configured lab fixture.
  return !(risk === 'HIGH' && assessment?.source === 'lab_configuration' && assessment.reason === 'controlled_fixture' && assessment.confidence === 'test_only');
}

// A single CTA response cannot both wait for legacy investigative history and
// make v2 independent of that wait. Require an explicit coherent migration.
export function assertCtaStealthCompatibility(policies:readonly StealthPolicy[]):void {
  for (const policy of policies) validateStealth(policy);
  if (new Set(policies.map(policy=>policy.stealth_version ?? 1)).size>1) throw Error('mixed CTA Stealth contracts require migration and reapproval');
}
