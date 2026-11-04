import { Pool } from 'pg';
import { deliverOne } from '../../apps/alerts.js';
import { deliverCtaAlert } from '../../apps/cta-delivery.js';
const db=new Pool({connectionString:process.env.TEST_DATABASE_URL});
try {
  if (process.argv[2]==='f26') await deliverOne(db,'p',Number(process.argv[3]));
  else await deliverCtaAlert(db,async()=>{});
} finally { await db.end(); }
