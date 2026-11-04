import { Pool } from 'pg';
import { deliverCtaAlert } from '../../apps/cta-delivery.js';
const db = new Pool({connectionString:process.env.TEST_DATABASE_URL});
await deliverCtaAlert(db, async () => { process.stdout.write('reserved\n'); await new Promise(() => {}); });
