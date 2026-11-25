import {useId} from 'react';
import {copyRuleBlocker} from './copy-rule-blockers';
import {useRef, useState} from 'react';
import type {AdminApi, Page} from './admin-api';
import {copyUrl, httpsDestination, type ContextKey, type CopyRedirectSettings} from './copy-redirect-rules';
import {emptyAllocation, formData, formatDate, InputError, trafficLabels, type Allocation, type useOperation} from './operations';
import type {RedirectStatus} from './page-redirect-controls';
import {Failure, Loading, useQuery} from './ui';

type Point = {marker:string;surface:string;native_url:string|null;native_digest:string;kind?:string;evidence?:string;compatible?:boolean};
type Rule = Point & {version:number;current:boolean;enabled:boolean;destination:string;percent:number;allocation?:Allocation|null;display_name?:string|null;execution_observed_at?:string|null};
type Inventory = {available:boolean;ctaGateway:RedirectStatus['gateway'];points:Point[];ctaRules:Rule[]};
const pointKey = (point:Point) => point.surface+':'+point.marker;

export function CopyCtaControls({api,page,state,settings,incidentHost,operation}: {
  api:AdminApi; page:Page; state:RedirectStatus; settings:CopyRedirectSettings; incidentHost?:string; operation:ReturnType<typeof useOperation>;
}) {
  const copies=new Map<string,ContextKey>();
  for (const scope of [...state.ctaRuleCopies,...(settings.contexts ?? [])]) {
    try { copies.set(copyUrl(scope),scope); } catch { /* Ignore unsupported observations. */ }
  }
  const matching=[...copies.keys()].filter(url=>!incidentHost || new URL(url).hostname===incidentHost.toLowerCase());
  const [choice,setChoice]=useState<string>();
  const selected=choice ?? (matching.length===1 ? matching[0] : '');
  const scope={project:page.project_id,page:page.id,copyUrl:selected};
  const query=useQuery(selected,signal=>api.request<Inventory>('page-redirect',{...scope,action:'inspect-cta'},signal));
  return <section className="panel operation-section">
    <h2>Substituição de CTA por cópia</h2>
    <label>Página clonada<select value={selected} onChange={event=>setChoice(event.target.value)} disabled={operation.busy || !copies.size}>
      <option value="">Selecione a URL da cópia</option>
      {[...copies.keys()].map(url=><option key={url}>{url}</option>)}
    </select></label>
    {!copies.size && <p>Nenhuma URL de cópia foi observada para esta LP.</p>}
    {incidentHost && matching.length===0 && <p>O caminho deste incidente ainda não foi observado para esta LP.</p>}
    {incidentHost && matching.length>1 && <p>Há vários caminhos observados para este domínio. Selecione a URL da cópia.</p>}
    {selected && query.error!==undefined && <Failure error={query.error} retry={query.revalidate}/>}
    {selected && query.pending && !query.data && <Loading/>}
    {query.data && (query.data.available ?
      <CtaEditor key={selected} api={api} state={state} scope={scope} inventory={query.data} operation={operation}
        pending={query.pending} refresh={query.revalidate}/> : <p>Atualize o banco para configurar CTAs por cópia.</p>)}
  </section>;
}

function CtaEditor({api,state,scope,inventory,operation,pending,refresh}: {
  api:AdminApi;state:RedirectStatus;scope:{project:string;page:string;copyUrl:string};inventory:Inventory;
  operation:ReturnType<typeof useOperation>;pending:boolean;refresh:()=>void;
}) {
  const points=new Map(inventory.points.map(point=>[pointKey(point),point]));
  const rules=new Map(inventory.ctaRules.map(rule=>[pointKey(rule),rule]));
  for (const [key,rule] of rules) if (!points.has(key)) points.set(key,rule);
  return <>
    <button type="button" disabled={operation.busy || pending} onClick={refresh}>Atualizar CTAs identificados</button>
    {points.size ? [...points].map(([key,point])=><CtaCard key={key} api={api} state={state} scope={scope} point={point}
      rule={rules.get(key)} observed={inventory.points.includes(point)} operation={operation} pending={pending}
      gateway={inventory.ctaGateway} refresh={refresh}/>) :
      <p>Nenhum CTA identificado nesta cópia. Abra a cópia com o runtime ativo e atualize a lista.</p>}
  </>;
}

const traffic = Object.keys(trafficLabels) as (keyof Allocation)[];
const kinds:Record<string,string> = {link:'Link',button:'Botão JavaScript',whatsapp:'WhatsApp'};
const sources:Record<string,string> = {marker:'Marcador',inline:'Navegação declarada',attribute:'Atributo de checkout',destination:'Destino ou atributos do elemento'};
const uniform = (percent:number):Allocation => Object.fromEntries(traffic.map(key=>[key,percent])) as Allocation;
const allocationSummary = (allocation:Allocation) => traffic.map(key=>trafficLabels[key]+' '+allocation[key]+'%').join(' · ');
type CardProps = {
  api:AdminApi;state:RedirectStatus;scope:{project:string;page:string;copyUrl:string};point:Point;rule?:Rule;observed:boolean;
  operation:ReturnType<typeof useOperation>;pending:boolean;gateway:RedirectStatus['gateway'];refresh:()=>void;
};

function CtaCard(props:CardProps) {
  const {point,rule,observed,gateway}=props;
  const ready=gateway==='OPERATIONAL';
  const details=useRef<HTMLDetailsElement>(null);
  const kind=kinds[point.kind ?? 'link'];
  const name=rule?.display_name ?? (point.evidence && point.evidence!=='marker'
    ? (point.native_url && new URL(point.native_url).pathname.slice(1).replace(/\.html$/,'').replace(/[-/]/g,' ') || kind)
    : point.marker.replace(/_/g,' '));
  const compatible=observed && point.compatible!==false;
  const allocation=rule?.allocation ?? uniform(rule?.percent ?? 100);
  const hasTraffic=Object.values(allocation).some(percent=>percent>0);
  const status=rule && !rule.enabled ? 'Desativado' : !observed ? 'Identificado · sem observação recente' :
    !compatible ? 'Não compatível' : rule?.enabled && rule.current && rule.native_digest===point.native_digest && ready ? hasTraffic ? 'Ativo' : 'Compatível · sem tráfego elegível' :
    rule?.enabled ? 'Compatível · revisão pendente' : 'Compatível';
  const close=()=>{if (details.current) details.current.open=false;};
  return <details ref={details} className="panel">
    <summary aria-label={name}>
      <strong>{name}</strong> · {kind} · {status}
      <div>URL nativa · {point.native_url ?? 'Indisponível'}</div>
      <div>Destino substituto · {rule?.destination ?? 'Sem destino'}</div>
      <div>{allocationSummary(rule ? allocation : emptyAllocation)}</div>
      {rule?.execution_observed_at && <div>Execução observada no runtime · {formatDate(rule.execution_observed_at)}</div>}
    </summary>
    <CtaRuleForm key={[rule?.version,point.native_digest].join('|')} {...props} name={name} allocation={allocation} close={close}/>
  </details>;
}

function CtaRuleForm({api,state,scope,point,rule,observed,operation,pending,gateway,refresh,name,allocation,close}: CardProps & {
  name:string;allocation:Allocation;close:()=>void;
}) {
  const [displayName,setDisplayName]=useState(name.slice(0,80));
  const [destination,setDestination]=useState(rule?.destination ?? '');
  const [percentages,setPercentages]=useState(allocation);
  const identity={...scope,marker:point.marker,surface:point.surface,revision:rule?.version ?? 0};
  const busy=operation.busy || pending;
  const blockerId=useId();
  const blocker=pending ? 'Aguarde a atualização dos CTAs identificados.' :
    operation.busy ? 'Aguarde a operação administrativa em andamento.' :
    !observed ? 'Abra o caminho da cópia para gerar nova observação e atualize os CTAs identificados.' :
    point.compatible===false ? 'Selecione um CTA compatível identificado nesta cópia.' :
    copyRuleBlocker(state.issue,gateway,5);
  return <>
    <p>{point.marker}{point.surface && ' · '+point.surface} · {sources[point.evidence ?? 'marker']}</p>
    <form onSubmit={event=>{
      const fields=formData(event);
      try {
        if (!displayName.trim() || traffic.some(key=>!Number.isInteger(percentages[key]) || percentages[key]<0 || percentages[key]>100)) {
          throw new InputError('Informe um nome e percentuais de 0 a 100.');
        }
        const target=httpsDestination(destination);
        setDestination(target);
        operation.review('Confirmar substituição de CTA', <dl className="review">
          <dt>Página clonada</dt><dd>{scope.copyUrl}</dd>
          <dt>CTA</dt><dd>{displayName} · {point.native_url}</dd>
          <dt>Novo destino</dt><dd>{target}</dd>
          <dt>Percentuais</dt><dd>{allocationSummary(percentages)}</dd>
        </dl>,async ()=>{
          await api.request('page-redirect',{...identity,action:'confirm-cta',destination:target,allocation:percentages,
            displayName,nativeDigest:point.native_digest,urlGeneration:state.urlGeneration,configGeneration:state.configGeneration});
          close();
          refresh();
          return 'Regra de CTA salva e habilitada.';
        },fields,'Confirmo substituição de CTA');
      } catch(error) { operation.setError(error); }
    }}>
      <label>Nome de identificação<input value={displayName} onChange={event=>setDisplayName(event.target.value)} maxLength={80} required/></label>
      <label>URL nativa observada<input value={point.native_url ?? 'Indisponível'} readOnly/></label>
      <label>Novo destino do CTA<input value={destination} onChange={event=>setDestination(event.target.value)}
        type="text" inputMode="url" maxLength={2048} required/></label>
      <fieldset>
        <legend>Percentuais por tráfego</legend>
        {traffic.map(key=><label key={key}>{trafficLabels[key]}<input value={Number.isNaN(percentages[key]) ? '' : percentages[key]}
          onChange={event=>setPercentages({...percentages,[key]:event.target.valueAsNumber})}
          type="number" min={0} max={100} required/></label>)}
        <button type="button" onClick={()=>setPercentages(uniform(100))}>Aplicar 100% a todas</button>
      </fieldset>
      <button className="primary" type="submit" disabled={!!blocker} aria-describedby={blocker ? blockerId : undefined}>
        {rule?.enabled ? 'Editar regra' : 'Salvar e ativar'}
      </button>
      {blocker && <p id={blockerId} role="status">{blocker}</p>}
    </form>
    {rule?.enabled && <button type="button" disabled={busy} onClick={()=>
      operation.review('Desativar regra de CTA', <p>{name} · {scope.copyUrl}</p>,async ()=>{
        await api.request('page-redirect',{...identity,action:'disable-cta'});
        close();
        refresh();
        return 'Regra de CTA desativada.';
      })}>Desativar regra de CTA</button>}
    <button type="button" onClick={close}>Recolher cartão</button>
  </>;
}
