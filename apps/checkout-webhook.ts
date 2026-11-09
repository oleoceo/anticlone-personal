import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { operationallyEligible } from './operational-eligibility.js';

export class CheckoutConflict extends Error {}
type Sale = {event_id: string; sale_id: string; amount_minor: number; currency: string; occurred_at: string};
function salePayload(raw: Buffer): Sale {
  const value: unknown = JSON.parse(raw.toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid sale');
  const data = value as Record<string, unknown>;
  if (Object.keys(data).sort().join(',') !== 'amount_minor,currency,event_id,occurred_at,sale_id' ||
    ![data.event_id,data.sale_id].every(id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id)) ||
    !Number.isSafeInteger(data.amount_minor) || (data.amount_minor as number) < 0 || (data.amount_minor as number) > 1e12 ||
    typeof data.currency !== 'string' || !/^[A-Z]{3}$/.test(data.currency) ||
    typeof data.occurred_at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(data.occurred_at) ||
    !Number.isFinite(Date.parse(data.occurred_at)) || new Date(data.occurred_at).toISOString() !== data.occurred_at)
    throw new TypeError('invalid sale');
  return data as Sale;
}

export async function recordCheckout(db: Pool, project: string, raw: Buffer) {
  const sale = salePayload(raw), digest = createHash('sha256').update(raw).digest('hex');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Hold the project lock through commit. A paused project rejects the event
    // with a retryable response and does not create a receipt.
    if (!await operationallyEligible(client,project,undefined,true)) throw new Error('project unavailable');
    // Serialize the project so event and sale identities cannot race independently.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1),35)', [project]);
    const prior = await client.query('SELECT payload_digest FROM checkout_receipts WHERE project_id=$1 AND event_id=$2', [project,sale.event_id]);
    if (prior.rowCount) {
      if (prior.rows[0].payload_digest !== digest) throw new CheckoutConflict();
      await client.query('COMMIT'); return {duplicate:true, attribution:'UNVERIFIED'};
    }
    const previous = await client.query('SELECT amount_minor,currency,occurred_at FROM checkout_sales WHERE project_id=$1 AND sale_id=$2',[project,sale.sale_id]);
    if (previous.rowCount && (Number(previous.rows[0].amount_minor) !== sale.amount_minor || previous.rows[0].currency !== sale.currency || previous.rows[0].occurred_at.toISOString() !== sale.occurred_at)) throw new CheckoutConflict();
    await client.query('INSERT INTO checkout_sales(project_id,sale_id,amount_minor,currency,occurred_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[project,sale.sale_id,sale.amount_minor,sale.currency,sale.occurred_at]);
    await client.query('INSERT INTO checkout_receipts(project_id,event_id,sale_id,payload_digest) VALUES($1,$2,$3,$4)',[project,sale.event_id,sale.sale_id,digest]);
    await client.query('COMMIT'); return {duplicate:!!previous.rowCount, attribution:'UNVERIFIED'};
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

// A per-project, private opt-in. This authenticates the configured sender, not a customer or recovered sale.
export function checkoutWebhook(db: Pool, project: string, env: NodeJS.ProcessEnv, now: () => number = Date.now, path = '/checkout-webhook') {
  const secret = env.CHECKOUT_WEBHOOK_SECRET;
  if (secret !== undefined && !/^[a-f0-9]{64,128}$/.test(secret)) throw Error('invalid checkout webhook configuration');
  let start = now(), count = 0;
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    if (req.url !== path) return false;
    res.setHeader('Cache-Control','no-store');
    if (!secret) { res.writeHead(404).end(); return true; }
    if (req.method !== 'POST') { res.writeHead(405).end(); return true; }
    if (now()-start >= 60_000) { start=now(); count=0; }
    if (++count>120) { res.writeHead(429).end(); return true; }
    if (req.headers.origin || req.headers['sec-fetch-site']) { res.writeHead(403).end(); return true; }
    if (req.headers['content-type'] !== 'application/json') { res.writeHead(415).end(); return true; }
    const timestamp=req.headers['x-checkout-timestamp'], signature=req.headers['x-checkout-signature'];
    if (typeof timestamp !== 'string' || !/^[0-9]{10}$/.test(timestamp) || Math.abs(now()/1000-Number(timestamp))>300 || typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) { res.writeHead(401).end(); return true; }
    const chunks: Buffer[]=[]; let size=0, rejected=false;
    req.on('data',(chunk:Buffer)=>{ size+=chunk.length; if(size>2048) { if(!rejected) res.writeHead(413).end(); rejected=true; chunks.length=0; } else if(!rejected) chunks.push(chunk); });
    req.on('end',()=>{
      if(rejected) return;
      const raw=Buffer.concat(chunks), expected=createHmac('sha256',Buffer.from(secret,'hex')).update(timestamp+'.').update(raw).digest();
      if (!timingSafeEqual(expected,Buffer.from(signature,'hex'))) { res.writeHead(401).end(); return; }
      void recordCheckout(db,project,raw).then(result=>res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(result))).catch((error:unknown)=>res.writeHead(error instanceof CheckoutConflict ? 409 : error instanceof TypeError || error instanceof SyntaxError ? 400 : 503).end());
    }); return true;
  };
}

export async function checkoutMetrics(db: Pool, project: string) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(project)) throw new TypeError('invalid project');
  const result=await db.query('SELECT currency,count(*)::int AS reported_sales,sum(amount_minor)::text AS reported_amount_minor FROM checkout_sales WHERE project_id=$1 GROUP BY currency ORDER BY currency',[project]);
  return {source:'authenticated_checkout_sender',attribution:'UNVERIFIED',recovered_revenue:null,estimated_revenue:null,clicks:null,handoffs:null,currencies:result.rows};
}

// Private operator configuration binds a route to one project and one distinct HMAC key.
// A public project/installation handle cannot authorize a sale.
export function projectCheckoutWebhooks(db: Pool, env: NodeJS.ProcessEnv) {
  const raw: unknown=JSON.parse(env.CHECKOUT_WEBHOOK_ROUTES ?? '[]');
  if (!Array.isArray(raw) || raw.length>100) throw Error('invalid checkout routes');
  const routes=new Set<string>(), secrets=new Set<string>();
  // HMAC pads keys up to its 64-byte block size. Trailing zero bytes can make
  // different hex strings authenticate identically; compare effective keys.
  const effectiveKey=(secret:string)=>Buffer.from(secret,'hex').toString('hex').padEnd(128,'0');
  const handlers=raw.map((value:unknown)=>{
    if (!value || typeof value!=='object' || Array.isArray(value)) throw Error('invalid checkout route');
    const v=value as Record<string,unknown>;
    if (Object.keys(v).sort().join(',')!=='project,route,secret' || typeof v.project!=='string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(v.project) || typeof v.route!=='string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(v.route) || typeof v.secret!=='string' || !/^[a-f0-9]{64,128}$/.test(v.secret) || v.secret.length%2!==0 || routes.has(v.route) || secrets.has(effectiveKey(v.secret)) || (env.CHECKOUT_WEBHOOK_SECRET!==undefined && effectiveKey(v.secret)===effectiveKey(env.CHECKOUT_WEBHOOK_SECRET))) throw Error('invalid checkout route');
    routes.add(v.route); secrets.add(effectiveKey(v.secret));
    return checkoutWebhook(db,v.project,{CHECKOUT_WEBHOOK_SECRET:v.secret},Date.now,'/checkout-webhook/'+v.route);
  });
  return (req:IncomingMessage,res:ServerResponse)=>handlers.some(handle=>handle(req,res));
}
