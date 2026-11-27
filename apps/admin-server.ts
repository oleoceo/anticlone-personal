import { Pool } from 'pg';
import { createAdminServer } from './admin-auth.js';
import {retainSmtpTestAttempts} from './notification-email-log.js';
import { cleanupCta } from './cta-inventory.js';
const record = process.env.ADMIN_PASSWORD_RECORD, secret = process.env.ADMIN_TOTP_SECRET, database = process.env.DATABASE_URL;
const port = Number(process.env.ADMIN_PORT ?? 3001);
if (!record || !secret || !database || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid laboratory admin configuration');
const db = new Pool({ connectionString: database });
db.on('error', () => process.stderr.write('admin database connection failed\n'));
await db.query('SELECT factor_id, last_counter FROM admin_totp_replay LIMIT 0');
await db.query('SELECT factor_id, digest, valid_until FROM admin_totp_codes LIMIT 0');
const server = createAdminServer(record, secret, db);
await cleanupCta(db);
function retainSmtpLog() {
  void retainSmtpTestAttempts(db).catch(() => process.stderr.write('SMTP test retention cleanup failed\n'));
}
retainSmtpLog();
const retention = setInterval(() => {
  void cleanupCta(db).catch(() => process.stderr.write('CTA retention cleanup failed\n'));
  retainSmtpLog();
}, 60 * 60_000);
retention.unref();
server.requestTimeout = 5000; server.headersTimeout = 6000;
server.listen(port, '127.0.0.1');
