import { useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { AiChatbot, AiLlmModel, AiMcpConnection, AiRagDocument, AiRagModel, AiRagNode } from '../../services/api';

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

export function AiDocumentEditor({
  model,
  documents,
  onAdd,
  onDelete,
  canWrite,
  t,
}: {
  model: AiRagModel;
  documents: AiRagDocument[];
  onAdd: (payload: { sourceType: 'text' | 'url' | 'site' | 'file'; title: string; content: string; sourceUrl: string }) => void;
  onDelete: (documentId: string) => void;
  canWrite: boolean;
  t: TFunction;
}) {
  // The knowledge editor is inline: one add row (source type + content) and the list of entries.
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
        <div className="ai-doc-list">
          {documents.map(doc => (
            <div key={doc.id} className="ai-doc-row">
              <span className={`ai-tag ${doc.sourceType === 'text' ? '' : 'ai-tag-muted'}`}>{doc.sourceType}</span>
              <span className="ai-doc-title">{doc.title || doc.sourceUrl || doc.id}</span>
              <span className="ai-doc-len">{t('ai.rag.documentChars', { count: doc.contentLength })}</span>
              {canWrite && (
                <button
                  type="button"
                  className="icon-btn danger"
                  title={t('ai.actions.delete')}
                  onClick={() => onDelete(doc.id)}
                >
                  🗑
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {canWrite && (
        <div className="ai-doc-add">
          <select
            aria-label={t('ai.rag.sourceTypeLabel')}
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
          <input
            type="text"
            placeholder={t('ai.rag.titlePlaceholder')}
            value={title}
            onChange={e => setTitle(e.target.value)}
          />
          <textarea
            placeholder={t('ai.rag.contentPlaceholder')}
            value={content}
            onChange={e => setContent(e.target.value)}
            style={{ minHeight: 60 }}
          />
          <button
            type="button"
            className="btn-secondary"
            disabled={!valid}
            onClick={() => {
              onAdd({
                sourceType,
                title: title.trim(),
                content: content,
                sourceUrl: sourceUrl.trim(),
              });
              setTitle('');
              setContent('');
              setSourceUrl('');
            }}
          >
            {t('ai.rag.addEntry')}
          </button>
        </div>
      )}
      {!model.hasIndex && canWrite && documents.length > 0 && (
        <span className="hint">{t('ai.rag.needsIndex')}</span>
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
