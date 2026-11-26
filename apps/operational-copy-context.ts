import type { PoolClient } from 'pg';
import { validCopyPath } from './page-copy-contexts.js';
import { configuredOrigin } from './detection.js';

export async function isOfficialOrigin(client: PoolClient, origin: string) {
  const result=await client.query('SELECT 1 FROM protected_page_urls WHERE origin=$1 UNION ALL SELECT 1 FROM projects WHERE origin=$1',[origin]);
  return Boolean(result.rowCount);
}

export async function validateOperationalCopy(client: PoolClient, copyOrigin: unknown, copyPathname: unknown, acknowledged: unknown) {
  if (acknowledged!==true || typeof copyOrigin!=='string' || typeof copyPathname!=='string' ||
      !validCopyPath(copyPathname)) throw new TypeError('explicit context required');
  try {
    if (!copyOrigin.startsWith('https://') || configuredOrigin(copyOrigin)!==copyOrigin) throw new TypeError();
  } catch { throw new TypeError('HTTPS context required'); }
  if (await isOfficialOrigin(client,copyOrigin)) throw new TypeError('original context forbidden');
  return {copy_origin:copyOrigin,copy_pathname:copyPathname};
}
