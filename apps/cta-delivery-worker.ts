import { Pool } from 'pg';
import { setTimeout as delay } from 'node:timers/promises';
import { deliverCtaAlert } from './cta-delivery.js';

if (!process.env.DATABASE_URL) throw Error('DATABASE_URL required');
const db = new Pool({connectionString:process.env.DATABASE_URL});
const stop = new AbortController();
process.on('SIGTERM', () => stop.abort());
process.on('SIGINT', () => stop.abort());
try {
  while (!stop.signal.aborted) {
    try { await deliverCtaAlert(db); } catch { process.stderr.write('CTA delivery maintenance failed\n'); }
    try { await delay(1000, undefined, {signal:stop.signal}); } catch { /* shutdown */ }
  }
} finally { await db.end(); }
