import {useState} from 'react';
import {AdminApi, type Page, type Project} from './admin-api';
import {CtaWorkspace} from './cta-workspace';
import {DetailsData, InputError, emptyAllocation, formData, trafficLabels, useOperation, value, type Allocation, type SetGuard} from './operations';
import type {Incident, Operational, PageProtection, Protection, ProtectionAction} from './protection-contracts';
import {Failure, Heading, Loading, useQuery} from './ui';

export function useProtection(api: AdminApi, project: string, page: string) {
  const pr = useQuery(project, signal => api.request<Protection>('protection', {project, action: 'inspect', data: null}, signal));
  const lp = useQuery(project + ':' + page, signal => api.request<PageProtection>('pages', {project, page, action: 'inspect'}, signal));
  return {pr, lp, refresh() { pr.revalidate(); lp.revalidate(); }};
}

export function scopedProtection(protection: Protection, lp: PageProtection) {
  const allowed = new Set(lp.ctaPolicies.filter(policy => policy.active && (!policy.bound_page || policy.bound_page === lp.page.id))
    .map(policy => policy.version));
  return {...protection, ctaSurfaces: protection.ctaSurfaces.filter(policy => allowed.has(policy.version))};
}

export function ProtectionScreen({api, project, page, incident, action, setGuard}: {
  api: AdminApi; project: Project; page: Page; incident: Incident; action: ProtectionAction; setGuard: SetGuard;
}) {
  const pageAction = action === 'redirecionar';
  const data = useProtection(api, project.id, page.id);
  const authorization = useQuery(page.id, signal => api.request<Operational>('operational', {
    project: project.id, page: page.id, action: 'inspect',
  }, signal));
  const operation = useOperation(setGuard);
  const controls = {...operation, busy: operation.busy || data.pr.pending || data.lp.pending || authorization.pending};
  function refresh() { data.refresh(); authorization.revalidate(); }

  return <>
    <Heading title={pageAction ? 'Redirecionar página' : 'Substituir CTA'} description={project.name + ' · ' + page.name + ' · ' + incident.host}
      actions={<button type="button" disabled={controls.busy} onClick={refresh}>Atualizar situação</button>}/>
    <ol className="steps protection-steps" aria-label="Etapas de proteção">
      <li><span>1</span>Publicar política</li><li><span>2</span>Aprovar na LP</li><li><span>3</span>Autorizar contexto</li>
    </ol>
    {operation.notice()}
    {data.pr.error !== undefined && <Failure error={data.pr.error} retry={data.pr.revalidate}/>}
    {data.lp.error !== undefined && <Failure error={data.lp.error} retry={data.lp.revalidate}/>}
    {data.pr.data && data.lp.data ? <>
      <PolicyEditor api={api} project={project} page={page} protection={data.pr.data} pageState={data.lp.data}
        pageAction={pageAction} operation={controls} refresh={refresh}/>
      {!pageAction && <CtaWorkspace api={api} project={project.id} page={page} protection={scopedProtection(data.pr.data, data.lp.data)}
        refresh={refresh} setGuard={setGuard}/>}
      <Approval api={api} project={project.id} page={page} state={data.lp.data} operation={controls} refresh={refresh}/>
      {authorization.error !== undefined ? <Failure error={authorization.error} retry={authorization.revalidate}/> :
        authorization.data ? <Authorization api={api} project={project.id} page={page} incident={incident}
          state={authorization.data} pageState={data.lp.data} operation={controls} refresh={refresh}/> : <Loading/>}
    </> : data.pr.error === undefined && data.lp.error === undefined && <Loading/>}
  </>;
}

type Operation = ReturnType<typeof useOperation>;

function PolicyEditor({api, project, page, protection, pageState, pageAction, operation, refresh}: {
  api: AdminApi; project: Project; page: Page; protection: Protection; pageState: PageProtection; pageAction: boolean;
  operation: Operation; refresh: () => void;
}) {
  const current = pageAction ? protection.page : null;
  const scoped = scopedProtection(protection, pageState);
  const [changing, setChanging] = useState(false);
  const urls = page.urls.map(url => url.origin + url.pathname);
  const initialPath = page.urls.length === 1 ? page.urls[0].pathname : '';
  const name = pageAction ? 'PAGE_REDIRECT' : 'REPLACE_CONVERSION';
  return <section className="panel operation-section">
    <div className="panel-heading"><h2>Publicar política</h2>
      {pageAction && current && <span className="badge">Versão do projeto {current.version}</span>}
    </div>
    <p>Escolha o destino e a proporção de tráfego por origem. A publicação gera uma versão para a etapa de aprovação.</p>
    {!pageAction && scoped.ctaSurfaces.length > 0 && <ul className="plain evidence-list">
      {scoped.ctaSurfaces.filter(policy => page.urls.some(url => url.pathname === policy.pathname)).map(policy =>
        <li key={policy.surface}><strong>{policy.surface}</strong><small>{policy.pathname} · versão {policy.version} · {policy.enabled ? 'Habilitada na política' : 'Desabilitada'}</small></li>)}
    </ul>}
    <form onChange={() => setChanging(true)} onSubmit={event => {
      const data = formData(event);
      const allocation = {...emptyAllocation};
      for (const key of Object.keys(allocation) as (keyof Allocation)[]) allocation[key] = Number(data.get(key));
      const common = {enabled: data.get('enabled') === 'on', stealth: data.get('stealth') === 'on', stealth_version: 2, allocation};
      const surface = value(data, 'surface');
      const pathname = value(data, 'pathname');
      const payload = pageAction ? {...common, approved_destination: value(data, 'destination')} : {...common, surface, pathname};
      if (!pageAction) {
        const problem = ctaScopeError(protection, pageState, surface, pathname);
        if (problem) { operation.setError(new InputError(problem)); return; }
      }
      const surfaceVersion = protection.ctaSurfaces.find(policy => policy.surface === surface)?.version;
      operation.review('Publicar ' + name, <>
        <p>{project.name} · {page.name}</p>
        <p>{pageAction ? value(data, 'destination') : value(data, 'surface') + ' · ' + value(data, 'pathname')}</p>
        <p>{common.enabled ? 'Política habilitada' : 'Política desabilitada'} · Stealth {common.stealth ? 'ligado' : 'desligado'}</p>
        <AllocationList allocation={allocation}/>
      </>, async () => {
        if (!pageAction) {
          const [latest, latestPage] = await Promise.all([
            api.request<Protection>('protection', {project: project.id, action: 'inspect', data: null}),
            api.request<PageProtection>('pages', {project: project.id, page: page.id, action: 'inspect'}),
          ]);
          const problem = ctaScopeError(latest, latestPage, surface, pathname);
          if (latest.ctaSurfaces.find(policy => policy.surface === surface)?.version !== surfaceVersion) {
            throw new InputError('A versão da superfície mudou. Atualize a situação antes de publicar.');
          }
          if (problem || latestPage.page.url_generation !== pageState.page.url_generation) {
            throw new InputError(problem ?? 'As URLs da LP mudaram. Atualize a situação antes de publicar.');
          }
        }
        const result = await api.request<{version: number}>('protection', {
          project: project.id, action: pageAction ? 'page-publish' : 'cta-publish', data: payload,
        });
        setChanging(false);
        refresh();
        return 'Política publicada. Versão ' + result.version + '.';
      }, data);
    }}>
      {pageAction ? <label>Destino da página
        <input name="destination" type="url" required maxLength={2048} defaultValue={current?.approved_destination}
          list="page-destinations"/>
        <datalist id="page-destinations">{[...new Set([...urls, ...protection.externalDestinations])].map(url => <option key={url} value={url}/>)}</datalist>
      </label> : <div className="filters">
        <label>Superfície de CTA<input name="surface" required pattern="[A-Za-z0-9_\-]+" maxLength={64} list="cta-surfaces"/>
          <datalist id="cta-surfaces">{scoped.ctaSurfaces.map(policy => <option key={policy.surface} value={policy.surface}/>)}</datalist>
        </label>
        <label>Caminho da LP<input name="pathname" required pattern="/(?:[A-Za-z0-9_\-]|/){0,200}" maxLength={201} defaultValue={initialPath}
          list="cta-paths"/><datalist id="cta-paths">{[...new Set(page.urls.map(url => url.pathname))].map(path => <option key={path} value={path}/>)}</datalist>
        </label>
      </div>}
      <fieldset className="allocation">
        <legend>Percentual por classe</legend>
        {Object.entries(trafficLabels).map(([key, label]) => <label key={key}>{label}
          <select name={key} defaultValue={current?.allocation[key as keyof Allocation] ?? 0}>
            {Array.from({length: 11}, (_, index) => <option key={index} value={index * 10}>{index * 10}%</option>)}
          </select></label>)}
      </fieldset>
      <label className="check"><input type="checkbox" name="enabled" defaultChecked={current?.enabled ?? false}/>Habilitar nesta versão</label>
      <label className="check"><input type="checkbox" name="stealth" defaultChecked={current?.stealth ?? false}/>Aplicar Stealth nesta política</label>
      <button type="submit" className="primary" disabled={operation.busy || !changing}>Revisar publicação</button>
    </form>
    {pageAction && protection.versions.length > 0 && <DetailsData heading="Versões publicadas no projeto" data={protection.versions}/>}
  </section>;
}

function ctaScopeError(protection: Protection, page: PageProtection, surface: string, pathname: string) {
  if (!page.urls.some(url => url.pathname === pathname)) return 'Selecione um caminho cadastrado nesta LP.';
  const active = protection.ctaSurfaces.find(policy => policy.surface === surface);
  if (!active) return null;
  const match = page.ctaPolicies.find(policy => policy.version === active.version && policy.active);
  if (!match) return 'A situação desta superfície está indisponível. Atualize a situação e revise novamente.';
  if (match.bound_page && match.bound_page !== page.page.id) return 'A superfície está vinculada a outra LP.';
  const migration = match.bound_page === page.page.id && page.page.url_review_required && page.urls.length === 1;
  if (active.pathname !== pathname && !migration) return 'A superfície já está publicada para outro caminho.';
  return null;
}

function AllocationList({allocation}: {allocation: Allocation}) {
  return <ul className="plain">{Object.entries(trafficLabels).map(([key, label]) =>
    <li key={key}>{label} · {allocation[key as keyof Allocation]}%</li>)}</ul>;
}

function Approval({api, project, page, state, operation, refresh}: {
  api: AdminApi; project: string; page: Page; state: PageProtection; operation: Operation;
  refresh: () => void;
}) {
  const entries = state.entryPolicies.filter(policy => policy.enabled && (policy.stealth || policy.stealth_version === 2));
  const ctas = state.ctaPolicies.filter(policy => policy.active && policy.enabled && (!policy.bound_page || policy.bound_page === page.id) &&
    state.urls.some(url => url.pathname === policy.pathname));
  const boundEntries = state.entryPolicies.filter(policy => policy.bound);
  const boundCtas = state.ctaPolicies.filter(policy => policy.bound);
  const [selection, setSelection] = useState<string>();
  const entry = selection ?? String(boundEntries[0]?.version ?? '');
  const entryPolicy = entries.find(item => String(item.version) === entry);
  return <section className="panel operation-section">
    <div className="panel-heading"><h2>Aprovar políticas na LP</h2>
      <span className="badge">{state.page.url_review_required ? 'Revisão pendente' : 'URL revisada'}</span></div>
    {state.urls.length !== 1 ? <p className="notice">A aprovação exige uma única URL oficial.</p> :
      <p>Selecione todas as versões que devem compor a aprovação de {page.name}. A seleção substitui os vínculos atuais da LP.</p>}
    {!!boundEntries.length && <p className="muted">Redirecionamento vinculado · v{boundEntries[0].version}</p>}
    {!!boundCtas.length && <p className="muted">CTAs vinculados · {boundCtas.map(policy => policy.surface + ' v' + policy.version).join(', ')}</p>}
    {(entries.length > 0 || ctas.length > 0) && state.urls.length === 1 && <form
      onSubmit={event => {
        const data = formData(event);
        const entryVersion = entryPolicy?.version ?? null;
        const chosen = ctas.filter(policy => data.getAll('cta').includes(String(policy.version)));
        if (!entryVersion && !chosen.length) {
          operation.setError(new InputError('Selecione pelo menos uma versão para aprovar.'));
          return;
        }
        const removed = [
          ...boundEntries.filter(policy => policy.version !== entryVersion).map(policy => 'Redirecionamento v' + policy.version),
          ...boundCtas.filter(policy => !chosen.some(item => item.version === policy.version)).map(policy => policy.surface + ' v' + policy.version),
        ];
        operation.review('Aprovar versões na LP', <>
          <p>{page.name} · {state.urls[0].origin + state.urls[0].pathname}</p>
          {entryPolicy && <p>Redirecionamento v{entryPolicy.version} · {entryPolicy.approved_destination}</p>}
          {chosen.map(policy => <details key={policy.version}><summary>{policy.surface} · versão {policy.version}</summary>
            <AllocationList allocation={policy.allocation}/>
            <ul className="plain">{state.points.filter(point => point.surface === policy.surface).map(point =>
              <li key={point.id}>{point.marker ?? 'Sem marcador'} · {point.url ?? 'Sem destino mapeado'}</li>)}</ul>
          </details>)}
          {!!removed.length && <p className="notice">Vínculos substituídos ou removidos · {removed.join(', ')}</p>}
        </>, async () => {
          const result = await api.request<{approval: string}>('pages', {
            project, page: page.id, action: 'approve', entryVersion, ctaVersions: chosen.map(item => item.version),
            generation: state.page.url_generation, configGeneration: state.page.config_generation,
          });
          setSelection(undefined);
          refresh();
          return 'Aprovação registrada. Referência ' + result.approval + '.';
        }, data);
      }}>
      <label>Versão de redirecionamento<select value={entryPolicy ? entry : ''} onChange={event => setSelection(event.target.value)}>
        <option value="">Sem redirecionamento</option>
        {entries.map(policy => <option key={policy.version} value={policy.version}>Versão {policy.version} · {policy.approved_destination}</option>)}
      </select></label>
      {ctas.length > 0 && <fieldset><legend>Versões de CTA</legend>
        {ctas.map(policy => <label className="check" key={policy.version + ":" + Boolean(policy.bound)}>
          <input type="checkbox" name="cta" value={policy.version} defaultChecked={policy.bound}/>{policy.surface} · versão {policy.version}
        </label>)}
      </fieldset>}
      <button type="submit" className="primary" disabled={operation.busy || !state.page.enabled}>Revisar aprovação</button>
    </form>}
    {entries.length === 0 && ctas.length === 0 && <p className="empty">Nenhuma versão habilitada disponível para seleção.</p>}
  </section>;
}

function Authorization({api, project, page, incident, state, pageState, operation, refresh}: {
  api: AdminApi; project: string; page: Page; incident: Incident; state: Operational; pageState: PageProtection;
  operation: Operation; refresh: () => void;
}) {
  const approvalVisible = pageState.approvalId !== null && pageState.urls.length === 1 && !pageState.page.url_review_required &&
    (pageState.entryPolicies.some(policy => policy.bound) || pageState.ctaPolicies.some(policy => policy.bound));
  const existing = state.state;
  const versions = (page: PageProtection) => ({
    approvalId: page.approvalId, generation: page.page.url_generation, config: page.page.config_generation, review: page.page.url_review_required,
    entry: page.entryPolicies.filter(policy => policy.bound).map(policy => 'Redirecionamento v' + policy.version),
    cta: page.ctaPolicies.filter(policy => policy.bound).map(policy => policy.surface + ' v' + policy.version),
  });
  const reviewed = versions(pageState);
  const context = existing ? existing.copy_origin + existing.copy_pathname : '';
  return <section className="panel operation-section">
    <h2>Autorizar contexto operacional</h2>
    <p>Confirme a origem HTTPS e o caminho exato. A autorização desta LP vale para o conjunto aprovado. A vigência é avaliada pelo servidor.</p>
    {existing && <p>Última revisão {existing.revision} · {existing.enabled ? 'Autorização registrada' : 'Suspensa'} · {context}</p>}
    {!approvalVisible && <p className="notice">Conclua a aprovação da LP antes de autorizar o contexto.</p>}
    {approvalVisible && <form onSubmit={event => {
      const fields = formData(event);
      const copyOrigin = value(fields, 'origin');
      const copyPathname = value(fields, 'pathname');
      let observedHost = '';
      try { observedHost = new URL(copyOrigin).hostname.toLowerCase(); } catch { /* Server validates the origin. */ }
      if (observedHost !== incident.host.toLowerCase()) {
        operation.setError(new InputError('Informe a origem HTTPS do domínio deste incidente.'));
        return;
      }
      operation.review('Autorizar contexto', <>
        <p>{page.name} · {copyOrigin}{copyPathname}</p>
        <p>Conjunto vinculado · {[...reviewed.entry, ...reviewed.cta].join(', ')}</p>
      </>, async () => {
        const latest = await api.request<PageProtection>('pages', {project, page: page.id, action: 'inspect'});
        if (JSON.stringify(versions(latest)) !== JSON.stringify(reviewed)) {
          throw new InputError('A configuração da LP mudou. Atualize a situação e revise a autorização novamente.');
        }
        const result = await api.request<Operational>('operational', {project, page: page.id, action: 'authorize',
          revision: existing?.revision ?? 0, expectedApprovalId: reviewed.approvalId, copyOrigin, copyPathname, acknowledgeUntrustedContext: fields.get('assent') === 'on'});
        refresh();
        return 'Autorização registrada. Revisão ' + result.state?.revision + '.';
      }, fields);
    }}>
      <div className="filters">
        <label>Origem HTTPS observada<input name="origin" type="url" required maxLength={2048} placeholder="https://dominio"
          defaultValue={existing?.copy_origin}/></label>
        <label>Caminho exato da cópia<input name="pathname" required maxLength={201} pattern="/(?:[A-Za-z0-9_\-]|/){0,200}"
          defaultValue={existing?.copy_pathname}/></label>
      </div>
      <label className="check"><input name="assent" type="checkbox" required/>Conferi o contexto e reconheço que o domínio observado é uma alegação.</label>
      <button type="submit" className="primary" disabled={operation.busy}>Revisar autorização</button>
    </form>}
    {existing?.enabled && <button type="button" disabled={operation.busy} onClick={() =>
      operation.review('Suspender autorização', <p>{page.name} · {context}</p>, async () => {
        await api.request('operational', {project, page: page.id, action: 'suspend', revision: existing.revision});
        refresh();
        return 'Autorização suspensa.';
      })}>Suspender autorização</button>}
  </section>;
}
