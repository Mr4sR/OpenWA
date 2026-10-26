import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, KeyRound, UserRound } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { saasAuthApi, type SaasProfile } from '../services/api';
import { useToast } from '../hooks/useToast';
import { useEffect } from 'react';
import './Settings.css';

/** Reads the SaaS session the login stored. Null when the caller is somehow unauthenticated. */
function readSession(): { token: string; user: { id: string; email: string; name: string; role: string } } | null {
  const token = sessionStorage.getItem('openwa_saas_token');
  const raw = sessionStorage.getItem('openwa_saas_user');
  if (!token || !raw) return null;
  try {
    return { token, user: JSON.parse(raw) };
  } catch {
    return null;
  }
}

/**
 * The signed-in user's own surface — profile (email/name/role/plan) and the change-password form.
 * Layout follows the repo's card language (Settings.css mirrors AiIntegration.css): a padded page,
 * PageHeader, then stacked cards.
 */
export function Settings() {
  const { t } = useTranslation();
  const toast = useToast();
  const session = readSession();
  const [profile, setProfile] = useState<SaasProfile | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!session) return;
    let active = true;
    void saasAuthApi
      .me(session.token)
      .then(result => {
        if (active) setProfile(result);
      })
      .catch(() => {
        /* the login fence already refused; the header shows the cached identity */
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!session) {
    return (
      <div className="settings-page">
        <PageHeader title={t('saas.settingsTitle')} subtitle={t('saas.sessionMissing')} />
      </div>
    );
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

  const plan = profile?.plan;
  const account = profile?.account;

  return (
    <div className="settings-page">
      <PageHeader title={t('saas.settingsTitle')} subtitle={t('saas.settingsSubtitle')} />

      <div className="settings-content">
        <div className="settings-card">
          <h3>
            <UserRound size={16} /> {t('saas.profileTitle')}
          </h3>
          <div className="profile-row">
            <span className="profile-label">{t('saas.email')}</span>
            <span className="profile-value">{session.user.email}</span>
          </div>
          <div className="profile-row">
            <span className="profile-label">{t('saas.name')}</span>
            <span className="profile-value">{session.user.name}</span>
          </div>
          <div className="profile-row">
            <span className="profile-label">{t('saas.role')}</span>
            <span className="profile-value role">{session.user.role}</span>
          </div>
          {account && (
            <div className="profile-row">
              <span className="profile-label">{t('saas.account')}</span>
              <span className="profile-value">{account.name}</span>
            </div>
          )}
          {plan && (
            <div className="profile-row">
              <span className="profile-label">{t('saas.plan')}</span>
              <span className="profile-value">
                {plan.name} ·{' '}
                {t('saas.planLimits', {
                  sessions: plan.maxSessions === -1 ? '∞' : plan.maxSessions,
                  chatbots: plan.maxChatbots === -1 ? '∞' : plan.maxChatbots,
                  webhooks: plan.maxWebhooks === -1 ? '∞' : plan.maxWebhooks,
                })}
              </span>
            </div>
          )}
        </div>

        <div className="settings-card">
          <h3>
            <KeyRound size={16} /> {t('saas.changePasswordTitle')}
          </h3>
          <form onSubmit={submit} className="settings-form">
            <label htmlFor="current-password">{t('saas.currentPassword')}</label>
            <input
              id="current-password"
              type="password"
              value={currentPassword}
              onChange={e => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
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
            <button type="submit" className="btn-primary" disabled={busy}>
              {busy && <Loader2 size={16} className="animate-spin" />}
              {t('common.save')}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
