import {useState} from 'react';
import {Link, useSearchParams} from 'react-router-dom';
import {AdminApi, type Project} from './admin-api';
import {CommerceSettings} from './commerce-settings';
import {DetailsData, formData, formatDate, InputError, useOperation, value, type SetGuard} from './operations';
import {Breadcrumbs, settingsPath, useContextNavigation} from './navigation';
import {Failure, Heading, Loading, useQuery} from './ui';
import {HealthOperations} from './health';

type Smtp = {version: number; provider: string | null; host: string | null; port: number | null;
  tls_mode: string | null; sender: string | null; recipient: string | null; status: string;
  preference_requested: boolean; clone_transport: string; smtp_login: string | null; smtp_key_saved: boolean; panel_smtp_available: boolean};
const smtpState: Record<string, string> = {incomplete: 'Configuração incompleta', configured_disabled: 'Configuração salva · habilitação desativada',
  enablement_requested: 'Habilitação solicitada'};
const transportState: Record<string, string> = {PRIVATE_ENVIRONMENT_NOT_CONFIGURED: 'Ambiente privado sem SMTP configurado',
  PRIVATE_ENVIRONMENT_MISMATCH: 'A configuração salva diverge do ambiente privado',
  PRIVATE_ENVIRONMENT_INVALID: 'Configuração do ambiente privado inválida',
  AUTHORIZED_CONFIGURATION: 'Configuração compatível com o transporte privado', DISABLED: 'Transporte privado configurado · alertas desativados'};
const reviewLabels = {RELEASE: 'Liberar para nova tentativa', CANCEL: 'Cancelar futuras tentativas', ACK_UNKNOWN: 'Registrar resultado desconhecido'} as const;

export function Settings({api, projects, section, setGuard}: {api: AdminApi; projects: Project[];
  section?: string; setGuard: SetGuard}) {
  const nav = useContextNavigation();
  const names = {'notificacoes': 'Notificações', 'integracoes': 'Integrações', 'operacoes': 'Saúde e operações'};
  return <>
    <Breadcrumbs items={[{label: 'Configurações', path: section ? settingsPath : undefined},
      ...(section ? [{label: names[section as keyof typeof names]}] : [])]}/>
    <Heading title="Configurações" description="Preferências e integrações do painel administrativo."/>
    <nav className="tabs" aria-label="Seções de configurações">
      {Object.entries(names).map(([part, label]) => <Link key={part}
        aria-current={part === (section ?? 'notificacoes') ? 'page' : undefined} {...nav.link(settingsPath + '/' + part)}>{label}</Link>)}
    </nav>
    {section === 'integracoes' ? <CommerceSettings api={api} setGuard={setGuard}/> : section === 'operacoes' ?
      <HealthOperations api={api} projects={projects} setGuard={setGuard}/> : <>
        <NotificationSettings api={api} setGuard={setGuard}/>
        <NotificationQueue api={api} projects={projects} setGuard={setGuard}/>
      </>}
  </>;
}

function NotificationSettings({api, setGuard}: {api: AdminApi; setGuard: SetGuard}) {
  const query = useQuery('settings', signal => api.request<Smtp>('settings', undefined, signal));
  const emailLog = useQuery('email-attempts', signal => api.request<EmailAttempt[]>('email-attempts', undefined, signal));
  const operation = useOperation(setGuard);
  const config = query.data;
  const [edited, setEdited] = useState(false);
  function testConnection(send = false) {
    if (!config) return;
    operation.review(send ? 'Enviar e-mail de teste' : 'Testar conexão SMTP', <p>{send ?
      'Enviar uma mensagem de teste para ' + config.recipient + '.' :
      'Verificar TLS e autenticação da configuração v' + config.version + ' sem enviar mensagens.'}</p>, async () => {
      const result = await api.request<{state: string; checked_at?: string}>('smtp-test', {version: config.version, ...(send ? {send: true} : {})})
        .finally(() => { if (send) emailLog.revalidate(); });
      if (result.state === 'VERIFIED') return 'TLS e autenticação SMTP verificados · v' + config.version + ' · ' + formatDate(result.checked_at);
      if (result.state === 'ACCEPTED') return 'O servidor SMTP aceitou o e-mail de teste. Confira a caixa postal.';
      if (result.state === 'AUTH_FAILED') throw new InputError('O servidor SMTP recusou a autenticação. Confira o login e a chave SMTP.');
      if (result.state === 'WAIT') throw new InputError(send ? 'Aguarde um minuto entre envios de teste.' : 'Aguarde um minuto entre testes de conexão SMTP.');
      throw new InputError(transportState[result.state] ?? 'A conexão SMTP falhou. Confira o endereço, TLS e as credenciais.');
    });
  }
  function preference(enabled: boolean) {
    if (!config) return;
    operation.review(enabled ? 'Solicitar habilitação de alertas' : 'Desativar solicitação de alertas',
      <p>{enabled ? 'O transporte depende da configuração privada correspondente. Esta solicitação não verifica entrega.' :
        'O servidor registra a desativação da preferência de envio.'}</p>, async () => {
        await api.request('preference', enabled ? {enabled, version: config.version} : {enabled});
        query.revalidate();
        return enabled ? 'Habilitação solicitada.' : 'Solicitação desativada.';
      });
  }
  return <><section className="panel form-panel">
    <h2>Notificações e SMTP</h2>
    {operation.notice()}
    {query.error !== undefined ? <Failure error={query.error} retry={query.revalidate}/> : !config ? <Loading/> : <>
      <p><strong>{smtpState[config.status] ?? 'Situação indisponível'}</strong> · versão {config.version}</p>
      <p>{transportState[config.clone_transport] ?? 'Transporte privado indisponível'}</p>
      <p className="muted">A chave salva fica cifrada. A aceitação SMTP pode ser conferida separadamente da chegada à caixa postal.</p>
      <form key={config.version} onChange={() => setEdited(true)} onSubmit={event => {
        const fields = formData(event);
        const optional = (name: string) => value(fields, name) || null;
        const port = optional('port');
        const login = optional('smtp_login');
        const password = String(fields.get('smtp_password') ?? '');
        const body = {version: config.version, provider: optional('provider'), host: optional('host'),
          port: port === null ? null : Number(port), tls_mode: optional('tls_mode'), sender: optional('sender'),
          recipient: optional('recipient'), ...(login ? {smtp_login: login} : {}), ...(password ? {smtp_password: password} : {})};
        operation.review('Salvar configuração SMTP', <><p>{body.host ?? 'Host não informado'} · {body.port ?? 'Porta não informada'}</p>
          <p>{body.sender ?? 'Sem remetente'} → {body.recipient ?? 'Sem destinatário'}</p>
          <p>Alterar os dados desativa a solicitação de habilitação existente.</p></>, async () => {
          await api.request('settings', body);
          setEdited(false);
          query.revalidate();
          return 'Configuração SMTP salva.';
        }, fields);
      }}>
        <label>Provedor<select name="provider" defaultValue={config.provider ?? ''}>
          <option value="">Selecione</option><option value="smtp">SMTP personalizado</option><option value="brevo">Brevo</option>
        </select></label>
        <div className="filters">
          <label>Host SMTP<input name="host" defaultValue={config.host ?? ''} maxLength={253}/></label>
          <label>Porta<input name="port" type="number" min={1} max={65535} defaultValue={config.port ?? ''}/></label>
        </div>
        <label>TLS<select name="tls_mode" defaultValue={config.tls_mode ?? ''}>
          <option value="">Selecione</option><option value="implicit">Implícito</option><option value="starttls">STARTTLS</option>
        </select></label>
        {config.panel_smtp_available && <>
          <label>Login SMTP<input name="smtp_login" autoComplete="off" defaultValue={config.smtp_login ?? ''} maxLength={512}/></label>
          <label>Chave SMTP<input name="smtp_password" type="password" autoComplete="new-password" maxLength={2048}
            placeholder={config.smtp_key_saved ? 'Chave salva · preencha para trocar' : undefined}/></label>
        </>}
        <label>Remetente<input name="sender" type="email" maxLength={254} defaultValue={config.sender ?? ''}/></label>
        <label>Destinatário<input name="recipient" type="email" maxLength={254} defaultValue={config.recipient ?? ''}/></label>
        <button className="primary" type="submit" disabled={operation.busy || query.pending}>Revisar configuração SMTP</button>
      </form>
      <div className="action-links">
        <button type="button" disabled={query.pending || operation.busy || edited ||
          !['AUTHORIZED_CONFIGURATION', 'DISABLED'].includes(config.clone_transport)} onClick={() => testConnection()}>Testar conexão SMTP</button>
        <button type="button" disabled={query.pending || operation.busy || edited ||
          !['AUTHORIZED_CONFIGURATION', 'DISABLED'].includes(config.clone_transport)} onClick={() => testConnection(true)}>Enviar e-mail de teste</button>
        {!config.preference_requested ? <button type="button" disabled={query.pending || operation.busy ||
          edited || config.status === 'incomplete'} onClick={() => preference(true)}>Solicitar habilitação</button> :
          <button type="button" disabled={query.pending || operation.busy || edited} onClick={() => preference(false)}>Desativar solicitação</button>}
        <button type="button" disabled={query.pending || operation.busy} onClick={query.revalidate}>Reconsultar configuração</button>
      </div>
    </>}
  </section>
    <EmailLog query={emailLog}/>
  </>;
}

type EmailAttempt = {
  kind: 'TEST' | 'CLONE' | 'CTA' | 'HEALTH';
  item_id: string;
  attempt: number;
  transport: string;
  project: string | null;
  started_at: string;
  finished_at: string | null;
  outcome: 'ACCEPTED' | 'FAILED' | 'UNKNOWN';
  failure_code: 'AUTH_FAILED' | 'SMTP_FAILED' | null;
  smtp_status: number | null;
  recovered_record: boolean;
};

const emailKinds = {TEST: 'E-mail de teste', CLONE: 'Alerta de cópia', CTA: 'Alerta de CTA', HEALTH: 'Alerta de saúde'};
const emailOutcomes = {ACCEPTED: 'Aceito pelo SMTP', FAILED: 'Falha no envio', UNKNOWN: 'Resultado desconhecido'};
const emailTransports: Record<string, string> = {SMTP_LOCAL: 'SMTP local', SMTP_PROVIDER: 'Provedor SMTP', brevo: 'Brevo', smtp: 'SMTP personalizado'};

function EmailLog({query}: {query: ReturnType<typeof useQuery<EmailAttempt[]>>}) {
  const [status, setStatus] = useState('');
  const rows = query.data?.filter(attempt => !status || attempt.outcome === status);
  return <section className="panel" aria-labelledby="email-log-heading">
    <div className="panel-heading">
      <h2 id="email-log-heading">Logs de e-mail</h2>
      <button type="button" onClick={query.revalidate} disabled={query.pending}>Atualizar logs</button>
    </div>
    <p className="muted">Até 100 tentativas recentes dos últimos 30 dias. Aceitação indica que o SMTP recebeu a mensagem. Uma falha observada pode ocorrer sem confirmação do resultado final.</p>
    <label>Status do e-mail<select value={status} onChange={event => setStatus(event.target.value)}>
      <option value="">Todos</option>
      {Object.entries(emailOutcomes).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
    </select></label>
    {query.error !== undefined ? <Failure error={query.error} retry={query.revalidate}/> : !rows ? <Loading/> :
      !rows.length ? <p className="empty">Nenhuma tentativa de envio neste recorte.</p> :
        <div className="finance-table-wrap" role="region" aria-label="Histórico de envio de e-mails" tabIndex={0}>
          <table className="activity-table finance-table">
            <thead><tr><th scope="col">E-mail</th><th scope="col">Horário</th><th scope="col">Status</th><th scope="col">Detalhes</th></tr></thead>
            <tbody>{rows.map(row => <tr key={row.kind + ':' + row.item_id + ':' + row.attempt}>
              <th scope="row">{emailKinds[row.kind]} · #{row.item_id}</th>
              <td data-heading="Horário"><time dateTime={row.started_at}>{formatDate(row.started_at)}</time></td>
              <td data-heading="Status">{emailOutcomes[row.outcome]}</td>
              <td data-heading="Detalhes">{emailTransports[row.transport] ?? row.transport} · tentativa {row.attempt}
                {row.project && <small>Projeto {row.project}</small>}
                {row.recovered_record && <small>Resultado recuperado do teste anterior</small>}
                {row.failure_code && <small>{row.failure_code === 'AUTH_FAILED' ? 'Autenticação recusada' : 'O envio não foi confirmado pelo SMTP'}
                  {row.smtp_status && ' · SMTP ' + row.smtp_status}</small>}
              </td>
            </tr>)}</tbody>
          </table>
        </div>}
  </section>;
}

type QueueItem = {queue: string; item_id: string; revision: string; hold_state: string; state: string; attempts: number};
type Queue = {state: string; items: QueueItem[]; history: unknown[]; attempts: unknown[]};
function NotificationQueue({api, projects, setGuard}: {api: AdminApi; projects: Project[]; setGuard: SetGuard}) {
  const [filters, setFilters] = useSearchParams();
  const project = projects.find(item => item.id === filters.get('projeto'))?.id ?? '';
  const query = useQuery(project, signal => api.request<Queue>('notifications', {action: 'inspect', project}, signal));
  const operation = useOperation(setGuard);
  return <section className="panel">
    <h2>Alertas em revisão</h2>
    <p>O histórico registra tentativas de transporte. A entrega na caixa postal permanece sem verificação.</p>
    <label>Projeto dos alertas<select value={project} disabled={operation.busy} onChange={event =>
      setFilters(event.target.value ? {projeto: event.target.value} : {}, {replace: true})}>
      <option value="">Selecione</option>{projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
    </select></label>
    {operation.notice()}
    {query.error !== undefined ? <Failure error={query.error} retry={query.revalidate}/> :
      query.pending ? <Loading/> : query.data ? <>
        <button type="button" disabled={operation.busy} onClick={query.revalidate}>Atualizar alertas</button>
        {query.data.state !== 'AVAILABLE' ? <p>Histórico de revisão indisponível no servidor.</p> :
          !query.data.items.length ? <p>Nenhum alerta em revisão no recorte retornado.</p> : <ul className="plain evidence-list">
          {query.data.items.map(item => <li key={item.queue + ':' + item.item_id}>
            <details><summary>{item.queue} · {item.item_id} · {item.hold_state}</summary>
              <p>{item.attempts} tentativa(s) registrada(s). O servidor revalida a ação e a revisão do item.</p>
              <form onSubmit={event => {
                const fields = formData(event);
                const action = value(fields, 'action') as keyof typeof reviewLabels;
                const confirmation = value(fields, 'confirmation');
                const acknowledgeDuplicateRisk = fields.get('duplicate') === 'on';
                if (confirmation !== item.queue + ':' + item.item_id || (action === 'RELEASE' && !acknowledgeDuplicateRisk)) {
                  operation.setError(new InputError('Confira a confirmação exata e o reconhecimento do risco de duplicidade.'));
                  return;
                }
                operation.review(reviewLabels[action], <><p>{confirmation} · {value(fields, 'reason')}</p>
                  <p>{action === 'CANCEL' ? 'Um envio já admitido pelo transporte ainda pode concluir.' :
                    action === 'RELEASE' ? 'A liberação mantém os limites de idade e tentativas e pode gerar duplicidade.' :
                      'O resultado permanece desconhecido. Este registro não agenda outro envio.'}</p></>, async () => {
                  await api.request('notifications', {action, confirmation, acknowledgeDuplicateRisk, project,
                    queue: item.queue, item: item.item_id, revision: item.revision, reason: value(fields, 'reason')});
                  query.revalidate();
                  return 'Revisão de alerta registrada.';
                }, fields);
              }}>
                <label>Ação de revisão<select name="action">{Object.entries(reviewLabels).map(([id, label]) =>
                  <option key={id} value={id}>{label}</option>)}</select></label>
                <label>Digite {item.queue}:{item.item_id}<input name="confirmation" required/></label>
                <label>Justificativa<textarea name="reason" maxLength={500} required/></label>
                <label className="check"><input type="checkbox" name="duplicate"/>Reconheço o risco de duplicidade ao liberar.</label>
                <button type="submit" disabled={operation.busy}>Revisar ação de alerta</button>
              </form>
            </details>
          </li>)}</ul>}
        <DetailsData heading="Histórico de revisão" data={query.data.history}/>
        <DetailsData heading="Tentativas registradas" data={query.data.attempts}/>
      </> : <p>Selecione um projeto para consultar o histórico disponível.</p>}
  </section>;
}
