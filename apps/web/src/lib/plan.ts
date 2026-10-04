import { useEffect, useState } from 'react';
import { api } from './api';

export interface SubscriptionView {
  planCode: string;
  planName: string;
  status: 'TRIAL' | 'ACTIVE' | 'SUSPENDED' | 'EXPIRED' | 'CANCELLED';
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  limits: { branches: number | null; employees: number | null; kiosks: number | null; members: number | null };
  features: { reportsExport: boolean; scheduleTemplates: boolean };
  usage: { branches: number; employees: number; kiosks: number; members: number; pendingInvitations: number };
}

/** Plan del negocio (solo lectura). `null` mientras carga o si no se pudo leer: la API sigue siendo la que decide. */
export function useSubscription(): SubscriptionView | null {
  const [value, setValue] = useState<SubscriptionView | null>(null);
  useEffect(() => {
    void api<SubscriptionView>('/subscription').then(setValue, () => setValue(null));
  }, []);
  return value;
}
