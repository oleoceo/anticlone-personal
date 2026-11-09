import type { Pool } from 'pg';
import { recordInstallationClaim } from './installation.js';
import { recordInstallationActivity } from './health-alerts.js';
import { cleanup } from './detection.js';
import { deliverOne } from './alerts.js';
import { optionalSchemas } from './optional-schema.js';
import { maintainDegradation } from './degradation.js';
import { OperationalObservations } from './operational-observations.js';
import { invalidateInactivity, evaluateInactivity, deliverHealth, maintainHealthHistory, reconcileOperationalEpisode, recoverOperationalSource } from './health-alerts.js';
import { authorizedHosts, realResolver, collectInfrastructure } from './infrastructure-dns.js';
import { smtpProvider } from './smtp-provider.js';

// One serialized sweep, keyset batches, independent failure/backoff state per project.
// Projects have no pause/archive lifecycle yet: every persisted project is eligible.
export function projectMaintenance(db: Pool, env: NodeJS.ProcessEnv, exclude?: string) {
  const states=new Map<string,Promise<Awaited<ReturnType<typeof createState>>>>();
  const hosts=authorizedHosts(env), resolver=hosts.length ? realResolver(env.INFRASTRUCTURE_DNS_SERVER!) : undefined;
  const smtp=smtpProvider(env);
  let busy=false;
  async function createState() {
    const failures=new OperationalObservations();
    const optional=await optionalSchemas(db,(source,failed,code)=>failures.observe(source,failed,code));
    return {failures,optional,version:1,persisted:0,pending:0,claimAfter:new Map<string,number>(),claims:new Set<string>(),retention:0,dnsAfter:0,dnsIndex:0};
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
          if (id===exclude) continue;
          try {
            const state=await getState(id);
            const {optional,failures}=state;
            await optional.degradation.run('maintenance',()=>maintainDegradation(db,id,undefined,optional.canaryDegradation.state!=='NOT_INSTALLED'));
            try { await cleanup(db,id); await deliverOne(db,id,smtp ?? Number(env.SMTP_PORT)); failures.observe('maintenance',false); }
            catch { failures.observe('maintenance',true,'UNKNOWN'); }
            await optional.health.run('maintenance',async()=>{
              if (state.persisted!==state.version) { const version=state.version; await invalidateInactivity(db,id,version>1); state.persisted=version; }
              await failures.reconcile(async pending=>{
                if (pending.key) await reconcileOperationalEpisode(db,id,pending.source,pending.key,pending.openedAt,pending.recoveredAt,pending.safeCode);
                else await recoverOperationalSource(db,id,pending.source,pending.openedAt);
              });
              const version=state.version;
              const current=()=>state.persisted===state.version && version===state.version && state.pending===0;
              if (current()) await evaluateInactivity(db,id,current);
              if (!smtp && current()) await deliverHealth(db,id,Number(env.SMTP_PORT),current);
              if (Date.now()>=state.retention) await maintainHealthHistory(db,id);
            });
            if (Date.now()>=state.retention) {
              const installed=await db.query("SELECT to_regclass('page_installation_signals') IS NOT NULL AS installed");
              if (installed.rows[0].installed) await db.query("DELETE FROM page_installation_signals WHERE project_id=$1 AND last_observed_at<now()-interval '7 days'",[id]);
              const done=await optional.installation.run('retention',()=>db.query("DELETE FROM installation_signals WHERE project_id=$1 AND last_observed_at<now()-interval '7 days'",[id]));
              if (done) state.retention=Date.now()+3600_000;
            }
            if (Date.now()>=state.dnsAfter) {
              try {
                const installed=await db.query("SELECT to_regclass('infrastructure_dns_observations') IS NOT NULL AS installed");
                if (installed.rows[0].installed) {
                  await db.query("DELETE FROM infrastructure_dns_observations WHERE project_id=$1 AND observed_at<now()-interval '30 days'",[id]);
                  if (resolver) await collectInfrastructure(db,id,hosts[state.dnsIndex++ % hosts.length],hosts,resolver,'configured-dns:'+env.INFRASTRUCTURE_DNS_SERVER);
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
      const installed=await db.query("SELECT to_regclass('page_installation_signals') IS NOT NULL AS installed");
      if (installed.rows[0].installed) await db.query(`INSERT INTO page_installation_signals(project_id,page_id,source) VALUES($1,$2,$3) ON CONFLICT(project_id,page_id,source) DO UPDATE SET last_observed_at=clock_timestamp() WHERE page_installation_signals.last_observed_at<clock_timestamp()-interval '1 minute'`,[id,page,source]);
      if (state.claims.has(source) || Date.now()<(state.claimAfter.get(source) ?? 0)) return true;
      state.claims.add(source); ownsClaim=true; state.claimAfter.set(source,Date.now()+60_000);
      const claimed=await state.optional.installation.run('claim',()=>recordInstallationClaim(db,id,origin,source));
      const active=await state.optional.health.run('activity',()=>recordInstallationActivity(db,id,origin));
      if ((!claimed && state.optional.installation.state==='DATABASE_ERROR') || (!active && state.optional.health.state==='DATABASE_ERROR')) { state.version++; return false; }
      state.failures.observe('installation_claim',false);
      return true;
    } catch { state.version++; state.failures.observe('installation_claim',true,'UNKNOWN'); return false; }
    finally { state.pending--; if (ownsClaim) state.claims.delete(source); }
  };
  return Object.assign(run,{collect});
}
