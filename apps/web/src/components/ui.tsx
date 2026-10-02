'use client';

import { cloneElement, type ReactElement, type ReactNode, useCallback, useEffect, useId, useState } from 'react';
import { ApiError } from '@/lib/api';
import { errorText, t } from '@/lib/i18n';

export function useLoad<T>(loader: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setError(null);
      setData(await loader());
    } catch (e) {
      setError(errorText(e instanceof ApiError ? e.code : undefined));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, reload };
}

/** Ejecuta una acción y traduce el error a texto (códigos estables de la API). */
export function useAction() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(errorText(e instanceof ApiError ? e.code : undefined));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { error, busy, run, setError };
}

export const ErrorBox = ({ message }: { message: string | null }) => (message ? <p className="error" role="alert">{message}</p> : null);

/** Etiqueta asociada por `id` (nombre accesible = solo el texto de la etiqueta). */
export function Field({ label, children }: { label: string; children: ReactElement<{ id?: string }> }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {cloneElement(children, { id })}
    </div>
  );
}

export function Card({ title, actions, children }: { title?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      {(title || actions) && (
        <header className="card-header">
          {title && <h2>{title}</h2>}
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

/** Secreto que solo se muestra UNA vez (PIN, token de kiosco, enlace de invitación). No se guarda en el navegador. */
export function OneTimeSecret({ label, value, onClose }: { label: string; value: string; onClose: () => void }) {
  return (
    <div className="secret" role="dialog" aria-label={label}>
      <strong>{label}</strong>
      <p className="muted">{t('secret.title')}</p>
      <code>{value}</code>
      <div className="row">
        <button type="button" onClick={() => void navigator.clipboard?.writeText(value)}>Copiar</button>
        <button type="button" className="primary" onClick={onClose}>{t('secret.close')}</button>
      </div>
    </div>
  );
}

export function Status({ active }: { active: boolean }) {
  return <span className={`badge ${active ? 'ok' : 'off'}`}>{active ? t('common.active') : t('common.inactive')}</span>;
}

export function Loading() {
  return <p className="muted">{t('common.loading')}</p>;
}
