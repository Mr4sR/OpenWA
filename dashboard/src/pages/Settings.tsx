import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, KeyRound } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { saasAuthApi } from '../services/api';
import { useToast } from '../hooks/useToast';

/** Reads the SaaS session the login stored. Null when the caller is somehow unauthenticated. */
function readSession(): { token: string; user: SaasStoredUser } | null {
  const token = sessionStorage.getItem('openwa_saas_token');
  const raw = sessionStorage.getItem('openwa_saas_user');
  if (!token || !raw) return null;
  try {
    return { token, user: JSON.parse(raw) };
  } catch {
    return null;
  }
}

interface SaasStoredUser {
  id: string;
  email: string;
  name: string;
  role: string;
  accountId: string | null;
}

/** The signed-in user's own surface: profile (display names) and the change-password form. */
export function Settings() {
  const { t } = useTranslation();
  const toast = useToast();
  const session = readSession();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);

  if (!session) {
    return <div className="page">{t('saas.sessionMissing')}</div>;
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      toast.error(t('saas.passwordsDiffer'));
      return;
    }
    setBusy(true);
    try {
      await saasAuthApi.changePassword(session.token, { currentPassword, newPassword });
      toast.success(t('saas.passwordChanged'));
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <PageHeader title={t('saas.settingsTitle')} subtitle={t('saas.settingsSubtitle')} />

      <div className="settings-card">
        <h3>{t('saas.profileTitle')}</h3>
        <p>
          <strong>{t('saas.email')}:</strong> {session.user.email}
        </p>
        <p>
          <strong>{t('saas.name')}:</strong> {session.user.name}
        </p>
        <p>
          <strong>{t('saas.role')}:</strong> {session.user.role}
        </p>
      </div>

      <div className="settings-card">
        <h3>
          <KeyRound size={16} /> {t('saas.changePasswordTitle')}
        </h3>
        <form onSubmit={submit} className="settings-form">
          <div className="input-group">
            <label htmlFor="current-password">{t('saas.currentPassword')}</label>
            <input
              id="current-password"
              type="password"
              value={currentPassword}
              onChange={e => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>
          <div className="input-group">
            <label htmlFor="new-password">{t('saas.newPassword')}</label>
            <input
              id="new-password"
              type="password"
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              autoComplete="new-password"
              minLength={8}
              required
            />
          </div>
          <div className="input-group">
            <label htmlFor="confirm-password">{t('saas.confirmPassword')}</label>
            <input
              id="confirm-password"
              type="password"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
              minLength={8}
              required
            />
          </div>
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy && <Loader2 size={16} className="animate-spin" />}
            {t('common.save')}
          </button>
        </form>
      </div>
    </div>
  );
}
