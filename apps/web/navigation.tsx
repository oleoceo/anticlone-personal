import {useEffect, useLayoutEffect, useRef, type PropsWithChildren} from 'react';
import {Link, useLocation, useNavigate, useNavigationType} from 'react-router-dom';

export const base = '/admin/ui/novo';
export const projectsPath = '/projetos';
export const offerPath = '/proteger-oferta';
export const projectPath = (project: string) => projectsPath + '/' + project;
export const newPagePath = (project: string) => projectPath(project) + '/nova-lp';
export const pagePath = (project: string, page: string) => projectPath(project) + '/lps/' + page;
export const installPath = (project: string, page: string) => pagePath(project, page) + '/instalacao';

type Trail = {path: string};
type HistoryContext = {query?: string; filter?: string; pages?: Record<string, string>; from?: Trail};
const pageId = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;

export function readRoute(path: string) {
  const [, , project, area, page, view] = path.replace(/\/$/, '').split('/');
  if (path === offerPath || path === offerPath + '/') return {kind: 'offer' as const};
  if (!project) return {kind: 'projects' as const};
  if (area === 'nova-lp') return {kind: 'new-page' as const, project};
  if (area === 'lps' && page && pageId.test(page)) {
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
    return {
      query, filter,
      pages: route.page ? {...state.pages, [route.project]: route.page} : state.pages,
    };
  }

  function link(path: string) {
    const search = path === projectsPath && ['ACTIVE', 'PAUSED', 'ARCHIVED'].includes(filter)
      ? '?estado=' + filter : '';
    return {to: {pathname: path, search}, state: {...context(), from: {path: location.pathname}}};
  }

  function back(path: string) {
    // Only go back when this entry was opened from the requested screen.
    if (state.from?.path.replace(/\/$/, '') === path && window.history.state?.idx > 0) {
      void navigate(-1);
    } else {
      void navigate(link(path).to, {state: context(), replace: true});
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

export function Back({to, children}: PropsWithChildren<{to: string}>) {
  const nav = useContextNavigation();
  return <button className="back" type="button" onClick={() => nav.back(to)}>← {children}</button>;
}

export type Crumb = {label: string; path?: string};
export function Breadcrumbs({items}: {items: Crumb[]}) {
  const nav = useContextNavigation();
  return <nav className="breadcrumbs" aria-label="Localização"><ol>
    {items.map((item, index) => <li key={index}>
      {item.path ? <Link {...nav.link(item.path)}>{item.label}</Link> : <span aria-current="page">{item.label}</span>}
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
