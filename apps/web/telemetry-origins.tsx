import {useState} from 'react';
import {AdminApi} from './admin-api';
import {formData, useOperation, value, type SetGuard} from './operations';
import {Failure, Loading, useQuery} from './ui';

type Entry = {origin: string; enabled: boolean; authorized: boolean};
type Pool = {installed: boolean; items: Entry[]};

export function TelemetryOrigins({api, setGuard}: {api: AdminApi; setGuard: SetGuard}) {
  const query = useQuery('telemetry-origins', signal => api.request<Pool>('telemetry-origins', undefined, signal));
  const operation = useOperation(setGuard);
  const [formVersion, resetForm] = useState(0);
  return <section className="panel" aria-labelledby="telemetry-origins-title">
    <h2 id="telemetry-origins-title">Endpoints de telemetria</h2>
    <p>Cadastre domínios próprios para receber os sinais das páginas protegidas. Após configurar DNS, HTTPS e o gateway, autorize a origem no ambiente privado e selecione-a na instalação da LP.</p>
    {operation.notice()}
    {query.error !== undefined ? <Failure error={query.error} retry={query.revalidate}/> : !query.data ? <Loading/> :
      !query.data.installed ? <p>O banco ainda precisa da migração de endpoints.</p> : <>
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
          <label>Origem HTTPS<input name="origin" type="url" required maxLength={253}
            placeholder="https://sinais.exemplo.com" autoComplete="off" spellCheck={false}/></label>
          <div><button className="primary" disabled={operation.busy} type="submit">Cadastrar endpoint</button></div>
        </form>
        {query.data.items.length === 0 ? <p className="empty">Nenhum endpoint cadastrado.</p> :
          <ul className="plain page-list">{query.data.items.map(item => <li key={item.origin}>
            <div><strong>{item.origin}</strong><small>{!item.enabled ? 'Desativado para novas revisões' :
              item.authorized ? 'Autorizado para novas revisões' : 'Aguardando autorização no ambiente privado'}</small></div>
            <button type="button" disabled={operation.busy} onClick={() => {
              const enabled = !item.enabled;
              operation.review(enabled ? 'Reativar endpoint' : 'Desativar endpoint',
                <p>{item.origin}. Revisões publicadas conservam o endereço que já usam.</p>, async () => {
                  await api.request('telemetry-origins',{action:'set-enabled',origin:item.origin,enabled});
                  query.revalidate();
                  return enabled ? 'Endpoint reativado.' : 'Endpoint desativado para novas revisões.';
                });
            }}>{item.enabled ? 'Desativar' : 'Reativar'}</button>
          </li>)}</ul>}
      </>}
  </section>;
}
