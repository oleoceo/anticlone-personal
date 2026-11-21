import {useState} from 'react';
import {Link, useLocation, useNavigate} from 'react-router-dom';
import {AdminApi, pageList, type Project} from './admin-api';
import {Back, Breadcrumbs, incidentPath, pagePath, projectIncidentsPath, projectPath, searchOf, sectionParams, settingsPath, useContextNavigation} from './navigation';
import {DetailsData, formData, formatDate, InputError, useOperation, uuid, value, type SetGuard} from './operations';
import {ProtectionScreen} from './protection';
import type {Incident, ProtectionAction} from './protection-contracts';
import {Failure, Heading, Loading, useQuery} from './ui';

const statuses: Record<string, string> = {
  unverified: 'Não verificado', investigating: 'Em investigação', confirmed_copy: 'Cópia confirmada', false_positive: 'Falso positivo',
};
const sources: Record<string, string> = {
  core: 'Core', fallback: 'Fallback', html_canary: 'Canário HTML', css_canary: 'Canário CSS', runtime: 'Runtime',
};
const alertStates = new Map([
  ['PENDING', 'Aguardando envio'], ['EXPIRED', 'Prazo de envio expirado'],
  ['EXHAUSTED', 'Limite de tentativas atingido'], ['ACCEPTED_BY_TRANSPORT', 'Aceito pelo servidor de e-mail'],
  ['SUSPENDED', 'Envio suspenso'], ['REVIEW_REQUIRED', 'Aguardando revisão'],
]);

export function IncidentProjects({projects}: {projects: Project[]}) {
  const navigation = useContextNavigation();
  return <>
    <Heading title="Incidentes" description="Selecione um projeto para investigar os domínios observados."/>
    <section className="panel">
      {projects.length ? <ul className="plain page-list">{projects.map(project => {
        const remembered = navigation.rememberedPage(project.id);
        return <li key={project.id}><strong>{project.name}</strong>
          <Link className="button" aria-label={'Ver incidentes de ' + project.name}
            {...navigation.link(projectIncidentsPath(project.id), remembered ? '?lp=' + remembered : '')}>Ver incidentes</Link>
        </li>;
      })}</ul> : <p>Nenhum projeto cadastrado.</p>}
    </section>
  </>;
}

export function Incidents({api, project, id, action, setGuard}: {
  api: AdminApi; project: Project; id?: string; action?: ProtectionAction; setGuard: SetGuard;
}) {
  const nav = useContextNavigation();
  const location = useLocation();
  const navigate = useNavigate();
  const query = sectionParams(location.search);
  const scopeSearch = searchOf(query);
  const pid = query.get('lp') ?? '';
  const status = query.get('situacao') ?? '';
  const days = query.get('dias') === '7' ? '7' : '30';
  const term = typeof location.state?.incidentText === 'string' ? location.state.incidentText as string : '';
  const listPath = projectIncidentsPath(project.id);
  const detailPath = id ? incidentPath(project.id, id) : listPath;
  const trail = [
    {label: 'Meus Projetos', path: '/projetos'},
    {label: project.name, path: projectPath(project.id)},
    {label: 'Incidentes', path: id ? listPath : undefined, search: scopeSearch},
  ];
  const incidents = useQuery(project.id, signal => api.request<Incident[]>('incidents', {project: project.id}, signal));
  const pages = useQuery(project.id, signal => pageList(api, project.id, signal));
  const selected = pages.data?.pages.find(item => item.id === pid);
  const incident = incidents.data?.find(item => item.incident_id === id);
  const matched = incidents.data?.filter(item => {
    const related = item.linked_evidence.events.some(event => event.page_id === pid);
    return (!pid || related) && (!status || status === item.status) &&
      item.host.toLowerCase().includes(term.trim().toLowerCase()) &&
      Date.parse(item.last_observed_at) >= Date.now() - Number(days) * 86_400_000;
  });

  function changeParam(key: string, newValue: string) {
    if (newValue) query.set(key, newValue);
    else query.delete(key);
    const search = searchOf(query);
    void navigate({pathname: location.pathname, search}, {replace: true, state: location.state});
  }

  function choosePage() {
    return <label>Página protegida<select value={selected?.id ?? ''} disabled={!pages.data}
      onChange={event => changeParam('lp', event.target.value)}>
      <option value="">{id ? 'Selecione a LP para as ações' : 'Todas as páginas'}</option>
      {pages.data?.pages.map(page => <option key={page.id} value={page.id}>{page.name}</option>)}
    </select></label>;
  }

  return <>
    <Breadcrumbs items={[...trail, ...(id ? [{label: incident?.host ?? 'Incidente', path: action ? detailPath : undefined, search: scopeSearch}] : []),
      ...(action ? [{label: action === 'redirecionar' ? 'Redirecionar página' : 'Substituir checkout/CTA'}] : [])]}/>
    {id ? <Back to={action ? detailPath : listPath} search={scopeSearch}>
      {action ? 'Voltar para investigação' : 'Voltar para Incidentes'}</Back> :
      <Back to={projectPath(project.id)}>Voltar para {project.name}</Back>}
    {incidents.error !== undefined && <Failure error={incidents.error} retry={incidents.retry}/>}
    {pages.error !== undefined && <Failure error={pages.error} retry={pages.retry}/>}
    {!incidents.data && incidents.error === undefined && <Loading/>}
    {!id && incidents.data && <>
      <Heading title="Incidentes" description={project.name}/>
      <section className="panel">
        <div className="filters">
          <label>Buscar domínio<input value={term} maxLength={253} onChange={event =>
            void navigate({pathname: location.pathname, search: scopeSearch}, {
              replace: true, state: {...location.state, incidentText: event.target.value},
            })}/></label>
          <label>Situação<select value={status} onChange={event => changeParam('situacao', event.target.value)}>
            <option value="">Todas</option>{Object.entries(statuses).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select></label>
          {choosePage()}
          <label>Período<select value={days} onChange={event => changeParam('dias', event.target.value)}>
            <option value="7">Últimos 7 dias</option><option value="30">Últimos 30 dias</option>
          </select></label>
        </div>
        {pid && <p className="muted">O filtro por página usa os recibos disponíveis na investigação.</p>}
        {matched?.length ? <ul className="plain page-list">{matched.map(item =>
          <li key={item.incident_id}><div><strong>{item.host}</strong><small>{statuses[item.status] ?? item.status} · {formatDate(item.last_observed_at)}</small></div>
            <Link className="button" aria-label={'Investigar ' + item.host}
              {...nav.link(incidentPath(project.id, item.incident_id), scopeSearch)}>Investigar</Link></li>)}
        </ul> : <p className="empty">Nenhum incidente corresponde aos filtros no histórico disponível.</p>}
      </section>
    </>}
    {id && incidents.data && !incident && <Heading title="Incidente indisponível" description="Confira o projeto e o histórico disponível."/>}
    {incident && <>
      {!action && <Heading title={incident.host} description={'Situação da investigação · ' + (statuses[incident.status] ?? incident.status)}
        actions={<button type="button" onClick={incidents.revalidate}>Atualizar investigação</button>}/>}
      <div className="selectors">{choosePage()}</div>
      {selected && <p><Link {...nav.link(pagePath(project.id, selected.id))}>Abrir {selected.name} na oferta</Link></p>}
      {action && selected && <ProtectionScreen key={action + ':' + selected.id} api={api} project={project} page={selected}
        incident={incident} action={action} setGuard={setGuard}/>}
      {action && !selected && <p className="notice">Selecione a página a que a ação será aplicada.</p>}
      {!action && <IncidentDetail key={id} incident={incident} project={project} api={api} pid={selected?.id}
        actionUrl={detailPath} search={scopeSearch} refresh={incidents.revalidate} setGuard={setGuard}/>}
    </>}
  </>;
}

function riskLabel(assessment: Incident['contextual_assessment']) {
  if (assessment?.reason === 'insufficient_evidence') return 'Indeterminado · evidência insuficiente';
  return 'Sem avaliação conclusiva disponível';
}

function IncidentDetail({incident, project, api, pid, actionUrl, search, refresh, setGuard}: {
  incident: Incident; project: Project; api: AdminApi; pid?: string; actionUrl: string; search: string;
  refresh: () => void; setGuard: SetGuard;
}) {
  const nav = useContextNavigation();
  const operation = useOperation(setGuard);
  const outbox = incident.notification?.outbox;
  return <>
    {operation.notice()}
    <section className="panel">
      <h2>Alerta por e-mail</h2>
      <p>{outbox ? alertStates.get(outbox.state) ?? 'Consulte o histórico de notificações' :
        incident.notification?.available ? 'Sem alerta registrado para este incidente' : 'Histórico de alertas indisponível'}</p>
      {outbox && <p>Tentativas de envio · {outbox.attempts}</p>}
      {outbox?.state === 'ACCEPTED_BY_TRANSPORT' && <p>O recebimento na caixa de destino precisa ser confirmado separadamente.</p>}
      <Link {...nav.link(settingsPath + '/notificacoes')}>Ver configurações de SMTP</Link>
    </section>
    <section className="panel">
      <h2>Ações de proteção</h2>
      <p>Selecione a LP e revise as etapas de publicação, aprovação e autorização para o contexto observado.</p>
      <div className="action-links">
        <Link className="button primary" {...nav.link(actionUrl + '/redirecionar', search)}>Redirecionar página</Link>
        <Link className="button" {...nav.link(actionUrl + '/substituir-cta', search)}>Substituir checkout/CTA</Link>
      </div>
    </section>
    <section className="panel">
      <h2>Evidências</h2>
      <dl className="review">
        <dt>Risco contextual</dt><dd>{riskLabel(incident.contextual_assessment)}</dd>
        <dt>Primeiro sinal</dt><dd>{formatDate(incident.first_observed_at)}</dd>
        <dt>Sinal mais recente</dt><dd>{formatDate(incident.last_observed_at)}</dd>
        <dt>Fontes observadas</dt><dd>{[...new Set(incident.observation_sources.map(item => sources[item.source] ?? item.source))].join(', ') || 'Indisponíveis'}</dd>
      </dl>
      <p className="muted">Domínios declarados e recibos indicam contexto. A identidade do operador permanece desconhecida.</p>
      {incident.timeline.events.length > 0 && <ul className="plain evidence-list">{[...incident.timeline.events].reverse().map(event =>
        <li key={event.id}><strong>{event.event_type === 'incident_status_transition' ? 'Mudança de situação' : sources[event.source] ?? event.source}</strong>
          <small>{formatDate(event.recorded_at)}</small></li>)}</ul>}
      {incident.linked_evidence.available && <DetailsData heading={'Recibos associados · ' + incident.linked_evidence.total} data={incident.linked_evidence.events}/>}
      <ReceiptHistory key={pid ?? project.id} api={api} project={project.id} pid={pid}/>
      <DetailsData heading="Detalhes da investigação" data={{assessment: incident.contextual_assessment, assessments: incident.assessments,
        timeline: incident.timeline, infrastructure: incident.infrastructure, operator_profile: incident.operator_profile,
        degradation: incident.degradation, notification: incident.notification, project_cta_context: incident.project_cta_context,
        browser_claims: incident.browser_claims}}/>
    </section>
    {pid && <PageEvidence api={api} project={project.id} page={pid} setGuard={setGuard} refresh={refresh} />}
    {incident.triage_version !== null && <section className="panel">
      <h2>Alterar situação</h2>
      <form onSubmit={event => {
        const data = formData(event);
        const next = value(data, 'status');
        const justification = value(data, 'justification');
        operation.review('Confirmar mudança de situação', <p>{incident.host} · {statuses[next]}</p>, async () => {
          await api.request('incident-status', {project: project.id, host: incident.host, incident_id: incident.incident_id,
            expected: incident.status, version: incident.triage_version, status: next, justification});
          refresh();
          return 'Situação atualizada.';
        }, data);
      }}>
        <label>Nova situação<select name="status" defaultValue="" required>
          <option value="">Selecione</option>{Object.entries(statuses).filter(([id]) => id !== incident.status)
            .map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select></label>
        <label>Justificativa<input name="justification" required maxLength={500}/></label>
        <button type="submit" disabled={operation.busy}>Revisar mudança</button>
      </form>
      {incident.status_audit.events.length > 0 && <ul className="plain evidence-list">{incident.status_audit.events.map(event =>
        <li key={event.id}><strong>{statuses[event.previous_status]} → {statuses[event.new_status]}</strong>
          <small>{formatDate(event.recorded_at)} · {event.justification}</small></li>)}</ul>}
    </section>}
  </>;
}

export function PageEvidence({api, project, page, setGuard, refresh}: {
  api: AdminApi; project: string; page: string; setGuard: SetGuard; refresh?: () => void;
}) {
  const [id, setId] = useState(() => crypto.randomUUID());
  const [refreshCount, setRefreshCount] = useState(0);
  const operation = useOperation(setGuard);
  return <details className="panel">
    <summary>Evidência de acesso à LP original</summary>
    {operation.notice()}
    <p>Registre metadados de um log próprio ou autorizado. Informe apenas o tipo de recurso, a fonte e, se disponível, o horário declarado no log.</p>
    <form onSubmit={event => {
      const form = event.currentTarget;
      const fields = formData(event);
      const time = value(fields, 'accessed');
      const accessed = time ? new Date(time) : null;
      if (accessed && !Number.isFinite(accessed.getTime())) {
        operation.setError(new InputError('Confira a data e a hora informadas.'));
        return;
      }
      const source = value(fields, 'source');
      const resource = value(fields, 'resource');
      operation.review('Registrar evidência de acesso', <p>{resource} · {accessed ? formatDate(accessed.toISOString()) : 'Horário desconhecido'}</p>, async () => {
        const result = await api.request<{state: string}>('original-requests', {project, page, id, source, resource,
          authorized: fields.has('authorized'), ...(accessed ? {accessed_at: accessed.toISOString()} : {})});
        form.reset();
        setId(crypto.randomUUID());
        setRefreshCount(current => current + 1);
        refresh?.();
        return result.state === 'ALREADY_IMPORTED' ? 'Esta evidência já está registrada.' : 'Evidência registrada como declaração administrativa.';
      }, fields);
    }}>
      <label>Fonte do log<select name="source" required defaultValue="">
        <option value="">Selecione</option><option value="owned_access_log">Log próprio</option><option value="authorized_provider_log">Log de provedor autorizado</option>
      </select></label>
      <label>Tipo de recurso<select name="resource" required defaultValue="">
        <option value="">Selecione</option><option value="HTML">HTML</option><option value="SCRIPT">Script</option>
        <option value="STYLE">Folha de estilos</option><option value="IMAGE">Imagem</option><option value="OTHER">Outro</option>
      </select></label>
      <label>Horário declarado no log, no fuso deste navegador<input name="accessed" type="datetime-local" step="1"/></label>
      <label className="check"><input name="authorized" type="checkbox" required/>Tenho autorização para usar este log.</label>
      <div><button disabled={operation.busy}>Revisar evidência</button></div>
    </form>
    {!refresh && <ReceiptHistory key={refreshCount} api={api} project={project} pid={page}/>}
  </details>;
}

function ReceiptHistory({api, project, pid}: {api: AdminApi; project: string; pid?: string}) {
  type Page = {available: boolean; events: unknown[]; next_after: string | null};
  const [state, setState] = useState<Page>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  async function load(restart = false) {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const next = await api.request<Page>('receipt-history', {project, ...(pid && uuid.test(pid) ? {page: pid} : {}),
        ...(!restart && state?.next_after ? {after: state.next_after} : {})});
      setState({...next, events: [...(restart ? [] : state?.events ?? []), ...next.events]});
    } catch (error) { setError(error); }
    finally { setBusy(false); }
  }
  return <details><summary>{pid ? 'Histórico de recibos da LP' : 'Histórico de recibos do projeto'}</summary>
    <p>Consulta dos recibos retidos nos últimos 7 dias.</p>
    {error !== undefined && <Failure error={error}/>}
    {state && (!state.available ? <p>Recibos indisponíveis.</p> : state.events.length ?
      <pre tabIndex={0}><code>{JSON.stringify(state.events, null, 2)}</code></pre> : <p>Nenhum recibo no recorte.</p>)}
    <div className="action-links">
      <button type="button" disabled={busy} onClick={() => void load(true)}>{busy ? 'Consultando…' : state ? 'Atualizar recibos' : 'Consultar histórico'}</button>
      {state?.next_after && <button type="button" disabled={busy} onClick={() => void load()}>Carregar mais recibos</button>}
    </div>
  </details>;
}
