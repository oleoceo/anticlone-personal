export type TrafficEvidence = 'paid_click_id' | 'paid_utm' | 'organic_referrer' | 'external_referrer' | 'none';
export function classifyTraffic(value: unknown, origin: string): { trafficClass: string; evidence: TrafficEvidence; certainty: string; source: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid attribution');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['clickId', 'clickKey', 'medium', 'referrerHost'].includes(key))) throw new Error('invalid attribution');
  if (input.clickId !== undefined && (typeof input.clickId !== 'string' || !/^[A-Za-z0-9._~-]{1,128}$/.test(input.clickId))) throw new Error('invalid click id');
  if ((input.clickId === undefined) !== (input.clickKey === undefined) || (input.clickKey !== undefined && (typeof input.clickKey !== 'string' || !['gclid','fbclid','ttclid','msclkid'].includes(input.clickKey)))) throw new Error('invalid click key');
  if (input.medium !== undefined && (typeof input.medium !== 'string' || !['cpc','ppc','paid','paid_social'].includes(input.medium))) throw new Error('invalid medium');
  if (input.referrerHost !== undefined && (typeof input.referrerHost !== 'string' || input.referrerHost.length > 253 || !/^(?=.{1,253}$)[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$/.test(input.referrerHost) || input.referrerHost.includes('..'))) throw new Error('invalid referrer');
  const ref = input.referrerHost as string | undefined;
  let evidence: TrafficEvidence = 'none';
  if (input.clickId) evidence = 'paid_click_id';
  else if (input.medium) evidence = 'paid_utm';
  else if (ref && ref !== new URL(origin).hostname) evidence = ['google.com','bing.com','duckduckgo.com'].some(d => ref === d || ref.endsWith('.' + d)) ? 'organic_referrer' : 'external_referrer';
  const trafficClass = evidence === 'paid_click_id' || evidence === 'paid_utm' ? 'PAID_ATTRIBUTED' : evidence === 'organic_referrer' ? 'ORGANIC' : evidence === 'external_referrer' ? 'REFERRAL' : 'DIRECT_UNKNOWN';
  const source = evidence === 'paid_click_id' ? String(input.clickKey) : evidence === 'paid_utm' ? 'utm_medium' : evidence === 'organic_referrer' ? ['google.com','bing.com','duckduckgo.com'].find(d => ref === d || ref?.endsWith('.' + d))! : evidence === 'external_referrer' ? 'external_referrer' : 'none';
  return { trafficClass, evidence, source, certainty: evidence === 'none' ? 'insufficient' : 'browser_declared_uncorroborated' };
}
