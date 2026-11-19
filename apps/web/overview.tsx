import {useState} from 'react';
import {Link, useLocation, useNavigate} from 'react-router-dom';
import {AdminApi, type Project, type ProjectState} from './admin-api';
import {conversionsPath, incidentPath, installPath, newPagePath, offerPath, projectPath, projectsPath, settingsPath, useContextNavigation} from './navigation';
import {commerceExponents, money} from './conversions';
import {trafficLabels} from './operations';
import {labels, Failure, Heading, Loading, useQuery} from './ui';
import type {Incident} from './protection-contracts';

type Observation = {action: string; traffic_class: string; events: number; day: string};
type OverviewReport = {
  observations: Observation[] | null;
  currencies: {currency: string; reported_sales: number; reported_amount_minor: string | null}[] | null;
  estimated_revenue: {currency: string; amount_minor_numerator: string; denominator: number}[] | null;
  estimate_projects: {project: string; clicks: number; currency: string; numerator: string}[];
};
const reviewStates: Record<string, string> = {unverified: 'Não verificado', investigating: 'Em investigação',
  confirmed_copy: 'Cópia confirmada', false_positive: 'Falso positivo'};
import {healthPath, installationMessages, publicationLabel, type InstallationStatus} from './installation-status';

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
    api.request<OverviewReport>('commerce', {action: 'report', activity: true, ...(project ? {project: project.id} : {}),
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
    api.request<InstallationStatus>('distribution', {action: 'inspect', project: project!.id, page: page!.id}, signal));
  const alerts = useQuery(project?.id ?? '', signal => api.request<{state: string; items: unknown[]}>(
    'notifications', {action: 'inspect', project: project!.id}, signal));
  function change(name: string, value: string) {
    if (value) filters.set(name, value);
    else filters.delete(name);
    if (name === 'projeto') filters.delete('lp');
    void navigate({pathname: location.pathname, search: filters.toString()}, {state: location.state, replace: true});
  }
  const observations = report.data?.observations;
  const rows=inventory.data ?? [];
  const projectCount=inventory.data && rows.every(row=>row.state!==null) ?
    rows.filter(row=>row.state?.state==='ACTIVE').length : null;
  const activePages=projectCount!==null ? rows.reduce((sum,row)=>sum+(row.state?.state==='ACTIVE' ?
    row.state.pages.filter(item=>item.enabled && item.lifecycle_state==='ACTIVE').length : 0),0) : null;
  const incidentCount=inventory.data && rows.every(row=>row.incidents!==null) ?
    rows.reduce((sum,row)=>sum+(row.incidents?.length ?? 0),0) : null;
  const clicks=observations?.filter(row=>row.action==='CTA_CLICK_OBSERVED').reduce((sum,row)=>sum+row.events,0);
  const count=(value: number|null|undefined, pending: boolean)=>value ?? (pending ? 'Consultando' : 'Indisponível');
  const needsPage=rows.filter(row=>row.state?.state==='ACTIVE' && row.state.pages.length===0);
  return <>
    <Heading title="Visão Geral" description="Projetos, sinais observados e resultados comerciais."
      actions={<div className="action-links">
        <Link className="button primary" {...nav.link(projects.length ? projectsPath : offerPath)}>
          {projects.length ? 'Ver projetos' : 'Proteger oferta'}</Link>
        <button type="button" onClick={() => {
          setUntil(Date.now()); inventory.revalidate(); installation.revalidate(); alerts.revalidate();
        }}>Atualizar visão geral</button>
      </div>}/>
    <section className="filters overview-filters" aria-label="Filtros da visão geral">
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
    <dl className="overview-metrics">
      <div><dt>Projetos ativos</dt><dd>{count(projectCount,inventory.pending)}</dd></div>
      <div><dt>LPs ativas</dt><dd>{count(activePages,inventory.pending)}</dd></div>
      <div><dt>Incidentes no histórico retornado</dt><dd>{count(incidentCount,inventory.pending)}</dd></div>
      <div><dt>Cliques de CTA no período</dt><dd>{count(clicks,report.pending)}</dd></div>
    </dl>
    <Activity observations={report.pending ? undefined : observations} error={report.error}/>
    <div className="operation-grid overview-panels"><section className="panel">
      <div className="panel-heading"><h2>Instalações e alertas</h2><Link {...nav.link(healthPath)}>Saúde e operações</Link></div>
      {needsPage.map(row=><div className="panel-heading" key={row.project.id}>
        <p>{row.project.name} ainda precisa da primeira LP.</p>
        <Link className="button" {...nav.link(newPagePath(row.project.id))}>Cadastrar LP</Link>
      </div>)}
      {!project ? <p>Selecione um projeto e uma LP para consultar a instalação.</p> : <>
        {alerts.error !== undefined ? <Failure error={alerts.error} retry={alerts.revalidate}/> : alerts.pending ? <Loading/> :
          <p>{alerts.data?.state === 'AVAILABLE' ? quantity(alerts.data.items.length, 'alerta', 'alertas') + ' no recorte de revisão' : 'Revisão de alertas indisponível'}</p>}
        {!!alerts.data?.items.length && <Link {...nav.link(settingsPath + '/notificacoes', '?projeto=' + project.id)}>Revisar alertas deste projeto</Link>}
        {page ? <>
          {installation.error !== undefined ? <Failure error={installation.error} retry={installation.revalidate}/> :
            installation.pending ? <Loading/> : installation.data && <div>
              <p><strong>{publicationLabel(installation.data)}</strong> · {
                labels[installation.data.diagnostic?.status ?? ''] ?? 'Sem diagnóstico de camadas'}</p>
              {installation.data.verification.issue && <p className="muted">{installationMessages[installation.data.verification.issue]}</p>}
            </div>}
          <div className="action-links"><Link className="button" {...nav.link(installPath(project.id, page.id))}>Abrir diagnóstico de {page.name}</Link>
            <Link {...nav.link(conversionsPath(project.id, page.id) + '/estimativa', '?dias=' + days)}>Configurar premissas</Link></div>
        </> : <p>Selecione uma LP para consultar a instalação.</p>}
      </>}
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
      {!report.pending && !!report.data?.estimate_projects?.length && <details>
        <summary>Estimativa por projeto</summary>
        <ul className="plain evidence-list">{report.data.estimate_projects.map(item => {
          const entry = rows.find(row => row.project.id === item.project);
          const candidate = entry?.state?.pages.find(lp => lp.enabled && lp.lifecycle_state === 'ACTIVE');
          return <li key={item.project}><strong>{entry?.project.name ?? item.project}</strong>
            <small>{quantity(item.clicks, 'clique', 'cliques')} · estimativa de {money((BigInt(item.numerator) + 5000n) / 10000n, item.currency)}</small>
            {candidate && <Link {...nav.link(conversionsPath(item.project, candidate.id) + '/estimativa', '?dias=' + days)}>Editar premissas</Link>}
          </li>;
        })}</ul>
      </details>}
    </section>
    </div>
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
  </>;
}

const activityTypes = {
  SESSION_OBSERVED: 'Sinais de sessão', CTA_CLICK_OBSERVED: 'Cliques de CTA',
  PAGE_REDIRECT_ATTEMPT: 'Tentativas de redirecionamento', CHECKOUT_HANDOFF_ATTEMPT: 'Tentativas de encaminhamento ao checkout',
} as const;

function Activity({observations, error}: {observations?: Observation[] | null; error: unknown}) {
  const [metric, setMetric] = useState<keyof typeof activityTypes>('SESSION_OBSERVED');
  const [traffic, setTraffic] = useState('');
  const [table, setTable] = useState(false);
  const days = new Map<string, number>();
  for (const row of observations ?? []) {
    if (row.action !== metric || (traffic && traffic !== row.traffic_class)) continue;
    days.set(row.day, (days.get(row.day) ?? 0) + row.events);
  }
  const data = [...days].sort(([a], [b]) => a.localeCompare(b));
  const max = Math.max(1, ...days.values());
  const total = data.reduce((sum, [, count]) => sum + count, 0);
  return <section className="panel" aria-labelledby="activity-heading">
    <div className="panel-heading"><h2 id="activity-heading">Atividade observada</h2>
      <div className="action-links" role="group" aria-label="Visualização da atividade">
        <button type="button" aria-pressed={!table} onClick={() => setTable(false)}>Gráfico</button>
        <button type="button" aria-pressed={table} onClick={() => setTable(true)}>Tabela</button>
      </div></div>
    <div className="filters activity-filters">
      <label>Métrica<select value={metric} onChange={event => setMetric(event.target.value as typeof metric)}>
        {Object.entries(activityTypes).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
      </select></label>
      <label>Origem declarada<select value={traffic} onChange={event => setTraffic(event.target.value)}>
        <option value="">Todas as origens</option>
        {Object.entries(trafficLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
      </select></label>
    </div>
    {error !== undefined ? <p className="muted">A atividade está indisponível.</p> : observations === undefined ? <Loading/> :
      data.length === 0 ? <p className="empty">Sem registros para a métrica e a origem selecionadas.</p> : <>
        <p><strong>{total.toLocaleString('pt-BR')}</strong> · {activityTypes[metric]}</p>
        {table ? <table className="activity-table"><thead><tr><th scope="col">Dia (UTC)</th><th scope="col">Registros</th></tr></thead>
          <tbody>{data.map(([day, count]) => <tr key={day}><th scope="row">{day}</th><td>{count.toLocaleString('pt-BR')}</td></tr>)}</tbody>
        </table> : <ul className="plain activity-bars">{data.map(([day, count]) => <li key={day}>
          <time dateTime={day}>{day.slice(8)}/{day.slice(5, 7)}</time><meter value={count} max={max} aria-label={'Registros em ' + day}/>
          <strong>{count.toLocaleString('pt-BR')}</strong>
        </li>)}</ul>}
      </>}
    <p className="muted">Horários em UTC. Sinais de navegador não identificam pessoas nem confirmam chegada ou venda.</p>
  </section>;
}
