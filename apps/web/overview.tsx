import {useState} from 'react';
import {Link, useLocation, useNavigate} from 'react-router-dom';
import {AdminApi, type Project, type ProjectState} from './admin-api';
import {incidentPath, installPath, projectPath, useContextNavigation} from './navigation';
import {commerceExponents, money} from './conversions';
import {labels, Failure, Heading, Loading, useQuery} from './ui';
import type {Incident} from './protection-contracts';

type OverviewReport = {
  observations: {action: string; events: number}[] | null;
  currencies: {currency: string; reported_sales: number; reported_amount_minor: string | null}[] | null;
  estimated_revenue: {currency: string; amount_minor_numerator: string; denominator: number}[] | null;
};
const reviewStates: Record<string, string> = {unverified: 'Não verificado', investigating: 'Em investigação',
  confirmed_copy: 'Cópia confirmada', false_positive: 'Falso positivo'};
type InstallationSummary = {state: string; diagnostic?: {status: string; controlledVerification: {status: string}}};

function quantity(count: number, singular: string, plural: string) {
  return count + ' ' + (count === 1 ? singular : plural);
}

export function Overview({api, projects}: {api: AdminApi; projects: Project[]}) {
  const nav = useContextNavigation();
  const location = useLocation();
  const navigate = useNavigate();
  const filters = new URLSearchParams(location.search);
  const project = projects.find(item => item.id === filters.get('projeto'));
  const days = filters.get('dias') === '1' ? 1 : 7;
  const [until, setUntil] = useState(Date.now);
  const key = project?.id ?? 'all';
  const report = useQuery(key + ':' + days + ':' + until, signal =>
    api.request<OverviewReport>('commerce', {action: 'report', ...(project ? {project: project.id} : {}),
      from: new Date(until - days * 86_400_000).toISOString(), until: new Date(until).toISOString()}, signal));
  const scope = project ? [project] : projects;
  const inventory = useQuery(JSON.stringify(scope.map(item => item.id)), async signal => {
    const rows = [];
    for (let start = 0; start < scope.length && !signal.aborted; start += 4) {
      const group = await Promise.all(scope.slice(start, start + 4).map(async item => {
        const [state, incidents] = await Promise.allSettled([
          api.request<ProjectState>('pages', {action: 'project-state', project: item.id}, signal),
          api.request<Incident[]>('incidents', {project: item.id}, signal),
        ]);
        return {project: item, state: state.status === 'fulfilled' ? state.value : null,
          incidents: incidents.status === 'fulfilled' ? incidents.value : null};
      }));
      rows.push(...group);
    }
    return rows;
  });
  const pageId = filters.get('lp');
  const page = project && inventory.data?.[0]?.state?.pages.find(item => item.id === pageId);
  const installation = useQuery(page && project ? project.id + ':' + page.id : '', signal =>
    api.request<InstallationSummary>('distribution', {action: 'inspect', project: project!.id, page: page!.id}, signal));
  const alerts = useQuery(project?.id ?? '', signal => api.request<{state: string; items: unknown[]}>(
    'notifications', {action: 'inspect', project: project!.id}, signal));
  function change(name: string, value: string) {
    if (value) filters.set(name, value);
    else filters.delete(name);
    if (name === 'projeto') filters.delete('lp');
    void navigate({pathname: location.pathname, search: filters.toString()}, {state: location.state, replace: true});
  }
  const observations = report.data?.observations;
  return <>
    <Heading title="Visão Geral" description="Projetos, sinais observados e resultados comerciais."
      actions={<button type="button" onClick={() => {
        setUntil(Date.now()); inventory.revalidate(); installation.revalidate(); alerts.revalidate();
      }}>Atualizar visão geral</button>}/>
    <section className="panel filters">
      <label>Projeto<select value={project?.id ?? ''} onChange={event => change('projeto', event.target.value)}>
        <option value="">Todos os projetos</option>{projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
      <label>LP para diagnóstico<select disabled={!project} value={page?.id ?? ''} onChange={event => change('lp', event.target.value)}>
        <option value="">Selecione</option>{project && inventory.data?.[0]?.state?.pages.map(item =>
          <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
      <label>Período dos resultados<select value={days} onChange={event => change('dias', event.target.value)}>
        <option value="1">Últimas 24 horas</option><option value="7">Últimos 7 dias</option>
      </select></label>
    </section>
    <section className="panel">
      <h2>Resultados do período</h2>
      {report.error !== undefined ? <Failure error={report.error} retry={report.revalidate}/> :
        report.pending ? <Loading/> : report.data && <dl className="review">
          <dt>Cliques de CTA observados</dt><dd>{observations?.filter(row => row.action === 'CTA_CLICK_OBSERVED')
            .reduce((total, row) => total + row.events, 0) ?? 'Indisponíveis'}</dd>
          <dt>Receita potencial estimada</dt><dd>{report.data.estimated_revenue?.length ?
            report.data.estimated_revenue.map(item => <div key={item.currency}>{money(
              (BigInt(item.amount_minor_numerator) + BigInt(item.denominator / 2)) / BigInt(item.denominator), item.currency)}</div>) :
            'Sem estimativa no período'}</dd>
          <dt>Vendas reportadas</dt><dd>{report.data.currencies?.length ? report.data.currencies.map(item =>
            <div key={item.currency}>{item.reported_sales} {item.reported_sales === 1 ? 'venda' : 'vendas'} · {
              money(item.reported_amount_minor, item.currency, commerceExponents[item.currency] ?? null)}</div>) : 'Sem vendas reportadas no período'}</dd>
          <dt>Receita recuperada comprovada</dt><dd>Indisponível</dd>
        </dl>}
      <p className="muted">Estimativas usam as premissas atuais dos projetos que têm configuração e cliques no período. O total geral de vendas inclui eventos reportados sem vínculo de projeto.</p>
    </section>
    <section className="panel">
      <h2>Projetos e investigações</h2>
      <p className="muted">O histórico de incidentes segue o recorte retornado pelo servidor.</p>
      {inventory.pending ? <Loading/> : inventory.data?.length ? <ul className="plain evidence-list">
        {inventory.data.map(row => <li key={row.project.id}>
          <div className="panel-heading"><strong>{row.project.name}</strong>
            <Link {...nav.link(projectPath(row.project.id))}>Administrar oferta</Link></div>
          <p>{row.state ? (labels[row.state.state] ?? row.state.state) + ' · ' +
            quantity(row.state.pages.filter(item => item.enabled && item.lifecycle_state === 'ACTIVE').length,
              'LP habilitada e ativa no cadastro', 'LPs habilitadas e ativas no cadastro') :
            'Cadastro de LPs indisponível'}</p>
          {row.incidents ? <>
            <p>{quantity(row.incidents.length, 'incidente', 'incidentes')} no histórico retornado</p>
            {row.incidents.slice(0, 3).map(item => <div key={item.incident_id}>
              <Link {...nav.link(incidentPath(row.project.id, item.incident_id))}>{item.host}</Link> · {reviewStates[item.status] ?? item.status}
            </div>)}
          </> : <p>Consulta de incidentes indisponível.</p>}
        </li>)}</ul> : <p>Nenhum projeto cadastrado.</p>}
    </section>
    <section className="panel">
      <h2>Instalações e alertas</h2>
      {!project ? <p>Selecione um projeto para consultar alertas em revisão e uma LP para ver o diagnóstico.</p> : <>
        {alerts.error !== undefined ? <Failure error={alerts.error} retry={alerts.revalidate}/> : alerts.pending ? <Loading/> :
          <p>{alerts.data?.state === 'AVAILABLE' ? quantity(alerts.data.items.length, 'alerta', 'alertas') + ' no recorte de revisão' : 'Revisão de alertas indisponível'}</p>}
        {page ? <>
          {installation.error !== undefined ? <Failure error={installation.error} retry={installation.revalidate}/> :
            installation.pending ? <Loading/> : <p>{installation.data?.state === 'PUBLISHED' ? 'Endereços publicados' :
              installation.data?.state === 'NOT_PUBLISHED' ? 'Endereços ainda não publicados' : 'Distribuição indisponível'} · {
              labels[installation.data?.diagnostic?.controlledVerification.status ?? ''] ?? 'Verificação controlada indisponível'}</p>}
          <Link {...nav.link(installPath(project.id, page.id))}>Abrir diagnóstico de {page.name}</Link>
        </> : <p>Selecione uma LP para consultar a instalação.</p>}
      </>}
    </section>
  </>;
}
