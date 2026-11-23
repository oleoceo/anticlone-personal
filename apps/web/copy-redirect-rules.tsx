import {useState} from 'react';
import type {AdminApi, Page} from './admin-api';
import {normalizeHttpsAddress} from '../https-address';
import {emptyAllocation, formData, formatDate, InputError, trafficLabels, type Allocation, type useOperation} from './operations';

export type ProjectDefault = {revision: number; destination: string};
export type ContextKey = {copy_origin: string; copy_pathname: string};
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
export const copyUrl = (scope: ContextKey) => normalizeHttpsAddress(scope.copy_origin + scope.copy_pathname);

export function httpsDestination(raw: string) {
  try { return normalizeHttpsAddress(raw); }
  catch { throw new InputError('Informe um endereço HTTPS válido, com domínio e sem credenciais.'); }
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
  const candidates=new Map<string,ContextKey>();
  for (const candidate of [...rules,...contexts]) {
    try { candidates.set(copyUrl(candidate),candidate); } catch { /* Ignore unsupported observations. */ }
  }
  const incidentMatches=[...candidates.values()].filter(copy=>new URL(copy.copy_origin).hostname===incidentHost?.toLowerCase());
  const [selection,setSelection]=useState<string>();
  const selected=selection ?? (incidentMatches.length===1 ? copyUrl(incidentMatches[0]) : candidates.size===1 && !incidentHost ? [...candidates.keys()][0] : '');
  const copy=candidates.get(selected);
  const context=contexts.find(item=>item.copy_origin===copy?.copy_origin && item.copy_pathname===copy.copy_pathname);
  const current=rules.find(item=>item.copy_origin===copy?.copy_origin && item.copy_pathname===copy.copy_pathname);
  const scope={project:page.project_id,page:page.id};
  const gatewayReady=ruleGateway==='OPERATIONAL';
  const stale=!!current && (current.url_generation!==urlGeneration || current.config_generation!==configGeneration);
  const eligible=!!current?.enabled && !stale && !current.copy_is_official && gatewayReady && !issue;
  return <section className="panel operation-section">
    <h2>Redirecionamento por cópia</h2>
    <p>Gateway {gateway==='OPERATIONAL' ? 'operacional' : gateway==='OBSERVATION_ONLY' ? 'em modo de observação' : 'sem disponibilidade operacional confirmada'}.</p>
    {gateway==='OPERATIONAL' && !gatewayReady && <p>O gateway ainda precisa da atualização para regras por cópia e seus diagnósticos.</p>}
    {issue && <p className="notice">{issue}</p>}
    <label>Página clonada<select value={copy ? selected : ''} disabled={operation.busy || !candidates.size} onChange={event=>setSelection(event.target.value)}>
      <option value="">Selecione a URL da cópia</option>
      {[...candidates].map(([name])=><option key={name} value={name}>{name}</option>)}
    </select></label>
    {!candidates.size && <p>Nenhuma URL de cópia foi observada para esta LP.</p>}
    {incidentHost && !incidentMatches.length && <p>O caminho deste incidente ainda não foi observado para esta LP.</p>}
    {incidentHost && incidentMatches.length>1 && <p>Há vários caminhos observados para este domínio. Selecione a URL da cópia.</p>}
    {copy && <>
      <p>{current ? `Configuração salva · v${current.version}` : 'Sem configuração salva para esta cópia.'}</p>
      {current && <p>{eligible ? 'Regra habilitada e elegível' : !current.enabled ? 'Regra desativada' : current.copy_is_official ? 'Origem oficial excluída da mitigação' : stale ? 'Regra aguarda nova revisão da LP' : 'Regra habilitada sem elegibilidade confirmada'}</p>}
      {current && <><p>Percentuais salvos{current.enabled ? '' : ' · inativos'}</p><AllocationSummary allocation={current.allocation}/></>}
      <CopyRuleEditor key={[selected,current?.revision,projectDefault?.revision,configGeneration].join('|')}
        api={api} scope={scope} copy={copy} current={current} projectDefault={projectDefault}
        ready={gatewayReady && !issue && !current?.copy_is_official} operation={operation} refresh={refresh} urlGeneration={urlGeneration} configGeneration={configGeneration}/>
      <CopyDiagnostics copy={context} rule={current}/>
    </>}
  </section>;
}

function CopyRuleEditor({api,scope,copy,current,projectDefault,ready,operation,refresh,urlGeneration,configGeneration}: {
  api: AdminApi; scope: {project:string;page:string}; copy: ContextKey; current?: CopyRule; projectDefault: ProjectDefault|null;
  ready: boolean; operation: Operation; refresh: () => void; urlGeneration: string; configGeneration: string;
}) {
  const [destination,setDestination]=useState(current?.approved_destination ?? projectDefault?.destination ?? '');
  const [allocation,setAllocation]=useState(current?.allocation ?? emptyAllocation);
  let preview = '';
  try { preview = httpsDestination(destination); } catch { /* Validate when submitting. */ }
  return <>
    <form onSubmit={event=>{
      const fields=formData(event);
      try {
        const target=httpsDestination(destination);
        if (new URL(target).origin===copy.copy_origin) throw new InputError('Escolha um destino fora da origem da cópia.');
        if (!Object.values(allocation).some(percent=>percent>0)) throw new InputError('Informe um percentual acima de 0% para pelo menos uma classe.');
        setDestination(target);
        void operation.run(async ()=>{
          await api.request('page-redirect',{...scope,action:'confirm-copy',copyUrl:copyUrl(copy),destination:target,
            revision:current?.revision??0,urlGeneration,configGeneration,allocation});
          refresh();
          return 'Regra salva e habilitada.';
        },fields);
      } catch(error) { operation.setError(error); }
    }}>
      <label>Redirecionar para<input name="destination" type="text" inputMode="url" required maxLength={2048}
        placeholder="exemplo.com/oferta" value={destination} onChange={event=>setDestination(event.target.value)}
        onBlur={()=>{try {setDestination(httpsDestination(destination));} catch { /* Validate on confirmation. */ }}}/></label>
      <fieldset className="allocation"><legend>Percentuais de redirecionamento</legend>
        {Object.entries(trafficLabels).map(([key,label])=><label key={key}>{label}
          <input type="number" name={key} min={0} max={100} step={10} required value={allocation[key as keyof Allocation]}
            onChange={event=>setAllocation({...allocation,[key]:Number(event.target.value)})}/>
        </label>)}
        <button type="button" disabled={operation.busy}
          onClick={()=>setAllocation({DIRECT_UNKNOWN:100,PAID_ATTRIBUTED:100,ORGANIC:100,REFERRAL:100})}>Aplicar 100% a todas</button>
      </fieldset>
      <dl className="review" aria-label="Resumo do redirecionamento">
        <dt>PÁGINA CLONADA</dt><dd>{copyUrl(copy)}</dd>
        <dt>REDIRECIONAR PARA</dt><dd>{preview || 'Informe o destino'}</dd>
        <dt>PERCENTUAIS</dt><dd><AllocationSummary allocation={allocation}/></dd>
      </dl>
      <button className="primary" type="submit" disabled={operation.busy || !ready}>CONFIRMO REDIRECIONAMENTO</button>
    </form>
    {current?.enabled && <button type="button" disabled={operation.busy} onClick={()=>
      operation.review('Desativar redirecionamento da cópia', <p>{copyUrl(copy)}</p>, async ()=>{
        await api.request('page-redirect',{...scope,action:'disable-copy',copyOrigin:copy.copy_origin,copyPathname:copy.copy_pathname,revision:current.revision});
        refresh();
        return 'Regra desativada.';
      })}>Desativar regra</button>}
  </>;
}

function AllocationSummary({allocation}: {allocation: Allocation}) {
  return <ul className="plain">{Object.entries(trafficLabels).map(([key,label])=>
    <li key={key}>{label} · {allocation[key as keyof Allocation]}%</li>)}</ul>;
}
