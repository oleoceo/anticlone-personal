import {useState} from 'react';
import {Link} from 'react-router-dom';
import {AdminApi} from './admin-api';
import {conversionsPath, projectPath, useContextNavigation} from './navigation';
import {DetailsData, formData, InputError, useOperation, value, type SetGuard} from './operations';
import {Failure, Loading, useQuery} from './ui';
import type {Mapping} from '../commerce-mapping';

type Model = {id: string; name: string; version: number; config: Mapping; approved: boolean};
type Account = {id: string; account: string; model_id: string; model_version: number; version: number; endpoint: string; state: string};
type Catalog = {models: Model[]; connections: Account[]; projects: {id: string; name: string}[];
  pages: {id: string; project_id: string; name: string}[]; bindings: {id: string; version: number; project_id: string; page_id: string | null; connection_id: string; state: string; url: string}[];
  samples: {connection_id: string; model_version: number; received_at: string}[];
  formats: {connection_id: string; model_version: number; state: string}[]};
type Operation = ReturnType<typeof useOperation>;
const states: Record<string, string> = {TEST: 'Em teste', ACTIVE: 'Ativa', INACTIVE: 'Inativa', ARCHIVED: 'Arquivada'};
const fieldLabels = {event: 'Identificador do evento', order: 'Identificador do pedido', amount: 'Valor', currency: 'Moeda',
  status: 'Status do pedido', occurred: 'Horário do evento', product: 'Produto', offer: 'Oferta', checkout: 'Checkout', reference: 'Referência opcional'};
const requiredFields = ['event', 'order', 'amount', 'currency', 'status', 'occurred'];
const statusLabels = {PAID: 'Pago', PENDING: 'Pendente', CANCELLED: 'Cancelado', REFUNDED: 'Estornado', CHARGEBACK: 'Chargeback'};

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
          <AccountDetails api={api} account={account} catalog={data} setGuard={setGuard} refresh={catalog.revalidate} pending={writesUnavailable}/>
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
            <label>Identificador da conta<input name="account" required maxLength={128} pattern="[A-Za-z0-9_\-]+"/></label>
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
        {!!data.connections.length && <BindingDestination catalog={data}/>}
        {data.bindings.length ? <ul className="plain evidence-list">{data.bindings.map(binding => {
          const page = data.pages.find(item => item.id === binding.page_id);
          const project = data.projects.find(item => item.id === binding.project_id);
          return <li key={binding.id}><strong>{project?.name ?? 'Projeto fora do catálogo'} · {page?.name ?? (binding.page_id ? 'LP fora do catálogo' : 'Escopo do projeto')}</strong>
            <small>{binding.url} · {states[binding.state] ?? binding.state} · versão {binding.version}</small>
            {page && project && <Link {...nav.link(conversionsPath(project.id, page.id) + '/vinculos')}>Gerenciar vínculo na LP</Link>}
            {!binding.page_id && project && <Link {...nav.link(projectPath(project.id) + '/checkouts')}>Gerenciar vínculo no projeto</Link>}
          </li>;
        })}</ul> : <p>Nenhum vínculo de checkout cadastrado.</p>}
      </section>
    </>}
  </>;
}

function BindingDestination({catalog}: {catalog: Catalog}) {
  const nav = useContextNavigation();
  const [project, setProject] = useState('');
  const [page, setPage] = useState('');
  if (!catalog.projects.length) return <p>Cadastre um projeto antes de vincular um checkout.</p>;
  return <div className="operation-card">
    <h3>Vincular checkout a uma oferta</h3>
    <div className="filters">
      <label>Oferta para o vínculo<select value={project} onChange={event => {setProject(event.target.value); setPage('');}}>
        <option value="">Selecione</option>{catalog.projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
      <label>LP para o vínculo<select disabled={!project} value={page} onChange={event => setPage(event.target.value)}>
        <option value="">Escopo do projeto</option>{catalog.pages.filter(item => item.project_id === project).map(item =>
          <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
    </div>
    {project && <Link className="button" {...nav.link(page ? conversionsPath(project, page) + '/vinculos' : projectPath(project) + '/checkouts')}>Abrir vínculos</Link>}
  </div>;
}

function guidedMapping(fields: FormData) {
  const paths = Object.fromEntries(Object.keys(fieldLabels).map(key => [key, value(fields, 'path-' + key)]).filter(([, field]) => field));
  if (!requiredFields.every(key => paths[key]) || ![paths.product, paths.offer, paths.checkout].some(Boolean)) {
    throw new InputError('Informe os caminhos obrigatórios e pelo menos um identificador de produto, oferta ou checkout.');
  }
  const statuses = Object.keys(statusLabels).flatMap(state => value(fields, 'status-' + state).split(',').map(alias => alias.trim())
    .filter(Boolean).map(alias => [alias, state]));
  if (!statuses.some(([, state]) => state === 'PAID') || new Set(statuses.map(([alias]) => alias)).size !== statuses.length) {
    throw new InputError('Informe um status de pagamento e use cada valor do provedor uma única vez.');
  }
  return {auth: value(fields, 'auth'), fields: paths, statuses: Object.fromEntries(statuses),
    money: {unit: value(fields, 'unit'), exponent: Number(fields.get('exponent'))}};
}

function Models({api, models, operation, refresh, pending}: {
  api: AdminApi; models: Model[]; operation: Operation; refresh: () => void; pending: boolean;
}) {
  const [model, setModel] = useState<Model>();
  const [edited, setEdited] = useState(false);
  const [editor, setEditor] = useState('guided');
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
      <label>Editor do modelo<select value={editor} disabled={edited || operation.busy || pending}
        onChange={event => setEditor(event.target.value)}>
        <option value="guided">Campos do modelo</option><option value="json">JSON avançado</option>
      </select></label>
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
          const config = action === 'inspect' ? undefined : editor === 'guided' ? guidedMapping(fields) : jsonObject(fields, 'config', 10_000);
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
            setModel({...saved, name, config: config as Mapping, approved: true});
            setEdited(false);
            setResult(undefined);
            refresh();
            return 'Versão do modelo aprovada.';
          }, fields);
        } catch (error) { operation.setError(error); }
      }}>
        <label>Identificador do modelo<input name="name" maxLength={128} pattern="[A-Za-z0-9_\-]+" defaultValue={model?.name}/></label>
        <MappingFields config={model?.config} hidden={editor !== 'guided'}/>
        <label hidden={editor !== 'json'}>Configuração do modelo (JSON)<textarea name="config" disabled={editor !== 'json'} rows={6} maxLength={10_000}
          defaultValue={model?.config ? JSON.stringify(model.config, null, 2) : ''}/></label>
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

function MappingFields({config, hidden}: {config?: Mapping; hidden: boolean}) {
  return <fieldset className="binding-fields" hidden={hidden} disabled={hidden}>
    <legend>Formato Custom</legend>
    <p className="muted">Informe os nomes que o seu provedor usa. Para objetos aninhados, use caminhos como <code>data.order_id</code>.</p>
    <label>Assinatura da conta<select name="auth" defaultValue={config?.auth ?? 'HMAC_SHA256_TIMESTAMP'}>
      <option value="HMAC_SHA256_TIMESTAMP">HMAC SHA-256 com timestamp</option><option value="HMAC_SHA512_TIMESTAMP">HMAC SHA-512 com timestamp</option>
    </select></label>
    <div className="filters">{Object.entries(fieldLabels).map(([key, label]) => <label key={key}>Caminho · {label}
      <input name={'path-' + key} autoComplete="off" maxLength={160}
        defaultValue={config ? config.fields[key as keyof Mapping['fields']] ?? '' : requiredFields.includes(key) ? key : ''}/>
    </label>)}</div>
    <div className="filters">{Object.entries(statusLabels).map(([key, label]) => <label key={key}>Status do provedor · {label}
      <input name={'status-' + key} autoComplete="off" maxLength={1342}
        defaultValue={config ? Object.keys(config.statuses).filter(alias => config.statuses[alias] === key).join(', ') : key === 'PAID' ? 'paid' : ''}/>
    </label>)}</div>
    <small>Separe valores equivalentes do mesmo status com vírgulas.</small>
    <div className="filters">
      <label>Unidade do valor<select name="unit" defaultValue={config?.money.unit ?? 'DECIMAL'}>
        <option value="DECIMAL">Texto decimal</option><option value="MINOR">Inteiro em unidades menores</option>
      </select></label>
      <label>Casas decimais da moeda<select name="exponent" defaultValue={config?.money.exponent ?? 2}>
        {[0, 1, 2, 3].map(exponent => <option key={exponent} value={exponent}>{exponent}</option>)}
      </select></label>
    </div>
  </fieldset>;
}

function AccountDetails({api, account, catalog, setGuard, refresh, pending}: {api: AdminApi; account: Account;
  catalog: Catalog; setGuard: SetGuard; refresh: () => void; pending: boolean}) {
  const operation = useOperation(setGuard);
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
      {operation.notice()}
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
          review('Desativar conta', {action: 'connection-state', state: 'INACTIVE'}, 'Impede novos pedidos. Ajustes de pedidos existentes continuam sendo processados.')}>Desativar conta</button>}
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
      <FormatMigration api={api} account={account} catalog={catalog} operation={operation} refresh={refresh} disabled={pending || operation.busy}/>
    </details>
  </>;
}

function FormatMigration({api, account, catalog, operation, refresh, disabled}: {
  api: AdminApi; account: Account; catalog: Catalog; operation: Operation; refresh: () => void; disabled: boolean;
}) {
  const pending = catalog.formats.find(format => format.connection_id === account.id && format.state === 'PENDING');
  const newer = catalog.models.filter(model => model.id === account.model_id && model.approved && model.version > account.model_version);
  const targetModel = pending && newer.find(model => model.version === pending.model_version);
  const tested = pending && catalog.samples.some(sample => sample.connection_id === account.id && sample.model_version === pending.model_version);
  const scope = {id: account.id, expected_version: account.version, reviewed: true};
  function finish(action: 'migration-commit' | 'migration-cancel', target_version: number) {
    const accept = action === 'migration-commit';
    operation.review(accept ? 'Confirmar migração de formato' : 'Cancelar migração de formato',
      <p>{account.account} · formato v{account.model_version} → v{target_version}. {accept ?
        'A versão testada passa a ser a versão corrente.' : 'A versão corrente continua em uso.'}</p>, async () => {
        await api.request('commerce', {...scope, action, target_version});
        refresh();
        return accept ? 'Migração confirmada.' : 'Migração cancelada.';
      });
  }
  return <details>
    <summary>Migração de formato</summary>
    {pending ? <>
      <p>Versão preparada: v{pending.model_version}. {tested ? 'Teste autenticado recente recebido.' : 'Aguarda teste autenticado para esta versão.'}</p>
      <details><summary>Como enviar o teste ao webhook</summary>
        <p>No emissor privado, envie um POST ao webhook acima com <code>Content-Type: application/json</code>,
          {' '}<code>X-Checkout-Model-Version: {pending.model_version}</code> e <code>X-Checkout-Test: 1</code>.</p>
        <p>Use o timestamp Unix em segundos em <code>X-Checkout-Timestamp</code> e envie a assinatura hexadecimal em <code>X-Checkout-Signature</code>.
          {' '}Assine <code>timestamp.{pending.model_version}.test.</code> seguido do corpo JSON bruto, com a chave da conta e {targetModel?.config.auth === 'HMAC_SHA512_TIMESTAMP'
            ? 'HMAC SHA-512' : targetModel ? 'HMAC SHA-256' : 'o algoritmo do modelo alvo'}.</p>
      </details>
      <div className="action-links">
        <button type="button" disabled={disabled || !tested} onClick={() => finish('migration-commit', pending.model_version)}>Confirmar migração</button>
        <button type="button" disabled={disabled} onClick={() => finish('migration-cancel', pending.model_version)}>Cancelar migração</button>
      </div>
    </> : newer.length ? <form onSubmit={event => {
      const fields = formData(event);
      const target_version = Number(fields.get('target'));
      if (!newer.some(model => model.version === target_version)) return;
      try {
        const old_sample = jsonObject(fields, 'old', 2048);
        const sample = jsonObject(fields, 'next', 2048);
        operation.review('Preparar migração de formato',
          <p>{account.account} · v{account.model_version} → v{target_version}. O servidor confere a equivalência das amostras.</p>, async () => {
            await api.request('commerce', {...scope, action: 'migration-prepare', target_version, old_sample, sample});
            refresh();
            return 'Migração preparada. Envie uma amostra autenticada para a versão alvo.';
          }, fields);
      } catch (error) { operation.setError(error); }
    }}>
      <p>Use amostras sintéticas do mesmo evento no formato atual e no novo formato.</p>
      <label>Nova versão do modelo<select name="target" required defaultValue="">
        <option value="">Selecione</option>{newer.map(model => <option key={model.version} value={model.version}>v{model.version}</option>)}
      </select></label>
      <label>Amostra do formato atual (JSON)<textarea name="old" required maxLength={2048} rows={4}/></label>
      <label>Amostra do novo formato (JSON)<textarea name="next" required maxLength={2048} rows={4}/></label>
      <button type="submit" disabled={disabled}>Revisar preparação</button>
    </form> : <p>Publique uma versão mais recente deste modelo para preparar a migração.</p>}
  </details>;
}
