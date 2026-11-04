import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { Conflict, getNotificationSettings, saveNotificationSettings, setNotificationPreference } from './notification-settings.js';

type Session = { expiry: number; kind: 'bearer' | 'web'; csrf: string };

// Returns true only for a validated web login, which shares the existing login path.
export function handleAdminUi(req: IncomingMessage, res: ServerResponse, db: Pool, sessions: Map<string, Session>, now: () => number, login: boolean): boolean {
  const port = req.socket.localPort;
  const origin = `http://127.0.0.1:${port}`;
  if (req.socket.localAddress !== '127.0.0.1' || req.headers.host !== `127.0.0.1:${port}`) { res.writeHead(403).end(); return false; }
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  res.setHeader('X-Frame-Options', 'DENY');
  const site = req.headers['sec-fetch-site'];
  const cookies = (req.headers.cookie ?? '').split(';').map(s => s.trim().split('='));
  const cookie = (name: string) => { const values = cookies.filter(c => c[0] === name); return values.length === 1 ? values[0][1] : undefined; };
  const token = cookie('admin_session');
  const key = token && /^[a-f0-9]{64}$/.test(token) ? createHash('sha256').update(token).digest('hex') : undefined;
  const session = key ? sessions.get(key) : undefined;
  const valid = session?.kind === 'web' && now() < session.expiry;
  if (key && session && now() >= session.expiry) sessions.delete(key);
  if (req.method === 'GET') {
    if ((req.headers.origin && req.headers.origin !== origin) || (site && !['same-origin', 'none'].includes(site))) { res.writeHead(403).end(); return false; }
    if (req.url === '/admin/ui/') { res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'}).end(page); return false; }
    if (site !== 'same-origin') { res.writeHead(403).end(); return false; }
    if (req.url === '/admin/ui/app.js') { res.writeHead(200, {'Content-Type':'text/javascript; charset=utf-8'}).end(script); return false; }
    if (req.url === '/admin/ui/bootstrap') {
      const csrf = valid ? session.csrf : randomBytes(32).toString('hex');
      if (!valid) res.setHeader('Set-Cookie', `admin_login_csrf=${csrf}; HttpOnly; SameSite=Strict; Path=/admin/ui/`);
      res.writeHead(200, {'Content-Type':'application/json'}).end(JSON.stringify({authenticated:!!valid, csrf})); return false;
    }
    if (req.url === '/admin/ui/settings') {
      if (!valid) { res.writeHead(401).end(); return false; }
      void getNotificationSettings(db).then(result => res.writeHead(200, {'Content-Type':'application/json'}).end(JSON.stringify(result))).catch(() => res.writeHead(503).end()); return false;
    }
    res.writeHead(404).end(); return false;
  }
  if (req.method !== 'POST' || !['/admin/ui/login','/admin/ui/logout','/admin/ui/settings','/admin/ui/preference'].includes(req.url ?? '')) { res.writeHead(404).end(); return false; }
  if (req.headers.origin !== origin || site !== 'same-origin' || req.headers['content-type'] !== 'application/json') { res.writeHead(403).end(); return false; }
  const expected = login ? cookie('admin_login_csrf') : valid ? session.csrf : undefined;
  if (!expected || !/^[a-f0-9]{64}$/.test(expected) || req.headers['x-csrf-token'] !== expected) { res.writeHead(403).end(); return false; }
  if (login) return true;
  if (!valid || !key) { res.writeHead(401).end(); return false; }
  if (req.url === '/admin/ui/logout') { sessions.delete(key); res.setHeader('Set-Cookie','admin_session=; HttpOnly; SameSite=Strict; Path=/admin/ui/; Max-Age=0'); res.writeHead(204).end(); return false; }
  let size=0, rejected=false; const chunks: Buffer[]=[];
  req.on('data',(chunk:Buffer)=>{ size+=chunk.length; if(size>4096) { if(!rejected) res.writeHead(413).end(); rejected=true; chunks.length=0; } else if(!rejected) chunks.push(chunk); });
  req.on('end',()=>{
    if(rejected) return;
    let body:unknown; try { body=JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.writeHead(400).end(); return; }
    const operation=req.url === '/admin/ui/settings' ? saveNotificationSettings(db,body) : setNotificationPreference(db,body);
    void operation.then(result=>res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(result))).catch((error:unknown)=>res.writeHead(error instanceof Conflict ? 409 : error instanceof TypeError ? 400 : 503).end());
  }); return false;
}

const page = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Notificações</title><script src="/admin/ui/app.js" defer></script></head><body>
<main><h1>Notificações por e-mail</h1><p>Envio real ainda não operacional.</p><p id="message" role="status"></p>
<form id="login"><h2>Entrar</h2><label>Senha administrativa <input name="password" type="password" autocomplete="current-password" required></label><label>Código TOTP <input name="code" inputmode="numeric" autocomplete="one-time-code" required></label><button>Entrar</button></form>
<section id="settings" hidden><p>Estado: <strong id="status"></strong></p><form id="config"><label>Provedor <select name="provider"><option value="">Selecione</option><option value="brevo">Brevo</option><option value="smtp">SMTP personalizado</option></select></label><label>Host <input name="host"></label><label>Porta <input name="port" type="number" min="1" max="65535"></label><label>TLS <select name="tls_mode"><option value="">Selecione</option><option value="implicit">Implícito</option><option value="starttls">STARTTLS</option></select></label><label>Remetente <input name="sender" type="email"></label><label>Destinatário <input name="recipient" type="email"></label><button>Salvar configurações</button></form><button id="enable" type="button">Solicitar habilitação</button><button id="disable" type="button">Desativar solicitação</button><button id="reload" type="button">Recarregar configuração</button><button id="logout" type="button">Sair</button></section></main></body></html>`;

const script = String.raw`'use strict';
let csrf='', version=0;
const el=id=>document.getElementById(id), login=el('login'), config=el('config'), section=el('settings'), message=el('message');
const say=text=>{message.textContent=text};
async function request(path,body) { const r=await fetch('/admin/ui/'+path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:body===undefined?undefined:JSON.stringify(body)}); if(!r.ok) {const e=new Error();e.status=r.status;throw e} return r.status===204?null:r.json() }
async function bootstrap() {const b=await request('bootstrap'); csrf=b.csrf; login.hidden=b.authenticated; section.hidden=!b.authenticated; if(b.authenticated) await load()}
function show(data) {version=data.version; el('status').textContent=({incomplete:'Configuração incompleta',configured_disabled:'Configurada / desativada',enablement_requested:'Habilitação solicitada — envio não operacional'})[data.status]; for(const name of ['provider','host','port','tls_mode','sender','recipient']) config.elements[name].value=data[name]??''; el('enable').disabled=data.status!=='configured_disabled'; el('disable').disabled=!data.preference_requested}
async function load() {show(await request('settings'))}
function failure(e) {say(e.status===409?'A configuração mudou em outra sessão. Seus dados foram preservados; recarregue antes de tentar novamente.':e.status===401||e.status===403?'Sessão inválida ou expirada. Recarregue a página.':e.status===400?'Verifique os dados informados.':'Não foi possível concluir a operação.')}
login.addEventListener('submit',async e=>{e.preventDefault(); try {await request('login',{password:login.elements.password.value,code:login.elements.code.value}); login.reset(); await bootstrap(); say('')} catch(err){login.elements.password.value=''; login.elements.code.value=''; say('Falha de autenticação ou acesso indisponível.')}});
config.addEventListener('submit',async e=>{e.preventDefault(); const data={version}; for(const name of ['provider','host','port','tls_mode','sender','recipient']) {const v=config.elements[name].value;data[name]=v===''?null:name==='port'?Number(v):v} try {show(await request('settings',data));say('Configuração salva. Alterações desativam a solicitação de habilitação.')}catch(err){failure(err)}});
el('enable').addEventListener('click',async()=>{try{show(await request('preference',{enabled:true,version}));say('Habilitação solicitada; envio real não operacional.')}catch(err){failure(err)}});
el('disable').addEventListener('click',async()=>{try{show(await request('preference',{enabled:false}));say('Solicitação desativada.')}catch(err){failure(err)}});
el('reload').addEventListener('click',async()=>{try{await load();say('Configuração recarregada.')}catch(err){failure(err)}});
el('logout').addEventListener('click',async()=>{try{await request('logout',{});await bootstrap();say('Sessão encerrada.')}catch(err){failure(err)}});
bootstrap().catch(failure);`;
