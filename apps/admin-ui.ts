import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { Conflict, getNotificationSettings, saveNotificationSettings, setNotificationPreference } from './notification-settings.js';
import { approveCommercial, selectObservation, SelectionConflict } from './cta-inventory.js';
import { disableInstallation, enableInstallation, installationDiagnostic, InstallationOriginConflict } from './installation.js';
import { investigation } from './investigation.js';
import { classifyIncident, IncidentConflict } from './incident-triage.js';
import { protectionAdmin } from './protection-admin.js';
import { protectionScript } from './protection-ui.js';

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
    if (req.url === '/admin/ui/projects') {
      if (!valid) { res.writeHead(401).end(); return false; }
      void db.query('SELECT id,name FROM projects ORDER BY name,id').then(result=>res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(result.rows))).catch(()=>res.writeHead(503).end()); return false;
    }
    if (req.url === '/admin/ui/settings') {
      if (!valid) { res.writeHead(401).end(); return false; }
      void getNotificationSettings(db).then(result => res.writeHead(200, {'Content-Type':'application/json'}).end(JSON.stringify(result))).catch(() => res.writeHead(503).end()); return false;
    }
    res.writeHead(404).end(); return false;
  }
  if (req.method !== 'POST' || !['/admin/ui/protection','/admin/ui/incidents','/admin/ui/incident-status','/admin/ui/login','/admin/ui/logout','/admin/ui/settings','/admin/ui/preference','/admin/ui/cta-inventory','/admin/ui/cta-selection','/admin/ui/cta-commercial','/admin/ui/installation','/admin/ui/installation-enable','/admin/ui/installation-disable'].includes(req.url ?? '')) { res.writeHead(404).end(); return false; }
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
    const operation=req.url === '/admin/ui/protection' ? protectionAdmin(db,body) : req.url === '/admin/ui/incidents' ? incidentList(db,body) : req.url === '/admin/ui/incident-status' ? classifyIncident(db,body) : req.url === '/admin/ui/settings' ? saveNotificationSettings(db,body) : req.url === '/admin/ui/preference' ? setNotificationPreference(db,body) : req.url === '/admin/ui/cta-inventory' ? inventory(db,body) : req.url?.startsWith('/admin/ui/installation') ? installation(db,body,req.url) : req.url === '/admin/ui/cta-commercial' ? approveCommercial(db,body).then(()=>({state:'APPROVED'})) : selectObservation(db,body).then(()=>({state:'PENDING'}));
    void operation.then(result=>res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(result))).catch((error:unknown)=>res.writeHead(error instanceof IncidentConflict || error instanceof Conflict || error instanceof SelectionConflict || error instanceof InstallationOriginConflict ? 409 : error instanceof TypeError ? 400 : 503).end());
  }); return false;
}

async function incidentList(db: Pool, body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).join(',') !== 'project' || typeof (body as {project?:unknown}).project !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test((body as {project:string}).project)) throw new TypeError('invalid project');
  return investigation(db,(body as {project:string}).project);
}

async function installation(db: Pool, body: unknown, action: string) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).join(',') !== 'project' || typeof (body as {project?:unknown}).project !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test((body as {project:string}).project)) throw new TypeError('invalid project');
  const project = (body as {project:string}).project;
  return action.endsWith('-enable') ? enableInstallation(db,project) : action.endsWith('-disable') ? disableInstallation(db,project) : installationDiagnostic(db,project);
}

async function inventory(db: Pool, body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TypeError('invalid inventory');
  const data=body as Record<string,unknown>;
  if (Object.keys(data).sort().join(',')!=='project,surface' || typeof data.project!=='string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(data.project) || typeof data.surface!=='string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(data.surface)) throw new TypeError('invalid inventory');
  const p=await db.query('SELECT origin FROM projects WHERE id=$1',[data.project]);
  if (!p.rowCount || !['localhost','127.0.0.1'].includes(new URL(p.rows[0].origin).hostname)) throw new TypeError('invalid project');
  const result=await db.query(`SELECT c.id AS capture_id,o.id AS observation_id,o.observed_at,o.observed_url,o.visual_context,o.confidence,o.selection_allowed,p.id AS point_id,p.marker,p.kind,p.review_required,
    o.commercial_amount,o.commercial_currency,r.amount AS approved_amount,r.currency AS approved_currency,r.suspension,r.version AS commercial_version,m.destination_id,d.url AS mapped_url,
    (SELECT json_build_object('reason',a.reason,'approved_amount',e.approved_amount,'approved_currency',e.approved_currency,'observed_amount',e.observed_amount,'observed_currency',e.observed_currency,'capture_id',e.capture_id) FROM cta_drift_alerts a JOIN cta_commercial_alert_evidence e ON e.alert_id=a.id WHERE a.project_id=p.project_id AND a.point_id=p.id ORDER BY a.id DESC LIMIT 1) AS commercial_alert,
    intent.offer AS pending_offer,intent.url AS pending_url
    FROM cta_captures c LEFT JOIN cta_observations o ON o.capture_id=c.id AND o.observed_at>=now()-interval '7 days'
    LEFT JOIN cta_points p ON p.project_id=o.project_id AND p.id=o.point_id
    LEFT JOIN cta_mappings m ON m.project_id=p.project_id AND m.point_id=p.id
    LEFT JOIN cta_destinations d ON d.project_id=m.project_id AND d.offer=m.offer AND d.id=m.destination_id
    LEFT JOIN cta_commercial_references r ON r.project_id=p.project_id AND r.point_id=p.id
    LEFT JOIN LATERAL (SELECT i.offer,d.url FROM cta_selection_intents i JOIN cta_destinations d ON d.project_id=i.project_id AND d.offer=i.offer AND d.id=i.destination_id WHERE i.capture_id=c.id AND i.observation_id=o.id ORDER BY i.id DESC LIMIT 1) intent ON true
    WHERE c.project_id=$1 AND c.surface=$2 AND c.is_current ORDER BY o.id`,[data.project,data.surface]);
  const destinations=await db.query('SELECT id,offer,url FROM cta_destinations WHERE project_id=$1 ORDER BY offer,id',[data.project]);
  const stale=await db.query('SELECT count(*)::int AS n FROM cta_selection_intents i JOIN cta_captures c ON c.id=i.capture_id WHERE i.project_id=$1 AND i.surface=$2 AND NOT c.is_current',[data.project,data.surface]);
  const missing=await db.query(`SELECT p.marker,r.amount,r.currency,r.suspension,d.url,
    (SELECT json_build_object('reason',a.reason,'approved_amount',e.approved_amount,'approved_currency',e.approved_currency,'observed_amount',e.observed_amount,'observed_currency',e.observed_currency,'capture_id',e.capture_id) FROM cta_drift_alerts a JOIN cta_commercial_alert_evidence e ON e.alert_id=a.id WHERE a.project_id=p.project_id AND a.point_id=p.id ORDER BY a.id DESC LIMIT 1) AS alert
    FROM cta_mappings m JOIN cta_points p ON p.project_id=m.project_id AND p.id=m.point_id
    LEFT JOIN cta_commercial_references r ON r.project_id=p.project_id AND r.point_id=p.id
    JOIN cta_destinations d ON d.project_id=m.project_id AND d.offer=m.offer AND d.id=m.destination_id
    WHERE p.project_id=$1 AND p.surface=$2 AND NOT EXISTS (SELECT 1 FROM cta_captures c JOIN cta_observations o ON o.capture_id=c.id AND o.project_id=c.project_id WHERE c.project_id=p.project_id AND c.surface=p.surface AND c.is_current AND o.point_id=p.id AND o.confidence='HIGH' AND o.observed_at>=now()-interval '7 days')`,[data.project,data.surface]);
  return {captureId:result.rows[0]?.capture_id ?? null,observations:result.rows.filter(r=>r.observation_id),missing:missing.rows,destinations:destinations.rows,stale:stale.rows[0].n};
}

const page = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Notificações</title><script src="/admin/ui/app.js" defer></script></head><body>
<main><h1>Notificações por e-mail</h1><p>Envio real ainda não operacional.</p><p id="message" role="status"></p>
<form id="login"><h2>Entrar</h2><label>Senha administrativa <input name="password" type="password" autocomplete="current-password" required></label><label>Código TOTP <input name="code" inputmode="numeric" autocomplete="one-time-code" required></label><button>Entrar</button></form>
<section id="settings" hidden><p>Estado: <strong id="status"></strong></p><p id="clone-transport" role="status"></p><form id="config"><label>Provedor <select name="provider"><option value="">Selecione</option><option value="brevo">Brevo</option><option value="smtp">SMTP personalizado</option></select></label><label>Host <input name="host"></label><label>Porta <input name="port" type="number" min="1" max="65535"></label><label>TLS <select name="tls_mode"><option value="">Selecione</option><option value="implicit">Implícito</option><option value="starttls">STARTTLS</option></select></label><label>Remetente <input name="sender" type="email"></label><label>Destinatário <input name="recipient" type="email"></label><button>Salvar configurações</button></form><p id="unsaved" role="status" hidden></p><button id="enable" type="button">Solicitar habilitação</button><button id="disable" type="button">Desativar solicitação</button><button id="reload" type="button">Recarregar configuração</button><button id="logout" type="button">Sair</button><section><h2>Inventário de CTAs — laboratório</h2><p>Seleção pendente não ativa redirecionamento. Conteúdo observado não é confiável.</p><form id="cta-query"><label>Projeto <input name="project" required></label><label>Superfície <input name="surface" required></label><button>Consultar CTAs</button></form><p id="capture"></p><div id="cta-list"></div><form id="cta-select" hidden><label>Destino aprovado <select name="destination" required></select></label><button>Confirmar seleção pendente</button><button type="button" id="cta-map">Mapear CTA ao destino aprovado</button></form><p id="cta-message" role="status"></p></section></section></main></body></html>`;

const script = String.raw`'use strict';
let csrf='', version=0, known='', status='';
const names=['provider','host','port','tls_mode','sender','recipient'];
const snapshotOf=data=>JSON.stringify(names.map(name=>String(data[name]??'')));
function hasUnsavedChanges() {return snapshotOf(Object.fromEntries(names.map(name=>[name,config.elements[name].value])))!==known}
function updateEnablement() {const dirty=hasUnsavedChanges(); el('unsaved').textContent='Salve as alterações antes de solicitar habilitação.'; el('unsaved').hidden=!dirty; el('enable').disabled=dirty||status!=='configured_disabled'}
const el=id=>document.getElementById(id), login=el('login'), config=el('config'), section=el('settings'), message=el('message');
const say=text=>{message.textContent=text};
const installationSection=document.createElement('section');
installationSection.innerHTML='<h2>Instalação — diagnóstico limitado</h2><p>Informe o ID do projeto. As alegações de navegador podem ser forjadas. Não há verificação controlada; elas não validam integridade nem proteção ativa.</p><form id="installation-form"><label>ID <input name="project" required></label><button>Consultar instalação</button><button type="button" id="installation-enable">Habilitar coleta da origem principal</button><button type="button" id="installation-disable">Desabilitar coleta</button></form><pre id="installation-result"></pre>';
section.append(installationSection);
const installationForm=el('installation-form');
async function showInstallation(action) {try {const data=await request('installation'+action,{project:installationForm.elements.project.value});el('installation-result').textContent=JSON.stringify(data,null,2)} catch (error) {el('installation-result').textContent=error.status===409?'A origem do projeto mudou. A instalacao anterior foi preservada; a coleta nao foi habilitada para a nova origem.':'Consulta indisponivel ou projeto invalido.'}}
installationForm.addEventListener('submit',e=>{e.preventDefault();void showInstallation('')});
el('installation-enable').addEventListener('click',()=>void showInstallation('-enable'));
el('installation-disable').addEventListener('click',()=>void showInstallation('-disable'));
async function request(path,body) { const r=await fetch('/admin/ui/'+path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:body===undefined?undefined:JSON.stringify(body)}); if(!r.ok) {const e=new Error();e.status=r.status;throw e} return r.status===204?null:r.json() }
async function bootstrap() {const b=await request('bootstrap'); csrf=b.csrf; login.hidden=b.authenticated; section.hidden=!b.authenticated; if(b.authenticated) {await load(); try {await loadIncidentProjects()} catch {el('incident-message').textContent='Lista de projetos indisponível.'}}}
function show(data,updateFields=true) {const snapshot=snapshotOf(data); if(updateFields || known===snapshot) version=data.version; if(updateFields) {known=snapshot; for(const name of names) config.elements[name].value=data[name]??''} el('status').textContent=({incomplete:'Configuração incompleta',configured_disabled:'Configurada / desativada',enablement_requested:'Habilitação solicitada — envio não operacional'})[data.status]; el('clone-transport').textContent='Transporte de alertas de clone: '+data.clone_transport+'. Credenciais somente no ambiente privado. O estado confirma a configuração deste processo, não a conexão do gateway. Aceitação SMTP não comprova entrega na caixa postal.'; status=data.status; updateEnablement(); el('disable').disabled=!data.preference_requested}
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
const alertText=a=>a ? a.reason+' (captura '+a.capture_id+', referência '+a.approved_amount+' unidades mínimas '+a.approved_currency+', observado '+(a.observed_amount===null?'incerto':a.observed_amount+' unidades mínimas '+a.observed_currency)+')' : 'nenhum';
let ctaData=null, ctaChoice=null, ctaScope=null, ctaQueryGeneration=0;
const ctaQuery=el('cta-query'), ctaSelect=el('cta-select');
ctaQuery.addEventListener('input',()=>{++ctaQueryGeneration;ctaData=null;ctaChoice=null;ctaScope=null;ctaSelect.hidden=true;el('cta-list').replaceChildren();el('capture').textContent='';el('cta-message').textContent='Consulte o projeto e a superfície selecionados antes de mapear.'});
el('cta-map').addEventListener('click',async()=>{if(!ctaChoice || !ctaScope || ctaChoice.confidence!=='HIGH' || !ctaChoice.marker || ctaChoice.review_required || ctaChoice.destination_id)return;const d=ctaData.destinations.find(item=>item.id===ctaSelect.elements.destination.value);if(!d)return;try{await request('protection',{project:ctaScope.project,action:'map',data:{pointId:ctaChoice.point_id,offer:d.offer,destinationId:d.id}});el('cta-message').textContent='Mapeamento aprovado registrado. Consulte novamente; a política CTA controla sua aplicação.';ctaSelect.hidden=true;ctaChoice=null;}catch(error){el('cta-message').textContent='Mapeamento recusado. Consulte novamente e verifique a oferta.'}});
ctaQuery.addEventListener('submit',async e=>{e.preventDefault();const generation=++ctaQueryGeneration; ctaChoice=null; ctaSelect.hidden=true; el('cta-list').replaceChildren(); el('cta-message').textContent='';
 try {ctaScope={project:ctaQuery.elements.project.value,surface:ctaQuery.elements.surface.value};const result=await request('cta-inventory',ctaScope);if(generation!==ctaQueryGeneration)return;ctaData=result; el('capture').textContent='Captura vigente: '+(ctaData.captureId??'nenhuma')+' | Seleções pendentes de capturas anteriores, desatualizadas e sem ativação: '+ctaData.stale;
 for(const row of ctaData.observations) {const label=document.createElement('label'), radio=document.createElement('input'), detail=document.createElement('span'); radio.type='radio'; radio.name='cta'; radio.disabled=!row.selection_allowed || row.review_required || row.kind!=='a'; radio.addEventListener('change',()=>{ctaChoice=row; ctaSelect.hidden=false; el('cta-map').disabled=!!row.destination_id || !row.marker || row.confidence!=='HIGH'});
 detail.textContent=' CTA observado | '+row.kind+' | contexto não confiável: '+(row.visual_context??'indisponível')+' | URL: '+(row.observed_url??'indisponível')+' | marcador: '+(row.marker??'ausente')+' | observação: '+row.observation_id+' | '+row.observed_at+' | confiança: '+row.confidence+' | '+(row.pending_offer?'seleção pendente: '+row.pending_offer+' — '+row.pending_url:'sem seleção nesta captura')+(row.review_required?' | revisão necessária':'')+(!row.selection_allowed?' | conflito de identificação':'')+(row.marker?' | marcador não comprova identidade':' | CTA observado, mas ainda sem identidade suficiente para substituição.')+' | referência comercial: '+(row.approved_amount===null?'não protegida contra drift de preço':row.approved_amount+' unidades mínimas '+row.approved_currency)+' | observado: '+(row.commercial_amount===null?'incerto':row.commercial_amount+' unidades mínimas '+row.commercial_currency)+' | suspensão: '+(row.suspension??'nenhuma')+' | alerta: '+alertText(row.commercial_alert)+' | destino aprovado: '+(row.mapped_url??'nenhum'); label.append(radio,detail); el('cta-list').append(label,document.createElement('br'));
 if(row.review_required && row.marker && row.confidence==='HIGH' && row.destination_id) {const review=document.createElement('button');review.type='button';review.textContent='Reaprovar destino do CTA '+row.marker;review.addEventListener('click',async()=>{if(!window.confirm('Confirma a observação '+row.observation_id+' em '+row.observed_url+' e o destino aprovado '+row.mapped_url+'?'))return;try{await request('protection',{project:ctaScope.project,action:'review',data:{pointId:row.point_id,destinationId:row.destination_id,observationId:row.observation_id}});review.disabled=true;el('cta-message').textContent='Revisão do ponto registrada. Consulte novamente.'}catch{el('cta-message').textContent='Revisão recusada. Consulte a captura mais recente.'}});el('cta-list').append(review)}
 if(row.destination_id && row.commercial_amount!==null && (row.commercial_version===null || row.suspension)) {const button=document.createElement('button'); button.type='button';button.textContent='Aprovar condição comercial';button.addEventListener('click',async()=>{if(!window.confirm('Confirma a condição observada '+row.commercial_amount+' unidades mínimas '+row.commercial_currency+' e o destino aprovado '+row.mapped_url+'?'))return; try{await request('cta-commercial',{...ctaScope,captureId:row.capture_id,observationId:row.observation_id,pointId:row.point_id,destinationId:row.destination_id,amount:Number(row.commercial_amount),currency:row.commercial_currency,version:row.commercial_version??0});el('cta-message').textContent='Condição aprovada. Consulte novamente.';button.disabled=true}catch(err){el('cta-message').textContent=err.status===409?'Captura ou aprovação alterada; consulte novamente.':'Não foi possível aprovar.'}});el('cta-list').append(button,document.createElement('br'))}}
 for(const row of ctaData.missing) {const detail=document.createElement('p'); detail.textContent='Ponto ausente ou ambíguo: '+row.marker+' | referência: '+(row.amount===null?'não protegida contra drift de preço':row.amount+' unidades mínimas '+row.currency)+' | observado: incerto | suspensão: '+(row.suspension??'nenhuma')+' | alerta: '+alertText(row.alert)+' | destino aprovado: '+row.url; el('cta-list').append(detail)}
 ctaSelect.elements.destination.replaceChildren(); for(const d of ctaData.destinations) {const option=document.createElement('option');option.value=d.id;option.textContent=d.offer+' — '+d.url;ctaSelect.elements.destination.append(option)}
 } catch(err){failure(err)} });
ctaSelect.addEventListener('submit',async e=>{e.preventDefault(); if(!ctaChoice || !ctaData) return; const d=ctaData.destinations.find(x=>x.id===ctaSelect.elements.destination.value); if(!d)return;
 try {await request('cta-selection',{...ctaScope,captureId:ctaData.captureId,observationId:ctaChoice.observation_id,pointId:ctaChoice.point_id,offer:d.offer,destinationId:d.id}); el('cta-message').textContent='Seleção PENDENTE registrada; redirecionamento não ativado.'; ctaSelect.hidden=true;} catch(err){el('cta-message').textContent=err.status===409?'Captura ou seleção indisponível; consulte novamente.':'Não foi possível registrar a seleção.'} });
const incidentSection=document.createElement('section');
incidentSection.innerHTML='<h2>Incidentes</h2><p>Classificação manual não identifica o responsável e não altera a proteção. Alertas pendentes e enviados permanecem inalterados.</p><form id="incident-query"><label>Selecionar escopo <select name="project" required></select></label><button>Consultar incidentes</button></form><p id="incident-message" role="status"></p><div id="incident-list"></div>';
section.append(incidentSection);
const incidentQuery=el('incident-query');
async function loadIncidentProjects() {const projects=await request('projects'); for(const select of [incidentQuery.elements.project,el('protection-project')]) {select.replaceChildren(); for(const project of projects) {const option=document.createElement('option'); option.value=project.id; option.textContent=project.name+' ('+project.id+')'; select.append(option)}}}
incidentQuery.addEventListener('submit',async event=>{event.preventDefault(); const project=incidentQuery.elements.project.value, list=el('incident-list'); list.replaceChildren(); el('incident-message').textContent=''; try {const rows=await request('incidents',{project}); if(!rows.length) el('incident-message').textContent='Nenhum incidente observado.'; for(const row of rows) {
 const box=document.createElement('section'), heading=document.createElement('h3'), details=document.createElement('pre'), form=document.createElement('form'), select=document.createElement('select'), reason=document.createElement('input'), button=document.createElement('button');
 heading.textContent=row.host+' — '+row.status+' | primeira: '+row.first_observed_at+' | última: '+row.last_observed_at;
 details.textContent=JSON.stringify({notificacao:row.notification,timeline:row.timeline,auditoria:row.status_audit,fontes:row.observation_sources,alegacoes:row.browser_claims,canarios:row.canary_claims,avaliacoes:row.assessments,degradacao:row.degradation,dns:row.infrastructure,lacuna:row.collection_gap,limitacoes:row.limitations},null,2);
 for(const [value,label] of [['unverified','Não verificado'],['investigating','Em investigação'],['confirmed_copy','Cópia confirmada manualmente'],['false_positive','Falso positivo']]) {const option=document.createElement('option');option.value=value;option.textContent=label;option.selected=value===row.status;select.append(option)}
 reason.required=true;reason.maxLength=500;reason.placeholder='Justificativa curta';reason.setAttribute('aria-label','Justificativa');button.textContent='Registrar classificação';form.append(select,reason,button);
 form.addEventListener('submit',async e=>{e.preventDefault();try {await request('incident-status',{project,host:row.host,incident_id:row.incident_id,expected:row.status,version:row.triage_version,status:select.value,justification:reason.value});el('incident-message').textContent='Classificação e auditoria registradas. Consulte novamente.';form.remove()}catch(err){el('incident-message').textContent=err.status===409?'Incidente alterado em outra sessão; consulte novamente.':err.status===400?'Verifique o novo estado e a justificativa.':'Não foi possível registrar a classificação.'}});
 box.append(heading,details,form);list.append(box);
 }} catch(err) {el('incident-message').textContent=err.status===401||err.status===403?'Sessão inválida ou expirada.':'Consulta indisponível.'}});
bootstrap().catch(failure);` + protectionScript;
