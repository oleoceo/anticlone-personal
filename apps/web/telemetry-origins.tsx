import {useState} from 'react';
import {AdminApi} from './admin-api';
import {telemetryEndpointLabels} from './installation-status';
import {formData, formatDate, useOperation, value, type SetGuard} from './operations';
import {Failure, Loading, useQuery} from './ui';

type AffectedPage = {project: string; projectName: string; page: string; pageName: string; lastRevision: number; historical: boolean};
type Entry = {origin: string; enabled: boolean; authorized: boolean; state: keyof typeof telemetryEndpointLabels;
  checkedAt: string | null; affectedPages: AffectedPage[]};
type Pool = {installed: boolean; verificationAvailable: boolean; items: Entry[]};

export function TelemetryOrigins({api, setGuard}: {api: AdminApi; setGuard: SetGuard}) {
  const query = useQuery('telemetry-origins', signal => api.request<Pool>('telemetry-origins', undefined, signal));
  const operation = useOperation(setGuard);
  const [formVersion, resetForm] = useState(0);
  return <section className="panel" aria-labelledby="telemetry-origins-title">
    <h2 id="telemetry-origins-title">Endpoints de telemetria</h2>
    <p>Cadastre domínios próprios para servir a instalação e receber os sinais das LPs. Depois de provisionar e autorizar o endereço, valide DNS, HTTPS e o gateway para selecioná-lo em novas revisões.</p>
    {operation.notice()}
    {query.error !== undefined ? <Failure error={query.error} retry={query.revalidate}/> : !query.data ? <Loading/> :
      !query.data.installed ? <p>O banco ainda precisa da migração de endpoints.</p> : <>
        {!query.data.verificationAvailable && <p>A verificação de endpoints depende da migração 068.</p>}
        <form key={formVersion} onSubmit={event => {
          const fields = formData(event);
          const origin = value(fields, 'origin');
          operation.review('Cadastrar endpoint', <p>{origin}</p>, async () => {
            await api.request('telemetry-origins', {action:'register', origin});
            resetForm(previous => previous + 1);
            query.revalidate();
            return 'Endpoint cadastrado.';
          },fields);
        }}>
          <label>Origem HTTPS<input name="origin" type="url" required maxLength={270}
            placeholder="https://sinais.exemplo.com" autoComplete="off" spellCheck={false}/></label>
          <div><button className="primary" disabled={operation.busy} type="submit">Cadastrar endpoint</button></div>
        </form>
        {query.data.items.length === 0 ? <p className="empty">Nenhum endpoint cadastrado.</p> :
          <ul className="plain page-list">{query.data.items.map(item => <li key={item.origin}>
            <div><strong>{item.origin}</strong><small>{telemetryEndpointLabels[item.state]}</small>
              {item.checkedAt && <small>Última verificação · {formatDate(item.checkedAt)}</small>}
              {item.affectedPages.length > 0 && <details>
                <summary>LPs afetadas ({item.affectedPages.length})</summary>
                <ul>{item.affectedPages.map(page => <li key={page.page}>
                  {page.projectName} · {page.pageName} · revisão {page.lastRevision}{page.historical ? ' anterior' : ' atual'}
                </li>)}</ul>
              </details>}
            </div>
            <div className="action-links">
              {query.data?.verificationAvailable && item.authorized && item.enabled &&
                <button type="button" disabled={operation.busy} onClick={() => {
                  operation.review('Verificar endpoint', <p>{item.origin} · DNS, certificado HTTPS e saúde do gateway.</p>, async () => {
                    const result = await api.request<Pool>('telemetry-origins',{action:'verify',origin:item.origin});
                    query.revalidate();
                    const state = result.items.find(entry => entry.origin === item.origin)?.state;
                    return state ? telemetryEndpointLabels[state] : 'Atualize a lista de endpoints.';
                  });
                }}>Verificar endpoint</button>}
              <button type="button" disabled={operation.busy} onClick={() => {
                const enabled = !item.enabled;
                operation.review(enabled ? 'Reativar endpoint' : 'Desativar endpoint', <>
                  <p>{item.origin}. As revisões publicadas conservam seus endereços.</p>
                  {!enabled && <p>LPs com revisões neste endpoint · {item.affectedPages.length}.</p>}
                </>, async () => {
                  await api.request('telemetry-origins',{action:'set-enabled',origin:item.origin,enabled});
                  query.revalidate();
                  return enabled ? 'Endpoint reativado. Verifique-o antes de publicar.' : 'Endpoint desativado para novas revisões.';
                });
              }}>{item.enabled ? 'Desativar' : 'Reativar'}</button>
            </div>
          </li>)}</ul>}
      </>}
  </section>;
}
