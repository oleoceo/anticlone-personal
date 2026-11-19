import {useState} from 'react';
import {AdminApi, type Page, type Project, type ProjectHistory, type ProjectState} from './admin-api';
import {DetailsData, formData, InputError, useOperation, value, type SetGuard} from './operations';
import {Failure, labels, Loading, useQuery} from './ui';

type Lifecycle = {state: string; version: string; deletedAt: string | null; audit?: unknown[];
  confirmation?: string; inventory?: Record<string, number>; remove?: Record<string, number>; retain?: Record<string, number>};
const names = {'pause-project': 'Pausar projeto', 'resume-project': 'Reativar projeto',
  'pause-page': 'Pausar LP', 'resume-page': 'Reativar LP', 'archive-project': 'Arquivar projeto',
  'restore-project': 'Restaurar projeto', 'delete-project': 'Excluir projeto', 'delete-page': 'Excluir LP',
  'add-url': 'Autorizar URL', 'remove-url': 'Remover URL autorizada'};
type LifecycleAction = keyof typeof names;

export function LifecycleControls({api, project, page, afterChange, setGuard}: {
  api: AdminApi; project: Project; page?: Page; afterChange: () => void; setGuard: SetGuard;
}) {
  const key = project.id + (page ? ':' + page.id : '');
  const projectState = useQuery(project.id, signal => api.request<ProjectState>('pages', {project: project.id, action: 'project-state'}, signal));
  const lifecycle = useQuery(key, signal => api.request<Lifecycle>('pages', {project: project.id,
    ...(page ? {page: page.id, action: 'preview-delete-page'} : {action: 'lifecycle-status'})}, signal));
  const [historyOpen, setHistoryOpen] = useState(false);
  const history = useQuery(historyOpen ? project.id : '', signal => api.request<ProjectHistory>('project-history', {project: project.id}, signal));
  const [preview, setPreview] = useState<Lifecycle>();
  const operation = useOperation(setGuard);
  const disabled = operation.busy || projectState.pending || lifecycle.pending;
  const status = page ? projectState.data?.pages.find(item => item.id === page.id)?.lifecycle_state : lifecycle.data?.state;
  const record = lifecycle.data;
  const scope = {project: project.id, ...(page ? {page: page.id} : {})};
  const refresh = () => { projectState.revalidate(); lifecycle.revalidate(); setPreview(undefined); };
  const apply = async (action: LifecycleAction, fields: object = {}) => {
    await api.request('pages', {...scope, action, ...fields});
    refresh();
    afterChange();
    if (action === 'add-url') return 'URL autorizada para a LP.';
    if (action === 'remove-url') return 'URL removida da LP.';
    return names[action] + ' · alteração registrada.';
  };
  function stateButton(action: LifecycleAction) {
    return <button type="button" disabled={disabled} onClick={() => operation.review(names[action],
      <><p>{project.name}{page ? ' · ' + page.name : ''}</p>
        <p>{action.startsWith('pause') ? 'A pausa suspende novas decisões neste escopo.' :
          'A reativação depende dos controles operacionais vigentes. A instalação continua sujeita à verificação.'}</p></>,
      () => apply(action))}>{names[action]}</button>;
  }

  return <section className="panel" aria-labelledby="lifecycle-title">
    <div className="panel-heading"><h2 id="lifecycle-title">{page ? 'Gestão da LP' : 'Gestão do projeto'}</h2>
      <button type="button" disabled={disabled} onClick={() => { refresh(); afterChange(); }}>Atualizar cadastro</button></div>
    {operation.notice()}
    {lifecycle.error !== undefined ? <Failure error={lifecycle.error} retry={refresh}/> :
      projectState.error !== undefined ? <Failure error={projectState.error} retry={refresh}/> :
      !record || !status ? <Loading/> : <>
      <p>Estado do cadastro · <strong>{record.deletedAt ? 'Excluído' : labels[status] ?? status}</strong></p>
      {page ? <>
        {projectState.data?.state !== 'ARCHIVED' && !record.deletedAt && (status === 'ACTIVE' || page.enabled) &&
          stateButton(status === 'ACTIVE' ? 'pause-page' : 'resume-page')}
        {!record.deletedAt && projectState.data?.state !== 'ARCHIVED' && <>
          <p>Durante a troca de URL, duas URLs autorizadas mantêm a página em observação. Após remover a antiga, revise novamente as políticas da LP.</p>
          <form onSubmit={event => {
            const fields = formData(event);
            const url = value(fields, 'url');
            operation.review(names['add-url'], <p>{page.name} · {url}</p>, () => apply('add-url', {url}), fields);
          }}>
            <label>Nova URL autorizada<input name="url" type="url" required maxLength={2048}/></label>
            <button type="submit" disabled={disabled}>Revisar nova URL</button>
          </form>
          {page.urls.length > 1 && <ul className="plain evidence-list">{page.urls.map(item => {
            const url = item.origin + item.pathname;
            return <li key={url}>{url} <button type="button" disabled={disabled} onClick={() =>
              operation.review(names['remove-url'], <p>{page.name} · {url}</p>, () => apply('remove-url', {url}))}>Remover URL</button></li>;
          })}</ul>}
        </>}
      </> : <>
        {status !== 'ARCHIVED' && stateButton(status === 'ACTIVE' ? 'pause-project' : 'resume-project')}
        <button type="button" disabled={disabled || historyOpen} onClick={() => setHistoryOpen(true)}>Consultar histórico de cadastro</button>
        {history.error !== undefined && <Failure error={history.error} retry={history.revalidate}/>}
        {historyOpen && history.pending && <Loading/>}
        {history.data && <><DetailsData heading="Registros de cadastro" data={history.data.registration}/>
          <DetailsData heading="Histórico administrativo do projeto e eventos globais" data={history.data.changes ?? []}/></>}
        {!!record.audit?.length && <DetailsData heading="Histórico de alterações de estado" data={record.audit}/>}
        <details><summary>{status === 'ARCHIVED' ? 'Restaurar projeto' : 'Arquivar projeto'}</summary>
          <form onSubmit={event => {
            const fields = formData(event);
            const action = status === 'ARCHIVED' ? 'restore-project' : 'archive-project';
            operation.review(names[action], <><p>{project.name} · versão {record.version}</p>
              <p>{status === 'ARCHIVED' ? 'O projeto volta pausado. O backlog permanece sujeito à revisão.' :
                'O arquivo suspende a operação do projeto e preserva o histórico.'}</p></>,
            () => apply(action, {version: record.version, justification: value(fields, 'reason')}), fields);
          }}>
            <label>Justificativa<input name="reason" minLength={3} maxLength={300} required/></label>
            <button type="submit" disabled={disabled}>Revisar mudança de estado</button>
          </form>
        </details>
      </>}
      {!record.deletedAt && (page ? projectState.data?.state !== 'ARCHIVED' : status === 'ARCHIVED') && <details>
        <summary>{page ? 'Exclusão da LP' : 'Exclusão lógica do projeto'}</summary>
        <p>{page ? 'A exclusão retira URLs e vínculos da LP. O servidor preserva o histórico. A restauração da LP não está disponível.' :
          'A exclusão lógica preserva os dados e permite restauração para o estado pausado.'}</p>
        <button type="button" disabled={disabled} onClick={() => {
          operation.review('Consultar impacto da exclusão', <p>{page?.name ?? project.name}</p>, async () => {
            const next = await api.request<Lifecycle>('pages', {...scope, action: page ? 'preview-delete-page' : 'preview-delete-project'});
            setPreview(next);
            return 'Impacto consultado.';
          });
        }}>Consultar impacto</button>
        {preview?.confirmation && !preview.deletedAt && <form onSubmit={event => {
          const fields = formData(event);
          const confirmation = value(fields, 'confirmation');
          const action = page ? 'delete-page' : 'delete-project';
          if (confirmation !== preview.confirmation) {
            operation.setError(new InputError('Digite exatamente o texto de confirmação exibido.'));
            return;
          }
          operation.review(names[action], <p>{page?.name ?? project.name} · versão {preview.version}</p>,
            () => apply(action, {version: preview.version, confirmation, justification: value(fields, 'reason')}), fields);
        }}>
          <DetailsData heading="Registros afetados" data={preview.inventory ?? {remover: preview.remove, preservar: preview.retain}}/>
          <p>Digite <code>{preview.confirmation}</code></p>
          <label>Confirmação exata<input name="confirmation" required maxLength={260}/></label>
          <label>Justificativa<input name="reason" minLength={3} maxLength={300} required/></label>
          <button type="submit" disabled={disabled}>Revisar exclusão</button>
        </form>}
      </details>}
      {!page && status === 'ARCHIVED' && <PurgePreview api={api} project={project.id}/>}
    </>}
  </section>;
}

function PurgePreview({api, project}: {api: AdminApi; project: string}) {
  const [open, setOpen] = useState(false);
  const query = useQuery(open ? project : '', signal => api.request<{blockers: {table: string; reason: string; rows?: number}[]}>(
    'pages', {project, action: 'preview-purge-project'}, signal));
  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Consultar bloqueios da purga física</summary>
    <p>A remoção definitiva está bloqueada. A consulta lista dependências e registros preservados.</p>
    {query.error !== undefined ? <Failure error={query.error} retry={query.retry}/> : query.pending ? <Loading/> :
      query.data && <ul className="plain evidence-list">{query.data.blockers.map((item, index) => <li key={index}>
        <strong>{item.table}{item.rows !== undefined ? ' · ' + item.rows + ' registro(s)' : ''}</strong><small>{item.reason}</small>
      </li>)}</ul>}
  </details>;
}
