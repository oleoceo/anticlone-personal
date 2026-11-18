import {useState} from 'react';
import {Link, useLocation, useNavigate} from 'react-router-dom';
import {AdminApi, type Page, type Project} from './admin-api';
import {CtaWorkspace} from './cta-workspace';
import {Back, Breadcrumbs, conversionsPath, pagePath, projectPath, projectsPath, useContextNavigation} from './navigation';
import {InputError, formData, formatDate, useOperation, value, type SetGuard} from './operations';
import {scopedProtection, useProtection} from './protection';
import {Failure, Heading, Loading, useQuery} from './ui';

type Assumptions = {version: string | number; ticket_minor: string; conversion_basis_points: number; currency: string; configured_at: string};
type Observations = {
  assumptions: Assumptions | null;
  estimate: null | {eligible_observed_clicks: number; amount_minor_numerator: string; denominator: number; currency: string};
  rows: {action: string; events: number}[];
  recovered_revenue: null;
};
type Report = {currencies: null | {currency: string; reported_sales: number; reported_amount_minor: string | null;
  net_amount_minor: string | null}[]; confirmed_arrivals: null};
type Connection = {id: string; model_id: string; model_version: number; account: string; state: string; endpoint: string};
type Binding = {id: string; version: number; connection_id: string; project_id: string; page_id: string | null;
  offer: string; product: string; checkout: string; url: string; price_minor: string; currency: string; state: string};
type Model = {id: string; version: number; name: string; config: {money: {exponent: number}; fields: Record<string, string>}};
type Catalog = {connections: Connection[]; bindings: Binding[]; models: Model[]};

const commonCurrencies = ['BRL', 'USD', 'EUR', 'GBP', 'JPY', 'KWD', 'BHD', 'CAD', 'AUD', 'CHF'];
const currencyCatalog = Intl.supportedValuesOf('currency');
export const commerceExponents: Record<string, number> = {BRL:2,USD:2,EUR:2,GBP:2,CAD:2,AUD:2,CHF:2,JPY:0,KWD:3,BHD:3,OMR:3,TND:3,JOD:3};

function exponent(currency: string) {
  return currencyCatalog.includes(currency)
    ? new Intl.NumberFormat('pt-BR', {style: 'currency', currency}).resolvedOptions().maximumFractionDigits ?? 0
    : null;
}

function amountInput(minor: string | bigint, precision: number, grouped = false) {
  const amount = BigInt(minor);
  const unsigned = amount < 0 ? -amount : amount;
  const str = unsigned.toString().padStart(precision + 1, '0');
  const integral = precision ? str.slice(0, -precision) : str;
  const sign = amount < 0 ? '−' : '';
  const head = grouped ? BigInt(integral).toLocaleString('pt-BR') : integral;
  return sign + head + (precision ? ',' + str.slice(-precision) : '');
}

export function money(minor: string | bigint | null, currency: string, precision = exponent(currency)) {
  if (minor === null) return 'Indisponível';
  return precision === null ? String(minor) + ' unidades menores · ' + currency : (currency === 'BRL' ? 'R$' : currency) + ' ' + amountInput(minor, precision, true);
}

function parseAmount(text: string, precision: number, max: number) {
  if (!/^(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d+)?$/.test(text)) throw new InputError('Use vírgula para separar as casas decimais.');
  const [whole, fraction = ''] = text.replaceAll('.', '').split(',');
  if (fraction.length > precision) throw new InputError('Confira o número de casas decimais.');
  const count = BigInt(whole + fraction.padEnd(precision, '0'));
  if (count > BigInt(max)) throw new InputError('Valor acima do limite permitido.');
  return Number(count);
}

const stateLabels: Record<string, string> = {ACTIVE: 'Ativo', TEST: 'Em teste', INACTIVE: 'Inativo', ARCHIVED: 'Arquivado'};

export function Conversions({api, project, page, subview, setGuard}: {
  api: AdminApi; project: Project; page: Page; subview?: string; setGuard: SetGuard;
}) {
  const nav = useContextNavigation();
  const location = useLocation();
  const navigate = useNavigate();
  const root = conversionsPath(project.id, page.id);
  const days = new URLSearchParams(location.search).get('dias') === '1' ? '1' : '7';
  const search = days === '1' ? '?dias=1' : '';
  const [until, setUntil] = useState(() => Date.now());
  const range = {from: new Date(until - Number(days) * 86_400_000).toISOString(), until: new Date(until).toISOString()};
  const scope = {project: project.id, page: page.id, ...range};
  const observed = useQuery(subview === 'vinculos' ? '' : days + ':' + until, signal =>
    api.request<Observations>('observed-metrics', {action: 'query', ...scope}, signal));
  const report = useQuery(subview ? '' : days + ':' + until, signal =>
    api.request<Report>('commerce', {action: 'report', ...scope}, signal));
  const data = useProtection(api, project.id, page.id);
  const crumbs = [{label: 'Meus Projetos', path: projectsPath}, {label: project.name, path: projectPath(project.id)},
    {label: page.name, path: pagePath(project.id, page.id)},
    {label: 'Conversões', path: subview ? root : undefined, search}];
  if (subview) crumbs.push({label: subview === 'estimativa' ? 'Estimativa de resultados' : 'Vínculos comerciais', path: '', search: ''});
  return <>
    <Breadcrumbs items={crumbs}/>
    <Back to={subview ? root : pagePath(project.id, page.id)} search={subview ? search : undefined}>
      {subview ? 'Voltar para Conversões' : 'Voltar para ' + page.name}
    </Back>
    <Heading title={subview === 'estimativa' ? 'Estimativa de resultados' : subview === 'vinculos' ? 'Vínculos comerciais' : 'Conversões'}
      description={project.name + ' · ' + page.name}/>
    {!subview && <div className="action-links">
      <Link className="button primary" {...nav.link(root + '/estimativa', search)}>Configurar estimativa</Link>
      <Link className="button" {...nav.link(root + '/vinculos', search)}>Vínculos comerciais</Link>
    </div>}
    {subview === 'vinculos' ? <CommerceBindings api={api} project={project.id} page={page.id} setGuard={setGuard}/> :
      subview === 'estimativa' ? observed.error !== undefined ? <Failure error={observed.error} retry={observed.revalidate}/> :
        observed.data ? <div className="operation-grid estimate-grid">
          <Estimate api={api} project={project.id} assumptions={observed.data.assumptions}
            refresh={observed.revalidate} setGuard={setGuard}/>
          <section className="panel" aria-labelledby="estimate-result">
            <h2 id="estimate-result">Resultado da estimativa</h2>
            <p className="muted">{page.name} · {days === '1' ? 'Últimas 24 horas' : 'Últimos 7 dias'}</p>
            {observed.pending ? <Loading>Atualizando estimativa…</Loading> : <Results data={observed.data} showAssumptions/>}
          </section>
        </div> : <Loading/> : <>
        <section className="panel">
          <div className="panel-heading"><h2>Resultados da página</h2>
            <button type="button" onClick={() => setUntil(Date.now())}>Atualizar resultados</button></div>
          <label>Período<select value={days} onChange={event => void navigate({
            pathname: root, search: event.target.value === '1' ? '?dias=1' : '',
          }, {state: location.state, replace: true})}><option value="7">Últimos 7 dias</option><option value="1">Últimas 24 horas</option></select></label>
          {observed.error !== undefined && <Failure error={observed.error} retry={observed.revalidate}/>}
          {observed.data ? <Results data={observed.data}/> : observed.error === undefined && <Loading/>}
        </section>
        <section className="panel">
          <h2>Vendas reportadas</h2>
          {report.error !== undefined && <Failure error={report.error} retry={report.revalidate}/>}
          {report.data ? report.data.currencies?.length ? <ul className="plain evidence-list">
            {report.data.currencies.map(group => <li key={group.currency}>
              <strong>{group.reported_sales} {group.reported_sales === 1 ? 'venda' : 'vendas'} · {money(group.reported_amount_minor, group.currency, commerceExponents[group.currency] ?? null)}</strong>
              <small>Líquido reportado · {money(group.net_amount_minor, group.currency, commerceExponents[group.currency] ?? null)}</small>
            </li>)}</ul> : <p>Sem vendas reportadas no período para esta LP.</p> : report.error === undefined && <Loading/>}
          <p className="muted">As vendas reportadas não têm atribuição comprovada à proteção.</p>
        </section>
        {data.pr.error !== undefined && <Failure error={data.pr.error} retry={data.pr.revalidate}/>}
        {data.lp.error !== undefined && <Failure error={data.lp.error} retry={data.lp.revalidate}/>}
        {data.pr.data && data.lp.data && <CtaWorkspace api={api} project={project.id} page={page}
          protection={scopedProtection(data.pr.data, data.lp.data)} refresh={data.refresh} setGuard={setGuard}/>}
      </>}
  </>;
}

function Results({data, showAssumptions = false}: {data: Observations; showAssumptions?: boolean}) {
  const clicks = data.rows.filter(row => row.action === 'CTA_CLICK_OBSERVED').reduce((total, row) => total + row.events, 0);
  const estimate = data.estimate;
  const rounded = estimate ? (BigInt(estimate.amount_minor_numerator) + BigInt(estimate.denominator / 2)) / BigInt(estimate.denominator) : null;
  return <dl className="review">
    <dt>Cliques observados</dt><dd>{clicks}</dd>
    {showAssumptions && <>
      <dt>Ticket médio aplicado</dt><dd>{data.assumptions ? money(data.assumptions.ticket_minor, data.assumptions.currency) : 'Sem configuração'}</dd>
      <dt>Taxa de conversão aplicada</dt><dd>{data.assumptions ? amountInput(String(data.assumptions.conversion_basis_points), 2) + '%' : 'Sem configuração'}</dd>
    </>}
    <dt>Receita potencial estimada</dt><dd>{estimate ? money(rounded, estimate.currency) : 'Indisponível'}</dd>
    <dt>Premissas da estimativa</dt><dd>{data.assumptions ?
      <>Versão {data.assumptions.version} · {formatDate(data.assumptions.configured_at)}</> : 'Sem configuração'}</dd>
    {!showAssumptions && <><dt>Receita recuperada comprovada</dt><dd>Indisponível</dd></>}
  </dl>;
}

function Estimate({api, project, assumptions, refresh, setGuard}: {
  api: AdminApi; project: string; assumptions: Assumptions | null; refresh: () => void; setGuard: SetGuard;
}) {
  const operation = useOperation(setGuard);
  const [currency, setCurrency] = useState(assumptions?.currency ?? 'BRL');
  const precision = exponent(currency);
  const firstPrecision = assumptions ? exponent(assumptions.currency) : null;
  return <section className="panel form-panel">
    <h2>Premissas do projeto</h2>
    <p>O ticket médio e a taxa são compartilhados por todas as LPs do projeto.</p>
    {assumptions && <p className="muted">Versão {assumptions.version} · {formatDate(assumptions.configured_at)}</p>}
    {operation.notice()}
    <form onSubmit={event => {
      const fields = formData(event);
      let ticket: number, rate: number;
      try {
        ticket = parseAmount(value(fields, 'ticket'), precision ?? 0, 1e12);
        rate = parseAmount(value(fields, 'rate'), 2, 10_000);
      } catch (error) { operation.setError(error); return; }
      operation.review('Salvar premissas da estimativa', <p>{money(String(ticket), currency)} · {amountInput(String(rate), 2)}%</p>,
        async () => {
          const result = await api.request<Assumptions>('observed-metrics', {action: 'configure', project, ticket, rate, currency});
          refresh();
          return 'Estimativa configurada. Versão ' + result.version + ' · ' + formatDate(result.configured_at) + '.';
        }, fields);
    }}>
      <label>Moeda<select value={currency} onChange={event => setCurrency(event.target.value)}>
        {[...new Set([...commonCurrencies, ...(assumptions ? [assumptions.currency] : []), ...currencyCatalog])]
          .map(code => <option value={code} key={code}>{code}</option>)}
      </select></label>
      <label>{precision === null ? 'Ticket médio em unidades menores' : 'Ticket médio'}
        <input name="ticket" inputMode="decimal" autoComplete="off" required maxLength={24}
          defaultValue={assumptions ? amountInput(assumptions.ticket_minor, firstPrecision ?? 0) : ''}/></label>
      <label>Taxa de conversão (%)<input name="rate" inputMode="decimal" autoComplete="off" required maxLength={8}
        defaultValue={assumptions ? amountInput(String(assumptions.conversion_basis_points), 2) : ''}/></label>
      <button type="submit" className="primary" disabled={operation.busy}>Revisar premissas</button>
    </form>
  </section>;
}

function CommerceBindings({api, project, page, setGuard}: {api: AdminApi; project: string; page: string; setGuard: SetGuard}) {
  const catalog = useQuery(project + ':' + page, signal => api.request<Catalog>('commerce', {action: 'list'}, signal));
  const operation = useOperation(setGuard);
  const entries = catalog.data?.bindings.filter(item => item.project_id === project && item.page_id === page) ?? [];
  const inherited = catalog.data?.bindings.filter(item => item.project_id === project && item.page_id === null) ?? [];
  return <section className="panel">
    <div className="panel-heading"><h2>Checkouts vinculados</h2><button type="button" disabled={operation.busy}
      onClick={catalog.revalidate}>Atualizar vínculos</button></div>
    <p>Os vínculos identificam eventos comerciais da LP. Destinos de proteção seguem sua própria aprovação.</p>
    {operation.notice()}
    {catalog.error !== undefined && <Failure error={catalog.error} retry={catalog.revalidate}/>}
    {catalog.data ? <>
      {entries.length ? <ul className="plain evidence-list">{entries.map(item => {
        const connection = catalog.data?.connections.find(account => account.id === item.connection_id);
        return <li key={item.id}>
          <strong>{connection?.account ?? 'Conta indisponível'} · {stateLabels[item.state] ?? item.state}</strong>
          <small>{item.url} · versão {item.version} · conta {stateLabels[connection?.state ?? ''] ?? 'indisponível'}</small>
          <details><summary>Editar vínculo</summary><BindingForm key={item.version} api={api} project={project} page={page}
            catalog={catalog.data!} binding={item} operation={operation} refresh={catalog.revalidate}/></details>
        </li>;
      })}</ul> : <p className="empty">Nenhum checkout vinculado a esta LP no catálogo retornado.</p>}
      {inherited.length > 0 && <p className="muted">{inherited.length} vínculo(s) do projeto sem LP associada.</p>}
      {catalog.data.connections.length > 0 ? <details><summary>Vincular checkout</summary>
        <BindingForm api={api} project={project} page={page} catalog={catalog.data}
          operation={operation} refresh={catalog.revalidate}/>
        </details> : <p>Cadastre uma conta de checkout em Integrações no painel anterior.</p>}
    </> : catalog.error === undefined && <Loading/>}
  </section>;
}

const discriminators = {offer: 'Oferta', product: 'Produto', checkout: 'Checkout'};

function BindingForm({api, project, page, catalog, binding, operation, refresh}: {
  api: AdminApi; project: string; page: string; catalog: Catalog; binding?: Binding;
  operation: ReturnType<typeof useOperation>; refresh: () => void;
}) {
  const [account, setAccount] = useState(binding?.connection_id ?? '');
  const connection = catalog.connections.find(row => row.id === account);
  const model = catalog.models.find(row => row.id === connection?.model_id && row.version === connection.model_version);
  const precision = model?.config.money.exponent;
  return <form className="binding-form" onSubmit={event => {
    const data = formData(event);
    if (!connection || precision === undefined) return;
    const currency = value(data, 'currency');
    let price_minor: number;
    try { price_minor = parseAmount(value(data, 'price'), precision, 1e12); }
    catch (error) { operation.setError(error); return; }
    const body = {action: 'binding', ...(binding ? {id: binding.id} : {}), expected_version: binding?.version ?? 0,
      connection: connection.id, project, page, offer: binding?.offer ?? value(data, 'offer'),
      product: binding?.product ?? value(data, 'product'), checkout: binding?.checkout ?? value(data, 'checkout'),
      url: value(data, 'url'), price_minor, currency, state: value(data, 'state')};
    operation.review('Salvar vínculo comercial', <>
      <p>{connection.account} · {body.url}</p><p>{[body.offer, body.product, body.checkout].filter(Boolean).join(' · ')} · {money(String(price_minor), currency, precision)} · {stateLabels[body.state]}</p>
    </>, async () => {
      const saved = await api.request<{version: number}>('commerce', body);
      refresh();
      return 'Vínculo salvo. Versão ' + saved.version + '.';
    }, data);
  }}>
    <label>Conta de checkout<select value={account} required disabled={!!binding} onChange={event => setAccount(event.target.value)}>
      <option value="">Selecione</option>{catalog.connections.map(row =>
        <option key={row.id} value={row.id}>{row.account} · {stateLabels[row.state] ?? row.state}</option>)}
    </select></label>
    {model ? <>
      {Object.entries(discriminators).filter(([key]) => model.config.fields[key]).map(([key, label]) =>
        <label key={key}>{label}<input name={key} required maxLength={128} readOnly={!!binding}
          defaultValue={binding?.[key as keyof typeof discriminators] ?? ''}/></label>)}
      <label>URL do checkout<input name="url" type="url" required maxLength={2048} defaultValue={binding?.url}/></label>
      <div className="filters">
        <label>Preço de referência<input name="price" inputMode="decimal" required maxLength={24}
          defaultValue={binding && precision !== undefined ? amountInput(binding.price_minor, precision) : ''}/></label>
        <label>Moeda do checkout<select name="currency" defaultValue={binding?.currency ?? ''} required>
          <option value="">Selecione</option>{Object.entries(commerceExponents).filter(([, scale]) => scale === precision)
            .map(([currency]) => <option key={currency} value={currency}>{currency}</option>)}
        </select></label>
      </div>
      <label>Estado do vínculo<select name="state" defaultValue={binding?.state ?? 'ACTIVE'}>
        {['ACTIVE','INACTIVE','ARCHIVED'].map(state => <option key={state} value={state}>{stateLabels[state]}</option>)}
      </select></label>
      <button type="submit" disabled={operation.busy}>Revisar vínculo comercial</button>
    </> : account && <p>Formato da conta indisponível no catálogo retornado.</p>}
  </form>;
}
