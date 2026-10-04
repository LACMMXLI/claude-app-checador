'use client';

import { Icon } from '@/components/icons';
import { Card, ErrorBox, useAction } from '@/components/ui';
import { api } from '@/lib/api';
import { t } from '@/lib/i18n';
import { useSession } from '@/lib/session';

/**
 * Selector de negocio. El servidor valida la membresía y ROTA la sesión; después se recarga la página
 * completa para descartar cualquier estado/caché del negocio anterior.
 */
export default function SelectOrganizationPage() {
  const { me } = useSession();
  const { error, busy, run } = useAction();

  async function choose(organizationId: string) {
    const ok = await run(() => api('/auth/switch-organization', { method: 'POST', body: { organizationId } }), false);
    if (ok) window.location.assign('/');
  }

  return (
    <div className="center">
      <Card title={t('org.select.title')}>
        <p className="muted">{t('org.select.help')}</p>
        <div className="org-list">
          {me?.memberships.map((m) => (
            <button key={m.organizationId} disabled={busy} className={m.organizationId === me.activeOrganization?.id ? 'primary' : ''} onClick={() => void choose(m.organizationId)}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '.6rem' }}><Icon name="building" size={18} />{m.name}</span>
              <Icon name="check" size={16} style={{ opacity: m.organizationId === me.activeOrganization?.id ? 1 : 0 }} />
            </button>
          ))}
        </div>
        <ErrorBox message={error} />
      </Card>
    </div>
  );
}
