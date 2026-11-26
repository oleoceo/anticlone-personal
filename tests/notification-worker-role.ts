import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';

export async function notificationWorkerRole(owner: Pool, schema: string, database: string) {
  if (!/^[a-z_0-9]+$/.test(schema) || schema.length>50) throw new Error('invalid fixture schema');
  const group=schema+'_notify';
  const url=new URL(database);
  url.username=schema+'_worker';
  url.password=randomUUID();
  const client=await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE ROLE ${group} NOLOGIN;
    CREATE ROLE ${url.username} LOGIN PASSWORD '${url.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE;
    GRANT ${group} TO ${url.username};
    GRANT USAGE ON SCHEMA ${schema} TO ${group};`);
    const grants=(await readFile('infra/postgres/notification-worker-grants.sql','utf8'))
      .replaceAll('anticlone_notification_worker',group);
    await client.query(grants);
    await client.query('COMMIT');
  } catch(error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {client.release();}
  return {
    url:url.href,
    drop:async (root: Pool) => {await root.query(`DROP ROLE ${url.username}; DROP ROLE ${group}`);},
  };
}
