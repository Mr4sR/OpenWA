import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Loader2, Pencil, ShieldCheck } from 'lucide-react';
import { accountApi, type Account } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useAccountsQuery } from '../hooks/queries';
import { PageHeader } from '../components/PageHeader';
import { Modal } from '../components/Modal';
import { useToast } from '../hooks/useToast';
import './Platform.css';

/**
 * Accounts (tenants) management — the multi-account surface. Loading this page requires an
 * unscoped key (the backend refuses everything else), which the route gate in App.tsx already
 * guarantees; the page itself only talks to /accounts.
 */
export function Accounts() {
  const { t } = useTranslation();
  useDocumentTitle(t('accounts.title'));
  const toast = useToast();
  const queryClient = useQueryClient();
  const accountsQuery = useAccountsQuery();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  const [deleting, setDeleting] = useState<Account | null>(null);
  const [draft, setDraft] = useState<{ name: string; note: string }>({ name: '', note: '' });
  const [busy, setBusy] = useState(false);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['accounts'] });
  };

  const run = async (what: () => Promise<unknown>, okMessage: string) => {
    setBusy(true);
    try {
      await what();
      toast.success(t(okMessage));
      invalidate();
      return true;
    } catch (err) {
      toast.error(t('common.error', { message: err instanceof Error ? err.message : String(err) }));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const accounts = accountsQuery.data ?? [];

  return (
    <div className="platform-page">
      <PageHeader
        title={t('accounts.title')}
        subtitle={t('accounts.subtitle')}
        actions={
          <button
            className="btn-primary"
            onClick={() => {
              setDraft({ name: '', note: '' });
              setCreating(true);
            }}
          >
            <Plus size={18} />
            {t('accounts.add')}
          </button>
        }
      />

      {accounts.length === 0 ? (
        <div className="empty-state">
          <ShieldCheck size={48} strokeWidth={1} />
          <h3>{t('accounts.emptyTitle')}</h3>
          <p>{t('accounts.emptyDescription')}</p>
        </div>
      ) : (
        <div className="platform-table-container">
          <table className="platform-table">
            <thead>
              <tr>
                <th>{t('accounts.name')}</th>
                <th>{t('accounts.note')}</th>
                <th>{t('accounts.status')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {accounts.map(account => (
                <tr key={account.id}>
                  <td>{account.name}</td>
                  <td>{account.note || '—'}</td>
                  <td>{account.isActive ? t('accounts.active') : t('accounts.inactive')}</td>
                  <td className="actions-cell">
                    <button
                      type="button"
                      className="icon-btn"
                      title={t('ai.actions.edit')}
                      onClick={() => {
                        setDraft({ name: account.name, note: account.note ?? '' });
                        setEditing(account);
                      }}
                    >
                      <Pencil size={16} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn danger"
                      title={t('ai.actions.delete')}
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
      )}

      {(creating || editing) && (
        <Modal
          open
          title={editing ? t('accounts.editTitle') : t('accounts.createTitle')}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          footer={
            <>
              <button
                className="btn-secondary"
                onClick={() => {
                  setCreating(false);
                  setEditing(null);
                }}
              >
                {t('common.cancel')}
              </button>
              <button
                className="btn-primary"
                disabled={busy || !draft.name.trim()}
                onClick={async () => {
                  const ok = editing
                    ? await run(
                        () =>
                          accountApi.update(editing.id, {
                            name: draft.name.trim(),
                            note: draft.note.trim() || undefined,
                          }),
                        'accounts.saved',
                      )
                    : await run(
                        () => accountApi.create({ name: draft.name.trim(), note: draft.note.trim() || undefined }),
                        'accounts.created',
                      );
                  if (ok) {
                    setCreating(false);
                    setEditing(null);
                  }
                }}
              >
                {busy ? <Loader2 size={16} className="animate-spin" /> : null}
                {t('common.save')}
              </button>
            </>
          }
        >
          <label htmlFor="account-name">{t('accounts.name')}</label>
          <input
            id="account-name"
            type="text"
            value={draft.name}
            onChange={e => setDraft({ ...draft, name: e.target.value })}
          />
          <label htmlFor="account-note">{t('accounts.note')}</label>
          <input
            id="account-note"
            type="text"
            value={draft.note}
            onChange={e => setDraft({ ...draft, note: e.target.value })}
          />
          <p className="hint">{t('accounts.hint')}</p>
        </Modal>
      )}

      {deleting && (
        <Modal
          open
          title={t('accounts.deleteTitle')}
          onClose={() => setDeleting(null)}
          footer={
            <>
              <button className="btn-secondary" onClick={() => setDeleting(null)}>
                {t('common.cancel')}
              </button>
              <button
                className="btn-danger"
                disabled={busy}
                onClick={async () => {
                  const ok = await run(() => accountApi.delete(deleting.id), 'accounts.deleted');
                  if (ok) setDeleting(null);
                }}
              >
                {t('ai.actions.delete')}
              </button>
            </>
          }
        >
          <p>{t('accounts.deleteConfirm', { name: deleting.name })}</p>
        </Modal>
      )}
    </div>
  );
}
