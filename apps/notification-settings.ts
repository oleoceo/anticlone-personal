import {notificationWorkerStatus} from './notification-worker-status.js';
import type { Pool } from 'pg';
import { sendProviderNotice, verifyProviderConnection } from './smtp-provider.js';
import {panelSmtpAllowed, resolveSmtpRow, sealSmtpPassword} from './panel-smtp.js';

type Settings = {provider: string|null; host: string|null; port: number|null; tls_mode: string|null; sender: string|null; recipient: string|null};
const names = ['provider','host','port','tls_mode','sender','recipient'] as const;
export class Conflict extends Error {}
const nextSmtpCheck = new WeakMap<Pool, number>();
const nextSmtpSend = new WeakMap<Pool, number>();
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid input');
  return value as Record<string, unknown>;
}
function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError('invalid version');
  return value as number;
}
function validate(input: unknown) {
  const data=object(input);
  const login = data.smtp_login;
  const password = data.smtp_password;
  if (Object.keys(data).some(field => ![...names, 'version', 'smtp_login', 'smtp_password'].includes(field))) throw new TypeError('invalid fields');
  if ((login !== undefined && (typeof login !== 'string' || !login || login.length > 512 || /[\r\n\0]/.test(login))) ||
      (password !== undefined && (typeof password !== 'string' || !password || password.length > 2048 || /[\r\n\0]/.test(password)))) throw new TypeError('invalid credentials');
  const v=version(data.version);
  for (const name of names) if (data[name] !== null && typeof data[name] !== (name === 'port' ? 'number' : 'string')) throw new TypeError('invalid type');
  const s=Object.fromEntries(names.map(n=>[n,data[n]])) as Settings;
  if (s.provider !== null && !['brevo','smtp'].includes(s.provider)) throw new TypeError('invalid provider');
  if (s.tls_mode !== null && !['implicit','starttls'].includes(s.tls_mode)) throw new TypeError('invalid TLS');
  if (s.port !== null && (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535)) throw new TypeError('invalid port');
  if (s.host !== null && (s.host.length > 253 || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(s.host))) throw new TypeError('invalid host');
  for (const mail of [s.sender,s.recipient]) if (mail !== null && (mail.length > 254 || !/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/.test(mail) || mail.split('@')[0].length > 64 || mail.split('@')[0].startsWith('.') || mail.split('@')[0].endsWith('.') || mail.includes('..'))) throw new TypeError('invalid address');
  return {version:v,settings:s,login:login as string | undefined,password:password as string | undefined};
}
function present(row: Record<string, unknown>) {
  const complete=names.every(name=>row[name] !== null);
  let cloneTransport='PRIVATE_ENVIRONMENT_NOT_CONFIGURED';
  try {
    const config=resolveSmtpRow(row);
    if (config) cloneTransport=!names.every(name=>row[name]===config[name])?'PRIVATE_ENVIRONMENT_MISMATCH':row.requested?'AUTHORIZED_CONFIGURATION':'DISABLED';
  } catch {cloneTransport='PRIVATE_ENVIRONMENT_INVALID';}
  return {version:row.version, smtp_login:row.smtp_login ?? null, smtp_key_saved:typeof row.smtp_secret_encrypted === 'string',
    panel_smtp_available:!!process.env.SMTP_PANEL_KEY, ...Object.fromEntries(names.map(name=>[name,row[name]])), preference_requested:row.requested,
    status:!complete?'incomplete':row.requested?'enablement_requested':'configured_disabled', real_delivery_operational:false, clone_transport:cloneTransport, updated_at:row.updated_at};
}
export async function getNotificationSettings(db:Pool) {
  const result=await db.query('SELECT * FROM notification_settings WHERE singleton=true');
  if (!result.rowCount) throw Error('settings missing');
  const row=result.rows[0];
  const worker=await notificationWorkerStatus();
  const fresh=await db.query(`SELECT max(created_at) AS cutoff FROM notification_settings_audit
    WHERE version<=$1 AND action='enable' AND 'new_events_only'=ANY(changed_fields)`,[row.version]);
  return {...present(row), worker:worker.state==='READY' && worker.version!==row.version
    ? {...worker,state:'SETTINGS_CHANGED'} : worker, delivery_after:row.requested ? fresh.rows[0].cutoff : null};
}

export async function testNotificationSmtp(db: Pool, input: unknown) {
  const data = object(input);
  if (Object.keys(data).some(field => !['version','send'].includes(field)) ||
      (data.send !== undefined && data.send !== true)) throw new TypeError('invalid fields');
  const expected = version(data.version);
  const result = await db.query('SELECT * FROM notification_settings WHERE singleton=true');
  const row = result.rows[0];
  if (!row) throw Error('settings missing');
  const current = present(row);
  if (current.version !== expected) throw new Conflict();
  if (!['AUTHORIZED_CONFIGURATION', 'DISABLED'].includes(current.clone_transport)) {
    return {state: current.clone_transport};
  }

  const now = Date.now();
  const limit = data.send ? nextSmtpSend : nextSmtpCheck;
  if ((limit.get(db) ?? 0) > now) return {state: 'WAIT'};
  const config = resolveSmtpRow(row);
  if (!config) return {state: 'PRIVATE_ENVIRONMENT_NOT_CONFIGURED'};
  limit.set(db, now + 60_000);
  if (data.send) return sendSmtpTest(db, config, expected, now);
  try {
    await verifyProviderConnection(config);
    return {state: 'VERIFIED', checked_at: new Date().toISOString()};
  } catch (error) {
    return {state: (error as {code?: string})?.code === 'EAUTH' ? 'AUTH_FAILED' : 'FAILED'};
  }
}

async function sendSmtpTest(db: Pool, config: NonNullable<ReturnType<typeof resolveSmtpRow>>, version: number, now: number) {
  const reserved = await db.query(`INSERT INTO smtp_test_attempts(settings_version,provider)
    SELECT version,$2 FROM notification_settings WHERE singleton=true AND version=$1 RETURNING id`, [version, config.provider]);
  if (!reserved.rowCount) throw new Conflict();
  const id = reserved.rows[0].id;
  let failure: 'AUTH_FAILED' | 'SMTP_FAILED' | null = null;
  let smtpStatus: number | null = null;
  try {
    await sendProviderNotice(config, String(now), 'AntiClone Dev — teste SMTP', 'Mensagem de teste solicitada no painel AntiClone.');
  } catch (error) {
    const details = error as {code?: string; responseCode?: number} | null;
    failure = details?.code === 'EAUTH' ? 'AUTH_FAILED' : 'SMTP_FAILED';
    const code = details?.responseCode;
    if (typeof code === 'number' && Number.isInteger(code) && code >= 400 && code <= 599) smtpStatus = code;
  }
  const outcome = failure ? 'FAILED' : 'ACCEPTED';
  const result = await db.query(`UPDATE smtp_test_attempts SET outcome=$2, failure_code=$3, smtp_status=$4,
    finished_at=clock_timestamp() WHERE id=$1 RETURNING finished_at`, [id, outcome, failure, smtpStatus]);
  return {state: failure === 'AUTH_FAILED' ? failure : outcome, checked_at: result.rows[0].finished_at};
}
export async function saveNotificationSettings(db:Pool, input:unknown) {
  const data=validate(input);
  return mutate(db, async row=>{
    if (row.version !== data.version) throw new Conflict();
    const changed=names.filter(n=>row[n] !== data.settings[n]);
    const login = data.login ?? (typeof row.smtp_login === 'string' ? row.smtp_login : undefined);
    const identityChanged = ['provider','host','port','tls_mode'].some(field => changed.includes(field as typeof names[number])) ||
      (data.login !== undefined && data.login !== row.smtp_login);
    let credentials: {login: string | null; encrypted: string | null} | undefined;
    if (data.password !== undefined) {
      if (!login || !names.every(name => data.settings[name] !== null) || !panelSmtpAllowed(data.settings)) throw new TypeError('SMTP endpoint not authorized');
      credentials = {login, encrypted:sealSmtpPassword(data.settings, login, data.password)};
    } else if (data.login !== undefined && data.login !== row.smtp_login) throw new TypeError('new SMTP key required');
    else if (identityChanged && row.smtp_secret_encrypted) credentials = {login:null, encrypted:null};
    if (!changed.length && !credentials) return null;
    const fields: string[] = [...changed];
    if (credentials) fields.push('smtp_credentials');
    if (row.requested) fields.push('preference_requested');
    return {action:'save',changed:fields,values:data.settings,requested:false,credentials};
  });
}
export async function setNotificationPreference(db:Pool, input:unknown) {
  const data=object(input);
  if (data.enabled === false) {
    if (Object.keys(data).join(',') !== 'enabled') throw new TypeError('invalid fields');
    return mutate(db, async row=>row.requested ? {action:'disable',changed:['preference_requested'],values:row as Settings,requested:false} : null);
  }
  const fields = Object.keys(data).sort().join(',');
  if (data.enabled !== true || (fields !== 'enabled,version' &&
    (fields !== 'enabled,newEventsOnly,version' || data.newEventsOnly !== true))) throw new TypeError('invalid fields');
  const v=version(data.version);
  return mutate(db, async row=>{
    if (row.version !== v) throw new Conflict();
    if (names.some(n=>row[n] === null)) throw new TypeError('incomplete');
    if (data.newEventsOnly && !row.requested) {
      if (present(row).clone_transport !== 'DISABLED') throw new TypeError('private transport unavailable');
      const worker=await notificationWorkerStatus();
      if (worker.state!=='NOT_CONFIGURED' && (worker.state!=='READY' || worker.version!==row.version)) throw new Conflict();
    }
    return row.requested ? null : {action:'enable',changed:data.newEventsOnly ? ['preference_requested','new_events_only'] : ['preference_requested'],values:row as Settings,requested:true};
  });
}
async function mutate(db:Pool, operation:(row:Record<string, unknown>)=>Promise<{action:string;changed:readonly string[];values:Settings;requested:boolean;credentials?:{login:string|null;encrypted:string|null}}|null>) {
  const client=await db.connect();
  try {
    await client.query('BEGIN');
    const result=await client.query('SELECT * FROM notification_settings WHERE singleton=true FOR UPDATE');
    if (!result.rowCount) throw Error('settings missing');
    const row=result.rows[0] as Record<string, unknown>, change=await operation(row);
    if (!change) { await client.query('COMMIT'); return present(row); }
    const s=change.values;
    const values=[s.provider,s.host,s.port,s.tls_mode,s.sender,s.recipient,change.requested];
    if (change.credentials) values.push(change.credentials.login, change.credentials.encrypted);
    const updated=await client.query(`UPDATE notification_settings
      SET provider=$1,host=$2,port=$3,tls_mode=$4,sender=$5,recipient=$6,requested=$7,version=version+1,updated_at=clock_timestamp()
      ${change.credentials ? ',smtp_login=$8,smtp_secret_encrypted=$9' : ''}
      WHERE singleton=true RETURNING *`,values);
    await client.query('INSERT INTO notification_settings_audit(version,action,changed_fields,created_at) SELECT $1,$2,$3,updated_at FROM notification_settings WHERE singleton=true',[updated.rows[0].version,change.action,change.changed]);
    await client.query('COMMIT'); return present(updated.rows[0]);
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
