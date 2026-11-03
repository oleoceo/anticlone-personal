import { createHash } from 'node:crypto';
const classes = ['PAID_ATTRIBUTED','ORGANIC','REFERRAL','DIRECT_UNKNOWN'] as const;
export type Allocation = Record<(typeof classes)[number], number>;
export function validateAllocation(value: unknown): Allocation {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...classes].sort().join(',')) throw Error('invalid allocation');
  const input = value as Record<string, unknown>;
  for (const key of classes) if (typeof input[key] !== 'number' || !Number.isInteger(input[key]) || (input[key] as number) < 0 || (input[key] as number) > 100 || (input[key] as number) % 10 !== 0) throw Error('invalid allocation');
  return input as Allocation;
}
export function selected(session: unknown, rule: string, version: number, allocation: Allocation, trafficClass: string): boolean {
  if (typeof session !== 'string' || !/^[a-f0-9]{32}$/.test(session) || !/^[A-Z_]{1,64}$/.test(rule) || !Number.isSafeInteger(version) || version < 1 || !classes.includes(trafficClass as typeof classes[number])) return false;
  const digest = createHash('sha256').update(JSON.stringify([session, rule, version])).digest();
  return digest.readUInt32BE(0) / 0x100000000 * 100 < allocation[trafficClass as typeof classes[number]];
}
