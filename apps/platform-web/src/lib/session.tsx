'use client';

import { usePathname, useRouter } from 'next/navigation';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { api, ApiError, type Operator } from './api';

interface SessionValue { operator: Operator | null; reload: () => Promise<void> }
const SessionContext = createContext<SessionValue>({ operator: null, reload: async () => undefined });
export const useSession = () => useContext(SessionContext);

/** Carga la identidad del operador desde el servidor y manda a /login si no hay sesión. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [operator, setOperator] = useState<Operator | null>(null);
  const [ready, setReady] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  const isPublic = pathname.startsWith('/login');

  const reload = useCallback(async () => {
    try {
      setOperator((await api<{ operator: Operator }>('/auth/me')).operator);
    } catch (e) {
      setOperator(null);
      if (e instanceof ApiError && e.status === 401 && !isPublic) router.replace('/login');
    } finally {
      setReady(true);
    }
  }, [isPublic, router]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (!ready && !isPublic) return null;
  return <SessionContext.Provider value={{ operator, reload }}>{children}</SessionContext.Provider>;
}
