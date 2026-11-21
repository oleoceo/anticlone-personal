import {useState, type ReactNode} from 'react';
import {AdminApi, type Page} from './admin-api';
import {Link} from 'react-router-dom';
import {Back, conversionsPath, installPath, pagePath, projectIncidentsPath, protectionPath, settingsPath, useContextNavigation} from './navigation';
import {healthPath, installationMessages, publicationIssueMessages, publicationLabel, roleLabels, telemetryEndpointLabels, type InstallationStatus} from './installation-status';
import {Confirm, Failure, Heading, labels, Loading, useQuery} from './ui';

const resources = {
  SCRIPT: ['runtime.js', 'core.js', 'fallback.js'],
  TELEMETRY: ['observe', 'observe/fallback', 'entry-decision', 'cta-refresh', 'observed-session', 'observed-action'],
  STATIC_ASSETS: ['html.gif', 'css.gif', 'cta-inventory.js'],
};
type Role = keyof typeof resources;
type Distribution = InstallationStatus & {
  telemetryOrigins?: string[];
  telemetryEndpoints?: {origin:string;state:keyof typeof telemetryEndpointLabels}[];
  selectedTelemetryOrigin?: string | null;
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
const placements = {
  'HTML': {
    head: 'Cole os dois scripts no arquivo da LP, antes de </head>.',
    body: 'Cole a imagem antes de </body> e acrescente a classe a um elemento visível que já exista.',
    css: 'Cole a regra na folha de estilos carregada pela LP. Se usar CSS no próprio HTML, coloque a regra entre <style> e </style> no HEAD.',
  },
  'React/Vite': {
    head: 'Cole os dois scripts no <head> do index.html do Vite.',
    body: 'Cole a imagem antes de </body> no index.html. Aplique a classe com className no componente que renderiza o elemento visível.',
    css: 'Cole a regra em um CSS global importado pela aplicação, como o arquivo de estilos do ponto de entrada.',
  },
  'WordPress': {
    head: 'Use o recurso de inserção de código do tema ou um plugin com regras por página. Insira os dois scripts no cabeçalho HTML da LP.',
    body: 'Na LP, cole a imagem em um bloco HTML personalizado. Em um bloco visível, abra Avançado → Classe(s) CSS adicional(is) e digite anticlone-canary sem o ponto.',
    css: 'Cole a regra no CSS adicional do tema ou na folha de estilos do tema filho.',
  },
};
type Technology = keyof typeof placements;
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
const installGuides = {
  HTML: 'Cole o trecho HTML na página oficial. Adicione o CSS aos estilos e aplique a classe anticlone-canary a um elemento existente.',
  'React / Vite': 'Inclua o trecho HTML no arquivo HTML de entrada. Adicione o CSS aos estilos globais e aplique a classe anticlone-canary via className. Confira o resultado no build publicado.',
  WordPress: 'Use um recurso autorizado do site para inserir o HTML e o CSS. Aplique a classe anticlone-canary a um bloco existente e, se houver cache, confira a versão publicada.',
} as const;
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

export function Installation({api, project, page, context, setGuard}: {
  api: AdminApi; project: string; page: Page; context: ReactNode; setGuard: (guard: 'clean' | 'saving') => void;
}) {
  const nav = useContextNavigation();
  const [technology, setTechnology] = useState<Technology>('HTML');
  const scope = {project, page: page.id};
  const query = useQuery(page.id, signal => api.request<Distribution>('distribution', {action: 'inspect', ...scope}, signal));
  const collection = useQuery(project, signal => api.request<Collection>('installation', {project}, signal));
  const [result, setResult] = useState<Distribution>();
  const [collectionResult, setCollectionResult] = useState<Collection>();
  const [confirmation, setConfirmation] = useState<Action>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState('');
  const [telemetry, setTelemetry] = useState<string>();
  const data = result ?? query.data;
  const collected = collectionResult ?? collection.data;
  const published = data?.distribution;
  const currentEndpoint = data?.selectedTelemetryOrigin ?? '';
  const unavailableEndpoints = data?.telemetryEndpoints?.filter(endpoint => endpoint.state !== 'OPERATIONAL') ?? [];
  const preserveSelection = 'current';
  const selectedTelemetry = telemetry ?? (currentEndpoint ? preserveSelection : '');
  const pendingTelemetry = telemetry !== undefined && telemetry !== preserveSelection &&
    (telemetry !== currentEndpoint || !!telemetry && !!published &&
      Object.values(published.bases).some(base => new URL(base).origin !== telemetry));
  const canPublish = data && (pendingTelemetry ? (telemetry ?
    data.telemetryOrigins?.includes(telemetry) && !data.publication.issues.some(issue => issue.code === 'DISTRIBUTION_SCHEMA_MISSING') :
    data.publication.defaultsReady) : data.publication.ready);
  const diagnostic = data?.diagnostic;
  const officialUrl = page.urls.length === 1 ? page.urls[0].origin + page.urls[0].pathname : null;
  const guide = placements[technology];
  const snippetLines = data?.snippets?.html.split('\n');
  const head = snippetLines?.filter(line => line.startsWith('<script ')).join('\n');
  const body = snippetLines?.find(line => line.startsWith('<img '));

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
        const status = await api.request<Distribution>('distribution', {action, ...scope,
          ...(action !== 'verify' && telemetry !== undefined && telemetry !== preserveSelection ? {telemetryOrigin:telemetry || null} : {})});
        if (action !== 'verify') setTelemetry(undefined);
        setResult(status);
        setNotice(action === 'verify' && status.verificationAttempt
          ? (labels[status.verificationAttempt.status] ?? status.verificationAttempt.status) + ' · ' +
            (installationMessages[status.verificationAttempt.reason] ?? 'Confira o diagnóstico abaixo.')
          : action === 'verify' ? 'Diagnóstico atualizado.' : 'Endereços de instalação publicados.');
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
    <div className="installation-context">
      <Back to={pagePath(project, page.id)}>Voltar para {page.name}</Back>
      <Heading title="Instalar a proteção"/>
      {context}
    </div>
    <nav className="tabs" aria-label="Áreas da LP">
      <Link aria-current="page" {...nav.link(installPath(project, page.id))}>Instalação</Link>
      <Link {...nav.link(protectionPath(project, page.id))}>Políticas de proteção</Link>
      <Link {...nav.link(conversionsPath(project, page.id))}>Conversões e CTAs</Link>
      <Link {...nav.link(projectIncidentsPath(project), '?lp=' + page.id)}>Incidentes da LP</Link>
    </nav>
    {error !== undefined && <Failure error={error}/>}
    {notice && <p className="notice" role="status">{notice}</p>}
    <section className="panel" aria-labelledby="install-distribution">
      <div className="panel-heading"><h2 id="install-distribution">Endereços de instalação</h2>
        {data && <span className={'badge ' + (published || data.publication.ready ? 'success' : 'warning')}>
          {published ? 'Revisão ' + published.version : publicationLabel(data)}</span>}
      </div>
      <dl className="installation-target">
        <dt>{page.urls.length === 1 ? 'URL oficial' : 'URLs cadastradas'}</dt>
        {page.urls.length ? page.urls.map(url => <dd key={url.origin + url.pathname}>{url.origin + url.pathname}</dd>) :
          <dd>Nenhuma URL cadastrada.</dd>}
      </dl>
      {query.error !== undefined && !result && <Failure error={query.error} retry={query.retry}/>}
      {!data && query.error === undefined && <Loading/>}
      {!canPublish && !!data?.publication.issues.length && <div className="notice">
        <strong>{published ? 'Publicação de novas revisões bloqueada' : 'O que falta para publicar'}</strong>
        <ul>{publicationIssueMessages(data.publication.issues).map(message => <li key={message}>{message}</li>)}</ul>
        <Link {...nav.link(healthPath)}>Consultar Saúde e operações</Link>
      </div>}
      {published && <p className="muted">Endpoint na revisão publicada: <code>{new URL(published.bases.TELEMETRY).origin}</code></p>}
      {data && (!!data.telemetryEndpoints?.length || !!data.telemetryOrigins?.length || !!currentEndpoint) &&
        <label className="installation-technology">Endpoint de telemetria<select value={selectedTelemetry} disabled={busy}
          onChange={event => setTelemetry(event.target.value)}>
          {currentEndpoint && <option value={preserveSelection}>Manter endereços da revisão atual</option>}
          <option value="">Usar origem padrão</option>
          {data.telemetryOrigins?.map(origin => <option key={origin}>{origin}</option>)}
          {unavailableEndpoints.map(({origin,state})=>
            <option key={origin} value={origin} disabled>{origin} · {telemetryEndpointLabels[state]}</option>)}
        </select></label>}
      {data?.telemetryOrigins?.length === 0 &&
        <Link {...nav.link(settingsPath + '/integracoes')}>Conferir endpoints de telemetria</Link>}
      {canPublish && (!published || data.publication.changesRequired || pendingTelemetry) && <>
        <p>{published ? 'Publique uma revisão para gerar trechos com os endereços selecionados.' :
          'Publique os endereços para gerar os trechos HTML e CSS desta página.'}</p>
        {!page.enabled && <p>Reative a LP na oferta para publicar pelo painel.</p>}
        <button className="primary" type="button" disabled={busy || !page.enabled}
          onClick={() => setConfirmation('publish')}>Publicar endereços de instalação</button>
      </>}
      {published && head && body && data.snippets && <div className="installation-steps">
        <label>Tecnologia do site <select value={technology}
          onChange={event => setTechnology(event.target.value as Technology)}>
          {(Object.keys(placements) as Technology[]).map(option => <option key={option}>{option}</option>)}
        </select></label>
        <p>Use os trechos da revisão {published.version} na página oficial.</p>
        <p>{guide.head} O Bootstrap carrega o Core automaticamente. O Fallback é instalado como script independente.
          A telemetria é enviada internamente pelos scripts.</p>
        <Snippet key={'head:' + published.version} code={head} language="HEAD"/>
        <p>{guide.body}</p>
        <Snippet key={'body:' + published.version} code={body} language="BODY"/>
        {technology !== 'WordPress' && <p>Exemplo no elemento existente <code>{technology === 'React/Vite'
          ? '<main className="conteudo anticlone-canary">…</main>'
          : '<main class="conteudo anticlone-canary">…</main>'}</code></p>}
        <p>{guide.css}</p>
        <Snippet key={'css:' + published.version} code={data.snippets.css} language="CSS"/>
                <div className="installation-next">
          <p>Depois de publicar no site, abra a página oficial e confira o diagnóstico.</p>
          <div className="action-links">
            {officialUrl && <a className="button" href={officialUrl} target="_blank" rel="noreferrer">Abrir página oficial em nova aba</a>}
            <a className="button" href="#install-check">Ir para o diagnóstico</a>
          </div>
        </div>
      </div>}
      {published && <details>
        <summary>Diagnóstico avançado e histórico de revisões</summary>
        <p>Os endereços abaixo servem para diagnóstico. Para instalar, copie os trechos de HEAD, BODY e CSS.</p>
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
        {canPublish && data.publication.rotationAvailable && <button type="button" disabled={busy || !page.enabled}
          onClick={() => setConfirmation('rotate')}>Publicar nova revisão</button>}
      </details>}
    </section>
    <section className="panel" aria-labelledby="install-check">
      <div className="panel-heading"><h2 id="install-check" tabIndex={-1}>Conferir situação</h2>
        <div className="action-links">
          {diagnostic && <span className="badge">{labels[diagnostic.status] ?? diagnostic.status}</span>}
          <button type="button" disabled={busy || query.pending}
            onClick={() => {setError(undefined); setNotice(''); reconsult();}}>Atualizar situação</button>
        </div>
      </div>
      {diagnostic && <>
        {data.verification.ready && <button className="primary" type="button" disabled={busy}
          onClick={() => setConfirmation('verify')}>Verificar instalação</button>}
        {data.verification.issue && <p className="notice">{installationMessages[data.verification.issue]}</p>}
        {diagnostic.controlledVerification.checkedAt && <p>
          {date(diagnostic.controlledVerification.checkedAt)} · {installationMessages[diagnostic.controlledVerification.reason]}</p>}
        {data.verification.ready && !diagnostic.controlledVerification.checkedAt && <p className="muted">
          {installationMessages.NO_CURRENT_VERIFICATION}</p>}
        <p>{diagnostic.layers.every(layer => layer.status === 'UNKNOWN')
          ? 'Sem sinais recentes para esta LP.'
          : 'Sinais recentes recebidos para esta LP.'} Os sinais passivos refletem acessos registrados.</p>
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
      {!published && data && <p className="muted">Publique os endereços e instale os códigos na página oficial para conferir os sinais.</p>}
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
      {(confirmation === 'publish' || confirmation === 'rotate') && pendingTelemetry &&
        <p>{selectedTelemetry || 'Usar origem padrão'}</p>}
    </Confirm>}
  </>;
}
