import {useEffect, useRef, useState, type FormEvent} from 'react';
import {createRoot} from 'react-dom/client';
import {DraftGuard, uuid} from './operations';
import {Conversions} from './conversions';
import {IncidentProjects, Incidents} from './incidents';
import {createBrowserRouter, Link, RouterProvider, useBlocker, useLocation, useNavigate} from 'react-router-dom';
import {AdminApi, type Project, type ProjectState, pageList} from './admin-api';
import {base, Back, Breadcrumbs, type Crumb, installPath, newPagePath, offerPath, pagePath,
  projectPath, projectsPath, readRoute, useContextNavigation, useRestoreScroll, conversionsPath, incidentsPath, projectIncidentsPath} from './navigation';
import {emptyFields, OfferForm} from './offer-form';
import {Installation} from './installation';
import {Brand, Confirm, Failure, Heading, labels, Loading, useQuery} from './ui';
import './style.css';

type Guard = 'dirty' | 'clean' | 'saving';

function Login({api, expired}: {api: AdminApi; expired: boolean}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  async function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const input = new FormData(form);
    setBusy(true);
    setFailed(false);
    try {
      await api.login(String(input.get('password')), String(input.get('code')));
    } catch {
      form.reset();
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }
  return <main className="login">
    <div>
      <Brand/>
      <Heading title="Entre no seu espaço" description="Acesse seus projetos com a senha administrativa e o autenticador."/>
      {expired && <p role="status" className="notice">Sua sessão terminou. Entre novamente para continuar.</p>}
      {failed && <p role="alert" className="notice danger">A entrada falhou. Confira a senha e use um código atual do autenticador.</p>}
      <form onSubmit={authenticate}>
        <label>Senha administrativa<input name="password" type="password" autoComplete="current-password" required disabled={busy}/></label>
        <label>Código do autenticador<input name="code" autoComplete="one-time-code" inputMode="numeric"
          pattern="[0-9]{6}" maxLength={6} required disabled={busy}/></label>
        <button className="primary" type="submit" disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</button>
      </form>
    </div>
  </main>;
}

type ProjectRow = Project & {state?: string; pages?: number};

function ProjectList({api, projects}: {api: AdminApi; projects: Project[]}) {
  const nav = useContextNavigation();
  const metadata = useQuery(projects.map(project => project.id).join(','), async signal => {
    const rows: ProjectRow[] = [];
    // The list endpoint returns only id and name. Limit concurrent status reads.
    for (let start = 0; start < projects.length; start += 4) {
      const group = projects.slice(start, start + 4);
      const batch = await Promise.all(group.map(async project => {
        try {
          const result = await api.request<ProjectState>('pages', {action: 'project-state', project: project.id}, signal);
          return {...project, state: result.state, pages: result.pages.length};
        } catch {
          return project;
        }
      }));
      if (signal.aborted) break;
      rows.push(...batch);
    }
    return rows;
  });
  const rows = metadata.data ?? projects as ProjectRow[];
  const filtered = rows.filter(project =>
    (!nav.filter || project.state === nav.filter) &&
    project.name.toLocaleLowerCase('pt-BR').includes(nav.query.trim().toLocaleLowerCase('pt-BR')));
  const unavailable = metadata.data?.some(project => !project.state);
  return <>
    <Heading title="Meus Projetos" description="Selecione uma oferta para gerenciar as páginas e a instalação."
      actions={<Link className="button primary" {...nav.link(offerPath)}>Proteger oferta</Link>}/>
    <section className="panel">
      <div className="filters">
        <label>Buscar projeto<input type="search" placeholder="Nome da oferta" value={nav.query} maxLength={100}
          onChange={event => nav.setFilters(event.target.value, nav.filter)}/></label>
        <label>Estado<select value={nav.filter} onChange={event => nav.setFilters(nav.query, event.target.value)}>
          <option value="">Todos</option>
          {['ACTIVE', 'PAUSED', 'ARCHIVED'].map(state => <option key={state} value={state}>{labels[state]}</option>)}
        </select></label>
      </div>
      {unavailable && <div className="notice"><p>Alguns estados de projeto estão indisponíveis.</p>
        <button type="button" onClick={metadata.retry}>Consultar novamente</button></div>}
      {!projects.length ? <p className="empty">Você ainda não tem projetos cadastrados.</p> :
        !metadata.data && nav.filter ? <Loading>Consultando estados dos projetos…</Loading> :
        !filtered.length ? <p className="empty">Nenhum projeto corresponde aos filtros.</p> :
        <div className="project-table" role="table" aria-label="Projetos">
          <div className="table-head" role="row">
            <span role="columnheader">Projeto</span><span role="columnheader">Páginas</span>
            <span role="columnheader">Estado</span><span role="columnheader">Ações</span>
          </div>
          {filtered.map(project => {
            const remembered = nav.rememberedPage(project.id);
            return <div className="table-row" key={project.id} role="row">
              <strong role="cell">{project.name}</strong>
              <span role="cell">{project.pages === undefined ? '—' : project.pages + (project.pages === 1 ? ' página' : ' páginas')}</span>
              <span role="cell"><span className={'badge ' + (project.state === 'ACTIVE' ? 'success' : project.state === 'PAUSED' ? 'warning' : '')}>
                {project.state ? labels[project.state] ?? project.state : 'Indisponível'}
              </span></span>
              <span role="cell"><Link className="button" aria-label={'Abrir oferta ' + project.name}
                {...nav.link(remembered ? pagePath(project.id, remembered) : projectPath(project.id))}>Abrir oferta</Link></span>
            </div>;
          })}
        </div>}
    </section>
  </>;
}

function Workspace({api, projects, project, pageId, installation, setGuard}: {
  api: AdminApi; projects: Project[]; project: Project; pageId?: string; installation: boolean; setGuard: (guard: Guard) => void;
}) {
  const nav = useContextNavigation();
  const navigate = useNavigate();
  const list = useQuery(project.id, signal => pageList(api, project.id, signal));
  const pages = list.data?.pages;
  const page = pages?.find(item => item.id === pageId);
  const projectHref = projectPath(project.id);
  const crumbs: Crumb[] = [{label: 'Meus Projetos', path: projectsPath},
    {label: project.name, path: pageId ? projectHref : undefined}];
  if (pageId) crumbs.push({label: page?.name ?? 'Página', path: installation ? pagePath(project.id, pageId) : undefined});
  if (installation) crumbs.push({label: 'Instalação'});

  function choose(path: string) {
    const link = nav.link(path);
    void navigate(link.to, {state: link.state});
  }

  return <>
    <Breadcrumbs items={crumbs}/>
    {!installation && <Back to={pageId ? projectHref : projectsPath}>
      {pageId ? 'Voltar para ' + project.name : 'Voltar para Meus Projetos'}</Back>}
    {!installation && <Heading title={project.name} description="Oferta, páginas e instalação."
      actions={<div className="action-links">
        <Link className="button" {...nav.link(projectIncidentsPath(project.id), pageId ? '?lp=' + pageId : '')}>Incidentes da oferta</Link>
        <Link className="button" {...nav.link(newPagePath(project.id))}>Adicionar página / variação</Link></div>}/>}
    <div className="filters selectors">
      <label>Oferta / projeto<select value={project.id} onChange={event => {
        const next = event.target.value;
        const remembered = nav.rememberedPage(next);
        choose(remembered ? pagePath(next, remembered) : projectPath(next));
      }}>{projects.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
      <label>Página protegida<select value={page?.id ?? ''} disabled={!pages?.length} onChange={event => {
        const next = event.target.value;
        choose(next ? installation ? installPath(project.id, next) : pagePath(project.id, next) : projectHref);
      }}>
        <option value="">Selecione a página</option>
        {pages?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
    </div>
    {list.error !== undefined ? <Failure error={list.error} retry={list.retry}/> : !pages ? <Loading/> :
      pageId && !page ? <section className="panel"><h2>Página indisponível</h2>
        <p>Selecione outra página deste projeto ou volte para a oferta.</p>
        <Back to={projectHref}>Voltar para {project.name}</Back>
      </section> :
      page && installation ? <Installation key={page.id} api={api} project={project.id} page={page} setGuard={setGuard}/> :
      page ? <section className="panel">
        <div className="panel-heading"><h2>{page.name}</h2>
          {!page.enabled && <span className="badge">Inativa</span>}</div>
        <h3>URLs autorizadas</h3>
        <ul className="plain">{page.urls.map(url => <li key={url.origin + url.pathname}>{url.origin + url.pathname}</li>)}</ul>
        {!page.urls.length && <p className="muted">Nenhuma URL está vinculada à página.</p>}
        <div className="action-links"><Link className="button primary" {...nav.link(installPath(project.id, page.id))}>Instalar e conferir</Link>
          <Link className="button" {...nav.link(conversionsPath(project.id, page.id))}>Conversões</Link></div>
      </section> : <section className="panel">
        <h2>Páginas da oferta</h2>
        {!pages.length ? <p className="empty">Cadastre a primeira página para publicar os endereços de instalação.</p> :
          <ul className="plain page-list">{pages.map(item => <li key={item.id}>
            <div><strong>{item.name}</strong>{item.urls.map(url =>
              <small key={url.origin + url.pathname}>{url.origin + url.pathname}</small>)}</div>
            <Link className="button" {...nav.link(pagePath(project.id, item.id))}>Abrir página</Link>
          </li>)}</ul>}
      </section>}
  </>;
}

function PageConversions({api, project, pageId, subview, setGuard}: {
  api: AdminApi; project: Project; pageId: string; subview?: string; setGuard: (guard: Guard) => void;
}) {
  const list = useQuery(project.id, signal => pageList(api, project.id, signal));
  const page = list.data?.pages.find(page => page.id === pageId);
  if (list.error !== undefined) return <Failure error={list.error} retry={list.retry}/>;
  if (!list.data) return <Loading/>;
  return page ? <Conversions key={page.id + ':' + (subview ?? '')} api={api} project={project} page={page} subview={subview} setGuard={setGuard}/> :
    <><Heading title="Página indisponível"/><Back to={projectPath(project.id)}>Voltar para {project.name}</Back></>;
}

function Authenticated({api, logout, guard, fields, setFields, setGuard}: {
  api: AdminApi; logout: () => void; guard: Guard; fields: typeof emptyFields;
  setFields: (fields: typeof emptyFields) => void; setGuard: (guard: Guard) => void;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const nav = useContextNavigation();
  const route = readRoute(location.pathname);
  const projects = useQuery('projects', signal => api.request<Project[]>('projects', undefined, signal));
  const project = projects.data?.find(item => item.id === route.project);
  const incidentActive = route.kind === 'incidents-home' || route.kind === 'incidents' || route.kind === 'incident';
  const requestedPage = new URLSearchParams(location.search).get('lp');
  const queryPage = requestedPage && uuid.test(requestedPage) ? requestedPage : null;
  const currentPage = route.page ?? queryPage ?? (project ? nav.rememberedPage(project.id) : '');
  const incidentLink = nav.link(project ? projectIncidentsPath(project.id) : incidentsPath, currentPage ? '?lp=' + encodeURIComponent(currentPage) : '');

  function finish(projectId: string, page: string) {
    const next = nav.link(installPath(projectId, page));
    setGuard('clean');
    void navigate(next.to, {replace: true, state: {...next.state, from: undefined}});
    projects.retry();
  }

  return <div className="shell">
    <a className="skip" href="#main">Pular para o conteúdo</a>
    <aside className="sidebar">
      <Brand/>
      <nav aria-label="Navegação principal">
        <Link className={!incidentActive ? "nav-current" : undefined} aria-current={!incidentActive ? "location" : undefined}
          {...nav.link(projectsPath)}>Meus Projetos</Link>
        <Link className={incidentActive ? "nav-current" : undefined} aria-current={incidentActive ? "location" : undefined} {...incidentLink}>Incidentes</Link>
        <a href="/admin/ui/">Painel anterior</a>
      </nav>
      <button type="button" disabled={guard === 'saving'} onClick={logout}>Sair da sessão</button>
    </aside>
    <header className="mobile-header"><Brand/><button type="button" disabled={guard === 'saving'} onClick={logout}>Sair</button></header>
    <main className="content" id="main" tabIndex={-1}>
      {route.kind === 'offer' ? <OfferForm key="new-offer" api={api} fields={fields}
        setFields={setFields} setGuard={setGuard} finish={finish}/> :
        projects.error !== undefined ? <Failure error={projects.error} retry={projects.retry}/> :
        !projects.data ? <Loading/> :
        route.kind === 'projects' ? <ProjectList api={api} projects={projects.data}/> :
        route.kind === 'incidents-home' ? <IncidentProjects projects={projects.data}/> :
        !project ? <><Heading title="Projeto indisponível"/><Back to={projectsPath}>Voltar para Meus Projetos</Back></> :
        route.kind === 'new-page' ? <OfferForm key={project.id} api={api} project={project} fields={fields}
          setFields={setFields} setGuard={setGuard} finish={finish}/> :
        route.kind === 'incidents' || route.kind === 'incident' ?
          <DraftGuard key={location.pathname + location.search} setGuard={setGuard}>
            <Incidents api={api} project={project} id={route.incident} action={route.action} setGuard={setGuard}/>
          </DraftGuard> :
        route.kind === 'conversions' ?
          <DraftGuard key={location.pathname + location.search} setGuard={setGuard}>
            <PageConversions api={api} project={project} pageId={route.page} subview={route.subview} setGuard={setGuard}/>
          </DraftGuard> :
        <Workspace api={api} project={project} projects={projects.data} pageId={route.page}
          installation={route.kind === 'installation'} setGuard={setGuard}/>}
    </main>
    <nav className="bottom-nav" aria-label="Navegação principal">
      <Link className={!incidentActive ? "nav-current" : undefined} aria-current={!incidentActive ? "location" : undefined}
        {...nav.link(projectsPath)}>Meus Projetos</Link>
      <Link className={incidentActive ? "nav-current" : undefined} aria-current={incidentActive ? "location" : undefined} {...incidentLink}>Incidentes</Link>
      <a href="/admin/ui/">Painel anterior</a>
    </nav>
  </div>;
}

function App() {
  const [authenticated, setAuthenticated] = useState<boolean>();
  const [sessionError, setSessionError] = useState<unknown>();
  const [logoutError, setLogoutError] = useState<unknown>();
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [fields, setFields] = useState(emptyFields);
  const [guard, setGuardState] = useState<Guard>('clean');
  const guardRef = useRef<Guard>('clean');
  const previouslyAuthenticated = useRef(false);
  const [api] = useState(() => new AdminApi(active => {
    if (active) previouslyAuthenticated.current = true;
    setAuthenticated(active);
  }));
  const location = useLocation();

  function setGuard(next: Guard) {
    guardRef.current = next;
    setGuardState(next);
  }

  const blocker = useBlocker(({currentLocation, nextLocation}) =>
    guardRef.current !== 'clean' && (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search));
  useRestoreScroll(authenticated === true);

  useEffect(() => {
    setFields(emptyFields);
    setGuard('clean');
  }, [location.pathname, location.search]);

  useEffect(() => {
    if (guard === 'clean') return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [guard]);

  function initialize() {
    setSessionError(undefined);
    void api.refresh().catch(setSessionError);
  }

  useEffect(() => { initialize(); }, []);
  useEffect(() => {
    if (!authenticated) return;
    const refresh = () => {
      if (document.visibilityState !== 'hidden') void api.refresh().catch(() => undefined);
    };
    window.addEventListener('focus', refresh);
    window.addEventListener('pageshow', refresh);
    document.addEventListener('visibilitychange', refresh);
    const timer = window.setInterval(refresh, 30_000);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('pageshow', refresh);
      document.removeEventListener('visibilitychange', refresh);
      window.clearInterval(timer);
    };
  }, [api, authenticated]);

  async function logout() {
    setConfirmLogout(false);
    setLogoutError(undefined);
    previouslyAuthenticated.current = false;
    try {
      await api.logout();
      setFields(emptyFields);
      setGuard('clean');
    } catch (error) {
      previouslyAuthenticated.current = true;
      setLogoutError(error);
    }
  }

  if (authenticated === undefined) return <main className="login">
    {sessionError !== undefined ? <Failure error={sessionError} retry={initialize}/> : <Loading>Verificando a sessão…</Loading>}
  </main>;
  if (!authenticated) return <Login api={api} expired={previouslyAuthenticated.current}/>;

  return <>
    <Authenticated api={api} logout={() => setConfirmLogout(true)} fields={fields} setFields={setFields}
      setGuard={setGuard} guard={guard}/>
    {logoutError !== undefined && <div className="feedback"><Failure error={logoutError}/></div>}
    {confirmLogout && <Confirm title="Sair da sessão?" cancel={() => setConfirmLogout(false)}
      accept={() => void logout()} confirmLabel="Sair">
      {guard === 'dirty' && <p>Os dados que você digitou neste formulário serão descartados.</p>}
    </Confirm>}
    {blocker.state === 'blocked' && <Confirm key={blocker.location.key}
      title={guard === 'saving' ? 'Aguarde a operação' : 'Descartar alterações?'}
      cancel={blocker.reset}
      accept={guard === 'saving' ? undefined : () => {
        setGuard('clean');
        blocker.proceed();
      }} confirmLabel="Descartar e sair">
      <p>{guard === 'saving' ? 'O servidor ainda está processando esta operação.' :
        'Você tem dados que ainda não foram salvos.'}</p>
    </Confirm>}
  </>;
}

const router = createBrowserRouter([{path: '*', element: <App/>}], {basename: base});
createRoot(document.getElementById('root')!).render(<RouterProvider router={router}/>);
