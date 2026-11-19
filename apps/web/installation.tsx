import {useState} from 'react';
import {AdminApi, type Page} from './admin-api';
import {Link} from 'react-router-dom';
import {Back, conversionsPath, installPath, pagePath, projectIncidentsPath, protectionPath, useContextNavigation} from './navigation';
import {healthPath, installationMessages, publicationIssueMessages, publicationLabel, roleLabels, type InstallationStatus} from './installation-status';
import {Confirm, Failure, Heading, labels, Loading, useQuery} from './ui';

const resources = {
  SCRIPT: ['runtime.js', 'core.js', 'fallback.js'],
  TELEMETRY: ['observe', 'observe/fallback', 'entry-decision', 'cta-refresh', 'observed-session', 'observed-action'],
  STATIC_ASSETS: ['html.gif', 'css.gif', 'cta-inventory.js'],
};
type Role = keyof typeof resources;
type Distribution = InstallationStatus & {
  distribution: null | {version: number; bases: Record<Role, string>; paths?: Record<string, string>};
  snippets?: {html: string; css: string} | null;
  history?: {version: number; created_at: string; reason: string | null}[];
  aliasActivity?: {alias: string; version: number; role: string; source: string; last_received_at: string}[];
  verificationAttempt?: NonNullable<InstallationStatus['diagnostic']>['controlledVerification'];
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
const utcDate = new Intl.DateTimeFormat('pt-BR', {dateStyle: 'short', timeStyle: 'short'});

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
  const nav = useContextNavigation();
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
        setNotice(action === 'verify' && status.verificationAttempt
          ? (labels[status.verificationAttempt.status] ?? status.verificationAttempt.status) + ' · ' +
            (installationMessages[status.verificationAttempt.reason] ?? 'Confira o diagnóstico abaixo.')
          : 'Endereços de instalação publicados.');
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
      actions={<button type="button" disabled={busy} onClick={() => {setError(undefined); setNotice(''); reconsult();}}>Atualizar situação</button>}/>
    <nav className="tabs" aria-label="Áreas da LP">
      <Link aria-current="page" {...nav.link(installPath(project, page.id))}>Instalação</Link>
      <Link {...nav.link(protectionPath(project, page.id))}>Políticas de proteção</Link>
      <Link {...nav.link(conversionsPath(project, page.id))}>Conversões e CTAs</Link>
      <Link {...nav.link(projectIncidentsPath(project), '?lp=' + page.id)}>Incidentes da LP</Link>
    </nav>
    {error !== undefined && <Failure error={error}/>}
    {notice && <p className="notice" role="status">{notice}</p>}
    <section className="panel">
      <div className="panel-heading"><h2>Endereços de instalação</h2>
        {data && <span className={'badge ' + (published || data.publication.ready ? 'success' : 'warning')}>
          {published ? 'Revisão ' + published.version : publicationLabel(data)}</span>}
      </div>
      {page.urls.map(url => <p className="muted" key={url.origin + url.pathname}>{url.origin + url.pathname}</p>)}
      {query.error !== undefined && !result && <Failure error={query.error} retry={query.retry}/>}
      {!data && query.error === undefined && <Loading/>}
      {!!data?.publication.issues.length && <div className="notice">
        <strong>{published ? 'Publicação de novas revisões bloqueada' : 'O que falta para publicar'}</strong>
        <ul>{publicationIssueMessages(data.publication.issues).map(message => <li key={message}>{message}</li>)}</ul>
        <Link {...nav.link(healthPath)}>Consultar Saúde e operações</Link>
      </div>}
      {data?.publication.ready && (!published || data.publication.changesRequired) && <>
        <p>{published ? 'As origens configuradas mudaram. Publique para obter trechos com os novos endereços.' :
          'A configuração permite gerar os trechos HTML e CSS. A entrega dos recursos é conferida na instalação.'}</p>
        {!page.enabled && <p>Reative a LP na oferta para publicar pelo painel.</p>}
        <button className="primary" type="button" disabled={busy || !page.enabled}
          onClick={() => setConfirmation('publish')}>Publicar endereços de instalação</button>
      </>}
      {data?.snippets && <>
        <div className="snippets">
          <Snippet key={'html:' + published?.version} code={data.snippets.html} language="HTML"/>
          <Snippet key={'css:' + published?.version} code={data.snippets.css} language="CSS"/>
        </div>
        <ol className="installation-guide"><li>Insira o HTML na página oficial. O Core é carregado pelo Bootstrap.</li>
          <li>Inclua o CSS nos estilos da página e aplique <code>anticlone-canary</code> a um elemento existente.</li>
          <li>Publique no seu site, abra a URL oficial e atualize o diagnóstico abaixo.</li></ol>
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
        {!data.publication.rotationAvailable && <p>{installationMessages.ROTATION_SCHEMA_MISSING}</p>}
        {data.publication.ready && data.publication.rotationAvailable && <button type="button" disabled={busy || !page.enabled}
          onClick={() => setConfirmation('rotate')}>Publicar nova revisão</button>}
      </details>}
    </section>
    <section className="panel">
      <div className="panel-heading"><h2>Conferir situação</h2>
        {diagnostic && <span className="badge">{labels[diagnostic.status] ?? diagnostic.status}</span>}
      </div>
      {diagnostic && <>
        {data.verification.ready && <button className="primary" type="button" disabled={busy}
          onClick={() => setConfirmation('verify')}>Verificar instalação</button>}
        {data.verification.issue && <p className="notice">{installationMessages[data.verification.issue]}</p>}
        {diagnostic.controlledVerification.checkedAt && <p>
          {date(diagnostic.controlledVerification.checkedAt)} · {installationMessages[diagnostic.controlledVerification.reason]}</p>}
        {data.verification.ready && !diagnostic.controlledVerification.checkedAt && <p className="muted">
          {installationMessages.NO_CURRENT_VERIFICATION}</p>}
        <ul className="layers">{diagnostic.layers.map(layer => <li key={layer.layer}>
          <strong>{layerLabels[layer.layer] ?? layer.layer}</strong>
          <small>{layer.controlled === 'OBSERVED' ? 'Comprovado na carga verificada' :
            layer.controlled === 'NOT_OBSERVED' ? 'Sem prova na carga verificada' : 'Sem prova controlada atual'}</small>
          <small className="muted">{layer.status === 'UNKNOWN' ? 'Sem sinal recente' : labels[layer.status]}</small>
        </li>)}</ul>
        <details><summary>Detalhes do diagnóstico</summary>
          <p>Recebimentos passivos podem ser declarados. O teste controlado mede canais na carga ensaiada. A mitigação é avaliada separadamente.</p>
          {diagnostic.status !== 'NOT_VERIFIED' && diagnostic.controlledVerification.layers && <dl className="review">
            <dt>Envio de observação pelo Core</dt><dd>{diagnostic.controlledVerification.layers.core_observation ? 'Recebido' : 'Sem prova nesta carga'}</dd>
            <dt>Fallback com Core bloqueado</dt><dd>{diagnostic.controlledVerification.layers.fallback_independent ? 'Recebido' : 'Sem prova nesta carga'}</dd>
          </dl>}
          {!!diagnostic.signals.length && <ul>{diagnostic.signals.map(signal => <li key={signal.source}>
            {layerLabels[signal.source] ?? signal.source} · {date(signal.last_observed_at)}</li>)}</ul>}
        </details>
      </>}
      {!diagnostic && data && <p className="muted">Instale a distribuição no ambiente para consultar as camadas.</p>}
      {busy && <Loading>Operação em andamento…</Loading>}
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
          <button type="button" disabled={busy || !!collected.installation && !collected.installation.originMatches && !collected.installation.enabled}
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
