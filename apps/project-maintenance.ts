import { operationallyEligible } from './operational-eligibility.js';
import type { Pool } from 'pg';
import { recordInstallationClaim } from './installation.js';
import { cleanup } from './detection.js';
import { deliverOne } from './alerts.js';
import { optionalSchemas } from './optional-schema.js';
import { maintainDegradation } from './degradation.js';
import { OperationalObservations } from './operational-observations.js';
import { invalidateInactivity, evaluateInactivity, deliverHealth, maintainHealthHistory, reconcileOperationalEpisode, recoverOperationalSource } from './health-alerts.js';
import { authorizedHosts, realResolver, collectInfrastructure } from './infrastructure-dns.js';
import { smtpProvider } from './smtp-provider.js';
import { scopedCorrelationOrigin } from './runtime-layer-observations.js';
import {deliverProviderCta} from './cta-delivery.js';

// One serialized sweep, keyset batches, independent failure/backoff state per project.
// Paused projects retain cleanup, but cannot collect or reconcile operations.
export function projectMaintenance(db: Pool, env: NodeJS.ProcessEnv, exclude?: string) {
  const states=new Map<string,Promise<Awaited<ReturnType<typeof createState>>>>();
  const hosts=authorizedHosts(env), resolver=hosts.length ? realResolver(env.INFRASTRUCTURE_DNS_SERVER!) : undefined;
  const smtp=smtpProvider(env);
  let busy=false;
  const pageRetention=new Map<string,number>();
  async function createState() {
    const failures=new OperationalObservations();
    const optional=await optionalSchemas(db,(source,failed,code)=>failures.observe(source,failed,code));
    return {failures,optional,version:1,persisted:0,pending:0,claimAfter:new Map<string,number>(),claims:new Set<string>(),retention:0,healthRetention:0,dnsRetention:0,dnsAfter:0,dnsIndex:0,ctaAfter:0};
  }
  async function getState(id:string) {
    if (!states.has(id)) {
      if (states.size>=1000) states.delete(states.keys().next().value!);
      states.set(id,createState());
    }
    try { return await states.get(id)!; } catch(error) { states.delete(id); throw error; }
  }
  const run=async () => {
    if (busy) return;
    busy=true;
    try {
      let after='';
      for (;;) {
        const projects=await db.query('SELECT id FROM projects WHERE id>$1 ORDER BY id LIMIT 25',[after]);
        if (!projects.rowCount) break;
        for (const {id} of projects.rows as {id:string}[]) {
          after=id;
          try {
            if (Date.now()>=(pageRetention.get(id) ?? 0)) {
              const installed=await db.query("SELECT to_regclass('page_installation_signals') IS NOT NULL AS installed");
              if (installed.rows[0].installed) await db.query("DELETE FROM page_installation_signals WHERE project_id=$1 AND last_observed_at<now()-interval '7 days'",[id]);
              const aliases=await db.query("SELECT to_regclass('runtime_alias_activity') IS NOT NULL AS installed");
              if(aliases.rows[0].installed)await db.query("DELETE FROM runtime_alias_activity s USING runtime_aliases a,protected_pages p WHERE s.alias=a.alias AND a.installation_id=p.installation_id AND p.project_id=$1 AND s.last_received_at<now()-interval '7 days'",[id]);
              const checks=await db.query("SELECT to_regclass('controlled_installation_checks') IS NOT NULL AS installed");
              if(checks.rows[0].installed)await db.query("DELETE FROM controlled_installation_checks WHERE project_id=$1 AND checked_at<now()-interval '7 days'",[id]);
              const reviews=await db.query("SELECT to_regclass('notification_reviews') IS NOT NULL AS installed");
              if(reviews.rows[0].installed)await db.query("DELETE FROM notification_reviews WHERE project_id=$1 AND occurred_at<now()-interval '30 days'",[id]);
              pageRetention.set(id,Date.now()+3600_000);
            }
            if (id===exclude) continue;
            const state=await getState(id);
            const {optional,failures}=state;
            const active=await operationallyEligible(db,id);
            await optional.degradation.run('maintenance',async()=>maintainDegradation(db,id,await scopedCorrelationOrigin(db,id,env),optional.canaryDegradation.state!=='NOT_INSTALLED'));
            try { await cleanup(db,id); if (active) await deliverOne(db,id,smtp ?? Number(env.SMTP_PORT)); failures.observe('maintenance',false); }
            catch { failures.observe('maintenance',true,'UNKNOWN'); }
            if(active&&smtp&&Date.now()>=state.ctaAfter){try{await deliverProviderCta(db,id,smtp);failures.observe('cta_delivery',false);}catch{state.ctaAfter=Date.now()+60000;failures.observe('cta_delivery',true,'UNKNOWN');}}
            if (active) {
            await optional.health.run('maintenance',async()=>{
              if (state.persisted!==state.version) { const version=state.version; await invalidateInactivity(db,id,version>1); state.persisted=version; }
              await failures.reconcile(async pending=>{
                if (pending.key) await reconcileOperationalEpisode(db,id,pending.source,pending.key,pending.openedAt,pending.recoveredAt,pending.safeCode);
                else await recoverOperationalSource(db,id,pending.source,pending.openedAt);
              });
              const version=state.version;
              const current=()=>state.persisted===state.version && version===state.version && state.pending===0;
              if (current()) await evaluateInactivity(db,id,current);
              if (current()) await deliverHealth(db,id,smtp??Number(env.SMTP_PORT),current);
            });
            }
            await optional.health.run('retention',async()=>{
              if (Date.now()>=state.healthRetention) { await maintainHealthHistory(db,id); state.healthRetention=Date.now()+3600_000; }
            });
            if (Date.now()>=state.retention) {
              const done=await optional.installation.run('retention',()=>db.query("DELETE FROM installation_signals WHERE project_id=$1 AND last_observed_at<now()-interval '7 days'",[id]));
              if (done) state.retention=Date.now()+3600_000;
            }
            if (Date.now()>=state.dnsAfter) {
              try {
                const installed=await db.query("SELECT to_regclass('infrastructure_dns_observations') IS NOT NULL AS installed");
                if (installed.rows[0].installed) {
                  if (Date.now()>=state.dnsRetention) {
                    await db.query("DELETE FROM infrastructure_dns_observations WHERE project_id=$1 AND observed_at<now()-interval '30 days'",[id]);
                    state.dnsRetention=Date.now()+3600_000;
                  }
                  if (active && resolver) await collectInfrastructure(db,id,hosts[state.dnsIndex++ % hosts.length],hosts,resolver,'configured-dns:'+env.INFRASTRUCTURE_DNS_SERVER);
                }
                failures.observe('infrastructure',false);
              } catch { failures.observe('infrastructure',true,'UNKNOWN'); }
              state.dnsAfter=Date.now()+60_000;
            }
          } catch { process.stderr.write('project maintenance failed; continuing sweep\n'); }
        }
      }
    } catch { process.stderr.write('project maintenance catalog unavailable\n'); }
    finally { busy=false; }
  };
  const collect=async(id:string,page:string,origin:string,source:'core'|'fallback')=>{
    const state=await getState(id);
    state.pending++;
    let ownsClaim=false;
    try {
      const client=await db.connect();
      try {
      await client.query('BEGIN');
      if (!await operationallyEligible(client,id,page,true)) { await client.query('ROLLBACK'); return false; }
      const installed=await client.query("SELECT to_regclass('page_installation_signals') IS NOT NULL AS installed");
      if (installed.rows[0].installed) await client.query(`INSERT INTO page_installation_signals(project_id,page_id,source) VALUES($1,$2,$3) ON CONFLICT(project_id,page_id,source) DO UPDATE SET last_observed_at=clock_timestamp() WHERE page_installation_signals.last_observed_at<clock_timestamp()-interval '1 minute'`,[id,page,source]);
      await client.query('COMMIT');
      } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
      if (state.claims.has(source) || Date.now()<(state.claimAfter.get(source) ?? 0)) return state.optional.installation.state!=='DATABASE_ERROR';
      state.claims.add(source); ownsClaim=true; state.claimAfter.set(source,Date.now()+60_000);
      const claimed=await state.optional.installation.run('claim',()=>recordInstallationClaim(db,id,origin,source));
      // Core/fallback cannot manufacture the independent activity required by F45.
      if (!claimed && state.optional.installation.state==='DATABASE_ERROR') { state.version++; return false; }
      state.failures.observe('installation_claim',false);
      return true;
    } catch { state.version++; state.failures.observe('installation_claim',true,'UNKNOWN'); return false; }
    finally { state.pending--; if (ownsClaim) state.claims.delete(source); }
  };
  return Object.assign(run,{collect});
}
