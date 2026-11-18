import {useEffect, useLayoutEffect, useRef, type PropsWithChildren} from 'react';
import {Link, useLocation, useNavigate, useNavigationType} from 'react-router-dom';

export const base = '/admin/ui/novo';
export const projectsPath = '/projetos';
export const offerPath = '/proteger-oferta';
export const projectPath = (project: string) => projectsPath + '/' + project;
export const newPagePath = (project: string) => projectPath(project) + '/nova-lp';
export const pagePath = (project: string, page: string) => projectPath(project) + '/lps/' + page;
export const incidentsPath = '/incidentes';
export const projectIncidentsPath = (project: string) => projectPath(project) + incidentsPath;
export const incidentPath = (project: string, incident: string) => projectIncidentsPath(project) + '/' + incident;
export const conversionsPath = (project: string, page: string) => pagePath(project, page) + '/conversoes';
export const installPath = (project: string, page: string) => pagePath(project, page) + '/instalacao';

type Trail = {path: string};
type HistoryContext = {incidentText?: string; query?: string; filter?: string; pages?: Record<string, string>; from?: Trail};
const pageId = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;

export function sectionParams(search: string) {
  const params = new URLSearchParams(search);
  const result = new URLSearchParams();
  const lp = params.get('lp');
  const days = params.get('dias');
  const status = params.get('situacao');
  const surface = params.get('superficie');
  if (lp && pageId.test(lp)) result.set('lp', lp);
  if (days && ['1', '7', '30'].includes(days)) result.set('dias', days);
  if (status && ['unverified', 'investigating', 'confirmed_copy', 'false_positive'].includes(status)) result.set('situacao', status);
  if (surface && /^[A-Za-z0-9_-]{1,64}$/.test(surface)) result.set('superficie', surface);
  return result;
}

export function searchOf(params: URLSearchParams) {
  return params.size ? '?' + params.toString() : '';
}

export function readRoute(path: string) {
  const [, , project, area, page, view, subview] = path.replace(/\/$/, '').split('/');
  if (path === offerPath || path === offerPath + '/') return {kind: 'offer' as const};
  if (path.replace(/\/$/, '') === incidentsPath) return {kind: 'incidents-home' as const};
  if (!project) return {kind: 'projects' as const};
  if (area === 'nova-lp') return {kind: 'new-page' as const, project};
  if (area === 'incidentes') {
    if (!page) return {kind: 'incidents' as const, project};
    const action: 'redirecionar' | 'substituir-cta' | undefined = view === 'redirecionar' || view === 'substituir-cta' ? view : undefined;
    return {kind: 'incident' as const, project, incident: page, action};
  }
  if (area === 'lps' && page && pageId.test(page)) {
    if (view === 'conversoes') return {kind: 'conversions' as const, project, page, subview};
    return {kind: view === 'instalacao' ? 'installation' as const : 'page' as const, project, page};
  }
  return {kind: 'project' as const, project};
}

export function useContextNavigation() {
  const location = useLocation();
  const navigate = useNavigate();
  const state = (location.state ?? {}) as HistoryContext;
  const route = readRoute(location.pathname);
  const query = typeof state.query === 'string' ? state.query : '';
  const storedFilter = new URLSearchParams(location.search).get('estado') ?? state.filter ?? '';
  const filter = ['ACTIVE', 'PAUSED', 'ARCHIVED'].includes(storedFilter) ? storedFilter : '';

  function context(): HistoryContext {
    const selectedPage = route.page ?? new URLSearchParams(location.search).get('lp');
    return {
      query, filter, incidentText: state.incidentText,
      pages: route.project && selectedPage && pageId.test(selectedPage)
        ? {...state.pages, [route.project]: selectedPage} : state.pages,
    };
  }

  function link(path: string, searchOverride?: string) {
    const search = searchOverride !== undefined ? searchOf(sectionParams(searchOverride)) : (path === projectsPath && ['ACTIVE', 'PAUSED', 'ARCHIVED'].includes(filter)
      ? '?estado=' + filter : '');
    return {to: {pathname: path, search}, state: {...context(), from: {path: location.pathname}}};
  }

  function back(path: string, search?: string) {
    // Only go back when this entry was opened from the requested screen.
    if (state.from?.path.replace(/\/$/, '') === path && window.history.state?.idx > 0) {
      void navigate(-1);
    } else {
      void navigate(link(path, search).to, {state: context(), replace: true});
    }
  }

  function setFilters(nextQuery: string, nextFilter: string) {
    const search = nextFilter ? '?estado=' + nextFilter : '';
    void navigate({pathname: location.pathname, search}, {
      replace: true,
      preventScrollReset: true,
      state: {...state, query: nextQuery, filter: nextFilter},
    });
  }

  function rememberedPage(project: string) {
    const id = state.pages?.[project];
    return typeof id === 'string' && pageId.test(id) ? id : '';
  }

  return {link, back, query, filter, setFilters, rememberedPage, previousPath: state.from?.path};
}

export function Back({to, search, children}: PropsWithChildren<{to: string; search?: string}>) {
  const nav = useContextNavigation();
  return <button className="back" type="button" onClick={() => nav.back(to, search)}>← {children}</button>;
}

export type Crumb = {label: string; path?: string; search?: string};
export function Breadcrumbs({items}: {items: Crumb[]}) {
  const nav = useContextNavigation();
  return <nav className="breadcrumbs" aria-label="Localização"><ol>
    {items.map((item, index) => <li key={index}>
      {item.path ? <Link {...nav.link(item.path, item.search)}>{item.label}</Link> : <span aria-current="page">{item.label}</span>}
    </li>)}
  </ol></nav>;
}

export function useRestoreScroll(visible: boolean) {
  const location = useLocation();
  const action = useNavigationType();
  const offsets = useRef(new Map<string, number>());
  const previousPath = useRef('');
  useEffect(() => {
    const restoration = history.scrollRestoration;
    history.scrollRestoration = 'manual';
    return () => { history.scrollRestoration = restoration; };
  }, []);

  useLayoutEffect(() => {
    if (!visible) return;
    const pathChanged = previousPath.current !== location.pathname;
    previousPath.current = location.pathname;
    const target = action === 'POP' ? offsets.current.get(location.key) ?? 0 : 0;
    let restoring = action === 'POP' && target > 0;
    const remember = () => {
      if (!restoring) offsets.current.set(location.key, window.scrollY);
    };
    let resize: ResizeObserver | undefined;
    function restore() {
      window.scrollTo(0, target);
      if (window.scrollY >= target - 1) {
        restoring = false;
        resize?.disconnect();
        remember();
      }
    }
    function cancelRestore() {
      restoring = false;
      resize?.disconnect();
      remember();
    }
    if (restoring) {
      resize = new ResizeObserver(restore);
      resize.observe(document.body);
      restore();
    } else if (pathChanged || action === 'POP') {
      window.scrollTo(0, 0);
    }
    window.addEventListener('scroll', remember, {passive: true});
    window.addEventListener('pointerdown', cancelRestore, {once: true});
    if (pathChanged) document.querySelector<HTMLElement>('#main')?.focus({preventScroll: true});
    return () => {
      resize?.disconnect();
      window.removeEventListener('scroll', remember);
      window.removeEventListener('pointerdown', cancelRestore);
    };
  }, [location.key, location.pathname, action, visible]);
}
