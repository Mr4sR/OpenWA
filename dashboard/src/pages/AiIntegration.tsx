import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  Plus,
  Bot,
  BrainCircuit,
  BookOpen,
  Plug,
  Loader2,
  AlertCircle,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { aiApi, type AiChatbot, type AiLlmModel, type AiMcpConnection, type AiRagDocument, type AiRagModel } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks/useRole';
import { useToast } from '../hooks/useToast';
import { useSessionsQuery } from '../hooks/queries';
import {
  useAiChatbotsQuery,
  useAiLlmModelsQuery,
  useAiMcpConnectionsQuery,
  useAiRagModelsQuery,
  useInvalidateAiQueries,
} from '../hooks/queries';
import { PageHeader } from '../components/PageHeader';
import { Modal } from '../components/Modal';
import './AiIntegration.css';
import {
  AiCard,
  AiDocumentEditor,
  AiLlmStatusCell,
  AiMcpStatusCell,
  AiMetaItem,
  AiSectionTabs,
  AiToggleActions,
  AiTreePreview,
  type AiSectionKey,
} from './ai/AiShared';

/**
 * AI Integration — the create/edit/delete surface for the four AI instance kinds:
 * Chatbot (per-session bots), AI LLM (provider connections), RAG Vectorless (PageIndex-style
 * knowledge bases) and MCP Server (outbound tool servers). One page, four tabs; each tab is a
 * card list with create/edit/delete modals in the webhook style.
 */
export function AiIntegration() {
  const { t } = useTranslation();
  useDocumentTitle(t('ai.title'));
  const { canWrite } = useRole();
  const invalidate = useInvalidateAiQueries();

  const [section, setSection] = useState<AiSectionKey>('chatbots');
  // The header's create action opens the ACTIVE tab's create modal; the section owns the modal
  // itself, the page owns which section is asking for one.
  const [creating, setCreating] = useState(false);
  const llmQuery = useAiLlmModelsQuery(true);
  const chatbotsQuery = useAiChatbotsQuery(true);
  const ragQuery = useAiRagModelsQuery(true);
  const mcpQuery = useAiMcpConnectionsQuery(true);
  // Sessions feed the chatbot binding select and the RAG scope picker.
  useSessionsQuery();

  const loading = llmQuery.isLoading || chatbotsQuery.isLoading || ragQuery.isLoading || mcpQuery.isLoading;
  const loadError = [llmQuery, chatbotsQuery, ragQuery, mcpQuery].find(q => q.error)?.error as
    | (Error & { status?: number })
    | undefined;

  return (
    <div className="ai-page">
      <PageHeader
        title={t('ai.title')}
        subtitle={t('ai.subtitle')}
        actions={
          canWrite && (
            <button
              className="btn-primary"
              onClick={() => setCreating(true)}
            >
              <Plus size={18} />
              {t(`ai.add.${section}`)}
            </button>
          )
        }
      />

      <AiSectionTabs active={section} onChange={setSection} t={t} />

      {loadError && (
        <div className="error-banner" role="alert">
          <AlertCircle size={20} />
          <span className="error-banner-text">
            {loadError.status === 403 ? t('ai.errors.forbidden') : t('dashboard.loadError')}
          </span>
        </div>
      )}

      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '400px' }}>
          <Loader2 className="animate-spin" size={32} />
        </div>
      ) : (
        <>
          {section === 'chatbots' && (
            <ChatbotsSection t={t} canWrite={canWrite} invalidate={invalidate} creating={creating} onCreated={() => setCreating(false)} />
          )}
          {section === 'llm' && (
            <LlmSection t={t} canWrite={canWrite} invalidate={invalidate} creating={creating} onCreated={() => setCreating(false)} />
          )}
          {section === 'rag' && (
            <RagSection t={t} canWrite={canWrite} invalidate={invalidate} creating={creating} onCreated={() => setCreating(false)} />
          )}
          {section === 'mcp' && (
            <McpSection t={t} canWrite={canWrite} invalidate={invalidate} creating={creating} onCreated={() => setCreating(false)} />
          )}
        </>
      )}
    </div>
  );
}

type Invalidate = (keys: Array<'llm' | 'chatbots' | 'rag' | 'mcp'>) => void;
type TFn = TFunction;

/** Shared ok/error toast helper for every AI mutation. */
async function runMutation(t: TFn, toast: ReturnType<typeof useToast>, what: () => Promise<unknown>, okMessage: string, invalidate?: Invalidate, keys?: Array<'llm' | 'chatbots' | 'rag' | 'mcp'>): Promise<boolean> {
  try {
    await what();
    toast.success(t(okMessage));
    if (invalidate && keys) invalidate(keys);
    return true;
  } catch (err) {
    toast.error(t('ai.common.failed', { message: err instanceof Error ? err.message : String(err) }));
    return false;
  }
}

// ── Chatbots ──────────────────────────────────────────────────────────────────────────────────

function ChatbotsSection({
  t,
  canWrite,
  invalidate,
  creating,
  onCreated,
}: {
  t: TFn;
  canWrite: boolean;
  invalidate: Invalidate;
  creating: boolean;
  onCreated: () => void;
}) {
  const toast = useToast();
  const { data: chatbots = [] } = useAiChatbotsQuery(true);
  const { data: llmModels = [] } = useAiLlmModelsQuery(true);
  const { data: ragModels = [] } = useAiRagModelsQuery(true);
  const { data: sessions = [] } = useSessionsQuery();

  const [editing, setEditing] = useState<AiChatbot | null>(null);
  const [deleting, setDeleting] = useState<AiChatbot | null>(null);
  const [draft, setDraft] = useState<AiChatbotDraft>(EMPTY_CHATBOT);


  const openEdit = (chatbot: AiChatbot) => {
    setEditing(chatbot);
    setDraft({
      sessionId: chatbot.sessionId,
      name: chatbot.name,
      llmModelId: chatbot.llmModelId,
      ragModelId: chatbot.ragModelId ?? '',
      persona: chatbot.persona ?? '',
      chatIdsText: (chatbot.chatIds ?? []).join(', '),
      cooldownSeconds: chatbot.cooldownSeconds,
      contextMessages: chatbot.contextMessages,
      enabled: chatbot.enabled,
    });
  };

  return (
    <div className="ai-card-list">
      {chatbots.length === 0 ? (
        <div className="empty-table-state">
          <Bot size={48} strokeWidth={1} />
          <h3>{t('ai.chatbots.emptyTitle')}</h3>
          <p>{t('ai.chatbots.emptyDescription')}</p>
        </div>
      ) : (
        chatbots.map(bot => {
          const sessionName = sessions.find(s => s.id === bot.sessionId)?.name ?? bot.sessionId.slice(0, 12);
          return (
            <AiCard
              key={bot.id}
              title={bot.name}
              icon={<Bot size={18} />}
              actions={
                <AiToggleActions
                  enabled={bot.enabled}
                  canWrite={canWrite}
                  onToggle={() =>
                    void runMutation(t, toast, () => aiApi.updateChatbot(bot.sessionId, bot.id, { enabled: !bot.enabled }), 'ai.toasts.updated', invalidate, ['chatbots'])
                  }
                  onEdit={() => openEdit(bot)}
                  onDelete={() => setDeleting(bot)}
                />
              }
            >
              <div className="ai-meta">
                <AiMetaItem label={t('ai.chatbots.session')} value={sessionName} />
                <AiMetaItem
                  label={t('ai.chatbots.llmModel')}
                  value={llmModels.find(m => m.id === bot.llmModelId)?.name ?? bot.llmModelId.slice(0, 8)}
                />
                <AiMetaItem
                  label={t('ai.chatbots.ragModel')}
                  value={bot.ragModelId ? ragModels.find(m => m.id === bot.ragModelId)?.name ?? '—' : t('ai.chatbots.noRag')}
                />
                <AiMetaItem label={t('ai.chatbots.chats')} value={bot.chatIds?.length ? bot.chatIds.join(', ') : t('ai.chatbots.allChats')} />
                <AiMetaItem label={t('ai.chatbots.cooldown')} value={t('ai.chatbots.cooldownValue', { count: bot.cooldownSeconds })} />
              </div>
              {bot.persona && <p className="hint">{bot.persona.slice(0, 160)}</p>}
              {bot.lastError && (
                <div className="ai-error-line">
                  <AlertCircle size={14} /> {bot.lastError}
                </div>
              )}
            </AiCard>
          );
        })
      )}

      {creating && (
        <ChatbotModal
          title={t('ai.chatbots.createTitle')}
          llmModels={llmModels}
          ragModels={ragModels}
          sessions={sessions.map(s => ({ id: s.id, name: s.name }))}
          draft={draft}
          setDraft={setDraft}
          onClose={onCreated}
          onSubmit={async () => {
            const ok = await runMutation(t, toast, () => aiApi.createChatbot(draft.sessionId, toChatbotPayload(draft)), 'ai.toasts.created', invalidate, ['chatbots']);
            if (ok) {
              onCreated();
              setDraft(EMPTY_CHATBOT);
            }
          }}
          t={t}
        />
      )}

      {editing && (
        <ChatbotModal
          title={t('ai.chatbots.editTitle')}
          llmModels={llmModels}
          ragModels={ragModels}
          sessions={sessions.map(s => ({ id: s.id, name: s.name }))}
          draft={draft}
          setDraft={setDraft}
          lockSession
          onClose={() => setEditing(null)}
          onSubmit={async () => {
            const ok = await runMutation(t, toast, () => aiApi.updateChatbot(editing.sessionId, editing.id, toChatbotPayload(draft)), 'ai.toasts.updated', invalidate, ['chatbots']);
            if (ok) setEditing(null);
          }}
          t={t}
        />
      )}

      {deleting && (
        <Modal
          open
          onClose={() => setDeleting(null)}
          title={t('ai.chatbots.deleteTitle')}
          className="modal-sm"
          closeLabel={t('common.close')}
          footer={
            <button
              className="btn-danger"
              onClick={async () => {
                if (await runMutation(t, toast, () => aiApi.deleteChatbot(deleting.sessionId, deleting.id), 'ai.toasts.deleted', invalidate, ['chatbots'])) {
                  setDeleting(null);
                }
              }}
            >
              {t('common.delete')}
            </button>
          }
        >
          <p>{t('ai.chatbots.deleteConfirm', { name: deleting.name })}</p>
        </Modal>
      )}
    </div>
  );
}

interface AiChatbotDraft {
  sessionId: string;
  name: string;
  llmModelId: string;
  ragModelId: string;
  persona: string;
  chatIdsText: string;
  cooldownSeconds: number;
  contextMessages: number;
  enabled: boolean;
}

const EMPTY_CHATBOT: AiChatbotDraft = {
  sessionId: '',
  name: '',
  llmModelId: '',
  ragModelId: '',
  persona: '',
  chatIdsText: '',
  cooldownSeconds: 60,
  contextMessages: 8,
  enabled: true,
};

function toChatbotPayload(draft: AiChatbotDraft) {
  return {
    name: draft.name.trim(),
    llmModelId: draft.llmModelId,
    ragModelId: draft.ragModelId || null,
    persona: draft.persona.trim() || null,
    chatIds: draft.chatIdsText
      .split(',')
      .map(entry => entry.trim())
      .filter(entry => entry.length > 0),
    cooldownSeconds: draft.cooldownSeconds,
    contextMessages: draft.contextMessages,
    enabled: draft.enabled,
  };
}

function ChatbotModal({
  title,
  llmModels,
  ragModels,
  sessions,
  draft,
  setDraft,
  onClose,
  onSubmit,
  lockSession,
  t,
}: {
  title: string;
  llmModels: AiLlmModel[];
  ragModels: AiRagModel[];
  sessions: Array<{ id: string; name: string }>;
  draft: AiChatbotDraft;
  setDraft: (draft: AiChatbotDraft) => void;
  onClose: () => void;
  onSubmit: () => void;
  lockSession?: boolean;
  t: TFn;
}) {
  const valid = draft.sessionId && draft.name.trim() && draft.llmModelId;
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      closeLabel={t('common.close')}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn-primary" onClick={onSubmit} disabled={!valid}>
            {t('common.save')}
          </button>
        </>
      }
    >
      {!lockSession && (
        <>
          <label htmlFor="ai-cb-session">{t('ai.chatbots.session')}</label>
          <select
            id="ai-cb-session"
            value={draft.sessionId}
            onChange={e => setDraft({ ...draft, sessionId: e.target.value })}
          >
            <option value="">{t('ai.chatbots.selectSession')}</option>
            {sessions.map(s => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </>
      )}
      <label htmlFor="ai-cb-name">{t('ai.chatbots.name')}</label>
      <input
        id="ai-cb-name"
        type="text"
        value={draft.name}
        onChange={e => setDraft({ ...draft, name: e.target.value })}
      />
      <label htmlFor="ai-cb-llm">{t('ai.chatbots.llmModel')}</label>
      <select
        id="ai-cb-llm"
        value={draft.llmModelId}
        onChange={e => setDraft({ ...draft, llmModelId: e.target.value })}
      >
        <option value="">{t('ai.chatbots.selectLlm')}</option>
        {llmModels.map(m => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
      <label htmlFor="ai-cb-rag">{t('ai.chatbots.ragModel')}</label>
      <select
        id="ai-cb-rag"
        value={draft.ragModelId}
        onChange={e => setDraft({ ...draft, ragModelId: e.target.value })}
      >
        <option value="">{t('ai.chatbots.noRag')}</option>
        {ragModels.map(m => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
      <label htmlFor="ai-cb-persona">{t('ai.chatbots.persona')}</label>
      <textarea
        id="ai-cb-persona"
        value={draft.persona}
        placeholder={t('ai.chatbots.personaPlaceholder')}
        onChange={e => setDraft({ ...draft, persona: e.target.value })}
      />
      <label htmlFor="ai-cb-chats">{t('ai.chatbots.chats')}</label>
      <input
        id="ai-cb-chats"
        type="text"
        value={draft.chatIdsText}
        placeholder={t('ai.chatbots.chatsPlaceholder')}
        onChange={e => setDraft({ ...draft, chatIdsText: e.target.value })}
      />
      <span className="hint">{t('ai.chatbots.chatsHint')}</span>
      <div className="ai-field-row">
        <div>
          <label htmlFor="ai-cb-cooldown">{t('ai.chatbots.cooldown')}</label>
          <input
            id="ai-cb-cooldown"
            type="number"
            min={0}
            max={86400}
            value={draft.cooldownSeconds}
            onChange={e => setDraft({ ...draft, cooldownSeconds: Number(e.target.value) || 0 })}
          />
        </div>
        <div>
          <label htmlFor="ai-cb-context">{t('ai.chatbots.context')}</label>
          <input
            id="ai-cb-context"
            type="number"
            min={0}
            max={20}
            value={draft.contextMessages}
            onChange={e => setDraft({ ...draft, contextMessages: Number(e.target.value) || 0 })}
          />
        </div>
      </div>
      <label className="ai-checkbox-row">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={e => setDraft({ ...draft, enabled: e.target.checked })}
        />
        {t('ai.chatbots.enabled')}
      </label>
    </Modal>
  );
}

// ── LLM models ────────────────────────────────────────────────────────────────────────────────

function LlmSection({
  t,
  canWrite,
  invalidate,
  creating,
  onCreated,
}: {
  t: TFn;
  canWrite: boolean;
  invalidate: Invalidate;
  creating: boolean;
  onCreated: () => void;
}) {
  const toast = useToast();
  const { data: models = [] } = useAiLlmModelsQuery(true);
  const [editing, setEditing] = useState<AiLlmModel | null>(null);
  const [deleting, setDeleting] = useState<AiLlmModel | null>(null);
  const [draft, setDraft] = useState<LlmDraft>(EMPTY_LLM);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [newKey, setNewKey] = useState('');

  const test = async (id: string) => {
    setTestingId(id);
    try {
      const result = await aiApi.testLlmModel(id);
      if (result.ok) toast.success(t('ai.toasts.testOk'));
      else toast.error(t('ai.toasts.testFailed', { message: result.answer }));
      invalidate(['llm']);
    } finally {
      setTestingId(null);
    }
  };

  return (
    <div className="ai-card-list">
      {models.length === 0 ? (
        <div className="empty-table-state">
          <BrainCircuit size={48} strokeWidth={1} />
          <h3>{t('ai.llm.emptyTitle')}</h3>
          <p>{t('ai.llm.emptyDescription')}</p>
        </div>
      ) : (
        models.map(model => (
          <AiCard
            key={model.id}
            title={model.name}
            icon={<BrainCircuit size={18} />}
            actions={
              <AiToggleActions
                enabled={model.enabled}
                canWrite={canWrite}
                extra={
                  <button
                    type="button"
                    className="icon-btn"
                    title={t('ai.llm.test')}
                    disabled={testingId === model.id}
                    onClick={() => void test(model.id)}
                  >
                    {testingId === model.id ? <Loader2 size={16} className="animate-spin" /> : '►'}
                  </button>
                }
                onToggle={() =>
                  void runMutation(t, toast, () => aiApi.updateLlmModel(model.id, { enabled: !model.enabled }), 'ai.toasts.updated', invalidate, ['llm'])
                }
                onEdit={() => {
                  setDraft({ name: model.name, endpointUrl: model.endpointUrl, model: model.model, persona: model.persona ?? '', parameters: model.parameters ?? {} });
                  setNewKey('');
                  setEditing(model);
                }}
                onDelete={() => setDeleting(model)}
              />
            }
          >
            <div className="ai-meta">
              <AiMetaItem label={t('ai.llm.endpoint')} value={model.endpointUrl} code />
              <AiMetaItem label={t('ai.llm.modelId')} value={model.model || '—'} code />
              <AiMetaItem label={t('ai.llm.apiKey')} value={model.apiKeyMasked ?? '—'} code />
              <AiMetaItem label={t('ai.llm.lastTest')} value={<AiLlmStatusCell model={model} t={t} />} />
            </div>
            {model.persona && <p className="hint">{model.persona.slice(0, 160)}</p>}
          </AiCard>
        ))
      )}

      {(creating || editing) && (
        <Modal
          open
          onClose={editing ? () => setEditing(null) : onCreated}
          title={editing ? t('ai.llm.editTitle') : t('ai.llm.createTitle')}
          closeLabel={t('common.close')}
          footer={
            <>
              <button
                className="btn-secondary"
                onClick={editing ? () => setEditing(null) : onCreated}
              >
                {t('common.cancel')}
              </button>
              <button
                className="btn-primary"
                disabled={!draft.name.trim() || !draft.endpointUrl.trim()}
                onClick={async () => {
                  const base = {
                    name: draft.name.trim(),
                    endpointUrl: draft.endpointUrl.trim(),
                    model: draft.model.trim(),
                    persona: draft.persona.trim() || null,
                    parameters: draft.parameters,
                  };
                  const body = newKey ? { ...base, apiKey: newKey } : base;
                  const ok = editing
                    ? await runMutation(t, toast, () => aiApi.updateLlmModel(editing.id, body), 'ai.toasts.updated', invalidate, ['llm'])
                    : await runMutation(t, toast, () => aiApi.createLlmModel({ ...body, apiKey: newKey } as never), 'ai.toasts.created', invalidate, ['llm']);
                  if (ok) {
                    onCreated();
                    setEditing(null);
                    setDraft(EMPTY_LLM);
                    setNewKey('');
                  }
                }}
              >
                {t('common.save')}
              </button>
            </>
          }
        >
          <label htmlFor="ai-llm-name">{t('ai.llm.name')}</label>
          <input id="ai-llm-name" type="text" value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} />
          <label htmlFor="ai-llm-url">{t('ai.llm.endpoint')}</label>
          <input
            id="ai-llm-url"
            type="url"
            placeholder="https://api.openai.com/v1"
            value={draft.endpointUrl}
            onChange={e => setDraft({ ...draft, endpointUrl: e.target.value })}
          />
          <span className="hint">{t('ai.llm.endpointHint')}</span>
          <label htmlFor="ai-llm-key">{t('ai.llm.apiKey')}</label>
          <input
            id="ai-llm-key"
            type="password"
            autoComplete="new-password"
            placeholder={editing ? t('ai.llm.apiKeyKeep') : 'sk-…'}
            value={newKey}
            onChange={e => setNewKey(e.target.value)}
          />
          <label htmlFor="ai-llm-model">{t('ai.llm.modelId')}</label>
          <input
            id="ai-llm-model"
            type="text"
            placeholder="gpt-4o-mini"
            value={draft.model}
            onChange={e => setDraft({ ...draft, model: e.target.value })}
          />
          <label htmlFor="ai-llm-persona">{t('ai.llm.persona')}</label>
          <textarea
            id="ai-llm-persona"
            value={draft.persona}
            placeholder={t('ai.llm.personaPlaceholder')}
            onChange={e => setDraft({ ...draft, persona: e.target.value })}
          />
          <span className="ai-subhead">{t('ai.llm.parameters')}</span>
          <div className="ai-field-row">
            <div>
              <label htmlFor="ai-llm-temp">{t('ai.llm.temperature')}</label>
              <input
                id="ai-llm-temp"
                type="number"
                step="0.1"
                min={0}
                max={2}
                value={draft.parameters.temperature ?? ''}
                onChange={e =>
                  setDraft({
                    ...draft,
                    parameters: { ...draft.parameters, temperature: e.target.value === '' ? undefined : Number(e.target.value) },
                  })
                }
              />
            </div>
            <div>
              <label htmlFor="ai-llm-maxtok">{t('ai.llm.maxTokens')}</label>
              <input
                id="ai-llm-maxtok"
                type="number"
                min={1}
                value={draft.parameters.maxTokens ?? ''}
                onChange={e =>
                  setDraft({
                    ...draft,
                    parameters: { ...draft.parameters, maxTokens: e.target.value === '' ? undefined : Number(e.target.value) },
                  })
                }
              />
            </div>
          </div>
        </Modal>
      )}

      {deleting && (
        <Modal
          open
          onClose={() => setDeleting(null)}
          title={t('ai.llm.deleteTitle')}
          className="modal-sm"
          closeLabel={t('common.close')}
          footer={
            <button
              className="btn-danger"
              onClick={async () => {
                if (await runMutation(t, toast, () => aiApi.deleteLlmModel(deleting.id), 'ai.toasts.deleted', invalidate, ['llm'])) {
                  setDeleting(null);
                }
              }}
            >
              {t('common.delete')}
            </button>
          }
        >
          <p>{t('ai.llm.deleteConfirm', { name: deleting.name })}</p>
        </Modal>
      )}
    </div>
  );
}

interface LlmDraft {
  name: string;
  endpointUrl: string;
  model: string;
  persona: string;
  parameters: { temperature?: number; maxTokens?: number; topP?: number; stop?: string[] };
}

const EMPTY_LLM: LlmDraft = { name: '', endpointUrl: '', model: '', persona: '', parameters: {} };

// ── RAG models ────────────────────────────────────────────────────────────────────────────────

function RagSection({
  t,
  canWrite,
  invalidate,
  creating,
  onCreated,
}: {
  t: TFn;
  canWrite: boolean;
  invalidate: Invalidate;
  creating: boolean;
  onCreated: () => void;
}) {
  const toast = useToast();
  const { data: ragModels = [] } = useAiRagModelsQuery(true);
  const { data: llmModels = [] } = useAiLlmModelsQuery(true);
  const { data: sessions = [] } = useSessionsQuery();
  const [editing, setEditing] = useState<AiRagModel | null>(null);
  const [deleting, setDeleting] = useState<AiRagModel | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [documents, setDocuments] = useState<AiRagDocument[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [indexingId, setIndexingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<RagDraft>(EMPTY_RAG);
  const [queryingId, setQueryingId] = useState<string | null>(null);
  const [queryText, setQueryText] = useState('');
  const [queryResult, setQueryResult] = useState<string | null>(null);

  const loadDocuments = async (id: string) => {
    setDocsLoading(true);
    try {
      setDocuments(await aiApi.listRagDocuments(id));
    } finally {
      setDocsLoading(false);
    }
  };

  const toggleExpand = (id: string) => {
    if (expanded === id) {
      setExpanded(null);
    } else {
      setExpanded(id);
      void loadDocuments(id);
    }
  };

  const runIndex = async (id: string) => {
    setIndexingId(id);
    try {
      await aiApi.indexRagModel(id);
      toast.success(t('ai.toasts.indexed'));
      invalidate(['rag']);
    } catch (err) {
      toast.error(t('ai.common.failed', { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setIndexingId(null);
    }
  };

  const runQuery = async (id: string) => {
    if (!queryText.trim()) return;
    setQueryingId(id);
    try {
      const result = await aiApi.queryRagModel(id, queryText.trim());
      setQueryResult(result.context || result.warnings?.join('; ') || '—');
    } catch (err) {
      setQueryResult(err instanceof Error ? err.message : String(err));
    } finally {
      setQueryingId(null);
    }
  };

  return (
    <div className="ai-card-list">
      {ragModels.length === 0 ? (
        <div className="empty-table-state">
          <BookOpen size={48} strokeWidth={1} />
          <h3>{t('ai.rag.emptyTitle')}</h3>
          <p>{t('ai.rag.emptyDescription')}</p>
        </div>
      ) : (
        ragModels.map(model => (
          <div key={model.id}>
            <AiCard
              title={model.name}
              icon={<BookOpen size={18} />}
              actions={
                <AiToggleActions
                  enabled={model.enabled}
                  canWrite={canWrite}
                  extra={
                    <>
                      <button
                        type="button"
                        className="icon-btn"
                        title={t('ai.actions.expand')}
                        onClick={() => toggleExpand(model.id)}
                      >
                        {expanded === model.id ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                      </button>
                      {canWrite && (
                        <button
                          type="button"
                          className="icon-btn"
                          title={t('ai.rag.index')}
                          disabled={indexingId === model.id || model.documentCount === 0}
                          onClick={() => void runIndex(model.id)}
                        >
                          {indexingId === model.id ? <Loader2 size={16} className="animate-spin" /> : '⟳'}
                        </button>
                      )}
                    </>
                  }
                  onToggle={() =>
                    void runMutation(t, toast, () => aiApi.updateRagModel(model.id, { enabled: !model.enabled }), 'ai.toasts.updated', invalidate, ['rag'])
                  }
                  onEdit={() => {
                    setDraft({
                      name: model.name,
                      sessionScope: model.sessionScope,
                      sessionIdsText: (model.sessionIds ?? []).join(', '),
                      llmModelId: model.llmModelId ?? '',
                      topK: model.topK,
                      maxContextChars: model.maxContextChars,
                    });
                    setEditing(model);
                  }}
                  onDelete={() => setDeleting(model)}
                />
              }
            >
              <div className="ai-meta">
                <AiMetaItem
                  label={t('ai.rag.scope')}
                  value={
                    model.sessionScope === 'all'
                      ? t('ai.rag.scopeAll')
                      : model.sessionScope === 'selected'
                        ? (model.sessionIds ?? []).map(id => sessions.find(s => s.id === id)?.name ?? id).join(', ')
                        : t('ai.rag.scopeNone')
                  }
                />
                <AiMetaItem label={t('ai.rag.documents')} value={String(model.documentCount)} />
                <AiMetaItem
                  label={t('ai.rag.indexState')}
                  value={model.hasIndex ? model.indexedAt!.slice(0, 19).replace('T', ' ') : t('ai.rag.noIndex')}
                />
                <AiMetaItem label={t('ai.rag.topK')} value={String(model.topK)} />
              </div>
              {model.lastIndexError && (
                <div className="ai-error-line">
                  <AlertCircle size={14} /> {model.lastIndexError}
                </div>
              )}
              {expanded === model.id && (
                <div style={{ marginTop: '0.75rem' }}>
                  {docsLoading ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <AiDocumentEditor
                      model={model}
                      documents={documents}
                      canWrite={canWrite}
                      t={t}
                      onAdd={payload => {
                        void runMutation(t, toast, () => aiApi.addRagDocument(model.id, payload), 'ai.toasts.created', invalidate, ['rag']).then(ok => {
                          if (ok) void loadDocuments(model.id);
                        });
                      }}
                      onDelete={documentId => {
                        void runMutation(t, toast, () => aiApi.deleteRagDocument(model.id, documentId), 'ai.toasts.deleted', invalidate, ['rag']).then(ok => {
                          if (ok) void loadDocuments(model.id);
                        });
                      }}
                    />
                  )}
                  {model.hasIndex && model.indexPreview?.structure && (
                    <div className="ai-tree">
                      <AiTreePreview nodes={model.indexPreview.structure} />
                    </div>
                  )}
                  <div className="ai-field-row" style={{ marginTop: '0.5rem' }}>
                    <input
                      type="text"
                      placeholder={t('ai.rag.queryPlaceholder')}
                      value={queryText}
                      onChange={e => setQueryText(e.target.value)}
                    />
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={!model.hasIndex || queryingId === model.id || !queryText.trim()}
                      onClick={() => void runQuery(model.id)}
                    >
                      {queryingId === model.id ? <Loader2 size={16} className="animate-spin" /> : t('ai.rag.query')}
                    </button>
                  </div>
                  {queryResult && (
                    <div className="ai-tree" style={{ whiteSpace: 'pre-wrap' }}>
                      {queryResult.slice(0, 2000)}
                    </div>
                  )}
                </div>
              )}
            </AiCard>
          </div>
        ))
      )}

      {(creating || editing) && (
        <Modal
          open
          onClose={editing ? () => setEditing(null) : onCreated}
          title={editing ? t('ai.rag.editTitle') : t('ai.rag.createTitle')}
          closeLabel={t('common.close')}
          footer={
            <>
              <button className="btn-secondary" onClick={editing ? () => setEditing(null) : onCreated}>
                {t('common.cancel')}
              </button>
              <button
                className="btn-primary"
                disabled={!draft.name.trim()}
                onClick={async () => {
                  const body = {
                    name: draft.name.trim(),
                    sessionScope: draft.sessionScope,
                    sessionIds:
                      draft.sessionScope === 'selected'
                        ? draft.sessionIdsText.split(',').map(s => s.trim()).filter(Boolean)
                        : null,
                    llmModelId: draft.llmModelId || null,
                    topK: draft.topK,
                    maxContextChars: draft.maxContextChars,
                  };
                  const ok = editing
                    ? await runMutation(t, toast, () => aiApi.updateRagModel(editing.id, body), 'ai.toasts.updated', invalidate, ['rag'])
                    : await runMutation(t, toast, () => aiApi.createRagModel(body), 'ai.toasts.created', invalidate, ['rag']);
                  if (ok) {
                    onCreated();
                    setEditing(null);
                    setDraft(EMPTY_RAG);
                  }
                }}
              >
                {t('common.save')}
              </button>
            </>
          }
        >
          <label htmlFor="ai-rag-name">{t('ai.rag.name')}</label>
          <input id="ai-rag-name" type="text" value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} />
          <label htmlFor="ai-rag-scope">{t('ai.rag.scope')}</label>
          <select
            id="ai-rag-scope"
            value={draft.sessionScope}
            onChange={e => setDraft({ ...draft, sessionScope: e.target.value as typeof draft.sessionScope })}
          >
            <option value="all">{t('ai.rag.scopeAll')}</option>
            <option value="selected">{t('ai.rag.scopeSelected')}</option>
            <option value="none">{t('ai.rag.scopeNone')}</option>
          </select>
          {draft.sessionScope === 'selected' && (
            <>
              <label htmlFor="ai-rag-sessions">{t('ai.rag.sessionIds')}</label>
              <input
                id="ai-rag-sessions"
                type="text"
                value={draft.sessionIdsText}
                placeholder={t('ai.rag.sessionIdsHint')}
                onChange={e => setDraft({ ...draft, sessionIdsText: e.target.value })}
              />
              <div className="ai-checkbox-group">
                {sessions.map(s => {
                  const ids = draft.sessionIdsText.split(',').map(x => x.trim()).filter(Boolean);
                  const checked = ids.includes(s.id);
                  return (
                    <label key={s.id} className="ai-checkbox-row">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          setDraft({
                            ...draft,
                            sessionIdsText: (checked ? ids.filter(x => x !== s.id) : [...ids, s.id]).join(', '),
                          })
                        }
                      />
                      {s.name}
                    </label>
                  );
                })}
              </div>
            </>
          )}
          <label htmlFor="ai-rag-llm">{t('ai.rag.llmOverride')}</label>
          <select
            id="ai-rag-llm"
            value={draft.llmModelId}
            onChange={e => setDraft({ ...draft, llmModelId: e.target.value })}
          >
            <option value="">{t('ai.rag.llmFromBot')}</option>
            {llmModels.map(m => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <div className="ai-field-row">
            <div>
              <label htmlFor="ai-rag-topk">{t('ai.rag.topK')}</label>
              <input
                id="ai-rag-topk"
                type="number"
                min={1}
                max={10}
                value={draft.topK}
                onChange={e => setDraft({ ...draft, topK: Number(e.target.value) || 4 })}
              />
            </div>
            <div>
              <label htmlFor="ai-rag-maxctx">{t('ai.rag.maxContextChars')}</label>
              <input
                id="ai-rag-maxctx"
                type="number"
                min={500}
                max={20000}
                value={draft.maxContextChars}
                onChange={e => setDraft({ ...draft, maxContextChars: Number(e.target.value) || 4000 })}
              />
            </div>
          </div>
          <span className="hint">{t('ai.rag.vectorlessHint')}</span>
        </Modal>
      )}

      {deleting && (
        <Modal
          open
          onClose={() => setDeleting(null)}
          title={t('ai.rag.deleteTitle')}
          className="modal-sm"
          closeLabel={t('common.close')}
          footer={
            <button
              className="btn-danger"
              onClick={async () => {
                if (await runMutation(t, toast, () => aiApi.deleteRagModel(deleting.id), 'ai.toasts.deleted', invalidate, ['rag'])) {
                  setDeleting(null);
                }
              }}
            >
              {t('common.delete')}
            </button>
          }
        >
          <p>{t('ai.rag.deleteConfirm', { name: deleting.name })}</p>
        </Modal>
      )}
    </div>
  );
}

interface RagDraft {
  name: string;
  sessionScope: 'all' | 'selected' | 'none';
  sessionIdsText: string;
  llmModelId: string;
  topK: number;
  maxContextChars: number;
}

const EMPTY_RAG: RagDraft = {
  name: '',
  sessionScope: 'all',
  sessionIdsText: '',
  llmModelId: '',
  topK: 4,
  maxContextChars: 4000,
};

// ── MCP connections ───────────────────────────────────────────────────────────────────────────

function McpSection({
  t,
  canWrite,
  invalidate,
  creating,
  onCreated,
}: {
  t: TFn;
  canWrite: boolean;
  invalidate: Invalidate;
  creating: boolean;
  onCreated: () => void;
}) {
  const toast = useToast();
  const { data: connections = [] } = useAiMcpConnectionsQuery(true);
  const [editing, setEditing] = useState<AiMcpConnection | null>(null);
  const [deleting, setDeleting] = useState<AiMcpConnection | null>(null);
  const [draft, setDraft] = useState<McpDraft>(EMPTY_MCP);
  const [credential, setCredential] = useState('');
  const [testingId, setTestingId] = useState<string | null>(null);
  const [toolList, setToolList] = useState<Record<string, string[]>>({});

  const test = async (id: string) => {
    setTestingId(id);
    try {
      const result = await aiApi.testMcpConnection(id);
      if (result.ok) {
        toast.success(t('ai.toasts.testOk'));
        setToolList(prev => ({ ...prev, [id]: result.tools.map(tool => tool.name) }));
      } else {
        toast.error(t('ai.toasts.testFailed', { message: result.error ?? 'MCP' }));
      }
      invalidate(['mcp']);
    } finally {
      setTestingId(null);
    }
  };

  return (
    <div className="ai-card-list">
      {connections.length === 0 ? (
        <div className="empty-table-state">
          <Plug size={48} strokeWidth={1} />
          <h3>{t('ai.mcp.emptyTitle')}</h3>
          <p>{t('ai.mcp.emptyDescription')}</p>
        </div>
      ) : (
        connections.map(connection => (
          <AiCard
            key={connection.id}
            title={connection.name}
            icon={<Plug size={18} />}
            actions={
              <AiToggleActions
                enabled={connection.enabled}
                canWrite={canWrite}
                extra={
                  <button
                    type="button"
                    className="icon-btn"
                    title={t('ai.mcp.test')}
                    disabled={testingId === connection.id}
                    onClick={() => void test(connection.id)}
                  >
                    {testingId === connection.id ? <Loader2 size={16} className="animate-spin" /> : '►'}
                  </button>
                }
                onToggle={() =>
                  void runMutation(t, toast, () => aiApi.updateMcpConnection(connection.id, { enabled: !connection.enabled }), 'ai.toasts.updated', invalidate, ['mcp'])
                }
                onEdit={() => {
                  setDraft({
                    name: connection.name,
                    endpointUrl: connection.endpointUrl,
                    authKind: connection.authKind,
                    authHeader: connection.authHeader,
                    timeoutMs: connection.timeoutMs,
                  });
                  setCredential('');
                  setEditing(connection);
                }}
                onDelete={() => setDeleting(connection)}
              />
            }
          >
            <div className="ai-meta">
              <AiMetaItem label={t('ai.mcp.endpoint')} value={connection.endpointUrl} code />
              <AiMetaItem
                label={t('ai.mcp.auth')}
                value={connection.authKind === 'none' ? t('ai.mcp.authNone') : `${connection.authKind} · ${connection.authCredentialMasked ?? '—'}`}
                code
              />
              <AiMetaItem label={t('ai.mcp.lastTest')} value={<AiMcpStatusCell connection={connection} t={t} />} />
            </div>
            {toolList[connection.id]?.length ? (
              <div className="ai-tags">
                {toolList[connection.id].slice(0, 12).map(name => (
                  <span key={name} className="ai-tag ai-tag-muted">
                    {name}
                  </span>
                ))}
              </div>
            ) : null}
          </AiCard>
        ))
      )}

      {(creating || editing) && (
        <Modal
          open
          onClose={editing ? () => setEditing(null) : onCreated}
          title={editing ? t('ai.mcp.editTitle') : t('ai.mcp.createTitle')}
          closeLabel={t('common.close')}
          footer={
            <>
              <button className="btn-secondary" onClick={editing ? () => setEditing(null) : onCreated}>
                {t('common.cancel')}
              </button>
              <button
                className="btn-primary"
                disabled={!draft.name.trim() || !draft.endpointUrl.trim()}
                onClick={async () => {
                  const base = {
                    name: draft.name.trim(),
                    endpointUrl: draft.endpointUrl.trim(),
                    authKind: draft.authKind,
                    authHeader: draft.authKind === 'header' ? draft.authHeader.trim() : 'X-API-Key',
                    timeoutMs: draft.timeoutMs,
                  };
                  const ok = editing
                    ? await runMutation(t, toast, () => aiApi.updateMcpConnection(editing.id, credential ? { ...base, authCredential: credential } : base), 'ai.toasts.updated', invalidate, ['mcp'])
                    : await runMutation(t, toast, () => aiApi.createMcpConnection(credential ? { ...base, authCredential: credential } : base), 'ai.toasts.created', invalidate, ['mcp']);
                  if (ok) {
                    onCreated();
                    setEditing(null);
                    setDraft(EMPTY_MCP);
                    setCredential('');
                  }
                }}
              >
                {t('common.save')}
              </button>
            </>
          }
        >
          <label htmlFor="ai-mcp-name">{t('ai.mcp.name')}</label>
          <input id="ai-mcp-name" type="text" value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} />
          <label htmlFor="ai-mcp-url">{t('ai.mcp.endpoint')}</label>
          <input
            id="ai-mcp-url"
            type="url"
            placeholder="https://server.example.com/mcp"
            value={draft.endpointUrl}
            onChange={e => setDraft({ ...draft, endpointUrl: e.target.value })}
          />
          <label htmlFor="ai-mcp-auth">{t('ai.mcp.auth')}</label>
          <select
            id="ai-mcp-auth"
            value={draft.authKind}
            onChange={e => setDraft({ ...draft, authKind: e.target.value as typeof draft.authKind })}
          >
            <option value="none">{t('ai.mcp.authNone')}</option>
            <option value="bearer">{t('ai.mcp.authBearer')}</option>
            <option value="header">{t('ai.mcp.authHeader')}</option>
          </select>
          {draft.authKind === 'header' && (
            <>
              <label htmlFor="ai-mcp-header">{t('ai.mcp.authHeaderName')}</label>
              <input
                id="ai-mcp-header"
                type="text"
                placeholder="X-API-Key"
                value={draft.authHeader}
                onChange={e => setDraft({ ...draft, authHeader: e.target.value })}
              />
            </>
          )}
          {draft.authKind !== 'none' && (
            <>
              <label htmlFor="ai-mcp-cred">{t('ai.mcp.credential')}</label>
              <input
                id="ai-mcp-cred"
                type="password"
                autoComplete="new-password"
                placeholder={editing ? t('ai.mcp.credentialKeep') : ''}
                value={credential}
                onChange={e => setCredential(e.target.value)}
              />
            </>
          )}
          <label htmlFor="ai-mcp-timeout">{t('ai.mcp.timeout')}</label>
          <input
            id="ai-mcp-timeout"
            type="number"
            min={1000}
            max={120000}
            step={1000}
            value={draft.timeoutMs}
            onChange={e => setDraft({ ...draft, timeoutMs: Number(e.target.value) || 30000 })}
          />
        </Modal>
      )}

      {deleting && (
        <Modal
          open
          onClose={() => setDeleting(null)}
          title={t('ai.mcp.deleteTitle')}
          className="modal-sm"
          closeLabel={t('common.close')}
          footer={
            <button
              className="btn-danger"
              onClick={async () => {
                if (await runMutation(t, toast, () => aiApi.deleteMcpConnection(deleting.id), 'ai.toasts.deleted', invalidate, ['mcp'])) {
                  setDeleting(null);
                }
              }}
            >
              {t('common.delete')}
            </button>
          }
        >
          <p>{t('ai.mcp.deleteConfirm', { name: deleting.name })}</p>
        </Modal>
      )}
    </div>
  );
}

interface McpDraft {
  name: string;
  endpointUrl: string;
  authKind: 'none' | 'bearer' | 'header';
  authHeader: string;
  timeoutMs: number;
}

const EMPTY_MCP: McpDraft = { name: '', endpointUrl: '', authKind: 'none', authHeader: 'X-API-Key', timeoutMs: 30000 };
