import {useEffect, useRef, useState, type PropsWithChildren, type ReactNode} from 'react';
import {errorMessage} from './admin-api';

export function useQuery<T>(key: string, load: (signal: AbortSignal) => Promise<T>) {
  const [version, setVersion] = useState(0);
  const [result, setResult] = useState<{key: string; data?: T; error?: unknown}>();
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    load(controller.signal).then(
      data => { if (!controller.signal.aborted) setResult({key, data}); },
      error => { if (!controller.signal.aborted) setResult({key, error}); },
    );
    return () => controller.abort();
  }, [key, version]); // The key names the contract and its parameters.
  return {
    data: result?.key === key ? result.data : undefined,
    error: result?.key === key ? result.error : undefined,
    retry: () => { setResult(undefined); setVersion(value => value + 1); },
  };
}

export function Brand() {
  return <div className="brand"><span aria-hidden="true">A</span><strong>AntiClone <small>Personal</small></strong></div>;
}

export function Heading({title, description, actions}: {title: string; description?: string; actions?: ReactNode}) {
  return <header className="heading">
    <div><h1>{title}</h1>{description && <p>{description}</p>}</div>
    {actions}
  </header>;
}

export function Failure({error, retry}: {error: unknown; retry?: () => void}) {
  return <div className="notice danger" role="alert">
    <p>{errorMessage(error)}</p>
    {retry && <button type="button" onClick={retry}>Consultar novamente</button>}
  </div>;
}

export function Loading({children = 'Carregando…'}: PropsWithChildren) {
  return <p className="muted" role="status">{children}</p>;
}

export function Confirm({title, children, accept, cancel, confirmLabel}: PropsWithChildren<{
  title: string; accept?: () => void; cancel: () => void; confirmLabel?: string;
}>) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    return () => { dialog?.close(); trigger?.focus(); };
  }, []);
  return <dialog ref={ref} aria-labelledby="dialog-title" onCancel={event => { event.preventDefault(); cancel(); }}>
    <h2 id="dialog-title">{title}</h2>
    {children}
    <div className="actions">
      <button autoFocus type="button" onClick={cancel}>{accept ? 'Cancelar' : 'Entendi'}</button>
      {accept && <button className="primary" type="button" onClick={accept}>{confirmLabel ?? 'Confirmar'}</button>}
    </div>
  </dialog>;
}

export const labels: Record<string, string> = {
  ACTIVE: 'Ativo', PAUSED: 'Pausado', ARCHIVED: 'Arquivado',
  NOT_VERIFIED: 'Não verificada', FULL: 'Completa na carga verificada',
  PARTIAL: 'Parcial na carga verificada', UNSUPPORTED: 'Não suportada na carga verificada',
  ROUTE_OBSERVED: 'Acesso ao recurso observado', CLAIM_OBSERVED: 'Sinal declarado recebido',
  UNKNOWN: 'Sem verificação atual',
};
