import { t } from '@/lib/i18n';
import type { SubStatus } from '@/lib/api';

/** Estado de la suscripción con texto (nunca solo color). */
export function StatusBadge({ status, testid }: { status: SubStatus; testid?: string }) {
  return <span className={`badge plan-${status}`} data-testid={testid}>{t(`status.${status}`)}</span>;
}

export function LimitText({ used, limit }: { used: number; limit: number | null }) {
  return <>{used} / {limit ?? t('unlimited')}</>;
}
