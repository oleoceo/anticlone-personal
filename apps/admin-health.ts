import { request } from 'node:http';
import type { Pool } from 'pg';
import { installationDiagnostic } from './installation.js';
import { configureHealth, healthHistory, healthSettings } from './health-alerts.js';
import { installationPrerequisites } from './runtime-distribution.js';

async function localGatewayHealth(value?: string) {
  if (!value) return {state:'NOT_CONFIGURED'};
  if (!/^\d{1,5}$/.test(value) || Number(value)<1 || Number(value)>65535) return {state:'INVALID_CONFIGURATION'};
  const state=await new Promise<string>(resolve=>{
    const req=request({hostname:'127.0.0.1',port:Number(value),path:'/healthz',agent:false,signal:AbortSignal.timeout(1500)},res=>{
      let body='';
      res.setEncoding('utf8');
      res.on('data',(chunk:string)=>{
        body+=chunk;
        if(body.length>1024) req.destroy(new Error('probe budget'));
      });
      res.on('end',()=>{
        if(res.statusCode===503) { resolve('BACKEND_UNAVAILABLE'); return; }
        try {
          const result=JSON.parse(body);
          const gateway=res.statusCode===200 && result?.status==='ready' && ['LAB','PILOT_OBSERVE','OPERATIONAL'].includes(result.mode);
          resolve(gateway?'READY':'UNEXPECTED_RESPONSE');
        } catch { resolve('UNEXPECTED_RESPONSE'); }
      });
      res.on('error',()=>resolve('UNREACHABLE'));
    });
    req.on('error',()=>resolve('UNREACHABLE'));
    req.end();
  });
  return {state,checkedAt:new Date().toISOString()};
}

export async function adminHealth(db: Pool, body: unknown, env=process.env) {
  if (!body || typeof body!=='object' || Array.isArray(body)) throw new TypeError('invalid health request');
  const value=body as Record<string,unknown>;
  const keys=Object.keys(value).sort().join(',');
  if (keys==='action' && value.action==='environment') {
    const [local, database]=await Promise.all([localGatewayHealth(env.ADMIN_GATEWAY_HEALTH_PORT),
      installationPrerequisites(db,env).catch(()=>null)]);
    return {database:database?'READY':'UNAVAILABLE',gateway:local,
      publicationIssues:database?.publicationIssues ?? null, verifierIssue:database?.verifierIssue ?? null};
  }
  if (typeof value.project!=='string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value.project)) throw new TypeError('invalid project');
  if (keys==='action,project' && value.action==='inspect') {
    const [settings,history,collection]=await Promise.all([
      healthSettings(db,value.project),healthHistory(db,value.project),installationDiagnostic(db,value.project),
    ]);
    return {settings,history,collection:collection.installation};
  }
  if (keys==='action,enabled,inactivity_seconds,operational_enabled,project' && value.action==='configure') {
    return configureHealth(db,value.project,value.enabled as boolean,value.inactivity_seconds as number,value.operational_enabled as boolean);
  }
  throw new TypeError('invalid health action');
}
