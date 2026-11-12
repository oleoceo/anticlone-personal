// Explicit operator-reviewed declarations, never inferred from text or price.
export interface CommercialTerms {
  offer: string | null;
  previousAmount: number | null;
  discountBps: number | null;
  installments: {count: number; amount: number} | null;
}
export function commercialTerms(value: unknown): CommercialTerms | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const integer = (n: unknown, max = Number.MAX_SAFE_INTEGER): n is number => Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= max;
  if (Object.keys(row).sort().join(',') !== 'discountBps,installments,offer,previousAmount' ||
      !(row.offer === null || typeof row.offer === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(row.offer)) ||
      !(row.previousAmount === null || integer(row.previousAmount)) ||
      !(row.discountBps === null || integer(row.discountBps, 10000))) return null;
  let installments: CommercialTerms['installments'] = null;
  if (row.installments !== null) {
    if (!row.installments || typeof row.installments !== 'object' || Array.isArray(row.installments)) return null;
    const item = row.installments as Record<string, unknown>;
    if (Object.keys(item).sort().join(',') !== 'amount,count' || !integer(item.amount) || !integer(item.count, 360) || item.count < 1) return null;
    installments = {count:item.count,amount:item.amount};
  }
  return {offer:row.offer,previousAmount:row.previousAmount,discountBps:row.discountBps,installments};
}
