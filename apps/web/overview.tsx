import {useState} from 'react';
import {Link, useLocation, useNavigate} from 'react-router-dom';
import {AdminApi, type Project, type ProjectState} from './admin-api';
import {conversionsPath, incidentPath, installPath, newPagePath, offerPath, projectPath, projectsPath, settingsPath, useContextNavigation} from './navigation';
import {commerceExponents, money} from './conversions';
import {trafficLabels} from './operations';
import {labels, Failure, Heading, Loading, useQuery} from './ui';
import type {Incident} from './protection-contracts';
import {healthPath, installationMessages, publicationLabel, type InstallationStatus} from './installation-status';

type Observation = {project_id: string; action: string; traffic_class: string; events: number; day: string};
type OverviewReport = {
  observations: Observation[] | null;
  currencies: {currency: string; reported_sales: number; reported_amount_minor: string | null}[] | null;
  estimated_revenue: {currency: string; amount_minor_numerator: string; denominator: number}[] | null;
  estimate_projects?: {project: string; currency: string; numerator: string}[];
  estimate_assumptions?: {project: string; currency: string; ticket_minor: string; rate: number; version: string}[];
};
const reviewStates: Record<string, string> = {unverified: 'Não verificado', investigating: 'Em investigação',
  confirmed_copy: 'Cópia confirmada', false_positive: 'Falso positivo'};
const dayMs = 86_400_000;

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
  const from = until - days * dayMs;
  const key = project?.id ?? 'all';
  const report = useQuery(key + ':' + days + ':' + until, signal =>
    api.request<OverviewReport>('commerce', {action: 'report', activity: true, ...(project ? {project: project.id} : {}),
      from: new Date(from).toISOString(), until: new Date(until).toISOString()}, signal));
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
  const clicksByProject = new Map<string, number>();
  for (const row of observations ?? []) if (row.action === 'CTA_CLICK_OBSERVED') {
    clicksByProject.set(row.project_id, (clicksByProject.get(row.project_id) ?? 0) + row.events);
  }
  const clicks = observations?.reduce((sum, row) => sum + (row.action === 'CTA_CLICK_OBSERVED' ? row.events : 0), 0);
  const estimates = new Map(report.data?.estimate_projects?.map(row => [row.project, row] as const));
  const premises = new Map(report.data?.estimate_assumptions?.map(row => [row.project, row] as const));
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
    <Activity observations={report.pending ? undefined : observations} error={report.error} from={from} until={until}/>
    {!report.pending && observations && <TrafficOrigins observations={observations}/>}
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
    </section>
    </div>
    {!report.pending && report.data && observations && scope.length > 0 && <section className="panel" aria-labelledby="finance-projects">
      <h2 id="finance-projects">Estimativa por projeto</h2>
      <div className="finance-table-wrap" tabIndex={0} role="region" aria-label="Detalhamento das estimativas">
        <table className="activity-table finance-table"><thead><tr>
          <th scope="col">Projeto</th><th scope="col">Cliques observados</th><th scope="col">Premissas</th><th scope="col">Receita potencial</th>
        </tr></thead><tbody>{scope.map(item => {
          const estimate = estimates.get(item.id);
          const assumption = premises.get(item.id);
          const count = clicksByProject.get(item.id) ?? 0;
          const candidate = rows.find(row => row.project.id === item.id)?.state?.pages.find(lp => lp.enabled && lp.lifecycle_state === 'ACTIVE');
          return <tr key={item.id}>
            <th scope="row">{item.name}</th><td data-heading="Cliques observados">{count}</td>
            <td data-heading="Premissas"><span>{assumption ? <>{money(assumption.ticket_minor, assumption.currency)} · {(assumption.rate / 100).toLocaleString('pt-BR', {maximumFractionDigits:2})}% · v{assumption.version}</> : 'Sem premissas'}</span>
              {candidate && <small><Link {...nav.link(conversionsPath(item.id, candidate.id) + '/estimativa', '?dias=' + days)}>Configurar premissas de {item.name}</Link></small>}
            </td>
            <td data-heading="Receita potencial">{estimate ? <>Estimativa {money((BigInt(estimate.numerator) + 5000n) / 10000n, estimate.currency)}</> :
              count ? 'Faltam premissas' : 'Sem cliques'}</td>
          </tr>;
        })}</tbody></table>
      </div>
    </section>}
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

function TrafficOrigins({observations}: {observations: Observation[]}) {
  const byClass = new Map<string, number>();
  for (const row of observations) if (row.action === 'SESSION_OBSERVED') {
    byClass.set(row.traffic_class, (byClass.get(row.traffic_class) ?? 0) + row.events);
  }
  const total = [...byClass.values()].reduce((sum, count) => sum + count, 0);
  return <section className="panel" aria-labelledby="traffic-origins">
    <h2 id="traffic-origins">Origem do tráfego</h2>
    {total ? <dl className="traffic-breakdown">{Object.entries(trafficLabels).map(([id, label]) => {
      const count = byClass.get(id) ?? 0;
      return <div key={id}>
        <dt>{label}</dt>
        <dd><strong>{(count / total).toLocaleString('pt-BR', {style:'percent',maximumFractionDigits:1})}</strong>
          <meter aria-label={label} min={0} max={total} value={count}/></dd>
      </div>;
    })}</dl> : <p>Sem sinais de sessão no período selecionado.</p>}
    <p className="muted">Distribuição por origem declarada nos sinais de sessão do período.</p>
  </section>;
}

const activityTypes = {
  SESSION_OBSERVED: 'Sinais de sessão', CTA_CLICK_OBSERVED: 'Cliques de CTA',
  PAGE_REDIRECT_ATTEMPT: 'Tentativas de redirecionamento', CHECKOUT_HANDOFF_ATTEMPT: 'Tentativas de encaminhamento ao checkout',
} as const;

function Activity({observations, error, from, until}: {observations?: Observation[] | null; error: unknown; from: number; until: number}) {
  const [metric, setMetric] = useState<keyof typeof activityTypes>('SESSION_OBSERVED');
  const [traffic, setTraffic] = useState('');
  const [table, setTable] = useState(false);
  const days = new Map<string, number>();
  for (const row of observations ?? []) {
    if (row.action !== metric || (traffic && traffic !== row.traffic_class)) continue;
    days.set(row.day, (days.get(row.day) ?? 0) + row.events);
  }
  const total = [...days.values()].reduce((sum, count) => sum + count, 0);
  const data: {day: string; count: number}[] = [];
  for (let time = Math.floor(from / dayMs) * dayMs; time < until; time += dayMs) {
    const day = new Date(time).toISOString().slice(0, 10);
    data.push({day, count: days.get(day) ?? 0});
  }
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
      total === 0 ? <p className="empty">Sem registros para a métrica e a origem selecionadas.</p> : <>
        <p><strong>{total.toLocaleString('pt-BR')}</strong> · {activityTypes[metric]}</p>
        {table ? <table className="activity-table"><thead><tr><th scope="col">Dia (UTC)</th><th scope="col">Registros</th></tr></thead>
          <tbody>{data.map(({day, count}) => <tr key={day}><th scope="row">{day}</th><td>{count.toLocaleString('pt-BR')}</td></tr>)}</tbody>
        </table> : <ActivityChart data={data} label={activityTypes[metric]}/>}
      </>}
    <p className="muted">Horários em UTC. Sinais de navegador não identificam pessoas nem confirmam chegada ou venda.</p>
  </section>;
}

function ActivityChart({data, label}: {data: {day: string; count: number}[]; label: string}) {
  const max = Math.max(1, ...data.map(point => point.count));
  const points = data.map((point, index) => ({
    ...point,
    x: data.length === 1 ? 360 : 50 + index * 648 / (data.length - 1),
    y: 168 - 138 * point.count / max,
  }));
  const coordinates = points.map(point => point.x + ',' + point.y).join(' ');
  const values = points.map(({day, count}) => day + ': ' + count).join('; ');
  return <svg className="activity-chart" viewBox="0 0 720 202" role="img" aria-label={label + ' por dia em UTC. ' + values}>
    <line x1="50" y1="30" x2="698" y2="30" className="activity-guide"/>
    <line x1="50" y1="168" x2="698" y2="168" className="activity-guide"/>
    <text x="40" y="35" textAnchor="end">{max.toLocaleString('pt-BR')}</text>
    <text x="40" y="172" textAnchor="end">0</text>
    <polygon points={`${points[0].x},168 ${coordinates} ${points.at(-1)!.x},168`} className="activity-fill"/>
    <polyline points={coordinates} className="activity-line"/>
    {points.map(({day, count, x, y}, index) => <g key={day}>
      <circle cx={x} cy={y} r="4.5" className="activity-point" data-count={count}><title>{day} · {count}</title></circle>
      {(points.length <= 4 || index % 2 === 0 || index === points.length - 1) &&
        <text x={x} y="193" textAnchor="middle">{day.slice(8)}/{day.slice(5, 7)}</text>}
    </g>)}
  </svg>;
}
