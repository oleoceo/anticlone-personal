import type {Pool} from 'pg';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {createHash} from 'node:crypto';
import {resolvePageContext} from './page-context.js';
import {classifyTraffic} from './traffic.js';
import {configuredOrigin} from './detection.js';
import {recordObservedFact} from './observed-metrics.js';

// Passive, unauthenticated browser observation; never authorizes mitigation or a sale.
export function observedSessionGateway(db:Pool){
 let started=Date.now(),count=0;
 return(req:IncomingMessage,res:ServerResponse):boolean=>{
  const match=/^\/i\/([a-f0-9-]{36})\/observed-session$/.exec(req.url??'');if(!match)return false;
  res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Cache-Control','no-store');
  if(Date.now()-started>=60000){started=Date.now();count=0;}
  if(++count>120){res.writeHead(429).end();return true;}
  if(req.method!=='POST'||!/^text\/plain(?:;|$)/i.test(req.headers['content-type']??'')){res.writeHead(415).end();return true;}
  const chunks:Buffer[]=[];let size=0,rejected=false;
  req.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>1024){if(!rejected)res.writeHead(413).end();rejected=true;chunks.length=0;}else if(!rejected)chunks.push(chunk);});
  req.on('end',()=>{if(rejected)return;void(async()=>{
   const input:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));
   if(!input||typeof input!=='object'||Array.isArray(input))throw new TypeError();
   const fields=input as Record<string,unknown>;
   if(Object.keys(fields).sort().join(',')!=='session,signals'||typeof fields.session!=='string'||!/^[a-f0-9]{32}$/.test(fields.session))throw new TypeError();
   const origin=configuredOrigin(req.headers.origin??''),traffic=classifyTraffic(fields.signals,origin);
   const installed=(await db.query("SELECT to_regclass('observed_action_facts') IS NOT NULL installed")).rows[0].installed;
   if(!installed){res.writeHead(204).end();return;}
   const context=await resolvePageContext(db,match[1]);if(!context){res.writeHead(404).end();return;}
   const hex=createHash('sha256').update(context.project+'|'+context.page+'|'+fields.session).digest('hex').slice(0,32);
   const event=[hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
   await recordObservedFact(db,context.project,{page:context.page,event,session:fields.session,action:'SESSION_OBSERVED',traffic:traffic.trafficClass,version:null,evidence:'BROWSER_UNVERIFIED'});
   res.writeHead(204).end();
  })().catch((error:unknown)=>res.writeHead(error instanceof TypeError||error instanceof SyntaxError?400:503).end());});return true;
 };
}
