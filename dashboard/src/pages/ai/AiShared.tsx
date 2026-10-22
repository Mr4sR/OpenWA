import { useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { AiChatbot, AiLlmModel, AiMcpConnection, AiRagDocument, AiRagNode } from '../../services/api';

/**
 * Shared presentational pieces of the AI Integration page. The four sections (chatbots, LLM
 * models, RAG models, MCP connections) render the same card shape and differ only in the metadata
 * rows and the actions, so the card chrome lives here once.
 */

export type AiSectionKey = 'chatbots' | 'llm' | 'rag' | 'mcp';

export function AiSectionTabs({
  active,
  onChange,
  t,
}: {
  active: AiSectionKey;
  onChange: (key: AiSectionKey) => void;
  t: TFunction;
}) {
  const tabs: Array<{ key: AiSectionKey; label: string }> = [
    { key: 'chatbots', label: t('ai.tabs.chatbots') },
    { key: 'llm', label: t('ai.tabs.llm') },
    { key: 'rag', label: t('ai.tabs.rag') },
    { key: 'mcp', label: t('ai.tabs.mcp') },
  ];
  return (
    <div className="ai-tabs" role="tablist">
      {tabs.map(({ key, label }) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={active === key}
          className={`ai-tab ${active === key ? 'active' : ''}`}
          onClick={() => onChange(key)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function AiCard({
  title,
  icon,
  actions,
  children,
}: {
  title: string;
  icon: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="ai-card">
      <div className="ai-card-header">
        <div className="ai-card-title-row">
          <span className="ai-card-icon">{icon}</span>
          <span className="ai-card-title">{title}</span>
        </div>
        <div className="ai-card-actions">{actions}</div>
      </div>
      <div className="ai-card-body">{children}</div>
    </div>
  );
}

export function AiMetaItem({ label, value, code }: { label: string; value: ReactNode; code?: boolean }) {
  return (
    <div className="ai-meta-item">
      <span className="ai-meta-label">{label}</span>
      <span className={`ai-meta-value ${code ? 'ai-meta-code' : ''}`}>{value}</span>
    </div>
  );
}

export function AiToggleActions({
  enabled,
  onToggle,
  onEdit,
  onDelete,
  canWrite,
  extra,
}: {
  enabled: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  canWrite: boolean;
  extra?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <>
      {extra}
      {canWrite && (
        <>
          <button
            type="button"
            className="icon-btn"
            title={enabled ? t('ai.actions.disable') : t('ai.actions.enable')}
            onClick={onToggle}
          >
            {enabled ? '⏸' : '▶'}
          </button>
          <button type="button" className="icon-btn" title={t('ai.actions.edit')} onClick={onEdit}>
            ✎
          </button>
          <button type="button" className="icon-btn danger" title={t('ai.actions.delete')} onClick={onDelete}>
            🗑
          </button>
        </>
      )}
    </>
  );
}

/** The [title] preview of a RAG tree node, one row per line. */
export function AiTreePreview({ nodes, depth = 0 }: { nodes: AiRagNode[]; depth?: number }) {
  return (
    <>
      {nodes.map(node => (
        <div key={node.nodeId} className="ai-tree-row" style={{ paddingLeft: `${depth * 14}px` }}>
          <strong>{node.title || node.nodeId}</strong>
          <span>{node.summary?.slice(0, 160)}</span>
        </div>
      ))}
    </>
  );
}

export function aiDocStatusBadgeClass(status: AiRagDocument['status']): string {
  switch (status) {
    case 'ready':
      return 'ai-doc-status ready';
    case 'failed':
      return 'ai-doc-status failed';
    default:
      return 'ai-doc-status ingesting';
  }
}

/**
 * The knowledge editor of one RAG model: a readable entry table (source, title, size, ingestion
 * status) plus a wide add form. Ingestion is asynchronous for url/site/file — the row starts
 * pending and the parent polls until it settles.
 */
export function AiDocumentEditor({
  documents,
  onAdd,
  onDelete,
  canWrite,
  t,
}: {
  /** Kept for API symmetry with the other editors; unused today. */
  model?: unknown;
  documents: AiRagDocument[];
  onAdd: (payload: {
    sourceType: 'text' | 'url' | 'site' | 'file';
    title: string;
    content: string;
    sourceUrl: string;
  }) => void;
  onDelete: (documentId: string) => void;
  canWrite: boolean;
  t: TFunction;
}) {
  const [sourceType, setSourceType] = useState<'text' | 'url' | 'site' | 'file'>('text');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');

  const valid =
    sourceType === 'text'
      ? content.trim().length > 0
      : sourceUrl.trim().startsWith('http://') || sourceUrl.trim().startsWith('https://');

  return (
    <div className="ai-doc-editor">
      {documents.length > 0 && (
        <div className="ai-doc-table" role="table" aria-label={t('ai.rag.docTable')}>
          <div className="ai-doc-head" role="row">
            <span role="columnheader">{t('ai.rag.colSource')}</span>
            <span role="columnheader">{t('ai.rag.colTitle')}</span>
            <span role="columnheader">{t('ai.rag.colSize')}</span>
            <span role="columnheader">{t('ai.rag.colStatus')}</span>
            <span aria-hidden />
          </div>
          {documents.map(doc => (
            <div key={doc.id} className="ai-doc-row" role="row">
              <span role="cell">
                <span className="ai-tag ai-tag-muted">{doc.sourceType}</span>
              </span>
              <span role="cell" className="ai-doc-title" title={doc.title || doc.sourceUrl || doc.id}>
                {doc.title || doc.sourceUrl || doc.id}
              </span>
              <span role="cell" className="ai-doc-len">
                {doc.status === 'ready' ? t('ai.rag.documentChars', { count: doc.contentLength }) : '—'}
              </span>
              <span role="cell">
                <span className={aiDocStatusBadgeClass(doc.status)}>
                  {doc.status === 'ready'
                    ? t('ai.rag.statusReady')
                    : doc.status === 'pending'
                      ? t('ai.rag.statusPending')
                      : doc.status === 'processing'
                        ? t('ai.rag.statusProcessing')
                        : t('ai.rag.statusFailed')}
                </span>
                {doc.status === 'failed' && doc.statusError && (
                  <span className="ai-doc-status-error" title={doc.statusError}>
                    {doc.statusError.slice(0, 120)}
                  </span>
                )}
              </span>
              <span role="cell">
                {canWrite && (
                  <button
                    type="button"
                    className="icon-btn danger"
                    title={t('ai.actions.delete')}
                    aria-label={t('ai.actions.delete')}
                    onClick={() => onDelete(doc.id)}
                  >
                    🗑
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}

      {canWrite && (
        <div className="ai-doc-add">
          <div className="ai-doc-add-row">
            <select
              aria-label={t('ai.rag.colSource')}
              value={sourceType}
              onChange={e => setSourceType(e.target.value as typeof sourceType)}
            >
              <option value="text">{t('ai.rag.sourceType.text')}</option>
              <option value="url">{t('ai.rag.sourceType.url')}</option>
              <option value="site">{t('ai.rag.sourceType.site')}</option>
            </select>
            {sourceType !== 'text' && (
              <input
                type="url"
                placeholder={t('ai.rag.sourceUrlPlaceholder')}
                value={sourceUrl}
                onChange={e => setSourceUrl(e.target.value)}
              />
            )}
          </div>
          <input
            type="text"
            placeholder={t('ai.rag.titlePlaceholder')}
            value={title}
            onChange={e => setTitle(e.target.value)}
          />
          {sourceType === 'text' && (
            <textarea
              placeholder={t('ai.rag.contentPlaceholder')}
              value={content}
              rows={5}
              className="ai-persona-input"
              onChange={e => setContent(e.target.value)}
            />
          )}
          <div className="ai-doc-add-footer">
            <span className="hint">{t('ai.rag.asyncHint')}</span>
            <button
              type="button"
              className="btn-primary"
              disabled={!valid}
              onClick={() => {
                onAdd({ sourceType, title: title.trim(), content, sourceUrl: sourceUrl.trim() });
                setTitle('');
                setContent('');
                setSourceUrl('');
              }}
            >
              {t('ai.rag.addEntry')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function AiLlmStatusCell({ model, t }: { model: AiLlmModel; t: TFunction }) {
  if (!model.lastStatus) return <span className="ai-meta-value">—</span>;
  return (
    <span className="ai-meta-value">
      <span className={`ai-status-dot ${model.lastStatus.ok ? 'ok' : 'fail'}`} />
      {model.lastStatus.ok ? t('ai.llm.testOk') : model.lastStatus.error?.slice(0, 80)}
    </span>
  );
}

export function AiMcpStatusCell({ connection, t }: { connection: AiMcpConnection; t: TFunction }) {
  if (!connection.lastStatus) return <span className="ai-meta-value">—</span>;
  const s = connection.lastStatus;
  return (
    <span className="ai-meta-value">
      <span className={`ai-status-dot ${s.ok ? 'ok' : 'fail'}`} />
      {s.ok
        ? `${s.serverName ?? 'MCP'} · ${t('ai.mcp.toolCount', { count: s.toolCount ?? 0 })}`
        : s.error?.slice(0, 80)}
    </span>
  );
}

export function AiChatbotSummary({ chatbot, models }: { chatbot: AiChatbot; models: AiLlmModel[] }) {
  const llm = models.find(m => m.id === chatbot.llmModelId);
  return (
    <span className="ai-meta-value">
      {chatbot.name} → {llm?.name ?? chatbot.llmModelId.slice(0, 8)}
    </span>
  );
}
