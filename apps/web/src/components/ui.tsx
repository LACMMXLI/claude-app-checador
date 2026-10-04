'use client';

import { cloneElement, type ReactElement, type ReactNode, useCallback, useEffect, useId, useState } from 'react';
import { ApiError, mutationCount } from '@/lib/api';
import { errorText, t } from '@/lib/i18n';
import { notify } from '@/lib/toast';
import { Icon, type IconName } from './icons';

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

/**
 * Ejecuta una acción y traduce el error a texto (códigos estables de la API). Si la acción responde con datos, avisa con
 * un mensaje flotante de éxito si modificó datos (`okMessage` lo personaliza; `false` lo omite).
 */
export function useAction() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>, okMessage?: string | false): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      const before = mutationCount();
      const result = await fn();
      // solo avisa si la acción realmente modificó datos (una consulta no es "guardar")
      if (result !== undefined && okMessage !== false && mutationCount() > before) notify('success', okMessage ?? t('toast.done'));
      return result;
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

export function Card({ title, actions, children, icon }: { title?: string; actions?: ReactNode; children: ReactNode; icon?: IconName }) {
  return (
    <section className="card">
      {(title || actions) && (
        <header className="card-header">
          {title && (
            <h2>
              {icon && <span className="card-icon"><Icon name={icon} size={18} /></span>}
              {title}
            </h2>
          )}
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

/** Campo de contraseña con botón para ver/ocultar. El botón NO se llama "contraseña" para no chocar con la etiqueta. */
export function PasswordInput({ id, ...rest }: { id?: string } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'id'>) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="password-input">
      <input id={id} type={visible ? 'text' : 'password'} {...rest} />
      <button type="button" className="icon-btn" aria-label={visible ? 'Ocultar texto' : 'Ver texto'} aria-pressed={visible} onClick={() => setVisible((v) => !v)}>
        <Icon name={visible ? 'eyeOff' : 'eye'} size={18} />
      </button>
    </div>
  );
}

/** Estado vacío con ilustración sencilla. */
export function Empty({ text }: { text?: string }) {
  return (
    <div className="empty">
      <span className="empty-icon"><Icon name="empty" size={28} /></span>
      <p>{text ?? t('common.empty')}</p>
    </div>
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

/** Esqueleto con destello mientras carga (el texto queda para lectores de pantalla). */
export function Loading() {
  return (
    <div className="skeleton" role="status" aria-label={t('common.loading')}>
      <span className="sr-only">{t('common.loading')}</span>
      <i /><i /><i />
    </div>
  );
}
