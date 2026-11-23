import type {AdminApi} from './admin-api';
import {httpsDestination, type ProjectDefault} from './copy-redirect-rules';
import {formData, useOperation, value, type SetGuard} from './operations';
import {Failure, Loading, useQuery} from './ui';

export function ProjectRedirectDestination({api,project,setGuard}: {api:AdminApi; project:string; setGuard:SetGuard}) {
  const query=useQuery(project,signal=>api.request<{available:boolean;projectDefault:ProjectDefault|null}>('page-redirect',{action:'inspect-default',project},signal));
  const operation=useOperation(setGuard);
  if (query.error!==undefined) return <Failure error={query.error} retry={query.retry}/>;
  if (!query.data) return <Loading/>;
  if (!query.data.available) return null;
  const current=query.data.projectDefault;
  return <section className="panel operation-section">
    <h2>Destino padrão de redirecionamento</h2>
    <p>Usado pelas regras de cópia que herdam o destino do projeto.</p>
    {operation.notice()}
    <form key={current?.revision} onSubmit={event=>{
      const fields=formData(event);
      try {
        const destination=httpsDestination(value(fields,'destination'));
        operation.review('Confirmar destino padrão', <p>{destination}</p>, async ()=>{
          await api.request('page-redirect',{project,action:'save-default',destination,revision:current?.revision??0,acknowledged:true});
          query.revalidate();
          return 'Destino padrão salvo.';
        },fields);
      } catch(error) { operation.setError(error); }
    }}>
      <label>Para onde redirecionar os visitantes<input name="destination" type="text" inputMode="url" required maxLength={2048} defaultValue={current?.destination}/></label>
      <button type="submit" disabled={operation.busy || query.pending}>Revisar destino padrão</button>
    </form>
  </section>;
}
