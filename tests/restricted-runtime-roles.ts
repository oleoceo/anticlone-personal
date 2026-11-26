import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';

export async function restrictedRuntimeRoles(owner: Pool, schema: string, database: string) {
  if (!/^[a-z_0-9]+$/.test(schema) || schema.length>49) throw new Error('invalid fixture schema');
  const groupRoles={admin:schema+'_a',gateway:schema+'_g',maintenance:schema+'_m'};
  const logins={
    admin:schema+'_admin', publicGateway:schema+'_public', privateGateway:schema+'_private', maintenance:schema+'_maint',
  };
  const groups={admin:groupRoles.admin,publicGateway:groupRoles.gateway,privateGateway:groupRoles.gateway,maintenance:groupRoles.maintenance};
  const credentials=Object.fromEntries(Object.entries(logins).map(([service, login])=>{
    const url=new URL(database);
    url.username=login;
    url.password=randomUUID();
    return [service,url];
  })) as Record<keyof typeof logins,URL>;
  const client=await owner.connect();
  try {
    await client.query('BEGIN');
    for(const group of Object.values(groupRoles)) {
      await client.query(`CREATE ROLE ${group} NOLOGIN; GRANT USAGE ON SCHEMA ${schema} TO ${group}`);
    }
    for(const service of Object.keys(credentials) as (keyof typeof logins)[]) {
      const url=credentials[service];
      await client.query(`CREATE ROLE ${url.username} LOGIN PASSWORD '${url.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE;
        GRANT ${groups[service]} TO ${url.username}`);
    }
    const sql=(await readFile('infra/postgres/runtime-grants.sql','utf8'))
      .replaceAll('anticlone_admin',groupRoles.admin).replaceAll('anticlone_gateway',groupRoles.gateway)
      .replaceAll('anticlone_maintenance',groupRoles.maintenance);
    await client.query(sql);
    await client.query('COMMIT');
  } catch(error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {client.release();}
  return {
    admin:credentials.admin.href,
    publicGateway:credentials.publicGateway.href,
    privateGateway:credentials.privateGateway.href,
    maintenance:credentials.maintenance.href,
    drop:async(root: Pool)=>{await root.query('DROP ROLE '+[...Object.values(logins),...Object.values(groupRoles)].join(','));},
  };
}
