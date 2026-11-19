import {createCipheriv, createDecipheriv, randomBytes} from 'node:crypto';
import type {Pool} from 'pg';
import {smtpProvider} from './smtp-provider.js';

function key(env: NodeJS.ProcessEnv) {
  const value = env.SMTP_PANEL_KEY;
  if (!value || !/^[a-f0-9]{64}$/.test(value)) throw Error('SMTP credential storage unavailable');
  return Buffer.from(value, 'hex');
}

export function panelSmtpAllowed(row: Record<string, unknown>, env = process.env) {
  return !!env.SMTP_PANEL_HOST && row.host === env.SMTP_PANEL_HOST &&
    row.port === Number(env.SMTP_PANEL_PORT) && row.tls_mode === env.SMTP_PANEL_TLS;
}

function identity(row: Record<string, unknown>, login: string) {
  return Buffer.from(JSON.stringify([row.provider, row.host, row.port, row.tls_mode, login]));
}

export function sealSmtpPassword(row: Record<string, unknown>, login: string, password: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(process.env), iv);
  cipher.setAAD(identity(row, login));
  const data = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}

export function resolveSmtpRow(row: Record<string, unknown>, env = process.env) {
  if (typeof row.smtp_login !== 'string' || typeof row.smtp_secret_encrypted !== 'string') return smtpProvider(env);
  if (!panelSmtpAllowed(row, env)) return undefined;
  const data = Buffer.from(row.smtp_secret_encrypted, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key(env), data.subarray(0, 12));
  decipher.setAAD(identity(row, row.smtp_login));
  decipher.setAuthTag(data.subarray(12, 28));
  const password = Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
  const config = smtpProvider({SMTP_PROVIDER: String(row.provider), SMTP_HOST: String(row.host),
    SMTP_PORT: String(row.port), SMTP_TLS: String(row.tls_mode), SMTP_SENDER: String(row.sender),
    SMTP_RECIPIENT: String(row.recipient), SMTP_USER: row.smtp_login, SMTP_PASSWORD: password});
  return config && {...config, settingsVersion: Number(row.version)};
}

export async function currentSmtpProvider(db: Pool, configured: ReturnType<typeof smtpProvider>, env = process.env) {
  if (!env.SMTP_PANEL_KEY) return configured;
  try {
    const result = await db.query('SELECT * FROM notification_settings WHERE singleton=true');
    return result.rows[0] ? resolveSmtpRow(result.rows[0], env) : undefined;
  } catch {
    return undefined;
  }
}
