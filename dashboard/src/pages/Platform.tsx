import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Trash2, Ban, Play, Users, Building2, CreditCard } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { Modal } from '../components/Modal';
import { useToast } from '../hooks/useToast';
import { platformApi, type SaasPlan } from '../services/api';
import './Platform.css';

/**
 * The DEVELOPER surface of the SaaS: every tenant (suspend/reactivate/plan/delete), every login
 * (disable) and the plan catalogue. Authenticates with the SaaS session token; the backend refuses
 * anything but an active platform_admin with 403 regardless of this page.
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

type Tab = 'accounts' | 'users' | 'plans';

export function Platform() {
  const { t } = useTranslation();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('accounts');
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
      setUsers(userRows as unknown as PlatformUser[]);
      setPlans(planRows as SaasPlan[]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
    // toast's identity is stable (module singleton); keeping it out avoids re-fetch loops.
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

  const tabs: Array<{ key: Tab; label: string; icon: typeof Users }> = [
    { key: 'accounts', label: t('platform.tab.accounts'), icon: Building2 },
    { key: 'users', label: t('platform.tab.users'), icon: Users },
    { key: 'plans', label: t('platform.tab.plans'), icon: CreditCard },
  ];

  return (
    <div className="platform-page">
      <PageHeader title={t('platform.title')} subtitle={t('platform.subtitle')} />

      <div className="platform-tabs" role="tablist">
        {tabs.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={`platform-tab ${tab === key ? 'active' : ''}`}
            onClick={() => setTab(key)}
          >
            <Icon size={16} /> {label}
          </button>
        ))}
      </div>

      <div className="platform-content">
        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '3rem' }}>
            <Loader2 className="animate-spin" size={28} />
          </div>
        ) : tab === 'accounts' ? (
          accounts.length === 0 ? (
            <div className="empty-state">
              <Building2 size={48} strokeWidth={1} />
              <h3>{t('platform.emptyTitle')}</h3>
              <p>{t('platform.emptyDescription')}</p>
            </div>
          ) : (
            <div className="platform-table-container">
              <table className="platform-table">
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
                      <td>
                        <div className="account-name">{account.name}</div>
                        {account.note && <div className="account-note">{account.note}</div>}
                      </td>
                      <td>
                        <select
                          value={account.planSlug}
                          disabled={busy}
                          aria-label={t('platform.plan')}
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
                        <span className={`status-badge ${account.status === 'suspended' ? 'suspended' : 'active'}`}>
                          {t(`platform.${account.status}`)}
                        </span>
                      </td>
                      <td>{account.userCount}</td>
                      <td className="actions-cell">
                        <button
                          type="button"
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
                          type="button"
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
          )
        ) : tab === 'users' ? (
          users.length === 0 ? (
            <div className="empty-state">
              <Users size={48} strokeWidth={1} />
              <h3>{t('platform.emptyUsersTitle')}</h3>
            </div>
          ) : (
            <div className="platform-table-container">
              <table className="platform-table">
                <thead>
                  <tr>
                    <th>{t('saas.email')}</th>
                    <th>{t('saas.name')}</th>
                    <th>{t('saas.role')}</th>
                    <th>{t('platform.status')}</th>
                    <th>{t('platform.lastLogin')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {users.map(user => (
                    <tr key={user.id}>
                      <td>{user.email}</td>
                      <td>{user.name}</td>
                      <td>
                        <span className="plan-badge">{user.role}</span>
                      </td>
                      <td>
                        <span className={`status-badge ${user.isActive ? 'active' : 'inactive'}`}>
                          {user.isActive ? t('platform.active') : t('platform.inactive')}
                        </span>
                      </td>
                      <td className="muted">{user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : '—'}</td>
                      <td className="actions-cell">
                        <button
                          type="button"
                          className="icon-btn"
                          disabled={busy || !token || user.role === 'platform_admin'}
                          title={user.isActive ? t('platform.disable') : t('platform.enable')}
                          onClick={() =>
                            token &&
                            void run(
                              () => platformApi.setUserActive(token, user.id, !user.isActive),
                              'platform.userChanged',
                            )
                          }
                        >
                          <Users size={16} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : plans.length === 0 ? (
          <div className="empty-state">
            <CreditCard size={48} strokeWidth={1} />
            <h3>{t('platform.emptyPlansTitle')}</h3>
          </div>
        ) : (
          <div className="platform-table-container">
            <table className="platform-table">
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
                    <td>
                      <span className="plan-badge">{plan.slug}</span>
                    </td>
                    <td>{plan.name}</td>
                    <td>{plan.maxSessions === -1 ? '∞' : plan.maxSessions}</td>
                    <td>{plan.maxChatbots === -1 ? '∞' : plan.maxChatbots}</td>
                    <td>{plan.maxWebhooks === -1 ? '∞' : plan.maxWebhooks}</td>
                    <td>
                      {plan.priceCents === 0
                        ? t('platform.free')
                        : `Rp ${(plan.priceCents / 100).toLocaleString('id-ID')}`}
                    </td>
                    <td>{plan.subscribers ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {deleting && (
        <Modal
          open
          title={t('platform.deleteTitle')}
          onClose={() => setDeleting(null)}
          closeLabel={t('common.cancel')}
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
