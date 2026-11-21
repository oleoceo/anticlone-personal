import {useState} from 'react';
import type {AdminApi, Page} from './admin-api';
import {emptyAllocation, formData, InputError, trafficLabels, value, type Allocation, type useOperation} from './operations';

type ProjectDefault = {revision: number; destination: string};
type CopyRule = {
  copy_origin: string; copy_pathname: string; revision: number; enabled: boolean;
  default_revision: number | null; url_generation: string; config_generation: string;
  copy_is_official: boolean; version: number; approved_destination: string; allocation: Allocation; stealth: boolean;
};
export type CopyRedirectSettings = {projectDefault: ProjectDefault | null; rules: CopyRule[]};
type Operation = ReturnType<typeof useOperation>;

const keyOf = (rule: CopyRule) => rule.copy_origin + rule.copy_pathname;

function parseUrl(raw: string) {
  try { return new URL(raw); } catch { return null; }
}

function httpsDestination(raw: string) {
  const url = parseUrl(raw);
  if (!url || !/^https:\/\/[^/?#]/i.test(raw) || /[\s\\]/.test(raw) || url.username || url.password || url.hash || url.href.length>2048) {
    throw new InputError('Informe uma URL HTTPS válida, sem credenciais nem fragmento.');
  }
  return url;
}

export function CopyRedirectRules({api,page,settings,issue,gatewayReady,operation,refresh,incidentHost,urlGeneration,configGeneration}: {
  api: AdminApi; page: Page; settings: CopyRedirectSettings; issue: string | null;
  gatewayReady: boolean; operation: Operation; refresh: () => void; incidentHost?: string; urlGeneration: string; configGeneration: string;
}) {
  const {projectDefault,rules} = settings;
  const [selected,setSelected] = useState<string | undefined>();
  const current = selected===undefined && incidentHost
    ? rules.find(rule=>new URL(rule.copy_origin).hostname===incidentHost.toLowerCase())
    : rules.find(rule=>keyOf(rule)===selected);
  const [override,setOverride] = useState<boolean | undefined>();
  const hasOverride = !projectDefault || (override ?? (current ? current.default_revision===null : false));
  const scope = {project:page.project_id,page:page.id};
  const stale = current && (current.url_generation!==urlGeneration || current.config_generation!==configGeneration);
  const effective = current?.approved_destination;
  const [copyOrigin,copyPathname] = current ? [current.copy_origin,current.copy_pathname] : ['', '/'];

  return <section className="panel operation-section">
    <h2>Destino padrão do projeto</h2>
    <p>Aplica-se às cópias autorizadas que usam o destino padrão.</p>
    <form key={projectDefault?.revision} onSubmit={event=>{
      const fields=formData(event);
      try {
        const destination=httpsDestination(value(fields,'destination')).href;
        operation.review('Confirmar destino padrão do projeto', <p>{destination}</p>, async ()=>{
          await api.request('page-redirect',{...scope,action:'save-default',destination,revision:projectDefault?.revision??0,acknowledged:true});
          refresh();
          return 'Destino padrão do projeto salvo.';
        },fields);
      } catch (error) { operation.setError(error); }
    }}>
      <label>Para onde redirecionar<input name="destination" type="url" required maxLength={2048} defaultValue={projectDefault?.destination}/></label>
      <button type="submit" disabled={operation.busy}>Revisar destino padrão</button>
    </form>

    <h2>Redirecionamento por cópia</h2>
    {!gatewayReady && <p className="notice">O gateway precisa estar operacional e com suporte a essa configuração para ativar ou editar regras.</p>}
    {issue && <p className="notice">{issue}</p>}
    {rules.length>0 && <label>Cópia<select value={current ? keyOf(current) : ''} onChange={event=>{
      setSelected(event.target.value); setOverride(undefined);
    }}>
      <option value="">Adicionar cópia</option>
      {rules.map(rule=><option key={keyOf(rule)} value={keyOf(rule)}>{keyOf(rule)}</option>)}
    </select></label>}
    {current && <p>{!current.enabled ? 'Desativado' : current.copy_is_official ? 'Bloqueado. A origem consta como oficial.' : stale ? 'Precisa ser reautorizado após a alteração da LP' :
      !gatewayReady || issue ? 'Ativação pendente de disponibilidade' : 'Ativo'} · {effective}</p>}
    {gatewayReady && <form key={[copyOrigin,copyPathname,current?.revision,projectDefault?.revision,configGeneration].join('|')} onSubmit={event=>{
      const fields=formData(event);
      try {
        const enteredOrigin=value(fields,'origin');
        const origin=parseUrl(enteredOrigin);
        const pathname=value(fields,'pathname');
        if (!origin || origin.protocol!=='https:' || origin.origin!==enteredOrigin ||
            (incidentHost && origin.hostname!==incidentHost.toLowerCase() && !current)) throw new InputError('Informe a origem HTTPS exata da cópia.');
        const destination=hasOverride ? httpsDestination(value(fields,'destination')).href : null;
        const target=destination ?? projectDefault?.destination;
        if (!target || new URL(target).origin===origin.origin) throw new InputError('Informe um destino em outra origem que a cópia.');
        const allocation={...emptyAllocation};
        for (const key of Object.keys(allocation) as (keyof Allocation)[]) allocation[key]=Number(fields.get(key));
        if (!Object.values(allocation).some(percent=>percent>0)) throw new InputError('Informe um percentual acima de 0% para pelo menos uma classe.');
        const existing=rules.find(rule=>keyOf(rule)===origin.origin+pathname);
        if (!current && existing) {
          setSelected(keyOf(existing)); setOverride(undefined);
          throw new InputError('Esta cópia já está cadastrada. Revise a regra existente.');
        }
        const stealth=fields.get('stealth')==='on';
        operation.review('Confirmar redirecionamento da cópia', <>
          <p>{origin.origin}{pathname} → {target}</p>
          <p>{destination ? 'Destino específico da cópia.' : 'Usar o destino padrão do projeto.'}</p>
          <ul className="plain">{Object.entries(trafficLabels).map(([key,label])=><li key={key}>{label} · {allocation[key as keyof Allocation]}%</li>)}</ul>
          <p>Stealth {stealth ? 'ligado' : 'desligado'}.</p>
        </>, async ()=>{
          await api.request('page-redirect',{...scope,action:'save-copy',copyOrigin:origin.origin,copyPathname:pathname,
            revision:current?.revision??0,defaultRevision:destination===null ? projectDefault?.revision : null,urlGeneration,configGeneration,
            acknowledged:fields.get('assent')==='on',policy:{destination,allocation,stealth}});
          setSelected(origin.origin+pathname); setOverride(undefined); refresh();
          return 'Redirecionamento da cópia salvo.';
        },fields);
      } catch (error) { operation.setError(error); }
    }}>
      <div className="filters">
        <label>Origem HTTPS da cópia<input name="origin" type="url" required readOnly={Boolean(current)}
          defaultValue={copyOrigin || (incidentHost ? 'https://'+incidentHost : '')}/></label>
        <label>Caminho exato da cópia<input name="pathname" required maxLength={201} pattern="/(?:[A-Za-z0-9_\-]|/){0,200}"
          readOnly={Boolean(current)} defaultValue={copyPathname}/></label>
      </div>
      {projectDefault && <label className="check"><input type="checkbox" checked={hasOverride}
        onChange={event=>setOverride(event.target.checked)}/>Usar um destino específico para esta cópia</label>}
      {hasOverride && <label>Destino específico da cópia<input name="destination" type="url" required maxLength={2048}
        defaultValue={current?.default_revision===null ? current.approved_destination : undefined}/></label>}
      <fieldset className="allocation"><legend>Percentual por classe</legend>
        {Object.entries(trafficLabels).map(([key,label])=><label key={key}>{label}
          <input type="number" name={key} min={0} max={100} step={10} required defaultValue={current?.allocation[key as keyof Allocation]??0}/>
        </label>)}
      </fieldset>
      <label className="check"><input name="stealth" type="checkbox" defaultChecked={current?.stealth??false}/>Aplicar Stealth</label>
      <label className="check"><input name="assent" type="checkbox" required/>Confirmo que estou autorizado a configurar esta cópia.</label>
      <button type="submit" className="primary" disabled={operation.busy || !gatewayReady || Boolean(issue) || current?.copy_is_official}>
        {current?.enabled ? 'Revisar alterações da cópia' : 'Revisar ativação da cópia'}
      </button>
    </form>}
    {current?.enabled && <button type="button" disabled={operation.busy} onClick={()=>
      operation.review('Desativar redirecionamento da cópia', <p>{keyOf(current)}</p>, async ()=>{
        await api.request('page-redirect',{...scope,action:'disable-copy',copyOrigin,copyPathname,revision:current.revision});
        refresh();
        return 'Redirecionamento da cópia desativado.';
      })}>Desativar redirecionamento da cópia</button>}
    <p>O navegador tem 150 ms para decidir. Em caso de atraso ou erro, mantém a página aberta.</p>
  </section>;
}
