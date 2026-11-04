import { Pool } from 'pg';
import { setTimeout as delay } from 'node:timers/promises';
import { deliverCtaAlert } from './cta-delivery.js';
import { sendLocalCtaAlert } from './cta-local-smtp.js';

if (process.env.CTA_SMTP_LAB !== '1') throw Error('CTA SMTP laboratory explicitly disabled');
if (!process.env.DATABASE_URL) throw Error('DATABASE_URL required');
const port = Number(process.env.CTA_SMTP_LAB_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('invalid local SMTP port');
const db = new Pool({connectionString:process.env.DATABASE_URL});
const stop = new AbortController();
process.on('SIGTERM', () => stop.abort());
process.on('SIGINT', () => stop.abort());
try {
  while (!stop.signal.aborted) {
    try { await deliverCtaAlert(db, id => sendLocalCtaAlert(id, port)); } catch { process.stderr.write('CTA delivery maintenance failed\n'); }
    try { await delay(1000, undefined, {signal:stop.signal}); } catch { /* shutdown */ }
  }
} finally { await db.end(); }
