import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Trash2, Ban, Play, UserPlus } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { Modal } from '../components/Modal';
import { useToast } from '../hooks/useToast';
import { platformApi, type SaasPlan } from '../services/api';

/**
 * The DEVELOPER surface of the SaaS: every tenant (suspend/reactivate/plan/delete), every login
 * (disable, move between tenants) and the plan catalogue. Reads its session from /login; anything
 * but an active platform_admin is refused server-side (403), the page only renders after role gate.
 */

interface PlatformAccount {
  id: string;
  name: string;
  note: string | null;
  planSlug: string;
  status: 'active' | 'suspended';
  planExpiresAt: string | null;
  isActive: boolean;
  createdAt: string;
  userCount: number;
}

interface PlatformUser {
  id: string;
  email: string;
  name: string;
  role: 'platform_admin' | 'account_admin' | 'account_member';
  accountId: string | null;
  isActive: boolean;
  lastLoginAt: string | null;
}

function readToken(): string | null {
  return sessionStorage.getItem('openwa_saas_token');
}

export function Platform() {
  const { t } = useTranslation();
  const toast = useToast();
  const [tab, setTab] = useState<'accounts' | 'users' | 'plans'>('accounts');
  const [accounts, setAccounts] = useState<PlatformAccount[]>([]);
  const [users, setUsers] = useState<PlatformUser[]>([]);
  const [plans, setPlans] = useState<SaasPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<PlatformAccount | null>(null);

  const token = readToken();
  const reload = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [accountRows, userRows, planRows] = await Promise.all([
        platformApi.accounts(token),
        platformApi.users(token),
        platformApi.plans(token),
      ]);
      setAccounts(accountRows as unknown as PlatformAccount[]);
      setUsers(userRows as PlatformUser[]);
      setPlans(planRows);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const run = async (what: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await what();
      toast.success(t(ok));
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <PageHeader title={t('platform.title')} subtitle={t('platform.subtitle')} />

      <div className="platform-tabs">
        {(['accounts', 'users', 'plans'] as const).map(key => (
          <button key={key} className={`platform-tab ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)}>
            {t(`platform.tab.${key}`)}
          </button>
        ))}
      </div>

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '3rem' }}>
          <Loader2 className="animate-spin" size={28} />
        </div>
      ) : tab === 'accounts' ? (
        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('platform.name')}</th>
                <th>{t('platform.plan')}</th>
                <th>{t('platform.status')}</th>
                <th>{t('platform.users')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {accounts.map(account => (
                <tr key={account.id}>
                  <td>{account.name}</td>
                  <td>
                    <select
                      value={account.planSlug}
                      disabled={busy}
                      onChange={e =>
                        token &&
                        void run(
                          () => platformApi.setAccountPlan(token, account.id, e.target.value),
                          'platform.planChanged',
                        )
                      }
                    >
                      {plans.map(plan => (
                        <option key={plan.slug} value={plan.slug}>
                          {plan.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <span className={account.status === 'suspended' ? 'status-suspended' : 'status-active'}>
                      {t(`platform.${account.status}`)}
                    </span>
                  </td>
                  <td>{account.userCount}</td>
                  <td className="actions-cell">
                    <button
                      className="icon-btn"
                      title={account.status === 'suspended' ? t('platform.reactivate') : t('platform.suspend')}
                      disabled={busy || !token}
                      onClick={() =>
                        token &&
                        void run(
                          () =>
                            platformApi.setAccountStatus(
                              token,
                              account.id,
                              account.status === 'suspended' ? 'active' : 'suspended',
                            ),
                          'platform.statusChanged',
                        )
                      }
                    >
                      {account.status === 'suspended' ? <Play size={16} /> : <Ban size={16} />}
                    </button>
                    <button
                      className="icon-btn danger"
                      title={t('common.delete')}
                      disabled={busy}
                      onClick={() => setDeleting(account)}
                    >
                      <Trash2 size={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : tab === 'users' ? (
        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('saas.email')}</th>
                <th>{t('saas.name')}</th>
                <th>{t('saas.role')}</th>
                <th>{t('platform.status')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.map(user => (
                <tr key={user.id}>
                  <td>{user.email}</td>
                  <td>{user.name}</td>
                  <td>{user.role}</td>
                  <td>{user.isActive ? t('platform.active') : t('platform.inactive')}</td>
                  <td className="actions-cell">
                    <button
                      className="icon-btn"
                      disabled={busy || !token}
                      title={user.isActive ? t('platform.disable') : t('platform.enable')}
                      onClick={() =>
                        token &&
                        void run(
                          () => platformApi.setUserActive(token, user.id, !user.isActive),
                          'platform.userChanged',
                        )
                      }
                    >
                      <UserPlus size={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('platform.slug')}</th>
                <th>{t('platform.name')}</th>
                <th>{t('platform.maxSessions')}</th>
                <th>{t('platform.maxChatbots')}</th>
                <th>{t('platform.maxWebhooks')}</th>
                <th>{t('platform.price')}</th>
                <th>{t('platform.subscribers')}</th>
              </tr>
            </thead>
            <tbody>
              {plans.map(plan => (
                <tr key={plan.id}>
                  <td>{plan.slug}</td>
                  <td>{plan.name}</td>
                  <td>{plan.maxSessions}</td>
                  <td>{plan.maxChatbots}</td>
                  <td>{plan.maxWebhooks}</td>
                  <td> Rp {(plan.priceCents / 100).toLocaleString('id-ID')}</td>
                  <td>{plan.subscribers ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {deleting && (
        <Modal
          open
          title={t('platform.deleteTitle')}
          onClose={() => setDeleting(null)}
          footer={
            <>
              <button className="btn-secondary" onClick={() => setDeleting(null)}>
                {t('common.cancel')}
              </button>
              <button
                className="btn-danger"
                disabled={busy || !token}
                onClick={async () => {
                  if (token) await run(() => platformApi.deleteAccount(token, deleting.id), 'platform.accountDeleted');
                  setDeleting(null);
                }}
              >
                {t('common.delete')}
              </button>
            </>
          }
        >
          <p>{t('platform.deleteConfirm', { name: deleting.name })}</p>
        </Modal>
      )}
    </div>
  );
}
