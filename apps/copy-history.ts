type Time = string | Date;
type Entry = {at: string; precision: 'instant' | 'day'; state: string; source: string; description: string; limitation: string};
type Input = {
  linked_evidence?:{events:{id:string;page_id:string;installation_id:string;kind:string;source:string;resource:string;alias:string|null;first_received_at:Time}[]};
  first_observed_at: Time; last_observed_at: Time;
  observation_sources: {source:string; day:string}[];
  browser_claims: {source:string; kind:string; traffic_class:string; observed_at:Time}[];
  canary_claims: {source:string; observed_at:Time}[];
  assessments: {level:string; version:string; observed_at:Time}[];
  timeline: {events:{event_type:string; source:string; provenance:string; recorded_at:Time; limitations:string; summary:Record<string,string>}[]};
  status_audit: {events:{new_status:string; justification:string; recorded_at:Time}[]};
  infrastructure: {dns:{record_type:string; state:string; changed:boolean; intervening_gap:boolean; observed_at:Time}[]};
  degradation: {inference:{state:string; observed_at:Time} | null};
  collection_gap: {last_dropped_at:Time | null};
  notification: {outbox:{state:string; sent_at:Time | null} | null; history:{attempt:number; outcome:string; started_at:Time}[]};
};
const instant = (value:Time) => new Date(value).toISOString();

// Read-only presentation of retained facts. Never imported by commercial decisions.
export function copyHistory(row:Input) {
  const entries:Entry[]=[];
  const add=(at:Time, state:string, source:string, description:string, limitation:string) => entries.push({at:instant(at),precision:'instant',state,source,description,limitation});
  for(const event of row.linked_evidence?.events??[]) add(event.first_received_at,event.kind==='original_request'?'Atestado administrativamente':'Recebido',event.source,
    (event.kind==='original_request'?'Importação de registro autorizado do original':'Contato recebido')+' | LP '+event.page_id+' | instalação '+event.installation_id+' | recurso '+event.resource+(event.alias?' | alias '+event.alias:''),
    event.kind==='original_request'?'Horário da importação, acesso original em horário desconhecido. Relação apenas pela LP; não demonstra download, clonagem ou vínculo entre visitantes.':'Hostname é alegado. Recebimento não prova execução; LP/alias públicos não autenticam operador. Deduplicação por minuto, retenção de 7 dias e capacidade podem omitir contatos.');
  add(row.first_observed_at,'Observado','gateway','Primeiro contato registrado no incidente','Recebimento de alegação de hostname; não é data de publicação, download ou identidade do operador. Canários isolados não atualizam este contato.');
  if(instant(row.last_observed_at)!==instant(row.first_observed_at)) add(row.last_observed_at,'Observado','gateway','Último contato registrado no incidente','Core/Fallback; pode haver recebimentos intermediários não preservados pela deduplicação diária.');
  for(const item of row.observation_sources) entries.push({at:String(item.day).slice(0,10),precision:'day',state:'Observado',source:item.source,description:'Fonte recebida neste dia UTC',limitation:'Presença diária, sem horário ou ordem entre fontes no mesmo dia. Core e Fallback podem vir do mesmo navegador.'});
  for(const item of row.browser_claims) add(item.observed_at,'Não verificado',item.source,'Tráfego declarado: '+item.traffic_class,'Primeiro registro retido desta combinação diária. DIRECT_UNKNOWN não identifica operador; PAID_ATTRIBUTED não comprova campanha.');
  for(const item of row.canary_claims) add(item.observed_at,'Não verificado',item.source,'Recebimento de recurso canário com Referer alegando este hostname','Referer não autenticado; não comprova download, execução, identidade ou independência. Sem Referer atribuível, o recurso não integra este caso.');
  for(const item of row.assessments) add(item.observed_at,'Inferência',item.version,'Avaliação retida: '+item.level,'Agregado diário atualizado; não reconstitui todas as avaliações nem determina outra sessão. HIGH de laboratório não é operacional.');
  for(const item of row.timeline.events) {
    const label=({first_observation:'Primeira observação',source_observed:'Fonte recebida',degradation_transition:'Transição de degradação',risk_assessment:'Avaliação de risco',dns_change:'Mudança DNS',incident_status_transition:'Classificação manual'} as Record<string,string>)[item.event_type]??item.event_type;
    const state=item.provenance==='administrator'?'Confirmado administrativamente':['gateway','infrastructure'].includes(item.provenance)?'Observado':'Inferência';
    const values=Object.entries(item.summary).filter(([key])=>['level','from','to','state','record_type','new_status','previous_status'].includes(key)).map(([key,value])=>key+': '+value).join(', ');
    add(item.recorded_at,state,item.source,'Timeline complementar: '+label+(values?' ('+values+')':''),item.limitations+' Registro complementar pode representar o mesmo fato exibido por outra fonte; não é evidência independente.');
  }
  for(const item of row.status_audit.events) add(item.recorded_at,'Confirmado administrativamente','administrador','Classificação manual: '+item.new_status+' — '+item.justification,'Confirma a ação administrativa, sem identificar operador ou alterar mitigação.');
  for(const item of row.infrastructure.dns) add(item.observed_at,item.state==='OK'||item.state==='NO_DATA'?'Observado':'Sem dados','DNS',item.record_type+': '+item.state+(item.changed?' — mudança entre respostas comparáveis':'')+(item.intervening_gap?' — lacuna entre respostas':''),'Resposta do resolver, sem identidade de visitante ou operador. TTL e validade atual desconhecidos.');
  if(row.degradation.inference) add(row.degradation.inference.observed_at,'Inferência','degradação','Última avaliação retida: '+row.degradation.inference.state,'Possível perda de camadas; ausência de sinal não comprova remoção. Estado histórico não confirma saúde atual.');
  // A project gap has no demonstrated hostname attribution: report it separately.
  if(row.notification.outbox?.sent_at) add(row.notification.outbox.sent_at,'Observado','transporte','Alerta aceito pelo transporte','Aceitação não comprova entrega na caixa postal.');
  for(const item of row.notification.history) add(item.started_at,'Observado','transporte','Tentativa '+item.attempt+': '+item.outcome,'Horário de início da tentativa; interrupção pode deixar aceitação incerta.');
  entries.sort((a,b)=>a.at.localeCompare(b.at)||a.source.localeCompare(b.source)||a.description.localeCompare(b.description));
  const first=(trafficClass:string)=>row.browser_claims.filter(item=>item.traffic_class===trafficClass).map(item=>instant(item.observed_at)).sort()[0]??null;
  const receipts=[row.first_observed_at,row.last_observed_at,...row.browser_claims.map(item=>item.observed_at),...row.canary_claims.map(item=>item.observed_at),...row.timeline.events.filter(item=>item.provenance==='gateway').map(item=>item.recorded_at)].map(instant).sort();
  return {
    first_available_receipt_at:receipts[0], last_available_receipt_at:receipts.at(-1),
    first_direct_unknown_at:first('DIRECT_UNKNOWN'), first_paid_at:first('PAID_ATTRIBUTED'),
    sources:[...new Set([...row.observation_sources.map(item=>item.source),...row.canary_claims.map(item=>item.source)])].sort(),
    chronology:entries,
    coverage:'Coleta incompleta',
    project_gap_at:row.collection_gap.last_dropped_at,
    scope:'Projeto e hostname alegado. Registros com LP/instalação explícitas vinculam contextos; agregados legados não demonstram essa relação nem vinculam visitantes.',
    limitations:[
      'Primeiro e último contato são os registros Core/Fallback do incidente; primeiros registros disponíveis podem já ter expirado em outras fontes.',
      'Fontes e tráfego: 7 dias; timeline e DNS: 30 dias, sujeitos a limites. Lacunas, retenção e deduplicação impedem reconstrução completa.',
      'Datas sem horário têm precisão de dia UTC; posição na lista não demonstra ordem dentro desse dia.',
      'Fontes podem compartilhar um navegador. Alegações contraditórias permanecem lado a lado, sem decidir qual é verdadeira.',
      'file:// só é visível quando uma transmissão chega e é aceita. Cópias offline, recursos bloqueados ou scripts removidos podem ser invisíveis.',
      'Saúde e alertas de instalação/LP não são atribuídos automaticamente a este hostname. A investigação não altera a seleção comercial.'
    ]
  };
}
