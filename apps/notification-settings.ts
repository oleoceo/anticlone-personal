import type { Pool } from 'pg';
import { smtpProvider } from './smtp-provider.js';

type Settings = {provider: string|null; host: string|null; port: number|null; tls_mode: string|null; sender: string|null; recipient: string|null};
const names = ['provider','host','port','tls_mode','sender','recipient'] as const;
export class Conflict extends Error {}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid input');
  return value as Record<string, unknown>;
}
function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError('invalid version');
  return value as number;
}
function validate(input: unknown): {version:number; settings:Settings} {
  const data=object(input);
  if (Object.keys(data).sort().join(',') !== [...names,'version'].sort().join(',')) throw new TypeError('invalid fields');
  const v=version(data.version);
  for (const name of names) if (data[name] !== null && typeof data[name] !== (name === 'port' ? 'number' : 'string')) throw new TypeError('invalid type');
  const s=Object.fromEntries(names.map(n=>[n,data[n]])) as Settings;
  if (s.provider !== null && !['brevo','smtp'].includes(s.provider)) throw new TypeError('invalid provider');
  if (s.tls_mode !== null && !['implicit','starttls'].includes(s.tls_mode)) throw new TypeError('invalid TLS');
  if (s.port !== null && (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535)) throw new TypeError('invalid port');
  if (s.host !== null && (s.host.length > 253 || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(s.host))) throw new TypeError('invalid host');
  for (const mail of [s.sender,s.recipient]) if (mail !== null && (mail.length > 254 || !/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/.test(mail) || mail.split('@')[0].length > 64 || mail.split('@')[0].startsWith('.') || mail.split('@')[0].endsWith('.') || mail.includes('..'))) throw new TypeError('invalid address');
  return {version:v,settings:s};
}
function present(row: Record<string, unknown>) {
  const complete=names.every(name=>row[name] !== null);
  let cloneTransport='PRIVATE_ENVIRONMENT_NOT_CONFIGURED';
  try {
    const config=smtpProvider(process.env);
    if (config) cloneTransport=!names.every(name=>row[name]===config[name])?'PRIVATE_ENVIRONMENT_MISMATCH':row.requested?'AUTHORIZED_CONFIGURATION':'DISABLED';
  } catch {cloneTransport='PRIVATE_ENVIRONMENT_INVALID';}
  return {version:row.version, ...Object.fromEntries(names.map(name=>[name,row[name]])), preference_requested:row.requested,
    status:!complete?'incomplete':row.requested?'enablement_requested':'configured_disabled', real_delivery_operational:false, clone_transport:cloneTransport, updated_at:row.updated_at};
}
export async function getNotificationSettings(db:Pool) {
  const result=await db.query('SELECT * FROM notification_settings WHERE singleton=true');
  if (!result.rowCount) throw Error('settings missing');
  return present(result.rows[0]);
}
export async function saveNotificationSettings(db:Pool, input:unknown) {
  const data=validate(input);
  return mutate(db, async row=>{
    if (row.version !== data.version) throw new Conflict();
    const changed=names.filter(n=>row[n] !== data.settings[n]);
    if (!changed.length) return null;
    return {action:'save',changed:row.requested ? [...changed,'preference_requested'] : changed,values:data.settings,requested:false};
  });
}
export async function setNotificationPreference(db:Pool, input:unknown) {
  const data=object(input);
  if (data.enabled === false) {
    if (Object.keys(data).join(',') !== 'enabled') throw new TypeError('invalid fields');
    return mutate(db, async row=>row.requested ? {action:'disable',changed:['preference_requested'],values:row as Settings,requested:false} : null);
  }
  if (data.enabled !== true || Object.keys(data).sort().join(',') !== 'enabled,version') throw new TypeError('invalid fields');
  const v=version(data.version);
  return mutate(db, async row=>{
    if (row.version !== v) throw new Conflict();
    if (names.some(n=>row[n] === null)) throw new TypeError('incomplete');
    return row.requested ? null : {action:'enable',changed:['preference_requested'],values:row as Settings,requested:true};
  });
}
async function mutate(db:Pool, operation:(row:Record<string, unknown>)=>Promise<{action:string;changed:readonly string[];values:Settings;requested:boolean}|null>) {
  const client=await db.connect();
  try {
    await client.query('BEGIN');
    const result=await client.query('SELECT * FROM notification_settings WHERE singleton=true FOR UPDATE');
    if (!result.rowCount) throw Error('settings missing');
    const row=result.rows[0] as Record<string, unknown>, change=await operation(row);
    if (!change) { await client.query('COMMIT'); return present(row); }
    const s=change.values;
    const updated=await client.query(`UPDATE notification_settings SET provider=$1,host=$2,port=$3,tls_mode=$4,sender=$5,recipient=$6,requested=$7,version=version+1,updated_at=now() WHERE singleton=true RETURNING *`,[s.provider,s.host,s.port,s.tls_mode,s.sender,s.recipient,change.requested]);
    await client.query('INSERT INTO notification_settings_audit(version,action,changed_fields) VALUES($1,$2,$3)',[updated.rows[0].version,change.action,change.changed]);
    await client.query('COMMIT'); return present(updated.rows[0]);
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
