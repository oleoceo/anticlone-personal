import {useState, type FormEvent, useRef} from 'react';
import {AdminApi, AdminError, pageList, type Project, type ProjectHistory} from './admin-api';
import {Back, Breadcrumbs, pagePath, projectPath, projectsPath, useContextNavigation} from './navigation';
import {Failure, Heading, useQuery} from './ui';

type Fields = {name: string; origin: string; pageName: string; url: string};
export const emptyFields: Fields = {name: '', origin: '', pageName: '', url: ''};
type PendingProject = {phase: 'project-write'; intent: string; digest: string};
type Checkpoint =
  | PendingProject
  | {phase: 'project-ready'; project: string}
  | {phase: 'page-write'; project: string; digest: string};

const checkpointPrefix = 'anticlone:register:';

function readCheckpoint(key: string): Checkpoint | null {
  try {
    const value = sessionStorage.getItem(key);
    return value ? JSON.parse(value) as Checkpoint : null;
  } catch { return null; }
}

async function identity(...fields: string[]) {
  const result = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(fields)));
  return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, '0')).join('');
}

function normalizedUrl(raw: string, originOnly: boolean) {
  const url = new URL(raw);
  const loopback = ['127.0.0.1', 'localhost'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username || url.password || url.search || url.hash || url.hostname.endsWith('.') ||
      /[\u0000-\u0020\\]/.test(raw) || url.pathname.includes('%') || (originOnly && url.pathname !== '/')) {
    throw new TypeError('URL da oferta');
  }
  return originOnly ? url.origin : url.origin + url.pathname;
}

function rejected(error: unknown) {
  return error instanceof AdminError && error.status >= 400 && error.status < 500;
}

const steps = ['Identificar oferta', 'Informar página', 'Confirmar cadastro', 'Instalar e conferir'];

export function OfferForm({api, project, fields, setFields, setGuard, finish}: {
  api: AdminApi; project?: Project; fields: Fields; setFields: (fields: Fields) => void;
  setGuard: (guard: 'clean' | 'dirty' | 'saving') => void;
  finish: (project: string, page: string) => void;
}) {
  const navigation = useContextNavigation();
  const key = checkpointPrefix + (project?.id ? 'lp:' + project.id : 'new');
  const [checkpoint, setCheckpoint] = useState(() => readCheckpoint(key));
  const [step, setStep] = useState(project || checkpoint?.phase === 'project-ready' ? 1 : 0);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [canEdit, setCanEdit] = useState(false);
  const [retryProject, setRetryProject] = useState(false);
  const [recoveredProject, setRecoveredProject] = useState<Project>();
  const [error, setError] = useState<unknown>();
  const [message, setMessage] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [existingPage, setExistingPage] = useState<{project: string; id: string; name: string}>();
  const savedProject = project?.id ?? (checkpoint && 'project' in checkpoint ? checkpoint.project : undefined);
  const target = useQuery(!project && savedProject ? savedProject : '', async signal =>
    (await api.request<Project[]>('projects', undefined, signal)).find(candidate => candidate.id === savedProject));
  const projectName = project?.name ?? target.data?.name;
  const uncertain = checkpoint && checkpoint.phase !== 'project-ready';
  const parent = project ? projectPath(project.id) : projectsPath;
  const lastPage = project ? navigation.rememberedPage(project.id) : '';
  const returnTo = project && lastPage && navigation.previousPath === pagePath(project.id, lastPage)
    ? navigation.previousPath : parent;

  function saveCheckpoint(next: Checkpoint | null) {
    if (next) sessionStorage.setItem(key, JSON.stringify(next));
    else sessionStorage.removeItem(key);
    setCheckpoint(next);
  }

  function update(field: keyof Fields, value: string) {
    const updated = {...fields, [field]: value};
    setFields(updated);
    setGuard(Object.values(updated).some(Boolean) ? 'dirty' : 'clean');
    setAcknowledged(false);
    setExistingPage(undefined);
    setMessage('');
    setError(undefined);
  }

  async function run(operation: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setExistingPage(undefined);
    setRecoveredProject(undefined);
    setRetryProject(false);
    setCanEdit(false);
    setBusy(true);
    setGuard('saving');
    setError(undefined);
    setMessage('');
    try {
      await operation();
    } catch (problem) {
      setError(problem);
    } finally {
      inFlight.current = false;
      setBusy(false);
      setGuard(Object.values(fields).some(Boolean) ? 'dirty' : 'clean');
    }
  }

  function completed(projectId: string, pageId: string) {
    saveCheckpoint(null);
    finish(projectId, pageId);
  }

  async function createProject(pending?: PendingProject) {
    const name = fields.name.trim();
    const origin = normalizedUrl(fields.origin, true);
    const digest = await identity(name, origin);
    if (pending && digest !== pending.digest) {
      setRetryProject(true);
      setMessage('Informe o mesmo nome e a mesma origem do primeiro envio.');
      return;
    }

    const operation: PendingProject = pending ?? {phase: 'project-write', intent: crypto.randomUUID(), digest};
    saveCheckpoint(operation);
    let created: Project;
    try {
      created = await api.createProject(name, origin, operation.intent);
    } catch (problem) {
      if (!pending && problem instanceof AdminError && [400, 413].includes(problem.status)) saveCheckpoint(null);
      throw problem;
    }
    saveCheckpoint({phase: 'project-ready', project: created.id});
    return created.id;
  }

  async function submit() {
    const pageName = fields.pageName.trim();
    const url = normalizedUrl(fields.url, false);
    const projectId = savedProject ?? await createProject();
    if (!projectId) return;

    saveCheckpoint({phase: 'page-write', project: projectId, digest: await identity(pageName, url)});
    let page: string;
    try {
      ({page} = await api.request<{page: string}>('pages', {action: 'create', project: projectId, name: pageName, url}));
    } catch (problem) {
      if (rejected(problem)) {
        saveCheckpoint(project ? null : {phase: 'project-ready', project: projectId});
        if (problem instanceof AdminError && problem.status === 409) {
          const result = await pageList(api, projectId).catch(() => undefined);
          const existing = result?.pages.find(candidate => candidate.urls.some(item => item.origin + item.pathname === url));
          if (existing) setExistingPage({project: projectId, id: existing.id, name: existing.name});
        }
      }
      throw problem;
    }
    completed(projectId, page);
  }

  async function reconcile(pending: Exclude<Checkpoint, {phase: 'project-ready'}>) {
    if (pending.phase === 'project-write') {
      if (!pending.intent) {
        setMessage('Esta tentativa é anterior à identificação do cadastro. Confira Meus Projetos.');
        return;
      }
      const history = await api.request<ProjectHistory>('project-history', {project: pending.intent});
      const original = history.registration.at(-1);
      if (!original) {
        setRetryProject(true);
        setMessage('O cadastro ainda não aparece no histórico. Você pode reenviar a mesma tentativa.');
      } else if (await identity(original.name, original.origin) !== pending.digest) {
        setMessage('A identificação desta tentativa pertence a outro cadastro. Confira Meus Projetos.');
      } else {
        const projects = await api.request<Project[]>('projects');
        const candidate = projects.find(project => project.id === pending.intent);
        if (candidate) {
          setRecoveredProject(candidate);
          setMessage('Oferta localizada. Confira a identificação antes de vincular a página.');
        } else {
          setMessage('O cadastro aparece no histórico, mas a oferta está indisponível.');
        }
      }
      return;
    }

    const {pages} = await pageList(api, pending.project);
    for (const candidate of pages) {
      for (const url of candidate.urls) {
        if (await identity(candidate.name, url.origin + url.pathname) === pending.digest) {
          setExistingPage({project: pending.project, id: candidate.id, name: candidate.name});
          setMessage('A página foi localizada. Abra a instalação para continuar.');
          return;
        }
      }
    }
    setCanEdit(true);
    setMessage('Nenhuma página foi localizada com os dados enviados. Confira os campos antes de enviar novamente.');
  }

  function advance(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || uncertain) return;
    if (step === 2) {
      if (acknowledged) void run(submit);
      return;
    }
    try {
      normalizedUrl(step === 0 ? fields.origin : fields.url, step === 0);
    } catch {
      setMessage(step === 0 ? 'Informe apenas a origem HTTPS, sem caminho, parâmetros ou fragmento.' :
        'Informe a URL oficial da página, sem parâmetros ou fragmento.');
      return;
    }
    setMessage('');
    setStep(step + 1);
  }

  const projectFields = <>
    <label>Nome da oferta<input autoComplete="off" required maxLength={100} value={fields.name}
      onChange={event => update('name', event.target.value)}/></label>
    <label>Origem oficial<input type="url" inputMode="url" required maxLength={2048} value={fields.origin}
      placeholder="https://…" onChange={event => update('origin', event.target.value)}/></label>
  </>;

  return <>
    <Breadcrumbs items={[{label: 'Meus Projetos', path: projectsPath},
      ...(project ? [{label: project.name, path: parent}] : []),
      {label: project ? 'Adicionar página' : 'Proteger oferta'}]}/>
    <Back to={returnTo}>{project ? 'Voltar para ' + project.name : 'Voltar para Meus Projetos'}</Back>
    <Heading title={project ? 'Adicionar página / variação' : 'Proteger oferta'}
      description={project ? project.name : 'Cadastre a oferta e instale a proteção na primeira página.'}/>
    <ol className="steps" aria-label="Etapas do cadastro">
      {steps.map((label, index) => <li key={label} aria-current={index === step ? 'step' : undefined}>
        <span>{index + 1}</span>{label}</li>)}
    </ol>
    <div className="panel form-panel">
      {savedProject && !project && <p className="notice">Oferta cadastrada. Continue com a primeira página.</p>}
      {message && <p className="notice" role="status">{message}</p>}
      {error !== undefined && <Failure error={error}/>}
      {uncertain ? <>
        <h2>Conferir cadastro</h2>
        <p>O servidor pode ter gravado o cadastro. Consulte o resultado antes de enviar novamente.</p>
        <button className="primary" type="button" disabled={busy}
          onClick={() => void run(() => reconcile(checkpoint))}>{busy ? 'Consultando…' : 'Consultar cadastro'}</button>
        {retryProject && checkpoint.phase === 'project-write' && <form onSubmit={event => {
          event.preventDefault();
          void run(async () => {
            if (await createProject(checkpoint)) {
              setStep(1);
              setAcknowledged(false);
            }
          });
        }}>
          {projectFields}
          <div className="actions"><button type="submit" disabled={busy}>Reenviar cadastro da oferta</button></div>
        </form>}
        {recoveredProject && <div className="notice">
          <strong>{recoveredProject.name}</strong>
          <p className="identifier">{recoveredProject.id}</p>
          <button type="button" onClick={() => {
            saveCheckpoint({phase: 'project-ready', project: recoveredProject.id});
            setStep(1);
            setAcknowledged(false);
            setRecoveredProject(undefined);
            setMessage('');
          }}>Usar oferta localizada</button>
        </div>}
        {canEdit && <button className="secondary-action" type="button" onClick={() => {
          saveCheckpoint(!project && savedProject ? {phase: 'project-ready', project: savedProject} : null);
          setStep(savedProject ? 1 : 0);
          setAcknowledged(false);
          setCanEdit(false);
          setMessage('');
        }}>Revisar dados do cadastro</button>}
      </> : <form onSubmit={advance}>
        <h2>{['Identificar oferta', 'Informar página', 'Confira antes de cadastrar'][step]}</h2>
        {step === 0 && projectFields}
        {step === 1 && <>
          <label>Nome da página<input autoComplete="off" required maxLength={100} value={fields.pageName}
            onChange={event => update('pageName', event.target.value)}/></label>
          <label>URL oficial da página<input type="url" inputMode="url" required maxLength={2048} value={fields.url}
            placeholder="https://…" onChange={event => update('url', event.target.value)}/></label>
        </>}
        {step === 2 && <>
          <dl className="review">
            <dt>Oferta</dt><dd>{savedProject ? projectName ?? savedProject : fields.name}
              {savedProject && projectName && <small className="identifier"> · {savedProject}</small>}</dd>
            {!savedProject && <><dt>Origem oficial</dt><dd>{fields.origin}</dd></>}
            <dt>Página</dt><dd>{fields.pageName}<br/>{fields.url}</dd>
          </dl>
          <p className="notice">{savedProject ? 'A página será vinculada à oferta.' : 'O servidor cadastra primeiro a oferta e depois a página.'}
            {' '}Você publica os endereços de instalação em uma etapa separada.</p>
          <label className="check"><input type="checkbox" checked={acknowledged}
            onChange={event => setAcknowledged(event.target.checked)}/>Conferi os dados da oferta e da página.</label>
        </>}
        <div className="actions">
          {step > (savedProject ? 1 : 0) && <button type="button" disabled={busy} onClick={() => {
            setStep(step - 1); setMessage(''); setError(undefined); setAcknowledged(false);
          }}>Corrigir {step === 2 ? 'página' : 'oferta'}</button>}
          <button className="primary" type="submit" disabled={busy || (step === 2 && !acknowledged)}>
            {busy ? 'Cadastrando…' : step < 2 ? 'Continuar' : savedProject ? 'Cadastrar página' : 'Cadastrar oferta e página'}
          </button>
        </div>
      </form>}
      {existingPage && <p><button type="button" onClick={() => completed(existingPage.project, existingPage.id)}>
        Abrir instalação de {existingPage.name}
      </button></p>}
    </div>
  </>;
}
