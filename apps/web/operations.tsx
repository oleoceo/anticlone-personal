import {createContext, useContext, useRef, useState, type FormEvent, type PropsWithChildren, type ReactNode} from 'react';
import {AdminError} from './admin-api';
import {Confirm, Failure} from './ui';

export class InputError extends Error {}

export type Guard = 'clean' | 'dirty' | 'saving';
export type SetGuard = (state: Guard) => void;
export const trafficLabels = {
  PAID_ATTRIBUTED: 'Tráfego pago atribuído',
  ORGANIC: 'Orgânico',
  REFERRAL: 'Referência',
  DIRECT_UNKNOWN: 'Direto ou desconhecido',
};
export type Allocation = Record<keyof typeof trafficLabels, number>;
export const emptyAllocation: Allocation = {PAID_ATTRIBUTED: 0, ORGANIC: 0, REFERRAL: 0, DIRECT_UNKNOWN: 0};

export const value = (data: FormData, key: string) => String(data.get(key) ?? '').trim();
export const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export function formatDate(value?: string | null) {
  if (!value) return 'Indisponível';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? 'Indisponível' : date.toLocaleString('pt-BR', {dateStyle: 'short', timeStyle: 'short'});
}

type Tracker = {saving: () => boolean; start: () => void; version: (form: HTMLFormElement) => number | undefined; finish: (saved?: HTMLFormElement, version?: number) => void};
const drafts = createContext<Tracker | null>(null);
const owners = new WeakMap<FormData, HTMLFormElement>();

export function DraftGuard({setGuard, children}: PropsWithChildren<{setGuard: SetGuard}>) {
  const changed = useRef(new Map<HTMLFormElement, number>());
  const revision = useRef(0);
  const saving = useRef(false);
  const tracker: Tracker = {
    saving: () => saving.current,
    start: () => { saving.current = true; setGuard('saving'); },
    version: form => changed.current.get(form),
    finish: (saved, version) => {
      if (saved && changed.current.get(saved) === version) changed.current.delete(saved);
      saving.current = false;
      for (const form of changed.current.keys()) if (!form.isConnected) changed.current.delete(form);
      setGuard(changed.current.size ? 'dirty' : 'clean');
    },
  };
  return <drafts.Provider value={tracker}><div className="draft-scope" onChangeCapture={event => {
    const form = event.target instanceof HTMLElement ? event.target.closest('form') : null;
    if (form) {
      changed.current.set(form, ++revision.current);
      if (!saving.current) setGuard('dirty');
    }
  }}>{children}</div></drafts.Provider>;
}

export function useOperation(setGuard: SetGuard) {
  const tracker = useContext(drafts);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [message, setMessage] = useState('');
  const [confirmation, setConfirmation] = useState<{title: string; summary: ReactNode; execute: () => Promise<string>; form?: HTMLFormElement; version?: number}>();

  function review(title: string, summary: ReactNode, execute: () => Promise<string>, fields?: FormData) {
    if (!inFlight.current && !tracker?.saving()) {
      setError(undefined);
      setMessage('');
      const form = fields ? owners.get(fields) : undefined;
      setConfirmation({title, summary, execute, form, version: form ? tracker?.version(form) : undefined});
    }
  }

  async function execute() {
    if (inFlight.current || tracker?.saving() || !confirmation) return;
    inFlight.current = true;
    setConfirmation(undefined);
    if (tracker) tracker.start();
    else setGuard('saving');
    setBusy(true);
    try {
      setMessage(await confirmation.execute());
      if (tracker) tracker.finish(confirmation.form, confirmation.version);
      else setGuard('clean');
    } catch (error) {
      setError(error);
      if (tracker) tracker.finish();
      else setGuard('dirty');
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  }

  function notice() {
    return <>
      {message && <p className="notice" role="status">{message}</p>}
      {error instanceof InputError ? <p className="notice danger" role="alert">{error.message}</p> : error !== undefined && <Failure error={error}/>}
      {error instanceof AdminError && error.status === 409 && <p>Consulte novamente a situação antes de revisar e enviar outra solicitação.</p>}
      {confirmation && <Confirm title={confirmation.title} accept={() => void execute()}
        cancel={() => setConfirmation(undefined)}>{confirmation.summary}</Confirm>}
    </>;
  }

  return {busy, review, notice, setError};
}

export function formData(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();
  const fields = new FormData(event.currentTarget);
  owners.set(fields, event.currentTarget);
  return fields;
}

export function DetailsData({heading, data}: {heading: string; data: unknown}) {
  return <details><summary>{heading}</summary><pre tabIndex={0}><code>{JSON.stringify(data, null, 2)}</code></pre></details>;
}
