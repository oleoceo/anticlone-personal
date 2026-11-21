import {useState} from 'react';
import {Link} from 'react-router-dom';
import type {AdminApi, Page} from './admin-api';
import {useContextNavigation, projectPath} from './navigation';
import {emptyAllocation, formData, formatDate, InputError, trafficLabels, value, type Allocation, type useOperation} from './operations';

export type ProjectDefault = {revision: number; destination: string};
type ContextKey = {copy_origin: string; copy_pathname: string};
type CopyRule = ContextKey & {
  revision: number; enabled: boolean; default_revision: number | null; url_generation: string; config_generation: string;
  copy_is_official: boolean; version: number; approved_destination: string; allocation: Allocation; stealth: boolean;
};
type CopyContext = ContextKey & {
  observed_at: string; gateway_at: string | null; gateway_action: string | null; gateway_reason: string | null;
  gateway_version: number | null; older_runtime: boolean; browser_correlated: boolean; browser_phase: string | null; elapsed_ms: number | null;
};
export type CopyRedirectSettings = {projectDefault: ProjectDefault | null; rules: CopyRule[]; contexts: CopyContext[] | null};
type Operation = ReturnType<typeof useOperation>;
const keyOf = (scope: ContextKey) => scope.copy_origin + scope.copy_pathname;

export function httpsDestination(raw: string) {
  let url: URL;
  try { url=new URL(raw); } catch { throw new InputError('Informe uma URL HTTPS válida.'); }
  if (!/^https:\/\/[^/?#]/i.test(raw) || /[\s\\]/.test(raw) || url.username || url.password || url.hash || url.href.length>2048) {
    throw new InputError('Informe uma URL HTTPS válida, sem credenciais nem fragmento.');
  }
  return url.href;
}

const reasons: Record<string,string> = {
  NO_COPY_RULE:'Nenhuma regra por cópia aplicável.', RULE_DISABLED:'A regra da cópia está desativada.',
  APPROVAL_REQUIRED:'A política anterior da LP precisa de aprovação.', PAGE_INACTIVE:'A LP ou o projeto está indisponível.', REVIEW_REQUIRED:'A LP mudou e a regra precisa de nova revisão.',
  GATEWAY_OBSERVE:'O gateway estava em modo de observação.', ALLOCATION:'A visita ficou fora do percentual da sua classe.',
  RISK_POLICY:'A política de risco excluiu a visita.', CONTEXT_EXCLUDED:'A origem ou o caminho ficou fora do contexto autorizado.',
  INVALID_POLICY:'O gateway recusou a política publicada.', POLICY_INACTIVE:'A política está inativa.',
  DESTINATION_LOOP:'O destino aponta para a origem da cópia.', LEGACY_RULE:'A decisão foi produzida pela política anterior da LP.',
};
const reports: Record<string,string> = {
  OBSERVE_ONLY:'OBSERVE_ONLY recebido. A visita continuou na cópia.',
  REPLACE_CONVERSION:'REPLACE_CONVERSION recebido. A decisão se aplica aos CTAs.',
  REDIRECT_HANDOFF:'PAGE_REDIRECT recebido. O navegador iniciou a navegação.',
  PAGE_LEFT:'PAGE_REDIRECT recebido. O navegador relatou saída da cópia após iniciar a navegação.',
  LATE_REDIRECT:'PAGE_REDIRECT recebido fora do prazo. A visita continuou na cópia.',
  TIMEOUT:'O prazo de 150 ms expirou sem decisão utilizável.',
  RUNTIME_ERROR:'O runtime relatou falha ao consultar ou processar a decisão.',
  INVALID_REDIRECT:'O navegador recusou o destino ou o contexto da decisão recebida.',
  INTERACTION:'Uma interação na página cancelou o redirecionamento de entrada.',
  CONTEXT_CHANGED:'A página mudou de contexto antes da decisão.',
};

function CopyDiagnostics({copy,rule}: {copy?: CopyContext; rule?: CopyRule}) {
  return <section aria-label="Diagnóstico do redirecionamento">
    <h3>Última decisão observada</h3>
    {copy?.gateway_at ? <>
      <p>Gateway enviou <strong>{copy.gateway_action}</strong>{copy.gateway_version ? ` · v${copy.gateway_version}` : ''} · {formatDate(copy.gateway_at)}</p>
      {rule && copy.gateway_version!==null && copy.gateway_version!==rule.version && <p>A decisão pertence a uma revisão anterior.</p>}
      {copy.gateway_reason && reasons[copy.gateway_reason] && <p>{reasons[copy.gateway_reason]}</p>}
      {copy.older_runtime && <p>O pedido veio sem o marcador do runtime atual. A cópia pode estar servindo JavaScript antigo.</p>}
    </> : <p>Sem resposta de decisão registrada nesta cópia.</p>}
    {copy?.browser_phase && !copy.browser_correlated && <p>Relato de outra visita, sem decisão correlacionada.</p>}
    <p>{copy?.browser_phase ? 'Relato do navegador · '+reports[copy.browser_phase] : 'Sem relato de execução do navegador.'}
      {copy?.browser_phase && copy.elapsed_ms!==null && ` · ${copy.elapsed_ms} ms desde o início do bootstrap${['PAGE_LEFT','REDIRECT_HANDOFF'].includes(copy.browser_phase) ? ' até iniciar a navegação' : ''}`}</p>
    {copy?.browser_phase && ['PAGE_LEFT','REDIRECT_HANDOFF'].includes(copy.browser_phase) && <p>Chegada ao destino externo sem confirmação.</p>}
  </section>;
}

export function CopyRedirectRules({api,page,settings,issue,gateway,ruleGateway,operation,refresh,incidentHost,urlGeneration,configGeneration}: {
  api: AdminApi; page: Page; settings: CopyRedirectSettings; issue: string | null; gateway: string; ruleGateway: string;
  operation: Operation; refresh: () => void; incidentHost?: string; urlGeneration: string; configGeneration: string;
}) {
  const {projectDefault,rules}=settings;
  const contexts=settings.contexts ?? [];
  const candidates=new Map<string,ContextKey>(contexts.map(context=>[keyOf(context),context]));
  for (const rule of rules) if (!candidates.has(keyOf(rule))) candidates.set(keyOf(rule),rule);
  const incidentMatches=[...candidates.values()].filter(copy=>new URL(copy.copy_origin).hostname===incidentHost?.toLowerCase());
  const [selection,setSelection]=useState<string>();
  const selected=selection ?? (incidentMatches.length===1 ? keyOf(incidentMatches[0]) : candidates.size===1 && !incidentHost ? [...candidates.keys()][0] : '');
  const copy=candidates.get(selected);
  const context=contexts.find(item=>keyOf(item)===selected);
  const current=rules.find(item=>keyOf(item)===selected);
  const scope={project:page.project_id,page:page.id};
  const gatewayReady=ruleGateway==='OPERATIONAL';
  const stale=!!current && (current.url_generation!==urlGeneration || current.config_generation!==configGeneration);
  const nav=useContextNavigation();
  const eligible=!!current?.enabled && !stale && !current.copy_is_official && gatewayReady && !issue;
  return <section className="panel operation-section">
    <h2>Redirecionamento por cópia</h2>
    <p>Gateway {gateway==='OPERATIONAL' ? 'operacional' : gateway==='OBSERVATION_ONLY' ? 'em modo de observação' : 'sem disponibilidade operacional confirmada'}.</p>
    {gateway==='OPERATIONAL' && !gatewayReady && <p>O gateway ainda precisa da atualização para regras por cópia e seus diagnósticos.</p>}
    {issue && <p className="notice">{issue}</p>}
    <label>Cópia identificada<select value={copy ? selected : ''} disabled={operation.busy || !candidates.size} onChange={event=>setSelection(event.target.value)}>
      <option value="">Selecione a origem e o caminho</option>
      {[...candidates].map(([name])=><option key={name} value={name}>{name}</option>)}
    </select></label>
    {!candidates.size && <p>O AntiClone ainda precisa observar a origem e o caminho da cópia desta LP.</p>}
    {incidentHost && !incidentMatches.length && candidates.size>0 && <p>O caminho deste incidente ainda não foi observado para esta LP.</p>}
    {copy && <>
      <p>{current ? `Configuração salva · v${current.version}` : 'Sem configuração salva para esta cópia.'}</p>
      {current && <p>{eligible ? 'Regra habilitada e elegível' : !current.enabled ? 'Regra desativada' : current.copy_is_official ? 'Origem oficial excluída da mitigação' : stale ? 'Regra aguarda nova revisão da LP' : 'Regra habilitada sem elegibilidade confirmada'}</p>}
      <CopyRuleEditor key={[selected,current?.revision,projectDefault?.revision,configGeneration].join('|')}
        api={api} scope={scope} copy={copy} current={current} projectDefault={projectDefault}
        ready={gatewayReady && !issue && !current?.copy_is_official} operation={operation} refresh={refresh} urlGeneration={urlGeneration} configGeneration={configGeneration}/>
      <CopyDiagnostics copy={context} rule={current}/>
    </>}
    <Link {...nav.link(projectPath(page.project_id))}>Configurar destino padrão do projeto</Link>
  </section>;
}

function CopyRuleEditor({api,scope,copy,current,projectDefault,ready,operation,refresh,urlGeneration,configGeneration}: {
  api: AdminApi; scope: {project:string;page:string}; copy: ContextKey; current?: CopyRule; projectDefault: ProjectDefault|null;
  ready: boolean; operation: Operation; refresh: () => void; urlGeneration: string; configGeneration: string;
}) {
  const [inherited,setInherited]=useState(!!projectDefault && (!current || current.default_revision!==null));
  const [reviewing,setReviewing]=useState(false);
  const fieldsDisabled=operation.busy || reviewing;
  return <>
    <form onSubmit={async event=>{
      const fields=formData(event);
      setReviewing(true);
      try {
        const destination=inherited ? null : httpsDestination(value(fields,'destination'));
        const target=destination ?? projectDefault?.destination;
        if (!target || new URL(target).origin===copy.copy_origin) throw new InputError('Escolha um destino fora da origem da cópia.');
        const allocation={...emptyAllocation};
        for (const key of Object.keys(allocation) as (keyof Allocation)[]) allocation[key]=Number(fields.get(key));
        if (!Object.values(allocation).some(percent=>percent>0)) throw new InputError('Informe um percentual acima de 0% para pelo menos uma classe.');
        const stealth=fields.get('stealth')==='on';
        const {reviewId}=await api.request<{reviewId:string}>('page-redirect',{...scope,action:'review-copy',
          copyOrigin:copy.copy_origin,copyPathname:copy.copy_pathname,revision:current?.revision??0,
          defaultRevision:inherited ? projectDefault?.revision : null,urlGeneration,configGeneration,policy:{destination,allocation,stealth}});
        operation.review('Revisar redirecionamento da cópia', <>
          <p>Cópia {keyOf(copy)}</p><p>Destino {target}</p>
          <p>Ao confirmar, você autoriza a regra para esta origem e caminho observados.</p>
          {inherited && <p>Esta regra usa o destino padrão do projeto.</p>}
          <ul className="plain">{Object.entries(trafficLabels).map(([key,label])=><li key={key}>{label} · {allocation[key as keyof Allocation]}%</li>)}</ul>
          {stealth && <p>Stealth ligado.</p>}
        </>, async ()=>{
          await api.request('page-redirect',{...scope,action:'confirm-copy',reviewId});
          refresh();
          return 'Regra salva e habilitada.';
        },fields);
      } catch(error) { operation.setError(error); } finally { setReviewing(false); }
    }}>
      {projectDefault && <label>Destino desta regra<select value={inherited?'default':'specific'} onChange={event=>setInherited(event.target.value==='default')}>
        <option value="default">Usar o padrão do projeto</option><option value="specific">Usar outro destino para esta cópia</option>
      </select></label>}
      <label>Para onde redirecionar os visitantes{inherited ? <input value={projectDefault?.destination ?? ''} readOnly/> :
        <input name="destination" type="url" required maxLength={2048} defaultValue={current?.approved_destination}/>}</label>
      <fieldset className="allocation"><legend>Percentual por classe de tráfego</legend>
        {Object.entries(trafficLabels).map(([key,label])=><label key={key}>{label}
          <input type="number" name={key} min={0} max={100} step={10} required defaultValue={current?.allocation[key as keyof Allocation]??0}/>
        </label>)}
      </fieldset>
      <label className="check"><input name="stealth" type="checkbox" defaultChecked={current?.stealth??false}/>Aplicar Stealth</label>
      <button className="primary" type="submit" disabled={fieldsDisabled || !ready}>{current?.enabled ? 'Revisar alterações' : 'Revisar e ativar'}</button>
    </form>
    {current?.enabled && <button type="button" disabled={fieldsDisabled} onClick={()=>
      operation.review('Desativar redirecionamento da cópia', <p>{keyOf(copy)}</p>, async ()=>{
        await api.request('page-redirect',{...scope,action:'disable-copy',copyOrigin:copy.copy_origin,copyPathname:copy.copy_pathname,revision:current.revision});
        refresh();
        return 'Regra desativada.';
      })}>Desativar regra</button>}
  </>;
}
