import {Link, useSearchParams} from 'react-router-dom';
import {AdminApi, type Project} from './admin-api';
import {installationMessages, publicationIssueMessages, type InstallationIssue} from './installation-status';
import {projectPath, useContextNavigation} from './navigation';
import {formData, useOperation, type SetGuard} from './operations';
import {Failure, Loading, useQuery} from './ui';

type Environment = {
  database: 'READY' | 'UNAVAILABLE';
  gateway: {state: string; checkedAt?: string};
  publicationIssues: InstallationIssue[] | null;
  verifierIssue: string | null;
};

type Health = {
  collection: {enabled: boolean; originMatches: boolean} | null;
  settings: {enabled: boolean; operational_enabled: boolean; inactivity_seconds: number; last_observed_at: string | null} | null;
  history: {id: string; kind: string; source: string; event: string | null; occurred_at: string | null; opened_at: string}[];
};

const gatewayStates: Record<string, [string, string]> = {
  READY: ['Gateway local respondeu', 'O backend respondeu a /healthz e confirmou acesso ao banco.'],
  BACKEND_UNAVAILABLE: ['Gateway respondeu com HTTP 503', 'Confira o banco usado pelo gateway.'],
  UNREACHABLE: ['Gateway local sem resposta', 'Confira se o processo está ativo na porta privada configurada.'],
  UNEXPECTED_RESPONSE: ['Resposta local inesperada', 'Confira se a porta e o perfil do gateway correspondem à sonda HTTP local.'],
  NOT_CONFIGURED: ['Gateway local sem sonda', 'Configure ADMIN_GATEWAY_HEALTH_PORT para o perfil HTTP direto. A cobertura pública permanece sem medição.'],
  INVALID_CONFIGURATION: ['Porta da sonda inválida', 'Informe uma porta TCP válida no ambiente privado do admin.'],
};

const events: Record<string,string> = {OPENED:'Episódio aberto', ATTEMPT:'Tentativa de envio', FAILED_UNCERTAIN:'Falha com resultado incerto',
  SENT:'Aceito pelo transporte', RECOVERED:'Recuperação observada', EXPIRED:'Envio expirado', DEFERRED:'Envio adiado', INVALIDATED:'Referência invalidada'};

export function HealthOperations({api, projects, setGuard}: {api: AdminApi; projects: Project[]; setGuard: SetGuard}) {
  const nav=useContextNavigation();
  const environment=useQuery('health-environment', signal=>api.request<Environment>('health',{action:'environment'},signal));
  const [filters,setFilters]=useSearchParams();
  const selected=filters.get('projeto') ?? '';
  const project=projects.find(item=>item.id===selected);
  const status=environment.data;
  const gateway=status && gatewayStates[status.gateway.state];
  return <>
    <section className="panel">
      <div className="panel-heading"><h2>Saúde do ambiente</h2>
        <button type="button" onClick={environment.revalidate} disabled={environment.pending}>Atualizar saúde</button>
      </div>
      {environment.error !== undefined ? <Failure error={environment.error} retry={environment.retry}/> :
        environment.pending ? <Loading>Consultando banco e sonda local…</Loading> : status && <div className="operation-grid health-grid">
          <section className="operation-card"><h3>Banco do admin</h3>
            <p>{status.database==='READY' ? 'Respondendo' : 'Consulta indisponível. Confira a conexão privada do admin.'}</p>
          </section>
          <section className="operation-card"><h3>Gateway</h3><p><strong>{gateway?.[0]}</strong></p><p className="muted">{gateway?.[1]}</p>
            {status.gateway.checkedAt && <small>{new Date(status.gateway.checkedAt).toLocaleString('pt-BR')}</small>}
          </section>
          <section className="operation-card"><h3>Publicação de endereços</h3>
            {status.publicationIssues === null ? <p>Pré-requisitos indisponíveis para consulta.</p> :
              status.publicationIssues.length ? <ul className="plain">{publicationIssueMessages(status.publicationIssues).map(message=>
                <li key={message}>{message}</li>)}</ul> : <p>Configuração apta a gerar revisões e snippets.</p>}
          </section>
          <section className="operation-card"><h3>Verificador isolado</h3>
            <p>{status.database==='UNAVAILABLE' ? 'Pré-requisitos indisponíveis para consulta.' : status.verifierIssue ?
              installationMessages[status.verifierIssue] : 'Imagem configurada. A execução é comprovada na verificação de cada LP.'}</p>
          </section>
        </div>}
    </section>
    <section className="panel">
      <h2>Monitoramento por projeto</h2>
      <p className="muted">O histórico registra transições e tentativas de envio. A atividade do worker fora dessas ocorrências fica sem medição nesta tela.</p>
      {projects.length ? <div className="field"><label htmlFor="health-project">Projeto</label><select id="health-project" value={project?.id ?? ''} onChange={event=>
        setFilters(event.target.value ? {projeto:event.target.value} : {}, {replace:true})}>
        <option value="">Selecione um projeto</option>
        {projects.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}
      </select></div> : <p>Nenhum projeto disponível para consulta.</p>}
      {project && <ProjectHealth key={project.id} api={api} project={project} setGuard={setGuard}/>}
      <div className="action-links"><Link {...nav.link('/visao-geral')}>Abrir diagnósticos na Visão Geral</Link>
        <Link {...nav.link('/configuracoes/notificacoes')}>Abrir revisão de alertas</Link></div>
    </section>
    <details className="panel"><summary>Recuperação, retenção e operações avançadas</summary>
      <p>Backup, restauração e retenção usam as ferramentas privadas. O <a href="/admin/ui/">painel anterior</a> mantém os fluxos avançados legados.</p>
    </details>
  </>;
}

function ProjectHealth({api,project,setGuard}: {api:AdminApi;project:Project;setGuard:SetGuard}) {
  const nav=useContextNavigation();
  const query=useQuery(project.id,signal=>api.request<Health>('health',{action:'inspect',project:project.id},signal));
  const operation=useOperation(setGuard);
  if (query.error !== undefined) return <Failure error={query.error} retry={query.retry}/>;
  if (!query.data) return <Loading/>;
  const {collection,history,settings}=query.data;
  return <>
    {operation.notice()}
    {!collection ? <p>Habilite a coleta da origem principal em Instalação para configurar a saúde.
      {' '}<Link {...nav.link(projectPath(project.id))}>Abrir oferta</Link></p> : <>
      {!collection.enabled && <p className="notice">A coleta da origem principal está desabilitada.</p>}
      {!collection.originMatches && <p className="notice">A origem da coleta diverge do cadastro atual do projeto.</p>}
      <p>{settings?.last_observed_at ? 'Último sinal declarado em ' + new Date(settings.last_observed_at).toLocaleString('pt-BR') :
        'Sem sinal declarado registrado na configuração de saúde.'}</p>
      <form key={JSON.stringify(settings && [settings.enabled,settings.operational_enabled,settings.inactivity_seconds])} onSubmit={event=>{
        const fields=formData(event);
        const enabled=fields.has('enabled'), operational_enabled=fields.has('operational');
        const inactivity_seconds=Number(fields.get('seconds'));
        operation.review('Salvar configuração de saúde', <p>
          Inatividade {enabled ? 'habilitada após ' + inactivity_seconds + ' segundos' : 'desabilitada'} ·
          alertas operacionais {operational_enabled ? 'habilitados' : 'desabilitados'}.
        </p>, async ()=>{
          await api.request('health',{action:'configure',project:project.id,enabled,operational_enabled,inactivity_seconds});
          query.revalidate();
          return 'Configuração de saúde salva.';
        },fields);
      }}>
        <div className="filters">
          <label className="check"><input type="checkbox" name="enabled" defaultChecked={settings?.enabled}/> Acompanhar inatividade de sinais</label>
          <label className="check"><input type="checkbox" name="operational" defaultChecked={settings?.operational_enabled}/> Habilitar alertas operacionais</label>
          <label>Intervalo de inatividade em segundos<input name="seconds" type="number" min={60} max={2592000}
            required defaultValue={settings?.inactivity_seconds ?? 86400}/></label>
        </div>
        <div><button disabled={operation.busy || query.pending}>Revisar configuração de saúde</button></div>
      </form>
    </>}
    <details><summary>Histórico de saúde</summary>
      {history.length ? <ul className="plain evidence-list">{history.map((row,index)=><li key={row.id+':'+index}>
        <strong>{events[row.event ?? 'OPENED'] ?? row.event} · {row.kind==='INACTIVE' ? 'Inatividade de sinais' : 'Operação'}</strong>
        <small>{row.source} · {new Date(row.occurred_at ?? row.opened_at).toLocaleString('pt-BR')}</small>
      </li>)}</ul> : <p>Sem ocorrências registradas para este projeto.</p>}
    </details>
  </>;
}
