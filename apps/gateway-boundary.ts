import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import type {TLSSocket} from 'node:tls';
import {npmFingerprints,npmPeer} from './npm-transport.js';

// Fixed, bounded process budget. Forwarded addresses are never persisted or used as identity.
export function gatewayBoundary(env: NodeJS.ProcessEnv) {
  const npm = env.GATEWAY_TRANSPORT === 'NPM_MTLS';
  const published = env.GATEWAY_TRANSPORT === 'HTTPS_PROXY' || npm;
  if(npm) npmFingerprints(env);
  if (env.GATEWAY_TRANSPORT && !published) throw Error('invalid gateway transport');
  const host = env.PUBLIC_GATEWAY_HOST;
  if (published && (!['PILOT_OBSERVE','OPERATIONAL'].includes(env.GATEWAY_MODE??'') || !host || host.length > 253 || !/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(host) || isIP(host))) throw Error('invalid HTTPS proxy configuration');
  if (!published && host) throw Error('public host requires HTTPS proxy');
  let start = Date.now(), total = 0;
  const clients = new Map<string, number>();
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    if (!published) return true;
    const peer = req.socket.remoteAddress;
    const forwarded = req.headers['x-forwarded-for'];
    const role=npm?npmPeer(req.socket as TLSSocket,env):undefined;
    if(npm && (!role || role==='monitor' && (req.method!=='GET' || req.url!=='/healthz'))) {res.writeHead(403).end();return false;}
    const sensitive=['host','x-forwarded-proto','x-forwarded-for','forwarded','x-forwarded-host','x-real-ip','cf-connecting-ip'];
    const names=req.rawHeaders.filter((_,i)=>i%2===0).map(name=>name.toLowerCase());
    const duplicate=npm && sensitive.some(name=>names.filter(value=>value===name).length>1);
    if(npm && (names.length>40 || ['forwarded','x-forwarded-host','x-real-ip','cf-connecting-ip'].some(name=>names.includes(name)))) {res.writeHead(400).end();return false;}
    if ((!npm && !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer ?? '')) || duplicate || req.headers.host !== host || req.headers['x-forwarded-proto'] !== 'https' || typeof forwarded !== 'string' || !isIP(forwarded) || req.headers.forwarded !== undefined || req.headers['x-forwarded-host'] !== undefined || npm && (req.headers['x-real-ip']!==undefined || req.headers['cf-connecting-ip']!==undefined)) {
      res.writeHead(400).end(); return false;
    }
    // Health probes have a distinct pinned credential and cannot consume visitor budgets.
    if(role==='monitor') return true;
    if (Date.now() - start >= 60_000) { start = Date.now(); total = 0; clients.clear(); }
    const count = (clients.get(forwarded) ?? 0) + 1;
    // Global budget bounds map growth, including many distinct spoofed sources.
    if (++total > 1200 || count > 120) { res.writeHead(429, {'Retry-After':'60'}).end(); return false; }
    clients.set(forwarded, count);
    return true;
  };
}
