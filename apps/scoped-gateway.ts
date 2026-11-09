import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { configuredOrigin, observe } from './detection.js';
import { classifyTraffic } from './traffic.js';
import { resolvePageContext } from './page-context.js';

// Identifiers in these routes are correlation handles, never credentials.
export function scopedGateway(db: Pool, scripts: Record<string, Buffer>) {
  let start = Date.now(), count = 0;
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    const match = /^\/i\/([0-9a-f-]{36})\/(runtime\.js|core\.js|fallback\.js|observe|observe\/fallback|entry-decision|cta-refresh)$/i.exec(req.url ?? '');
    if (!match) return false;
    res.setHeader('Access-Control-Allow-Origin','*'); res.setHeader('Cache-Control','no-store');
    if (Date.now()-start >= 60_000) { start=Date.now(); count=0; }
    if (++count > 1200) { res.writeHead(429).end(); return true; }
    const endpoint = match[2];
    if (req.method === 'GET' && scripts[endpoint]) {
      res.writeHead(200,{'Content-Type':'application/javascript; charset=utf-8','X-Content-Type-Options':'nosniff'}).end(scripts[endpoint]); return true;
    }
    if (req.method !== 'POST') { res.writeHead(405).end(); return true; }
    if (endpoint === 'entry-decision' || endpoint === 'cta-refresh') {
      // Policy evaluation is intentionally unavailable until all per-project
      // policy and URL migration checks are integrated.
      res.writeHead(200,{'Content-Type':'application/json'}).end('{"action":"OBSERVE_ONLY"}'); return true;
    }
    if (!['observe','observe/fallback'].includes(endpoint) || !/^text\/plain(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) { res.writeHead(415).end(); return true; }
    const chunks: Buffer[] = []; let size=0, rejected=false;
    req.on('data',(chunk:Buffer) => { size+=chunk.length; if (size>2048) { if (!rejected) res.writeHead(413).end(); rejected=true; chunks.length=0; } else if (!rejected) chunks.push(chunk); });
    req.on('end',() => {
      if (rejected) return;
      void (async () => {
        const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('invalid');
        const fields = input as Record<string,unknown>;
        const core = endpoint === 'observe';
        if (Object.keys(fields).sort().join(',') !== (core ? 'origin,pathname,signals' : 'origin,pathname') || typeof fields.origin !== 'string' || typeof fields.pathname !== 'string' || fields.pathname.length>1024) throw new TypeError('invalid');
        const origin=configuredOrigin(fields.origin);
        if (!req.headers.origin || configuredOrigin(req.headers.origin)!==origin) throw new TypeError('invalid');
        const url=new URL(origin+fields.pathname);
        if (url.origin!==origin || url.pathname!==fields.pathname || url.search || url.hash || !fields.pathname.startsWith('/')) throw new TypeError('invalid');
        if (core) classifyTraffic(fields.signals,origin);
        const context=await resolvePageContext(db,match[1]);
        if (!context) { res.writeHead(404).end(); return; }
        const authorized=context.urls.some(value => value.origin===origin && value.pathname===url.pathname);
        const result=await observe(db,context.project,authorized ? [origin] : [],origin,core ? 'core' : 'fallback',core ? fields.signals : undefined);
        res.writeHead(result==='capacity' ? 429 : 204).end();
      })().catch((error:unknown) => res.writeHead(error instanceof TypeError || error instanceof SyntaxError ? 400 : 503).end());
    });
    return true;
  };
}
