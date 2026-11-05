import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { Conflict, getNotificationSettings, saveNotificationSettings, setNotificationPreference } from './notification-settings.js';
import { selectObservation, SelectionConflict } from './cta-inventory.js';

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
  if (req.method !== 'POST' || !['/admin/ui/login','/admin/ui/logout','/admin/ui/settings','/admin/ui/preference','/admin/ui/cta-inventory','/admin/ui/cta-selection'].includes(req.url ?? '')) { res.writeHead(404).end(); return false; }
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
    const operation=req.url === '/admin/ui/settings' ? saveNotificationSettings(db,body) : req.url === '/admin/ui/preference' ? setNotificationPreference(db,body) : req.url === '/admin/ui/cta-inventory' ? inventory(db,body) : selectObservation(db,body).then(()=>({state:'PENDING'}));
    void operation.then(result=>res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(result))).catch((error:unknown)=>res.writeHead(error instanceof Conflict || error instanceof SelectionConflict ? 409 : error instanceof TypeError ? 400 : 503).end());
  }); return false;
}

async function inventory(db: Pool, body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TypeError('invalid inventory');
  const data=body as Record<string,unknown>;
  if (Object.keys(data).sort().join(',')!=='project,surface' || typeof data.project!=='string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(data.project) || typeof data.surface!=='string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(data.surface)) throw new TypeError('invalid inventory');
  const p=await db.query('SELECT origin FROM projects WHERE id=$1',[data.project]);
  if (!p.rowCount || !['localhost','127.0.0.1'].includes(new URL(p.rows[0].origin).hostname)) throw new TypeError('invalid project');
  const result=await db.query(`SELECT c.id AS capture_id,o.id AS observation_id,o.observed_at,o.observed_url,o.visual_context,o.confidence,o.selection_allowed,p.id AS point_id,p.marker,p.kind,p.review_required,
    intent.offer AS pending_offer,intent.url AS pending_url
    FROM cta_captures c LEFT JOIN cta_observations o ON o.capture_id=c.id AND o.observed_at>=now()-interval '7 days'
    LEFT JOIN cta_points p ON p.project_id=o.project_id AND p.id=o.point_id
    LEFT JOIN LATERAL (SELECT i.offer,d.url FROM cta_selection_intents i JOIN cta_destinations d ON d.project_id=i.project_id AND d.offer=i.offer AND d.id=i.destination_id WHERE i.capture_id=c.id AND i.observation_id=o.id ORDER BY i.id DESC LIMIT 1) intent ON true
    WHERE c.project_id=$1 AND c.surface=$2 AND c.is_current ORDER BY o.id`,[data.project,data.surface]);
  const destinations=await db.query('SELECT id,offer,url FROM cta_destinations WHERE project_id=$1 ORDER BY offer,id',[data.project]);
  return {captureId:result.rows[0]?.capture_id ?? null,observations:result.rows.filter(r=>r.observation_id),destinations:destinations.rows};
}

const page = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Notificações</title><script src="/admin/ui/app.js" defer></script></head><body>
<main><h1>Notificações por e-mail</h1><p>Envio real ainda não operacional.</p><p id="message" role="status"></p>
<form id="login"><h2>Entrar</h2><label>Senha administrativa <input name="password" type="password" autocomplete="current-password" required></label><label>Código TOTP <input name="code" inputmode="numeric" autocomplete="one-time-code" required></label><button>Entrar</button></form>
<section id="settings" hidden><p>Estado: <strong id="status"></strong></p><form id="config"><label>Provedor <select name="provider"><option value="">Selecione</option><option value="brevo">Brevo</option><option value="smtp">SMTP personalizado</option></select></label><label>Host <input name="host"></label><label>Porta <input name="port" type="number" min="1" max="65535"></label><label>TLS <select name="tls_mode"><option value="">Selecione</option><option value="implicit">Implícito</option><option value="starttls">STARTTLS</option></select></label><label>Remetente <input name="sender" type="email"></label><label>Destinatário <input name="recipient" type="email"></label><button>Salvar configurações</button></form><p id="unsaved" role="status" hidden></p><button id="enable" type="button">Solicitar habilitação</button><button id="disable" type="button">Desativar solicitação</button><button id="reload" type="button">Recarregar configuração</button><button id="logout" type="button">Sair</button><section><h2>Inventário de CTAs — laboratório</h2><p>Seleção pendente não ativa redirecionamento. Conteúdo observado não é confiável.</p><form id="cta-query"><label>Projeto <input name="project" required></label><label>Superfície <input name="surface" required></label><button>Consultar CTAs</button></form><p id="capture"></p><div id="cta-list"></div><form id="cta-select" hidden><label>Destino aprovado <select name="destination" required></select></label><button>Confirmar seleção pendente</button></form><p id="cta-message" role="status"></p></section></section></main></body></html>`;

const script = String.raw`'use strict';
let csrf='', version=0, known='', status='';
const names=['provider','host','port','tls_mode','sender','recipient'];
const snapshotOf=data=>JSON.stringify(names.map(name=>String(data[name]??'')));
function hasUnsavedChanges() {return snapshotOf(Object.fromEntries(names.map(name=>[name,config.elements[name].value])))!==known}
function updateEnablement() {const dirty=hasUnsavedChanges(); el('unsaved').textContent='Salve as alterações antes de solicitar habilitação.'; el('unsaved').hidden=!dirty; el('enable').disabled=dirty||status!=='configured_disabled'}
const el=id=>document.getElementById(id), login=el('login'), config=el('config'), section=el('settings'), message=el('message');
const say=text=>{message.textContent=text};
async function request(path,body) { const r=await fetch('/admin/ui/'+path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:body===undefined?undefined:JSON.stringify(body)}); if(!r.ok) {const e=new Error();e.status=r.status;throw e} return r.status===204?null:r.json() }
async function bootstrap() {const b=await request('bootstrap'); csrf=b.csrf; login.hidden=b.authenticated; section.hidden=!b.authenticated; if(b.authenticated) await load()}
function show(data,updateFields=true) {const snapshot=snapshotOf(data); if(updateFields || known===snapshot) version=data.version; if(updateFields) {known=snapshot; for(const name of names) config.elements[name].value=data[name]??''} el('status').textContent=({incomplete:'Configuração incompleta',configured_disabled:'Configurada / desativada',enablement_requested:'Habilitação solicitada — envio não operacional'})[data.status]; status=data.status; updateEnablement(); el('disable').disabled=!data.preference_requested}
config.addEventListener('input',updateEnablement);
config.addEventListener('change',updateEnablement);
async function load() {show(await request('settings'))}
function failure(e) {say(e.status===409?'A configuração mudou em outra sessão. Seus dados foram preservados; recarregue antes de tentar novamente.':e.status===401||e.status===403?'Sessão inválida ou expirada. Recarregue a página.':e.status===400?'Verifique os dados informados.':'Não foi possível concluir a operação.')}
login.addEventListener('submit',async e=>{e.preventDefault(); try {await request('login',{password:login.elements.password.value,code:login.elements.code.value}); login.reset(); await bootstrap(); say('')} catch(err){login.elements.password.value=''; login.elements.code.value=''; say('Falha de autenticação ou acesso indisponível.')}});
config.addEventListener('submit',async e=>{e.preventDefault(); const data={version}; for(const name of ['provider','host','port','tls_mode','sender','recipient']) {const v=config.elements[name].value;data[name]=v===''?null:name==='port'?Number(v):v} section.inert=true; try {show(await request('settings',data));say('Configuração salva. Alterações desativam a solicitação de habilitação.')}catch(err){failure(err)}finally{section.inert=false}});
el('enable').addEventListener('click',async()=>{if(hasUnsavedChanges()) {updateEnablement();return} try{show(await request('preference',{enabled:true,version}),false);say('Habilitação solicitada; envio real não operacional.')}catch(err){failure(err)}});
el('disable').addEventListener('click',async()=>{try{show(await request('preference',{enabled:false}),false);say('Solicitação desativada.')}catch(err){failure(err)}});
el('reload').addEventListener('click',async()=>{try{await load();say('Configuração recarregada.')}catch(err){failure(err)}});
el('logout').addEventListener('click',async()=>{try{await request('logout',{});await bootstrap();say('Sessão encerrada.')}catch(err){failure(err)}});
let ctaData=null, ctaChoice=null, ctaScope=null;
const ctaQuery=el('cta-query'), ctaSelect=el('cta-select');
ctaQuery.addEventListener('submit',async e=>{e.preventDefault(); ctaChoice=null; ctaSelect.hidden=true; el('cta-list').replaceChildren(); el('cta-message').textContent='';
 try {ctaScope={project:ctaQuery.elements.project.value,surface:ctaQuery.elements.surface.value}; ctaData=await request('cta-inventory',ctaScope); el('capture').textContent='Captura vigente: '+(ctaData.captureId??'nenhuma');
 for(const row of ctaData.observations) {const label=document.createElement('label'), radio=document.createElement('input'), detail=document.createElement('span'); radio.type='radio'; radio.name='cta'; radio.disabled=!row.selection_allowed || row.review_required || row.kind!=='a'; radio.addEventListener('change',()=>{ctaChoice=row; ctaSelect.hidden=false});
 detail.textContent=' CTA observado | '+row.kind+' | contexto não confiável: '+(row.visual_context??'indisponível')+' | URL: '+(row.observed_url??'indisponível')+' | marcador: '+(row.marker??'ausente')+' | observação: '+row.observation_id+' | '+row.observed_at+' | confiança: '+row.confidence+' | '+(row.pending_offer?'seleção pendente: '+row.pending_offer+' — '+row.pending_url:'sem seleção nesta captura')+(row.review_required?' | revisão necessária':'')+(!row.selection_allowed?' | conflito de identificação':'')+(row.marker?' | marcador não comprova identidade':' | CTA observado, mas ainda sem identidade suficiente para substituição.'); label.append(radio,detail); el('cta-list').append(label,document.createElement('br'));}
 ctaSelect.elements.destination.replaceChildren(); for(const d of ctaData.destinations) {const option=document.createElement('option');option.value=d.id;option.textContent=d.offer+' — '+d.url;ctaSelect.elements.destination.append(option)}
 } catch(err){failure(err)} });
ctaSelect.addEventListener('submit',async e=>{e.preventDefault(); if(!ctaChoice || !ctaData) return; const d=ctaData.destinations.find(x=>x.id===ctaSelect.elements.destination.value); if(!d)return;
 try {await request('cta-selection',{...ctaScope,captureId:ctaData.captureId,observationId:ctaChoice.observation_id,pointId:ctaChoice.point_id,offer:d.offer,destinationId:d.id}); el('cta-message').textContent='Seleção PENDENTE registrada; redirecionamento não ativado.'; ctaSelect.hidden=true;} catch(err){el('cta-message').textContent=err.status===409?'Captura ou seleção indisponível; consulte novamente.':'Não foi possível registrar a seleção.'} });
bootstrap().catch(failure);`;
