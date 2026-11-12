import {createCipheriv,createDecipheriv,createHash,createHmac,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
import type {Pool,PoolClient} from 'pg';
import {assertProjectAdministrativeWrite,assertPageAdministrativeWrite} from './admin-project-write.js';
import {identifier,mapping,normalize,object,sampleShape,sampleFields,currencyExponents,type Mapping} from './commerce-mapping.js';

export class CommerceConflict extends Error {}
function uuid(value:unknown):string{if(typeof value!=='string'||! /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value))throw new TypeError('invalid id');return value;}
function encryptionKey(env:NodeJS.ProcessEnv){const value=env.COMMERCE_ENCRYPTION_KEY;if(!value||! /^[a-f0-9]{64}$/.test(value))throw new Error('commerce encryption unavailable');return Buffer.from(value,'hex');}
function encrypt(secret:string,id:string,env:NodeJS.ProcessEnv){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',encryptionKey(env),iv);cipher.setAAD(Buffer.from(id));const encrypted=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64');}
function decrypt(value:string,id:string,env:NodeJS.ProcessEnv){const raw=Buffer.from(value,'base64'),cipher=createDecipheriv('aes-256-gcm',encryptionKey(env),raw.subarray(0,12));cipher.setAAD(Buffer.from(id));cipher.setAuthTag(raw.subarray(12,28));return Buffer.concat([cipher.update(raw.subarray(28)),cipher.final()]).toString('utf8');}
async function transaction<T>(db:Pool,fn:(client:PoolClient)=>Promise<T>){const c=await db.connect();try{await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='5s'");const result=await fn(c);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
async function lock(c:PoolClient){await c.query("SELECT pg_advisory_xact_lock(631,31)");}
async function audit(c:PoolClient,id:string,operation:string,version:number){await c.query('INSERT INTO commerce_audit(entity,operation,version) VALUES($1,$2,$3)',[id,operation,version]);}
function version(value:unknown):number{if(!Number.isSafeInteger(value)||Number(value)<0)throw new TypeError('invalid version');return Number(value);}
function state(value:unknown,test=false):string{if(typeof value!=='string'||!(test?['TEST','ACTIVE','INACTIVE','ARCHIVED']:['ACTIVE','INACTIVE','ARCHIVED']).includes(value))throw new TypeError('invalid state');return value;}
function only(data:Record<string,unknown>,names:string[]){if(Object.keys(data).some(k=>!['action',...names].includes(k)))throw new TypeError('unexpected field');}

// Called only behind the existing MFA web session + same-origin CSRF boundary.
export async function commerceAdmin(db:Pool,body:unknown,env:NodeJS.ProcessEnv=process.env):Promise<unknown>{
 const d=object(body);
 if(d.action==='list'){
  only(d,[]);
  const models=(await db.query('SELECT id,version,name,config,approved,created_at FROM commerce_models ORDER BY created_at DESC LIMIT 200')).rows;
  const connections=(await db.query('SELECT id,model_id,model_version,legacy_model_version,account,state,version,created_at FROM commerce_connections ORDER BY created_at DESC LIMIT 200')).rows.map(r=>({...r,endpoint:'/commerce-webhook/'+r.id}));
  const bindings=(await db.query('SELECT DISTINCT ON(id) * FROM commerce_bindings ORDER BY id,version DESC LIMIT 500')).rows;
  const samples=(await db.query("SELECT connection_id,model_version,shape,received_at FROM commerce_version_samples WHERE received_at>clock_timestamp()-interval '24 hours' LIMIT 200")).rows;
  const formats=(await db.query('SELECT connection_id,model_version,state,prepared_at,accepted_at FROM commerce_connection_versions ORDER BY prepared_at DESC LIMIT 500')).rows;
  const projects=(await db.query('SELECT id,name FROM projects ORDER BY name,id LIMIT 500')).rows;
  const pages=(await db.query("SELECT id,project_id,to_jsonb(p)->>'name' AS name FROM protected_pages p ORDER BY project_id,id LIMIT 500")).rows;
  return {models,connections,bindings,samples,formats,projects,pages,capabilities:{authentication:['HMAC_SHA256_TIMESTAMP','HMAC_SHA512_TIMESTAMP'],attribution:'UNVERIFIED',arrival_confirmation:false,api_verification:false,raw_samples:false}};
 }
 if(d.action==='inspect'){only(d,['sample']);if(Buffer.byteLength(JSON.stringify(d.sample))>2048)throw new TypeError('sample too large');object(d.sample);return {shape:sampleShape(d.sample),fields:sampleFields(d.sample)};}
 if(d.action==='test'){
  only(d,['config','sample']);const config=mapping(d.config),sample=object(d.sample);
  if(Buffer.byteLength(JSON.stringify(sample))>2048)throw new TypeError('sample too large');
  const result=normalize(config,sample);
  // Return only bounded commercial interpretation, never submitted identifiers or reference values.
  return {valid:true,amount_minor:result.amount,currency:result.currency,status:result.status,reference_present:result.reference_present,attribution:'UNVERIFIED',shape:sampleShape(sample),fields:sampleFields(sample),test_digest:createHash('sha256').update(JSON.stringify(config)).digest('hex')};
 }
 if(d.action==='model'){
  only(d,['id','expected_version','name','config','sample','reviewed']);
  const config=mapping(d.config),name=identifier(d.name),id=d.id?uuid(d.id):randomUUID(),expected=version(d.expected_version);
  if(d.reviewed!==true)throw new TypeError('explicit commercial review required');
  normalize(config,d.sample);if(Buffer.byteLength(JSON.stringify(d.sample))>2048)throw new TypeError('sample too large');
  return transaction(db,async c=>{await lock(c);const latest=(await c.query('SELECT max(version) v FROM commerce_models WHERE id=$1',[id])).rows[0].v??0;if(latest!==expected)throw new CommerceConflict('model version changed');
   await c.query('INSERT INTO commerce_models(id,version,name,config,approved) VALUES($1,$2,$3,$4,true)',[id,expected+1,name,config]);await audit(c,id,'MODEL_REVIEWED',expected+1);return {id,version:expected+1};});
 }
 if(d.action==='connection'){
  only(d,['model','model_version','account']);const model=uuid(d.model),mv=version(d.model_version),account=identifier(d.account),id=randomUUID();
  // No secret is ever returned to browser. Reference sender reads the laboratory key through a server-side operator channel.
  const secret=randomBytes(32).toString('hex'),encrypted=encrypt(secret,id,env);
  return transaction(db,async c=>{await lock(c);if(!(await c.query('SELECT 1 FROM commerce_models WHERE id=$1 AND version=$2 AND approved',[model,mv])).rowCount)throw new TypeError('unapproved model');
   if((await c.query('SELECT 1 FROM commerce_connections WHERE model_id=$1 AND account=$2',[model,account])).rowCount)throw new CommerceConflict('account already connected');
   await c.query("INSERT INTO commerce_connections(id,model_id,model_version,legacy_model_version,account,secret_encrypted,state) VALUES($1,$2,$3,$3,$4,$5,'TEST')",[id,model,mv,account,encrypted]);
   await audit(c,id,'CONNECTION_CREATED',1);return {id,version:1,state:'TEST',endpoint:'/commerce-webhook/'+id};});
 }
 if(d.action==='migration-prepare'){
  only(d,['id','expected_version','target_version','reviewed','old_sample','sample']);const id=uuid(d.id),expected=version(d.expected_version),target=version(d.target_version);
  if(d.reviewed!==true||[d.old_sample,d.sample].some(s=>Buffer.byteLength(JSON.stringify(s))>2048))throw new TypeError('review and bounded samples required');
  return transaction(db,async c=>{await lock(c);const row=(await c.query('SELECT c.*,m.config FROM commerce_connections c JOIN commerce_models m ON(m.id,m.version)=(c.model_id,c.model_version) WHERE c.id=$1 FOR UPDATE OF c',[id])).rows[0];
   if(!row||row.version!==expected)throw new CommerceConflict('connection version changed');
   const next=(await c.query('SELECT config FROM commerce_models WHERE id=$1 AND version=$2 AND approved',[row.model_id,target])).rows[0];
   if(!next||target<=row.model_version)throw new TypeError('newer approved version of same model required');
   const old=mapping(row.config),config=mapping(next.config);
   // Event/order namespace and commercial discriminator semantics must remain stable.
   for(const key of ['event','order','product','offer','checkout','currency'] as const)if(old.fields[key]!==config.fields[key])throw new CommerceConflict('identity field changes require an explicit adapter');
   if(JSON.stringify(normalize(old,d.old_sample))!==JSON.stringify(normalize(config,d.sample)))throw new CommerceConflict('samples must describe the same canonical event');
   if((await c.query("SELECT 1 FROM commerce_connection_versions WHERE connection_id=$1 AND state='PENDING'",[id])).rowCount)throw new CommerceConflict('migration already pending');
   await c.query("INSERT INTO commerce_connection_versions(connection_id,model_id,model_version,state) VALUES($1,$2,$3,'PENDING')",[id,row.model_id,target]);
   await c.query('UPDATE commerce_connections SET version=version+1 WHERE id=$1',[id]);await audit(c,id,'MIGRATION_PREPARED_V'+target,expected+1);
   return {id,version:expected+1,target_version:target,state:'PENDING',requires:'authenticated version-bound test, then explicit commit'};
  });
 }
 if(d.action==='migration-commit'||d.action==='migration-cancel'){
  only(d,['id','expected_version','target_version','reviewed']);const id=uuid(d.id),expected=version(d.expected_version),target=version(d.target_version);
  if(d.reviewed!==true)throw new TypeError('explicit migration review required');
  return transaction(db,async c=>{await lock(c);const row=(await c.query('SELECT * FROM commerce_connections WHERE id=$1 FOR UPDATE',[id])).rows[0];
   if(!row||row.version!==expected||!(await c.query("SELECT 1 FROM commerce_connection_versions WHERE connection_id=$1 AND model_version=$2 AND state='PENDING'",[id,target])).rowCount)throw new CommerceConflict('migration version changed');
   if(d.action==='migration-commit'){
    if(!(await c.query("SELECT 1 FROM commerce_version_samples WHERE connection_id=$1 AND model_version=$2 AND received_at>clock_timestamp()-interval '24 hours'",[id,target])).rowCount)throw new CommerceConflict('authenticated target mapping test required');
    await c.query("UPDATE commerce_connection_versions SET state='ACCEPTED',accepted_at=clock_timestamp() WHERE connection_id=$1 AND model_version=$2",[id,target]);
    await c.query('UPDATE commerce_connections SET model_version=$2,version=version+1 WHERE id=$1',[id,target]);
   }else{await c.query('DELETE FROM commerce_version_samples WHERE connection_id=$1 AND model_version=$2',[id,target]);await c.query('DELETE FROM commerce_connection_versions WHERE connection_id=$1 AND model_version=$2',[id,target]);await c.query('UPDATE commerce_connections SET version=version+1 WHERE id=$1',[id]);}
   await audit(c,id,(d.action==='migration-commit'?'MIGRATION_ACCEPTED_V':'MIGRATION_CANCELLED_V')+target,expected+1);return {id,version:expected+1,model_version:d.action==='migration-commit'?target:row.model_version};
  });
 }
 if(d.action==='connection-state'||d.action==='rotate'){
  only(d,d.action==='rotate'?['id','expected_version']:['id','expected_version','state']);const id=uuid(d.id),expected=version(d.expected_version),next=d.action==='rotate'?null:state(d.state,true);
  return transaction(db,async c=>{await lock(c);const row=(await c.query('SELECT * FROM commerce_connections WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!row||row.version!==expected)throw new CommerceConflict('connection version changed');
   if(next==='ACTIVE'&&!(await c.query("SELECT 1 FROM commerce_version_samples WHERE connection_id=$1 AND model_version=$2 AND received_at>clock_timestamp()-interval '24 hours'",[id,row.model_version])).rowCount)throw new CommerceConflict('authenticated mapping test required');
   const encrypted=d.action==='rotate'?encrypt(randomBytes(32).toString('hex'),id,env):row.secret_encrypted;
   await c.query('UPDATE commerce_connections SET secret_encrypted=$2,state=$3,version=version+1 WHERE id=$1',[id,encrypted,next??row.state]);
   if(d.action==='rotate'){await c.query('DELETE FROM commerce_samples WHERE connection_id=$1',[id]);await c.query('DELETE FROM commerce_version_samples WHERE connection_id=$1',[id]);}
   await audit(c,id,d.action==='rotate'?'KEY_ROTATED':'CONNECTION_'+next,expected+1);return {id,version:expected+1,state:next??row.state};});
 }
 if(d.action==='binding'){
  only(d,['id','expected_version','connection','project','page','offer','product','checkout','url','price_minor','currency','state']);
  const id=d.id?uuid(d.id):randomUUID(),expected=version(d.expected_version),connection=uuid(d.connection),project=identifier(d.project),page=d.page?uuid(d.page):null;
  const offer=d.offer?identifier(d.offer):'',product=d.product?identifier(d.product):'',checkout=d.checkout?identifier(d.checkout):'',next=state(d.state);
  if(!offer&&!product&&!checkout)throw new TypeError('commercial identity required');
  if(typeof d.url!=='string'||d.url.length>2048)throw new TypeError('invalid checkout URL');const url=new URL(d.url);if(url.protocol!=='https:'||url.username||url.password||url.hash)throw new TypeError('HTTPS URL required');
  if(!Number.isSafeInteger(d.price_minor)||Number(d.price_minor)<0||Number(d.price_minor)>1e12||typeof d.currency!=='string'||! /^[A-Z]{3}$/.test(d.currency))throw new TypeError('invalid price');
  return transaction(db,async c=>{await assertProjectAdministrativeWrite(c,project);if(page)await assertPageAdministrativeWrite(c,project,page);await lock(c);
   const account=(await c.query('SELECT m.config FROM commerce_connections c JOIN commerce_models m ON(m.id,m.version)=(c.model_id,c.model_version) WHERE c.id=$1',[connection])).rows[0];if(!account)throw new TypeError('unknown connection');
   const config=mapping(account.config);if(currencyExponents[d.currency as string]!==config.money.exponent)throw new TypeError('unsupported binding currency');
   for(const [key,value] of [['product',product],['offer',offer],['checkout',checkout]] as const)if(Boolean(config.fields[key])!==Boolean(value))throw new TypeError('binding discriminators must match mapped fields');
   const prior=(await c.query('SELECT * FROM commerce_bindings WHERE id=$1 ORDER BY version DESC LIMIT 1',[id])).rows[0];if((prior?.version??0)!==expected)throw new CommerceConflict('binding version changed');
   // Identity is permanent even after archival. Price/URL/state can evolve; historical orders pin their revision.
   if(prior&&[prior.connection_id,prior.project_id,prior.page_id,prior.offer,prior.product,prior.checkout].join('|')!==[connection,project,page,offer,product,checkout].join('|'))throw new CommerceConflict('binding identity is immutable');
   const conflicts=await c.query('SELECT 1 FROM commerce_bindings WHERE connection_id=$1 AND product=$2 AND offer=$3 AND checkout=$4 AND id<>$5',[connection,product,offer,checkout,id]);if(conflicts.rowCount)throw new CommerceConflict('ambiguous commercial identity');
   await c.query('INSERT INTO commerce_bindings(id,version,connection_id,project_id,page_id,offer,product,checkout,url,price_minor,currency,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[id,expected+1,connection,project,page,offer,product,checkout,url.href,d.price_minor,d.currency,next]);await audit(c,id,'BINDING_'+next,expected+1);return {id,version:expected+1,protection_approval:'UNCHANGED_REQUIRES_F20_F25'};});
 }
 if(d.action==='history'){
  only(d,['id']);return (await db.query('SELECT operation,version,occurred_at FROM commerce_audit WHERE entity=$1 ORDER BY id DESC LIMIT 100',[uuid(d.id)])).rows;
 }
 if(d.action==='report')return commerceReport(db,d);
 throw new TypeError('invalid commerce operation');
}

export type CommerceFormat={version?:number;test?:boolean};
export function commerceSigningInput(timestamp:string,raw:Buffer,format:CommerceFormat={}){
 return Buffer.concat([Buffer.from(format.version===undefined?timestamp+'.':timestamp+'.'+format.version+'.'+(format.test?'test':'event')+'.'),raw]);
}
function algorithm(config:Mapping){return config.auth==='HMAC_SHA512_TIMESTAMP'?'sha512':'sha256';}
export async function receiveCommerce(db:Pool,id:string,raw:Buffer,timestamp:string,signature:string,env:NodeJS.ProcessEnv,now=Date.now(),format:CommerceFormat={}){
 uuid(id);if(! /^\d{10}$/.test(timestamp)||Math.abs(now/1000-Number(timestamp))>300||! /^(?:[a-f0-9]{64}|[a-f0-9]{128})$/.test(signature)||raw.length>2048||(format.version!==undefined&&(!Number.isSafeInteger(format.version)||format.version<1))||(format.test&&format.version===undefined))throw new CommerceUnauthorized();
 return transaction(db,async c=>{await lock(c);const connection=(await c.query('SELECT * FROM commerce_connections WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!connection)throw new CommerceUnauthorized();
  const modelVersion=format.version??connection.legacy_model_version;
  const model=(await c.query('SELECT v.state,m.config FROM commerce_connection_versions v JOIN commerce_models m ON(m.id,m.version)=(v.model_id,v.model_version) WHERE v.connection_id=$1 AND v.model_version=$2',[id,modelVersion])).rows[0];if(!model)throw new CommerceUnauthorized();
  const config=mapping(model.config),secret=decrypt(connection.secret_encrypted,id,env),expected=createHmac(algorithm(config),Buffer.from(secret,'hex')).update(commerceSigningInput(timestamp,raw,format)).digest();if(expected.length!==signature.length/2||!timingSafeEqual(expected,Buffer.from(signature,'hex')))throw new CommerceUnauthorized();
  const payload:unknown=JSON.parse(raw.toString('utf8')),sale=normalize(config,payload);
  if(Date.parse(sale.occurred)>now+300000)throw new TypeError('future commercial event');
  if(model.state==='PENDING'&&!format.test)throw new CommerceConflict('target mapping is not active');
  await c.query("DELETE FROM commerce_version_samples WHERE received_at<clock_timestamp()-interval '24 hours'");
  await c.query("DELETE FROM commerce_samples WHERE received_at<clock_timestamp()-interval '24 hours'");
  const previous=(await c.query('SELECT * FROM commerce_orders WHERE connection_id=$1 AND order_id=$2 FOR UPDATE',[id,sale.order])).rows[0];
  if(format.test||(connection.state==='TEST'&&!previous)){
   const shape={structure:sampleShape(payload),fields:sampleFields(payload)};
   await c.query('INSERT INTO commerce_version_samples(connection_id,model_version,shape) VALUES($1,$2,$3) ON CONFLICT(connection_id,model_version) DO UPDATE SET shape=excluded.shape,received_at=clock_timestamp()',[id,modelVersion,JSON.stringify(shape)]);
   if(modelVersion===connection.legacy_model_version&&connection.model_version===connection.legacy_model_version)await c.query('INSERT INTO commerce_samples(connection_id,shape) VALUES($1,$2) ON CONFLICT(connection_id) DO UPDATE SET shape=excluded.shape,received_at=clock_timestamp()',[id,JSON.stringify(shape)]);
   return {mode:'TEST',recorded:false,attribution:'UNVERIFIED'};
  }
  const digest=createHash('sha256').update(raw).digest('hex'),canonical=createHash('sha256').update(JSON.stringify(sale)).digest('hex'),prior=(await c.query('SELECT digest,canonical_digest FROM commerce_events WHERE connection_id=$1 AND event_id=$2',[id,sale.event])).rows[0];
  if(prior){if(prior.digest!==digest&&prior.canonical_digest!==canonical)throw new CommerceConflict('event conflict');return {duplicate:true,attribution:'UNVERIFIED'};}
  if(!previous&&connection.state!=='ACTIVE')throw new CommerceConflict('inactive connection');
  const bound=previous?.binding_id?(await c.query('SELECT * FROM commerce_bindings WHERE id=$1 AND version=$2',[previous.binding_id,previous.binding_version])).rows[0]:previous?null:(await c.query("SELECT * FROM (SELECT DISTINCT ON(id) * FROM commerce_bindings WHERE connection_id=$1 ORDER BY id,version DESC) b WHERE product=$2 AND offer=$3 AND checkout=$4 AND state='ACTIVE'",[id,sale.product,sale.offer,sale.checkout])).rows;
  const binding=Array.isArray(bound)?bound.length===1?bound[0]:null:bound;
  if(binding&&(binding.product!==sale.product||binding.offer!==sale.offer||binding.checkout!==sale.checkout||binding.currency!==sale.currency))throw new CommerceConflict('order identity conflict');
  if(previous&&(Number(previous.amount_minor)!==sale.amount||previous.currency!==sale.currency||previous.product!==sale.product||previous.offer!==sale.offer||previous.checkout!==sale.checkout))throw new CommerceConflict('order identity conflict');
  // Full-order terminal adjustments are monotone. A late PAID cannot resurrect an adjusted order.
  const rank={PENDING:0,PAID:1,CANCELLED:2,REFUNDED:3,CHARGEBACK:4}[sale.status];
  if(!previous)await c.query('INSERT INTO commerce_orders(connection_id,order_id,binding_id,binding_version,amount_minor,currency,status,occurred_at,rank,product,offer,checkout,paid_reported,paid_at,adjusted_at,reversed_at,model_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)',[id,sale.order,binding?.id??null,binding?.version??null,sale.amount,sale.currency,sale.status,sale.occurred,rank,sale.product,sale.offer,sale.checkout,sale.status==='PAID',sale.status==='PAID'?sale.occurred:null,rank>=2?sale.occurred:null,rank>=3?sale.occurred:null,modelVersion]);
  else await c.query('UPDATE commerce_orders SET status=CASE WHEN rank<$4 THEN $3 ELSE status END,rank=greatest(rank,$4),paid_reported=paid_reported OR $5,paid_at=CASE WHEN $5 THEN least(paid_at,$6::timestamptz) ELSE paid_at END,adjusted_at=CASE WHEN $4>=2 THEN least(adjusted_at,$6::timestamptz) ELSE adjusted_at END,reversed_at=CASE WHEN $4>=3 THEN least(reversed_at,$6::timestamptz) ELSE reversed_at END WHERE connection_id=$1 AND order_id=$2',[id,sale.order,sale.status,rank,sale.status==='PAID',sale.occurred]);
  await c.query('INSERT INTO commerce_events(connection_id,event_id,order_id,digest,canonical_digest,model_version) VALUES($1,$2,$3,$4,$5,$6)',[id,sale.event,sale.order,digest,canonical,modelVersion]);
  return {duplicate:false,attribution:'UNVERIFIED',bound:!!binding};
 });
}
class CommerceUnauthorized extends Error{}
export function commerceWebhook(db:Pool,env:NodeJS.ProcessEnv=process.env){
 let window=Date.now(),requests=0,inflight=0;
 return (req:IncomingMessage,res:ServerResponse)=>{
  if(!req.url?.startsWith('/commerce-webhook/'))return false;
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  const id=req.url.slice('/commerce-webhook/'.length);try{uuid(id);}catch{res.writeHead(404).end();return true;}
  if(req.method!=='POST'){res.writeHead(405).end();return true;}
  if(Date.now()-window>=60000){window=Date.now();requests=0;}if(++requests>120||inflight>=8){res.writeHead(429).end();return true;}
  if(req.headers.origin||req.headers['sec-fetch-site']){res.writeHead(403).end();return true;}
  if(req.headers['content-type']!=='application/json'){res.writeHead(415).end();return true;}
  const timestamp=req.headers['x-checkout-timestamp'],signature=req.headers['x-checkout-signature'],v=req.headers['x-checkout-model-version'],test=req.headers['x-checkout-test'];
  if(typeof timestamp!=='string'||typeof signature!=='string'||(v!==undefined&&(typeof v!=='string'||!/^[1-9][0-9]{0,8}$/.test(v)))||(test!==undefined&&(test!=='1'||v===undefined))){res.writeHead(401).end();return true;}
  const format:CommerceFormat={...(v!==undefined?{version:Number(v)}:{}),...(test==='1'?{test:true}:{})};
  inflight++;let released=false;const release=()=>{if(!released){inflight--;released=true;}};res.on('close',release);
  const chunks:Buffer[]=[];let size=0,rejected=false;req.setTimeout(5000,()=>{rejected=true;res.writeHead(408).end();req.destroy();});
  req.on('error',()=>{rejected=true;release();});req.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>2048){if(!rejected)res.writeHead(413).end();rejected=true;chunks.length=0;}else if(!rejected)chunks.push(chunk);});
  req.on('end',()=>{if(rejected)return;req.setTimeout(0);void receiveCommerce(db,id,Buffer.concat(chunks),timestamp,signature,env,Date.now(),format).then(result=>res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(result))).catch((e:unknown)=>res.writeHead(e instanceof CommerceUnauthorized?401:e instanceof CommerceConflict?409:e instanceof TypeError||e instanceof SyntaxError?400:503).end()).finally(release);});return true;
 };
}

async function commerceReport(db:Pool,d:Record<string,unknown>){
 only(d,['project','page','offer','checkout','provider','from','until','traffic','protection']);
 if(typeof d.from!=='string'||typeof d.until!=='string'||!Number.isFinite(Date.parse(d.from))||!Number.isFinite(Date.parse(d.until))||Date.parse(d.until)<=Date.parse(d.from)||Date.parse(d.until)-Date.parse(d.from)>366*86400000)throw new TypeError('invalid report period');
 const project=d.project?identifier(d.project):null,page=d.page?uuid(d.page):null,offer=d.offer?identifier(d.offer):null,checkout=d.checkout?identifier(d.checkout):null,provider=d.provider?uuid(d.provider):null;
 const traffic=d.traffic?String(d.traffic):null,protection=d.protection?String(d.protection):null;
 if(traffic&&!['PAID_ATTRIBUTED','ORGANIC','REFERRAL','DIRECT_UNKNOWN'].includes(traffic)||protection&&!['PAGE_REDIRECT','REPLACE_CONVERSION'].includes(protection))throw new TypeError('invalid observation filter');
 // Orders have no demonstrable traffic/action chain; never assign them the browser's class.
 const currencies=traffic||protection?null:(await db.query(`SELECT o.currency,count(*) FILTER(WHERE o.paid_at >= $6 AND o.paid_at < $7)::int reported_sales,
 coalesce(sum(o.amount_minor) FILTER(WHERE o.paid_at >= $6 AND o.paid_at < $7),0)::text reported_amount_minor,
 CASE WHEN bool_or(o.status='CANCELLED' AND o.paid_reported AND o.reversed_at IS NULL) THEN NULL ELSE (coalesce(sum(o.amount_minor) FILTER(WHERE o.paid_at >= $6 AND o.paid_at < $7),0)-coalesce(sum(o.amount_minor) FILTER(WHERE o.reversed_at >= $6 AND o.reversed_at < $7),0))::text END net_amount_minor,
 (coalesce(sum(o.amount_minor) FILTER(WHERE o.paid_at >= $6 AND o.paid_at < $7),0)-coalesce(sum(o.amount_minor) FILTER(WHERE o.reversed_at >= $6 AND o.reversed_at < $7),0))::text reported_balance_minor,
 coalesce(sum(o.amount_minor) FILTER(WHERE o.status='CANCELLED' AND o.paid_reported AND o.reversed_at IS NULL),0)::text cancelled_payment_uncertain_minor,
 count(*) FILTER(WHERE o.adjusted_at >= $6 AND o.adjusted_at < $7)::int adjusted_orders,
 coalesce(sum(o.amount_minor) FILTER(WHERE o.reversed_at >= $6 AND o.reversed_at < $7),0)::text reversal_amount_minor,
 count(*) FILTER(WHERE o.binding_id IS NULL)::int unknown_commercial_origin_orders,
 count(*) FILTER(WHERE o.status='PENDING')::int pending_orders,
 count(*) FILTER(WHERE o.status='CANCELLED')::int cancelled_orders,
 count(*) FILTER(WHERE o.status='REFUNDED')::int refunded_orders,
 count(*) FILTER(WHERE o.status='CHARGEBACK')::int chargeback_orders,
 count(*) FILTER(WHERE (m.config->'money'->>'exponent')::int IS DISTINCT FROM ($8::jsonb->>o.currency)::int)::int monetary_integrity_unverified_orders,
 count(*)::int unverified_orders
 FROM commerce_orders o JOIN commerce_connections c ON c.id=o.connection_id JOIN commerce_models m ON(m.id,m.version)=(c.model_id,o.model_version) LEFT JOIN commerce_bindings b ON (b.id,b.version)=(o.binding_id,o.binding_version)
 WHERE ($1::text IS NULL OR b.project_id=$1) AND ($2::uuid IS NULL OR b.page_id=$2) AND ($3::text IS NULL OR b.offer=$3) AND ($4::text IS NULL OR b.checkout=$4) AND ($5::uuid IS NULL OR c.model_id=$5) AND ((o.paid_at >= $6 AND o.paid_at < $7) OR (o.adjusted_at >= $6 AND o.adjusted_at < $7) OR (o.reversed_at >= $6 AND o.reversed_at < $7) OR (o.occurred_at >= $6 AND o.occurred_at < $7)) GROUP BY o.currency ORDER BY o.currency`,[project,page,offer,checkout,provider,d.from,d.until,currencyExponents])).rows;
 if(currencies)for(const row of currencies){row.monetary_integrity=row.monetary_integrity_unverified_orders?'UNVERIFIED_HISTORICAL_CONTRACT':'VALIDATED_CURRENCY_EXPONENT';if(row.monetary_integrity_unverified_orders)for(const key of ['reported_amount_minor','net_amount_minor','reported_balance_minor','reversal_amount_minor','cancelled_payment_uncertain_minor'])row[key]=null;}
 const observations=offer||checkout||provider?null:(await db.query(`SELECT project_id,page_id,traffic_class,action,evidence,count(*)::int events,count(DISTINCT session_id)::int sessions FROM observed_action_facts WHERE ($1::text IS NULL OR project_id=$1) AND ($2::uuid IS NULL OR page_id=$2) AND received_at >= $3 AND received_at < $4 AND received_at>=clock_timestamp()-interval '7 days' AND ($5::text IS NULL OR traffic_class=$5) AND ($6::text IS NULL OR ($6='PAGE_REDIRECT' AND action='PAGE_REDIRECT_ATTEMPT') OR ($6='REPLACE_CONVERSION' AND action='CTA_CLICK_OBSERVED')) GROUP BY project_id,page_id,traffic_class,action,evidence ORDER BY project_id,page_id,action`,[project,page,d.from,d.until,traffic,protection])).rows;
 const installed=(await db.query("SELECT to_regclass('observed_decision_receipts') IS NOT NULL installed")).rows[0].installed;
 const prepared_decisions=!installed||offer||checkout||provider?null:(await db.query(`SELECT project_id,page_id,traffic_class,action,policy_version,count(*)::int decisions FROM observed_decision_receipts WHERE ($1::text IS NULL OR project_id=$1) AND ($2::uuid IS NULL OR page_id=$2) AND prepared_at >= $3 AND prepared_at < $4 AND prepared_at>=clock_timestamp()-interval '7 days' AND ($5::text IS NULL OR traffic_class=$5) AND ($6::text IS NULL OR action=$6) GROUP BY project_id,page_id,traffic_class,action,policy_version`,[project,page,d.from,d.until,traffic,protection])).rows;
 const estimates:Record<string,bigint>={};
 if(observations){const clicks=new Map<string,number>();for(const row of observations)if(row.action==='CTA_CLICK_OBSERVED')clicks.set(row.project_id,(clicks.get(row.project_id)??0)+row.events);
  if(clicks.size){const assumptions=(await db.query('SELECT DISTINCT ON(project_id) project_id,ticket_minor,conversion_basis_points,currency FROM estimate_assumptions WHERE project_id=ANY($1::text[]) ORDER BY project_id,version DESC',[[...clicks.keys()]])).rows;
   for(const row of assumptions)estimates[row.currency]=(estimates[row.currency]??0n)+BigInt(clicks.get(row.project_id)!)*BigInt(row.ticket_minor)*BigInt(row.conversion_basis_points);
  }
 }
 return {financial_basis:'REPORTED_EVENTS_NOT_SETTLEMENT',settled_revenue:null,currencies,observations,prepared_decisions,attribution:'UNVERIFIED',attributed_sales:0,attributed_revenue:[],confirmed_arrivals:null,estimated_revenue:observations?Object.entries(estimates).map(([currency,n])=>({label:'ESTIMATE',currency,amount_minor_numerator:n.toString(),denominator:10000})):null,observation_retention_days:7,limitations:['Orders cannot be filtered by traffic/protection without verified attribution.','Offer/checkout/provider observation segmentation unavailable (null).','Legacy project HMAC report remains separate; do not add overlapping sources.','Full-order terminal adjustments only; partial refunds require an adapter.','Sales use earliest authenticated PAID occurrence; adjustments use earliest terminal occurrence, independently of arrival order.']};
}

// Server-side operator channel only. Never exposed by admin HTTP or logs.
export async function provisionCommerceSender(db:Pool,id:string,env:NodeJS.ProcessEnv){uuid(id);const row=(await db.query('SELECT secret_encrypted FROM commerce_connections WHERE id=$1',[id])).rows[0];if(!row)throw new TypeError('unknown connection');return decrypt(row.secret_encrypted,id,env);}
