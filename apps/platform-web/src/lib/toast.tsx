'use client';

import { useEffect, useState } from 'react';
import { Icon } from '@/components/icons';

type Kind = 'success' | 'error' | 'info';
interface ToastItem {
  id: number;
  kind: Kind;
  message: string;
}

const listeners = new Set<(items: ToastItem[]) => void>();
let items: ToastItem[] = [];
let seq = 0;
const TTL_MS = 4200;

const emit = () => listeners.forEach((l) => l(items));

/** Aviso flotante, desde cualquier parte (también fuera de componentes). Se anuncian por la región aria-live del contenedor. */
export function notify(kind: Kind, message: string): void {
  const id = ++seq;
  items = [...items.slice(-3), { id, kind, message }];
  emit();
  setTimeout(() => dismiss(id), TTL_MS);
}

function dismiss(id: number) {
  items = items.filter((i) => i.id !== id);
  emit();
}

/** Contenedor de avisos: se monta una sola vez en el layout raíz. */
export function ToastHost() {
  const [list, setList] = useState<ToastItem[]>([]);
  useEffect(() => {
    listeners.add(setList);
    setList(items);
    return () => {
      listeners.delete(setList);
    };
  }, []);
  return (
    <div className="toasts" aria-live="polite">
      {list.map((tt) => (
        <div key={tt.id} className={`toast ${tt.kind}`} data-testid="toast">
          <span className="toast-icon"><Icon name={tt.kind === 'success' ? 'check' : tt.kind === 'error' ? 'alert' : 'info'} size={18} /></span>
          <span className="toast-text">{tt.message}</span>
          <button type="button" className="toast-x" aria-label="Cerrar aviso" onClick={() => dismiss(tt.id)}><Icon name="close" size={16} /></button>
          <span className="toast-bar" style={{ animationDuration: `${TTL_MS}ms` }} />
        </div>
      ))}
    </div>
  );
}
