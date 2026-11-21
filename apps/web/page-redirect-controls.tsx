import {CopyRedirectRules, type CopyRedirectSettings} from './copy-redirect-rules';
import type {Page} from './admin-api';
import {emptyAllocation, formData, InputError, trafficLabels, value, type Allocation, type useOperation} from './operations';
import type {EntryPolicy, Operational} from './protection-contracts';
import type {AdminApi} from './admin-api';

export type RedirectStatus = {
  gateway: 'OPERATIONAL' | 'OBSERVATION_ONLY' | 'UNREACHABLE' | 'UNCONFIGURED';
  issue: string | null;
  rules: CopyRedirectSettings | null;
  rulesGateway: RedirectStatus['gateway'];
  entryIssue: string | null;
  entry: EntryPolicy | null;
  approvalId: string | null;
  authorization: Operational['state'];
  active: boolean;
  urlGeneration: string;
  configGeneration: string;
};

const gatewayMessages: Record<RedirectStatus['gateway'], string> = {
  OPERATIONAL: 'Gateway público em modo operacional.',
  OBSERVATION_ONLY: 'O gateway consultado está em modo de observação e mantém a navegação original.',
  UNREACHABLE: 'O gateway público não confirmou funcionamento. Confira a saúde da origem de telemetria.',
  UNCONFIGURED: 'A sonda do gateway público está indisponível. Configure ADMIN_OPERATIONAL_GATEWAY_ORIGIN no admin privado.',
};
const blockers: Record<string, string> = {
  REDIRECT_SCHEMA_REQUIRED: 'A atualização 069 do banco do AntiClone precisa ser aplicada.',
  LEGACY_STEALTH: 'Revise e salve a política para migrar a configuração de Stealth.',
  ZERO_ALLOCATION: 'Todas as classes estão em 0%. Escolha pelo menos um percentual acima de 0%.',
  DESTINATION_ON_COPY: 'Escolha um destino em outra origem. O domínio da cópia é o mesmo do destino atual.',
  OFFICIAL_COPY_ORIGIN: 'A origem registrada para a cópia consta como oficial. Informe outra origem autorizada.',
  LP_INACTIVE: 'Ative o projeto e a LP antes de configurar o redirecionamento.',
  LP_URL_REQUIRED: 'Cadastre uma única URL oficial para esta LP.',
  RUNTIME_NOT_PUBLISHED: 'Publique a instalação desta LP e atualize a situação.',
  TELEMETRY_MISMATCH: 'A origem de telemetria da revisão publicada difere do gateway operacional consultado.',
  CTA_REVIEW_REQUIRED: 'Revise a aprovação e a autorização dos CTAs vinculados a esta LP.',
};

export function PageRedirectControls({api, page, state, incidentHost, operation, refresh}: {
  api: AdminApi; page: Page; state: RedirectStatus; incidentHost?: string;
  operation: ReturnType<typeof useOperation>; refresh: () => void;
}) {
  const authorization=state.authorization;
  const current=state.entry;
  const original=page.urls.length===1 ? page.urls[0].origin+page.urls[0].pathname : '';
  const authorizedCopy=authorization ? authorization.copy_origin+authorization.copy_pathname : '';
  const replaced = state.rules?.rules.some(rule=>rule.copy_origin===authorization?.copy_origin && rule.copy_pathname===authorization.copy_pathname);
  const mismatch=incidentHost && authorization && new URL(authorization.copy_origin).hostname!==incidentHost.toLowerCase();
  const scope={project:page.project_id,page:page.id,approvalId:state.approvalId,
    revision:authorization?.revision??0,configGeneration:state.configGeneration,urlGeneration:state.urlGeneration};
  return <>
    {state.rules && <CopyRedirectRules api={api} page={page} settings={state.rules} gatewayReady={state.rulesGateway==='OPERATIONAL'}
      issue={state.issue && !['CTA_REVIEW_REQUIRED','REDIRECT_SCHEMA_REQUIRED'].includes(state.issue) ? blockers[state.issue] : null}
      operation={operation} refresh={refresh} incidentHost={incidentHost} urlGeneration={state.urlGeneration} configGeneration={state.configGeneration}/>}
    {state.gateway!=='UNCONFIGURED' && (!state.rules || current) && <details className="panel operation-section" open={!state.rules}>
    <summary>Política vinculada à LP</summary>
    <p>{gatewayMessages[state.gateway]}</p>
    {state.entryIssue && <p className="notice">{blockers[state.entryIssue]}</p>}
    {state.issue && <p className="notice">{blockers[state.issue] ?? 'A configuração desta LP exige revisão.'}</p>}
    {replaced ? <p>A regra específica da cópia tem prioridade sobre esta política de página.</p> : state.active && !mismatch ? <>
      <p><strong>Autorizado para {authorizedCopy}</strong> · versão {current?.version}</p>
      <p>O navegador aplica a decisão dentro de 150 ms. Em caso de atraso ou falha, a visita segue na página aberta.</p>
    </> : <p>{!current ? 'Sem redirecionamento vinculado a esta LP.' :
      !state.approvalId ? 'A aprovação do redirecionamento precisa ser atualizada.' :
      !authorization?.enabled ? 'Falta autorizar a origem e o caminho da cópia.' :
      mismatch ? 'O domínio deste incidente difere da autorização registrada.' :
      authorization.approval_id!==state.approvalId ? 'A autorização pertence a uma aprovação anterior.' :
      'O redirecionamento está registrado. A disponibilidade depende do gateway e do escopo acima.'}</p>}
    {current?.allocation.DIRECT_UNKNOWN===0 && <p className="notice">Direto ou desconhecido está em 0%. Uma visita direta à cópia permanece aberta.</p>}
    <form key={[state.configGeneration,authorization?.revision].join('/')} onSubmit={event=>{
      const fields=formData(event);
      const copyOrigin=value(fields,'origin');
      const copyPathname=value(fields,'pathname');
      const destination=value(fields,'destination');
      const stealth=fields.get('stealth')==='on';
      const allocation={...emptyAllocation};
      for (const key of Object.keys(allocation) as (keyof Allocation)[]) allocation[key]=Number(fields.get(key));
      if (Object.values(allocation).every(percent=>percent===0)) {
        operation.setError(new InputError('Selecione pelo menos uma classe de tráfego com percentual acima de 0%.'));
        return;
      }
      const copyUrl=new URL(copyOrigin);
      if (copyUrl.protocol!=='https:' || copyUrl.origin!==copyOrigin || copyUrl.username || copyUrl.password) {
        operation.setError(new InputError('Use uma origem HTTPS canônica para a cópia, com o caminho no campo separado.'));
        return;
      }
      const destinationUrl=new URL(destination);
      if (destinationUrl.origin===copyUrl.origin) {
        operation.setError(new InputError('O destino precisa estar em outra origem que a cópia.'));
        return;
      }
      if (destinationUrl.protocol!=='https:' || destinationUrl.username || destinationUrl.password || destinationUrl.hash) {
        operation.setError(new InputError('Informe uma URL HTTPS válida, sem credenciais nem fragmento.'));
        return;
      }
      if (incidentHost && copyUrl.hostname!==incidentHost.toLowerCase()) {
        operation.setError(new InputError('Informe a origem HTTPS do domínio deste incidente.'));
        return;
      }
      operation.review(current ? 'Revisar alterações do redirecionamento' : 'Revisar ativação do redirecionamento', <>
        <p>{copyOrigin}{copyPathname} → {destination}</p>
        <ul className="plain">{Object.entries(trafficLabels).map(([key,label])=>
          <li key={key}>{label} · {allocation[key as keyof Allocation]}%</li>)}</ul>
        <p>Stealth {stealth ? 'ligado' : 'desligado'}.</p>
      </>, async ()=>{
        const result=await api.request<{version:number}>('page-redirect',{action:'activate',...scope,
          copyOrigin,copyPathname,acknowledged:fields.get('assent')==='on',policy:{destination,allocation,stealth}});
        refresh();
        return 'Redirecionamento configurado e autorizado · v' + result.version + '.';
      }, fields);
    }}>
      <label>Destino da página<input name="destination" type="url" required maxLength={2048}
        defaultValue={current?.approved_destination ?? original}/></label>
      <fieldset className="allocation">
        <legend>Percentual por classe</legend>
        {Object.entries(trafficLabels).map(([key,label])=><label key={key}>{label}
          <select name={key} defaultValue={current?.allocation[key as keyof Allocation] ?? 0}>
            {Array.from({length:11},(_,index)=><option key={index} value={index*10}>{index*10}%</option>)}
          </select></label>)}
      </fieldset>
      <div className="filters">
        <label>Origem HTTPS da cópia<input name="origin" type="url" required
          defaultValue={(mismatch ? undefined : authorization?.copy_origin) ?? (incidentHost ? 'https://'+incidentHost : '')}/></label>
        <label>Caminho exato da cópia<input name="pathname" required maxLength={201} pattern="/(?:[A-Za-z0-9_\-]|/){0,200}"
          defaultValue={authorization?.copy_pathname ?? '/'}/></label>
      </div>
      <label className="check"><input name="stealth" type="checkbox" defaultChecked={current?.stealth ?? false}/>Aplicar Stealth</label>
      <label className="check"><input name="assent" type="checkbox" required/>Confirmo a autorização para esta cópia e reconheço que a origem observada é uma alegação.</label>
      <button className="primary" type="submit" disabled={operation.busy || state.gateway!=='OPERATIONAL' || Boolean(state.issue)}>
        {current ? 'Revisar alterações' : 'Revisar ativação'}
      </button>
    </form>
    {current && <button type="button" disabled={operation.busy || state.issue==='REDIRECT_SCHEMA_REQUIRED'} onClick={()=>
      operation.review('Desativar redirecionamento', <p>{page.name} · {authorizedCopy || current.approved_destination}</p>, async ()=>{
        await api.request('page-redirect',{action:'deactivate',...scope});
        refresh();
        return 'Redirecionamento desativado.';
      })}>Desativar redirecionamento</button>}
  </details>}
  </>;
}
