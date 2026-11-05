import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';

// Fixed, bounded process budget. Forwarded addresses are never persisted or used as identity.
export function gatewayBoundary(env: NodeJS.ProcessEnv) {
  const published = env.GATEWAY_TRANSPORT === 'HTTPS_PROXY';
  if (env.GATEWAY_TRANSPORT && !published) throw Error('invalid gateway transport');
  const host = env.PUBLIC_GATEWAY_HOST;
  if (published && (env.GATEWAY_MODE !== 'PILOT_OBSERVE' || !host || host.length > 253 || !/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(host) || isIP(host))) throw Error('invalid HTTPS proxy configuration');
  if (!published && host) throw Error('public host requires HTTPS proxy');
  let start = Date.now(), total = 0;
  const clients = new Map<string, number>();
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    if (!published) return true;
    const peer = req.socket.remoteAddress;
    const forwarded = req.headers['x-forwarded-for'];
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer ?? '') || req.headers.host !== host || req.headers['x-forwarded-proto'] !== 'https' || typeof forwarded !== 'string' || !isIP(forwarded) || req.headers.forwarded !== undefined || req.headers['x-forwarded-host'] !== undefined) {
      res.writeHead(400).end(); return false;
    }
    if (Date.now() - start >= 60_000) { start = Date.now(); total = 0; clients.clear(); }
    const count = (clients.get(forwarded) ?? 0) + 1;
    // Global budget bounds map growth, including many distinct spoofed sources.
    if (++total > 1200 || count > 120) { res.writeHead(429, {'Retry-After':'60'}).end(); return false; }
    clients.set(forwarded, count);
    return true;
  };
}
