'use client';

import { usePathname, useRouter } from 'next/navigation';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { api, ApiError, type Me } from './api';

interface SessionValue {
  me: Me | null;
  reload: () => Promise<void>;
  can: (permission: string) => boolean;
}

const SessionContext = createContext<SessionValue>({ me: null, reload: async () => undefined, can: () => false });
export const useSession = () => useContext(SessionContext);

const PUBLIC = ['/login', '/invitacion'];

/** Carga la identidad y el negocio activo desde el servidor; redirige a login o al selector según corresponda. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  const isPublic = PUBLIC.some((p) => pathname.startsWith(p));

  const reload = useCallback(async () => {
    try {
      setMe(await api<Me>('/auth/me'));
    } catch (e) {
      setMe(null);
      if (e instanceof ApiError && e.status === 401 && !isPublic) router.replace('/login');
    } finally {
      setReady(true);
    }
  }, [isPublic, router]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!ready || isPublic || !me) return;
    if (!me.activeOrganization && pathname !== '/seleccionar-negocio') router.replace('/seleccionar-negocio');
  }, [ready, me, isPublic, pathname, router]);

  const can = useCallback((p: string) => Boolean(me?.permissions?.[p]), [me]);
  if (!ready && !isPublic) return null;
  return <SessionContext.Provider value={{ me, reload, can }}>{children}</SessionContext.Provider>;
}
