import {CopyRedirectRules, type CopyRedirectSettings} from './copy-redirect-rules';
import type {Page} from './admin-api';
import type {useOperation} from './operations';
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

const blockers: Record<string,string> = {
  LP_INACTIVE:'Ative o projeto e a LP antes de ativar a regra.',
  LP_URL_REQUIRED:'Cadastre uma única URL oficial para esta LP.',
  RUNTIME_NOT_PUBLISHED:'Publique a instalação desta LP.',
  TELEMETRY_MISMATCH:'A instalação aponta para outra origem de telemetria.',
};

export function PageRedirectControls({api,page,state,incidentHost,operation,refresh}: {
  api: AdminApi; page: Page; state: RedirectStatus; incidentHost?: string;
  operation: ReturnType<typeof useOperation>; refresh: () => void;
}) {
  const authorization=state.authorization;
  return <>
    {state.rules?.contexts ? <CopyRedirectRules key={page.id+':'+(incidentHost??'')} api={api} page={page} settings={state.rules}
      gateway={state.gateway} ruleGateway={state.rulesGateway} issue={state.issue ? blockers[state.issue] ?? null : null} operation={operation} refresh={refresh}
      incidentHost={incidentHost} urlGeneration={state.urlGeneration} configGeneration={state.configGeneration}/> :
      <p className="notice">As regras por cópia observada exigem a atualização do banco.</p>}
    {state.entry && authorization && state.gateway!=='UNCONFIGURED' && <details className="panel operation-section">
      <summary>Regra anterior da LP</summary>
      <p>Cópia {authorization.copy_origin}{authorization.copy_pathname}</p>
      <p>Destino {state.entry.approved_destination}</p>
      <button type="button" disabled={operation.busy} onClick={()=>
        operation.review('Desativar regra anterior', <p>{authorization.copy_origin}{authorization.copy_pathname}</p>, async ()=>{
          await api.request('page-redirect',{action:'deactivate',project:page.project_id,page:page.id,approvalId:state.approvalId,
            revision:authorization.revision,configGeneration:state.configGeneration,urlGeneration:state.urlGeneration});
          refresh();
          return 'Regra anterior desativada.';
        })}>Desativar regra anterior</button>
    </details>}
  </>;
}
