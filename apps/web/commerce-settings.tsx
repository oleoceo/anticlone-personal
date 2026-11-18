import {useState} from 'react';
import {Link} from 'react-router-dom';
import {AdminApi} from './admin-api';
import {conversionsPath, useContextNavigation} from './navigation';
import {DetailsData, formData, InputError, useOperation, value, type SetGuard} from './operations';
import {Failure, Loading, useQuery} from './ui';

type Model = {id: string; name: string; version: number; config: object; approved: boolean};
type Account = {id: string; account: string; model_id: string; model_version: number; version: number; endpoint: string; state: string};
type Catalog = {models: Model[]; connections: Account[]; projects: {id: string; name: string}[];
  pages: {id: string; name: string}[]; bindings: {id: string; version: number; project_id: string; page_id: string | null; connection_id: string; state: string; url: string}[];
  samples: {connection_id: string; model_version: number; received_at: string}[];
  formats: {connection_id: string; model_version: number; state: string}[]};
type Operation = ReturnType<typeof useOperation>;
const states: Record<string, string> = {TEST: 'Em teste', ACTIVE: 'Ativa', INACTIVE: 'Inativa', ARCHIVED: 'Arquivada'};

function jsonObject(fields: FormData, name: string, max: number) {
  try {
    const input = value(fields, name);
    if (new TextEncoder().encode(input).byteLength > max) throw new Error();
    const parsed: unknown = JSON.parse(input);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new InputError('Informe um objeto JSON válido dentro do limite de ' + max + ' bytes.');
  }
}

export function CommerceSettings({api, setGuard}: {api: AdminApi; setGuard: SetGuard}) {
  const catalog = useQuery('catalog', signal => api.request<Catalog>('commerce', {action: 'list'}, signal));
  const operation = useOperation(setGuard);
  const nav = useContextNavigation();
  const data = catalog.data;
  const writesUnavailable = catalog.pending || catalog.error !== undefined;
  return <>
    <section className="panel">
      <div className="panel-heading"><h2>Integrações comerciais</h2>
        <button type="button" disabled={operation.busy || catalog.pending} onClick={catalog.revalidate}>Atualizar catálogo</button></div>
      <p>Modelos descrevem o formato do evento. Cada conta tem um webhook próprio e precisa de teste autenticado antes da ativação.</p>
      {operation.notice()}
      {catalog.error !== undefined && <Failure error={catalog.error} retry={catalog.revalidate}/>}
      {data ? <Models api={api} models={data.models} operation={operation} refresh={catalog.revalidate} pending={writesUnavailable}/> :
        catalog.error === undefined && <Loading/>}
    </section>
    {data && <>
      <section className="panel">
        <h2>Contas e webhooks</h2>
        <p>Use o endereço público do gateway autorizado com o caminho mostrado. A chave de assinatura é provisionada pelo operador no ambiente privado.</p>
        {data.connections.length ? <ul className="plain evidence-list">{data.connections.map(account => <li key={account.id}>
          <AccountDetails api={api} account={account} catalog={data} operation={operation} refresh={catalog.revalidate} pending={writesUnavailable}/>
        </li>)}</ul> : <p>Nenhuma conta cadastrada.</p>}
        <details><summary>Cadastrar conta</summary>
          <form onSubmit={event => {
            const fields = formData(event);
            const [model, version] = value(fields, 'model').split(':');
            const account = value(fields, 'account');
            operation.review('Cadastrar conta de checkout', <p>{account} será cadastrada em modo de teste.</p>, async () => {
              await api.request('commerce', {action: 'connection', model, model_version: Number(version), account});
              catalog.revalidate();
              return 'Conta cadastrada em modo de teste.';
            }, fields);
          }}>
            <label>Identificador da conta<input name="account" required maxLength={64}/></label>
            <label>Modelo aprovado<select name="model" required defaultValue="">
              <option value="">Selecione</option>{data.models.filter(model => model.approved).map(model =>
                <option key={model.id + ':' + model.version} value={model.id + ':' + model.version}>{model.name} · v{model.version}</option>)}
            </select></label>
            <button type="submit" disabled={operation.busy || writesUnavailable}>Revisar conta de checkout</button>
          </form>
        </details>
      </section>
      <section className="panel">
        <h2>Vínculos de checkout</h2>
        {data.bindings.length ? <ul className="plain evidence-list">{data.bindings.map(binding => {
          const page = data.pages.find(item => item.id === binding.page_id);
          const project = data.projects.find(item => item.id === binding.project_id);
          return <li key={binding.id}><strong>{project?.name ?? 'Projeto fora do catálogo'} · {page?.name ?? (binding.page_id ? 'LP fora do catálogo' : 'Escopo do projeto')}</strong>
            <small>{binding.url} · {states[binding.state] ?? binding.state} · versão {binding.version}</small>
            {page && project && <Link {...nav.link(conversionsPath(project.id, page.id) + '/vinculos')}>Gerenciar vínculo na LP</Link>}
          </li>;
        })}</ul> : <p>Nenhum vínculo de checkout cadastrado.</p>}
        <p>Os vínculos sem LP associada permanecem disponíveis no <a href="/admin/ui/">painel anterior</a>.</p>
      </section>
    </>}
  </>;
}

function Models({api, models, operation, refresh, pending}: {
  api: AdminApi; models: Model[]; operation: Operation; refresh: () => void; pending: boolean;
}) {
  const [model, setModel] = useState<Model>();
  const [edited, setEdited] = useState(false);
  const [result, setResult] = useState<unknown>();
  const latest = models.filter(model => !models.some(other => other.id === model.id && other.version > model.version));
  const selected = model?.id ?? '';
  return <>
    <h3>Modelos de integração</h3>
    {latest.length ? <ul className="plain evidence-list">{latest.map(item =>
      <li key={item.id}><strong>{item.name}</strong> · versão {item.version} · {item.approved ? 'Aprovado' : 'Sem aprovação'}</li>)}</ul> :
      <p>Nenhum modelo cadastrado.</p>}
    <details><summary>Criar ou versionar modelo</summary>
      <label>Modelo para editar<select value={selected} disabled={edited || operation.busy || pending} onChange={event => {
        setModel(latest.find(item => item.id === event.target.value)); setResult(undefined);
      }}>
        <option value="">Novo modelo</option>{latest.map(item => <option key={item.id} value={item.id}>{item.name} · v{item.version}</option>)}
      </select></label>
      {model && <p className="muted">Versão consultada para edição · {model.version}</p>}
      <form key={selected + ':' + (model?.version ?? 0)} onChange={() => setEdited(true)} onSubmit={event => {
        const form = event.currentTarget;
        const fields = formData(event);
        const action = (event.nativeEvent as SubmitEvent).submitter?.getAttribute('value');
        if (action === 'discard') {
          operation.review('Descartar alterações do modelo', <p>Os campos voltam à configuração consultada.</p>, async () => {
            form.reset(); setEdited(false); setResult(undefined);
            setModel(latest.find(item => item.id === selected));
            return 'Alterações descartadas.';
          }, fields);
          return;
        }
        try {
          const sample = jsonObject(fields, 'sample', 2048);
          const config = action === 'inspect' ? undefined : jsonObject(fields, 'config', 10_000);
          if (action === 'inspect' || action === 'test') {
            operation.review(action === 'inspect' ? 'Conferir campos da amostra' : 'Testar interpretação da amostra',
              <p>Use apenas dados sintéticos. A consulta não envia eventos ao webhook.</p>, async () => {
                setResult(await api.request('commerce', {action, sample, ...(config ? {config} : {})}));
                return 'Resultado da amostra disponível.';
              });
            return;
          }
          const name = value(fields, 'name');
          if (!name || !config) throw new InputError('Informe o identificador e a configuração do modelo.');
          operation.review('Aprovar versão do modelo', <p>{name} · próxima versão {(model?.version ?? 0) + 1}</p>, async () => {
            const saved = await api.request<{id: string; version: number}>('commerce', {action: 'model', name, config, sample, reviewed: true,
              ...(model ? {id: model.id} : {}), expected_version: model?.version ?? 0});
            setModel({...saved, name, config, approved: true});
            setEdited(false);
            setResult(undefined);
            refresh();
            return 'Versão do modelo aprovada.';
          }, fields);
        } catch (error) { operation.setError(error); }
      }}>
        <label>Identificador do modelo<input name="name" maxLength={64} defaultValue={model?.name}/></label>
        <label>Configuração do modelo (JSON)<textarea name="config" rows={6} maxLength={10_000} defaultValue={model ? JSON.stringify(model.config, null, 2) : ''}/></label>
        <label>Amostra sintética (JSON)<textarea name="sample" required rows={4} maxLength={2048}/></label>
        <div className="action-links">
          <button type="submit" value="inspect" disabled={operation.busy || pending}>Inspecionar amostra</button>
          <button type="submit" value="test" disabled={operation.busy || pending}>Testar modelo</button>
          <button type="submit" value="model" disabled={operation.busy || pending}>Revisar aprovação do modelo</button>
          {edited && <button type="submit" value="discard" formNoValidate disabled={operation.busy}>Descartar alterações do modelo</button>}
        </div>
      </form>
      {result !== undefined && <DetailsData heading="Resultado sanitizado" data={result}/>}
    </details>
  </>;
}

function AccountDetails({api, account, catalog, operation, refresh, pending}: {api: AdminApi; account: Account;
  catalog: Catalog; operation: Operation; refresh: () => void; pending: boolean}) {
  const [copied, setCopied] = useState('');
  const [history, setHistory] = useState<unknown>();
  const tested = catalog.samples.some(sample => sample.connection_id === account.id && sample.model_version === account.model_version);
  const model = catalog.models.find(item => item.id === account.model_id && item.version === account.model_version);
  function review(label: string, body: object, description: string) {
    operation.review(label, <><p>{account.account} · revisão {account.version}</p><p>{description}</p></>, async () => {
      await api.request('commerce', {id: account.id, expected_version: account.version, ...body});
      refresh();
      return 'Alteração da conta registrada.';
    });
  }
  return <>
    <strong>{account.account} · {states[account.state] ?? account.state}</strong>
    <p>{model?.name ?? 'Modelo fora do catálogo'} · versão {account.model_version}</p>
    <p>{tested ? 'Teste autenticado recente para esta versão' : 'Sem teste autenticado recente no recorte retornado'}</p>
    <details>
      <summary>Webhook e manutenção</summary>
      <p><code>{account.endpoint}</code></p>
      <button type="button" onClick={() => {
        void navigator.clipboard.writeText(account.endpoint).then(() => setCopied('Caminho copiado.'), () => setCopied('Selecione o caminho para copiar.'));
      }}>Copiar caminho do webhook</button>
      {copied && <p role="status">{copied}</p>}
      <p>Use o modo de teste e envie uma amostra assinada pelo provedor para a versão do modelo configurada. O teste de interpretação local não substitui este recebimento autenticado.</p>
      <div className="action-links">
        {account.state !== 'ACTIVE' && <button type="button" disabled={operation.busy || pending || !tested} onClick={() =>
          review('Ativar conta', {action: 'connection-state', state: 'ACTIVE'}, 'O servidor exige amostra autenticada recente.')}>Ativar conta</button>}
        {account.state !== 'INACTIVE' && <button type="button" disabled={operation.busy || pending} onClick={() =>
          review('Desativar conta', {action: 'connection-state', state: 'INACTIVE'}, 'O webhook deixa de registrar eventos comerciais.')}>Desativar conta</button>}
        {account.state !== 'ARCHIVED' && <button type="button" disabled={operation.busy || pending} onClick={() =>
          review('Arquivar conta', {action: 'connection-state', state: 'ARCHIVED'}, 'O histórico é mantido.')}>Arquivar conta</button>}
        {account.state !== 'TEST' && <button type="button" disabled={operation.busy || pending} onClick={() =>
          review('Voltar para modo de teste', {action: 'connection-state', state: 'TEST'}, 'A conta volta ao modo de teste.')}>Colocar em teste</button>}
        <button type="button" disabled={operation.busy || pending} onClick={() =>
          review('Girar chave de assinatura', {action: 'rotate'}, 'A chave anterior perde validade e os testes autenticados são apagados. Prepare a atualização do emissor pelo canal privado.')}>Girar chave</button>
        <button type="button" disabled={operation.busy} onClick={() => operation.review('Consultar histórico da conta',
          <p>{account.account}</p>, async () => {
            setHistory(await api.request('commerce', {action: 'history', id: account.id}));
            return 'Histórico consultado.';
          })}>Consultar histórico da conta</button>
      </div>
      {history !== undefined && <DetailsData heading="Histórico comercial" data={history}/>}
      {catalog.formats.some(format => format.connection_id === account.id && format.state === 'PENDING') &&
        <p>Existe uma migração de formato pendente.</p>}
      <p>Preparar, aceitar e cancelar migração de formato continuam no <a href="/admin/ui/">painel anterior</a>.</p>
    </details>
  </>;
}
