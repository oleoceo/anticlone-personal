import {useState} from 'react';
import {AdminApi, type Page} from './admin-api';
import {Back, pagePath} from './navigation';
import {Confirm, Failure, Heading, labels, Loading, useQuery} from './ui';

const resources = {
  SCRIPT: ['runtime.js', 'core.js', 'fallback.js'],
  TELEMETRY: ['observe', 'observe/fallback', 'entry-decision', 'cta-refresh', 'observed-session', 'observed-action'],
  STATIC_ASSETS: ['html.gif', 'css.gif', 'cta-inventory.js'],
};
type Role = keyof typeof resources;
type Distribution = {
  state: 'PUBLISHED' | 'NOT_PUBLISHED' | 'NOT_INSTALLED';
  distribution: null | {version: number; bases: Record<Role, string>; paths?: Record<string, string>};
  snippets?: {html: string; css: string} | null;
  history?: {version: number; created_at: string; reason: string | null}[];
  aliasActivity?: {alias: string; version: number; role: string; source: string; last_received_at: string}[];
  diagnostic?: {
    status: string;
    controlledVerification: {status: string; reason?: string};
    signals: {source: string; last_observed_at: string}[];
    layers: {layer: string; status: string}[];
  };
};
type Collection = {
  installation: null | {enabled: boolean; origin: string; originMatches: boolean};
  signals: {source: string; lastObservedAt: string}[];
};
type Action = 'publish' | 'rotate' | 'verify' | 'enable' | 'disable';
const actionText: Record<Action, {name: string; description: string}> = {
  publish: {name: 'Publicar endereços de instalação', description: 'O servidor gera os endereços da página usando as origens operacionais configuradas no ambiente privado.'},
  rotate: {name: 'Publicar nova revisão', description: 'Use os novos trechos nas próximas instalações. Os endereços já publicados continuam válidos.'},
  verify: {name: 'Verificar instalação', description: 'O servidor vai verificar a URL oficial cadastrada com o verificador isolado, quando configurado.'},
  enable: {name: 'Habilitar coleta na origem principal', description: 'Esta configuração vale para a origem principal de todo o projeto.'},
  disable: {name: 'Desabilitar coleta na origem principal', description: 'Esta configuração vale para a origem principal de todo o projeto.'},
};
const layerLabels: Record<string, string> = {
  bootstrap: 'Bootstrap', core: 'Core', fallback: 'Fallback',
  html_canary: 'Canário HTML', css_canary: 'Canário CSS',
};
const roleLabels: Record<Role, string> = {SCRIPT: 'Scripts', TELEMETRY: 'Telemetria', STATIC_ASSETS: 'Recursos estáticos'};
const utcDate = new Intl.DateTimeFormat('pt-BR', {dateStyle: 'short', timeStyle: 'short'});
const diagnosticReasons: Record<string, string> = {
  ISOLATED_VERIFIER_UNAVAILABLE: 'O verificador isolado não está disponível para esta consulta.',
  CONFIGURATION_CHANGED: 'A configuração mudou durante a verificação. Confira a LP antes de executar outra consulta.',
};

function date(value: string) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? utcDate.format(parsed) : 'Data indisponível';
}

function Snippet({code, language}: {code: string; language: string}) {
  const [feedback, setFeedback] = useState('');
  return <section className="snippet" aria-label={'Trecho ' + language}>
    <div className="panel-heading"><h3>{language}</h3>
      <button type="button" onClick={async () => {
        try {
          await navigator.clipboard.writeText(code);
          setFeedback(language + ' copiado.');
        } catch {
          setFeedback('Selecione o trecho para copiá-lo.');
        }
      }}>Copiar {language}</button>
    </div>
    <pre tabIndex={0}><code>{code}</code></pre>
    {feedback && <p role="status">{feedback}</p>}
  </section>;
}

export function Installation({api, project, page, setGuard}: {
  api: AdminApi; project: string; page: Page; setGuard: (guard: 'clean' | 'saving') => void;
}) {
  const scope = {project, page: page.id};
  const query = useQuery(page.id, signal => api.request<Distribution>('distribution', {action: 'inspect', ...scope}, signal));
  const collection = useQuery(project, signal => api.request<Collection>('installation', {project}, signal));
  const [result, setResult] = useState<Distribution>();
  const [collectionResult, setCollectionResult] = useState<Collection>();
  const [confirmation, setConfirmation] = useState<Action>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState('');
  const data = result ?? query.data;
  const collected = collectionResult ?? collection.data;
  const published = data?.distribution;
  const diagnostic = data?.diagnostic;

  async function execute(action: Action) {
    setConfirmation(undefined);
    setBusy(true);
    setGuard('saving');
    setError(undefined);
    setNotice('');
    try {
      if (action === 'enable' || action === 'disable') {
        const status = await api.request<Collection>('installation-' + action, {project});
        setCollectionResult(status);
        setNotice(status.installation?.enabled ? 'Coleta habilitada.' : 'Coleta desabilitada.');
      } else {
        const status = await api.request<Distribution>('distribution', {action, ...scope});
        setResult(status);
        setNotice(action === 'verify' ? 'Resultado da verificação atualizado.' : 'Endereços de instalação publicados.');
      }
    } catch (problem) {
      setError(problem);
      // The operation may already have committed. Re-read before the next action.
      reconsult();
    } finally {
      setBusy(false);
      setGuard('clean');
    }
  }

  function reconsult() {
    setResult(undefined);
    setCollectionResult(undefined);
    query.retry();
    collection.retry();
  }

  return <>
    <Back to={pagePath(project, page.id)}>Voltar para {page.name}</Back>
    <Heading title="Instalar a proteção" description={page.name}
      actions={<button type="button" disabled={busy} onClick={reconsult}>Atualizar situação</button>}/>
    {error !== undefined && <Failure error={error}/>}
    {notice && <p className="notice" role="status">{notice}</p>}
    <section className="panel">
      <div className="panel-heading"><h2>Endereços de instalação</h2>
        {published && <span className="badge success">Revisão {published.version}</span>}
      </div>
      {page.urls.map(url => <p className="muted" key={url.origin + url.pathname}>{url.origin + url.pathname}</p>)}
      {query.error !== undefined && !result && <Failure error={query.error} retry={query.retry}/>}
      {!data && query.error === undefined && <Loading/>}
      {data?.state === 'NOT_INSTALLED' && <p className="notice">Distribuição indisponível neste ambiente.</p>}
      {data?.state === 'NOT_PUBLISHED' && <>
        <p>Publique os endereços desta página para obter os trechos de instalação.</p>
        <button className="primary" type="button" disabled={busy || !page.enabled}
          onClick={() => setConfirmation('publish')}>Publicar endereços de instalação</button>
      </>}
      {data?.snippets && <>
        <ol className="installation-guide"><li>Copie o HTML para a página oficial.</li>
          <li>Copie o CSS para os estilos da página e aplique a classe <code>anticlone-canary</code> a um elemento existente.</li>
          <li>Publique as alterações no seu site e volte para conferir a situação.</li></ol>
        <div className="snippets">
          <Snippet key={'html:' + published?.version} code={data.snippets.html} language="HTML"/>
          <Snippet key={'css:' + published?.version} code={data.snippets.css} language="CSS"/>
        </div>
      </>}
      {published && <details>
        <summary>Recursos, revisões e rotação</summary>
        <dl className="review resources">
          {(Object.keys(resources) as Role[]).map(role => <div key={role}>
            <dt>{roleLabels[role]}</dt><dd>
              <ul>{resources[role].map(name => <li key={name}><code>{published.bases[role] + (published.paths?.[name] ?? name)}</code></li>)}</ul>
            </dd>
          </div>)}
        </dl>
        <h3>Histórico de revisões</h3>
        <ul>{data.history?.map(item => <li key={item.version}>Revisão {item.version} · {date(item.created_at)}
          {item.reason === 'rotate' && ' · Rotação'}</li>)}</ul>
        <h3>Atividade dos endereços</h3>
        {data.aliasActivity?.length ? <ul>{data.aliasActivity.map(item =>
          <li key={item.alias + ':' + item.source}>Revisão {item.version} · {layerLabels[item.source] ?? item.source} · {date(item.last_received_at)}</li>)}</ul>
          : <p className="muted">Nenhum acesso registrado no período disponível.</p>}
        <button type="button" disabled={busy || !page.enabled} onClick={() => setConfirmation('rotate')}>Publicar nova revisão</button>
      </details>}
    </section>
    <section className="panel">
      <div className="panel-heading"><h2>Conferir situação</h2>
        {diagnostic && <span className="badge">{labels[diagnostic.status] ?? diagnostic.status}</span>}
      </div>
      {diagnostic && <>
        <p className="muted">A verificação se refere à carga atual da URL oficial. Os sinais de acesso são exibidos por componente.</p>
        <ul className="layers">{diagnostic.layers.map(layer => <li key={layer.layer}>
          <strong>{layerLabels[layer.layer] ?? layer.layer}</strong>
          <small>{labels[layer.status] ?? layer.status}</small>
        </li>)}</ul>
        <button type="button" disabled={busy || !published || !page.enabled || page.urls.length !== 1}
          onClick={() => setConfirmation('verify')}>Verificar instalação</button>
        {published && page.urls.length !== 1 && <p className="muted">A verificação exige uma única URL oficial.</p>}
        {diagnostic.controlledVerification.reason && <p className="muted">
          {diagnosticReasons[diagnostic.controlledVerification.reason] ?? 'Consulte o detalhe técnico do resultado abaixo.'}
        </p>}
        <details><summary>Detalhes do diagnóstico</summary>
          <dl className="review"><dt>Verificação controlada</dt>
            <dd>{diagnostic.controlledVerification.reason ?? labels[diagnostic.controlledVerification.status] ?? diagnostic.controlledVerification.status}</dd>
          </dl>
          {!!diagnostic.signals.length && <ul>{diagnostic.signals.map(signal => <li key={signal.source}>
            {layerLabels[signal.source] ?? signal.source} · {date(signal.last_observed_at)}</li>)}</ul>}
        </details>
      </>}
      {!diagnostic && <p className="muted">Diagnóstico indisponível.</p>}
      <details>
        <summary>Configurar coleta da origem principal</summary>
        {collection.error !== undefined && !collectionResult && <Failure error={collection.error} retry={collection.retry}/>}
        {!collected && collection.error === undefined && <Loading/>}
        {collected && <>
          <p>Coleta do projeto {collected.installation?.enabled ? 'habilitada' : 'desabilitada'}.</p>
          {collected.installation && <p className="muted">{collected.installation.origin}</p>}
          {collected.installation && !collected.installation.originMatches &&
            <p className="notice">A origem cadastrada na coleta diverge da origem atual do projeto.</p>}
          {!!collected.signals.length && <ul>{collected.signals.map(signal => <li key={signal.source}>
            {layerLabels[signal.source] ?? signal.source} · {date(signal.lastObservedAt)}</li>)}</ul>}
          <button type="button" disabled={busy}
            onClick={() => setConfirmation(collected.installation?.enabled ? 'disable' : 'enable')}>
            {collected.installation?.enabled ? 'Desabilitar coleta' : 'Habilitar coleta'}
          </button>
        </>}
      </details>
    </section>
    {confirmation && <Confirm title={actionText[confirmation].name}
      accept={() => void execute(confirmation)} cancel={() => setConfirmation(undefined)}>
      <p>{actionText[confirmation].description}</p>
    </Confirm>}
  </>;
}
