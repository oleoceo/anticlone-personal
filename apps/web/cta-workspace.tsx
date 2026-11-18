import {useLocation, useNavigate} from 'react-router-dom';
import {searchOf, sectionParams} from './navigation';
import {AdminApi, type Page} from './admin-api';
import {DetailsData, InputError, formData, formatDate, useOperation, value, type SetGuard} from './operations';
import type {CtaPolicy, Destination, Protection} from './protection-contracts';
import {Failure, Loading, useQuery} from './ui';

type Observation = {
  observation_id: string; observed_at: string; observed_url: string | null; confidence: string;
  selection_allowed: boolean; point_id: string | null; marker: string | null; kind: string;
  review_required: boolean; destination_id: string | null; mapped_url: string | null;
  pending_offer: string | null; pending_url: string | null; commercial_amount: string | number | null;
  commercial_currency: string | null; commercial_terms: object | null; approved_amount: string | number | null;
  approved_currency: string | null; approved_terms: object | null; commercial_version: number | null;
  suspension: string | null; commercial_alert: unknown;
};
type Inventory = {captureId: string | null; observations: Observation[]; destinations: Destination[]; missing: unknown[]; stale: number};

export function CtaWorkspace({api, project, page, protection, refresh, setGuard}: {
  api: AdminApi; project: string; page: Page; protection: Protection; refresh: () => void; setGuard: SetGuard;
}) {
  const surfaces = protection.ctaSurfaces.filter(policy => page.urls.some(url => url.pathname === policy.pathname));
  const location = useLocation();
  const navigate = useNavigate();
  const params = sectionParams(location.search);
  const selected = params.get('superficie');
  const surface = surfaces.find(policy => policy.surface === selected) ?? surfaces[0];
  return <section className="panel" id="inventario-cta" aria-labelledby="cta-inventory-heading" tabIndex={-1}>
    <h2 id="cta-inventory-heading">Pontos de conversão</h2>
    <p>Confira a captura da superfície, revise as mudanças e vincule os pontos a destinos aprovados.</p>
    {surfaces.length > 1 && <label>Superfície de CTA<select value={surface?.surface ?? ''} onChange={event => {
      params.set('superficie', event.target.value);
      void navigate({pathname: location.pathname, search: searchOf(params)}, {replace: true, state: location.state});
    }}>{surfaces.map(policy => <option key={policy.surface} value={policy.surface}>{policy.surface}</option>)}</select></label>}
    {surface ? <InventoryView key={surface.surface} api={api} project={project} surface={surface}
      refresh={refresh} setGuard={setGuard}/> :
      <p className="empty">Nenhuma política de CTA publicada para os caminhos desta LP.</p>}
  </section>;
}

function InventoryView({api, project, surface, refresh, setGuard}: {
  api: AdminApi; project: string; surface: CtaPolicy; refresh: () => void; setGuard: SetGuard;
}) {
  const operation = useOperation(setGuard);
  const query = useQuery(surface.surface, signal => api.request<Inventory>('cta-inventory', {project, surface: surface.surface}, signal));
  const protection = (action: string, data: object) => api.request('protection', {action, project, data});
  const update = () => { query.revalidate(); refresh(); };
  return <>
    <p className="muted">{surface.surface} · {surface.pathname} · versão {surface.version}</p>
    {operation.notice()}
    {query.error !== undefined && <Failure error={query.error} retry={query.revalidate}/>}
    <button type="button" disabled={operation.busy} onClick={query.revalidate}>Atualizar inventário</button>
    {query.data ? <>
      {query.data.observations.length ? <div className="operation-grid">
        {query.data.observations.map(point => <PointCard key={point.observation_id} point={point}
          inventory={query.data!} surface={surface.surface} api={api} project={project}
          operation={operation} update={update}/>)}
      </div> : <p className="empty">Nenhuma observação recente nesta superfície.</p>}
      {query.data.stale > 0 && <p>Seleções de capturas anteriores: {query.data.stale}.</p>}
      {query.data.missing.length > 0 && <DetailsData heading="Pontos sem observação recente" data={query.data.missing}/>}
    </> : query.error === undefined && <Loading/>}
    <details>
      <summary>Cadastrar destino aprovado</summary>
      <form onSubmit={event => {
        const data = formData(event);
        const offer = value(data, 'offer');
        const url = value(data, 'url');
        operation.review('Cadastrar destino aprovado', <p>{offer} · {url}</p>, async () => {
          await protection('destination', {offer, url});
          update();
          return 'Destino cadastrado.';
        }, data);
      }}>
        <label>Identificador da oferta<input name="offer" required maxLength={64} pattern="[A-Za-z0-9_\-]+"/></label>
        <label>URL do destino do CTA<input name="url" type="url" required maxLength={2048}/></label>
        <button type="submit" disabled={operation.busy}>Revisar destino</button>
      </form>
    </details>
    <details>
      <summary>Importar captura existente</summary>
      <p>Use o JSON de candidatos exportado para esta superfície. A importação atualiza a captura usada na revisão.</p>
      <form onSubmit={event => {
        const data = formData(event);
        let candidates: unknown;
        try {
          candidates = JSON.parse(value(data, 'candidates'));
          if (!Array.isArray(candidates) || candidates.length > 100) throw new TypeError();
        } catch { operation.setError(new InputError('Formato da captura inválido')); return; }
        operation.review('Importar captura', <p>{surface.surface} · {surface.pathname} · {(candidates as unknown[]).length} candidatos</p>, async () => {
          await api.request('cta-import', {project, surface: surface.surface, pathname: surface.pathname, candidates});
          update();
          return 'Captura importada.';
        }, data);
      }}>
        <label>JSON dos candidatos<textarea name="candidates" rows={6} required maxLength={60_000}/></label>
        <button type="submit" disabled={operation.busy}>Revisar captura</button>
      </form>
    </details>
  </>;
}

function PointCard({point, inventory, surface, api, project, operation, update}: {
  point: Observation; inventory: Inventory; surface: string; api: AdminApi; project: string;
  operation: ReturnType<typeof useOperation>; update: () => void;
}) {
  const {captureId, destinations} = inventory;
  const pointId = point.point_id;
  const observationId = point.observation_id;
  const destinationId = point.destination_id;
  const protection = (action: string, data: object) => api.request('protection', {action, project, data});
  const label = point.marker ?? 'Ponto sem marcador';
  const eligible = point.kind === 'a' && point.marker && point.confidence === 'HIGH' && point.selection_allowed;
  return <article className="operation-card">
    <h3>{label}</h3>
    <p className="muted">{point.confidence === 'HIGH' ? 'Confiança alta' : 'Confiança limitada'} · {formatDate(point.observed_at)}</p>
    <dl className="review">
      <dt>Destino observado</dt><dd>{point.observed_url ?? 'Indisponível'}</dd>
      <dt>Destino mapeado</dt><dd>{point.mapped_url ?? 'Sem mapeamento'}</dd>
    </dl>
    {point.review_required && <p className="notice">A observação requer reaprovação do mapeamento.</p>}
    {point.suspension && <p className="notice">Mudança comercial pendente de revisão.</p>}
    {point.pending_offer && <p>Seleção pendente para {point.pending_offer} · {point.pending_url}</p>}
    {(point.commercial_amount !== null || point.approved_amount !== null || !!point.commercial_alert) &&
      <DetailsData heading="Evidência comercial" data={{
        observado: {unidades_menores: point.commercial_amount, moeda: point.commercial_currency, termos: point.commercial_terms},
        aprovado: {unidades_menores: point.approved_amount, moeda: point.approved_currency, termos: point.approved_terms},
        alerta: point.commercial_alert,
      }}/>}
    {eligible && pointId && !destinationId && !point.review_required && destinations.length > 0 && <form
      onSubmit={event => {
        const data = formData(event);
        const chosen = destinations.find(item => item.id === value(data, 'destination'));
        const pending = data.get('pending') === 'on';
        if (!chosen || (pending && !captureId)) return;
        operation.review(pending ? 'Registrar seleção pendente' : 'Mapear CTA ao destino',
          <p>{label} → {chosen.offer} · {chosen.url}</p>, async () => {
            if (pending) await api.request('cta-selection', {project, surface, captureId, observationId,
              pointId, offer: chosen.offer, destinationId: chosen.id});
            else await protection('map', {pointId, offer: chosen.offer, destinationId: chosen.id});
            update();
            return pending ? 'Seleção pendente registrada.' : 'Mapeamento salvo.';
          }, data);
      }}>
      <label>Destino aprovado para {label}<select name="destination" defaultValue="" required>
        <option value="">Selecione</option>
        {destinations.map(item => <option key={item.id} value={item.id}>{item.offer} · {item.url}</option>)}
      </select></label>
      <label className="check"><input type="checkbox" name="pending"/>Registrar como seleção pendente</label>
      <button type="submit" disabled={operation.busy}>Revisar mapeamento</button>
    </form>}
    {point.kind === 'a' && point.marker && point.confidence === 'HIGH' && pointId && destinationId && point.review_required &&
      <button type="button" disabled={operation.busy} onClick={() =>
        operation.review('Reaprovar mapeamento', <p>{label} · observado {point.observed_url} · mapeado {point.mapped_url}</p>, async () => {
          await protection('review', {pointId, observationId, destinationId});
          update();
          return 'Mapeamento reavaliado.';
        })}>Reaprovar mapeamento</button>}
    {eligible && pointId && destinationId && captureId && point.commercial_amount !== null &&
      point.commercial_currency && (point.suspension || point.commercial_version === null) &&
      <button type="button" disabled={operation.busy} onClick={() => {
        operation.review('Aprovar termos observados', <><p>{label} · {point.mapped_url}</p>
          <p>{point.commercial_amount} unidades menores · {point.commercial_currency}</p>
          {point.commercial_terms && <DetailsData heading="Detalhes dos termos" data={point.commercial_terms}/>}</>, async () => {
          await api.request('cta-commercial', {project, surface, pointId, observationId, captureId, destinationId,
            amount: Number(point.commercial_amount), currency: point.commercial_currency, version: point.commercial_version ?? 0,
            ...(point.commercial_terms ? {terms: point.commercial_terms} : {})});
          update();
          return 'Termos comerciais revisados.';
        });
      }}>Revisar termos comerciais</button>}
  </article>;
}
