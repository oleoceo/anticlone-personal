import {useState} from 'react';
import type {AdminApi, Page} from './admin-api';
import {copyUrl, httpsDestination, type ContextKey, type CopyRedirectSettings} from './copy-redirect-rules';
import {formData, InputError, type useOperation} from './operations';
import type {RedirectStatus} from './page-redirect-controls';
import {Failure, Loading, useQuery} from './ui';

type Point = {marker:string;surface:string;native_url:string;native_digest:string};
type Rule = Point & {version:number;current:boolean;enabled:boolean;destination:string;percent:number};
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
  const [selected,setSelected]=useState('');
  const points=new Map(inventory.points.map(point=>[pointKey(point),point]));
  for (const rule of inventory.ctaRules) if (!points.has(pointKey(rule))) points.set(pointKey(rule),rule);
  const point=points.get(selected);
  const rule=inventory.ctaRules.find(item=>pointKey(item)===selected);
  const observed=inventory.points.some(item=>pointKey(item)===selected);
  return <>
    <button type="button" disabled={operation.busy || pending} onClick={refresh}>Atualizar CTAs identificados</button>
    {points.size ? <label>CTA identificado<select value={selected} onChange={event=>setSelected(event.target.value)} disabled={operation.busy}>
      <option value="">Selecione um CTA</option>
      {[...points].map(([key,item])=><option key={key} value={key}>
        {[item.marker,item.surface,item.native_url].filter(Boolean).join(' · ')}
      </option>)}
    </select></label> : <p>Nenhum link de CTA identificado nesta cópia. Abra a cópia com o runtime ativo e atualize a lista.</p>}
    {point && <CtaRuleForm key={[selected,rule?.version,point.native_digest].join('|')} api={api} state={state} scope={scope}
      point={point} rule={rule} observed={observed} operation={operation} pending={pending} ready={inventory.ctaGateway==='OPERATIONAL'} refresh={refresh}/>}
  </>;
}

function CtaRuleForm({api,state,scope,point,rule,observed,operation,pending,ready,refresh}: {
  api:AdminApi;state:RedirectStatus;scope:{project:string;page:string;copyUrl:string};point:Point;rule?:Rule;observed:boolean;
  operation:ReturnType<typeof useOperation>;pending:boolean;ready:boolean;refresh:()=>void;
}) {
  const [destination,setDestination]=useState(rule?.destination ?? '');
  const [percent,setPercent]=useState(rule?.percent ?? 100);
  const identity={...scope,marker:point.marker,surface:point.surface,revision:rule?.version ?? 0};
  const busy=operation.busy || pending;
  return <>
    {rule && <p>{!rule.enabled ? 'Regra de CTA desativada' : rule.current ? 'Regra de CTA habilitada' : 'Regra de CTA aguarda nova confirmação'} · {rule.percent}%</p>}
    {!ready && <p>Gateway sem suporte operacional confirmado para CTAs por cópia.</p>}
    {!observed && <p>O CTA ainda não foi observado na captura atual.</p>}
    <form onSubmit={event=>{
      const fields=formData(event);
      try {
        if (!Number.isInteger(percent) || percent<0 || percent>100) throw new InputError('Informe um percentual de 0 a 100.');
        const target=httpsDestination(destination);
        setDestination(target);
        operation.review('Confirmar substituição de CTA', <dl className="review">
          <dt>Página clonada</dt><dd>{scope.copyUrl}</dd>
          <dt>CTA</dt><dd>{point.marker} · {point.native_url}</dd>
          <dt>Novo destino</dt><dd>{target}</dd>
          <dt>Percentual</dt><dd>{percent}%</dd>
        </dl>,async ()=>{
          await api.request('page-redirect',{...identity,action:'confirm-cta',destination:target,percent,nativeDigest:point.native_digest,
            urlGeneration:state.urlGeneration,configGeneration:state.configGeneration});
          refresh();
          return 'Regra de CTA salva e habilitada.';
        },fields,'Confirmo substituição de CTA');
      } catch(error) { operation.setError(error); }
    }}>
      <label>Novo destino do CTA<input value={destination} onChange={event=>setDestination(event.target.value)}
        type="text" inputMode="url" maxLength={2048} required/></label>
      <label>Percentual do CTA<input value={percent} onChange={event=>setPercent(Number(event.target.value))}
        type="number" min={0} max={100} required/></label>
      <button className="primary" type="submit" disabled={busy || !observed || !!state.issue || !ready}>
        {rule?.enabled ? 'Editar regra de CTA' : 'Ativar regra de CTA'}
      </button>
    </form>
    {rule?.enabled && <button type="button" disabled={busy} onClick={()=>
      operation.review('Desativar regra de CTA', <p>{point.marker} · {scope.copyUrl}</p>,async ()=>{
        await api.request('page-redirect',{...identity,action:'disable-cta'});
        refresh();
        return 'Regra de CTA desativada.';
      })}>Desativar regra de CTA</button>}
  </>;
}
