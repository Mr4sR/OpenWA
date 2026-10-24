import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Plus, Bot, BrainCircuit, BookOpen, Plug, Loader2, AlertCircle, ChevronDown, ChevronRight } from 'lucide-react';
import {
  aiApi,
  type AiChatbot,
  type AiLlmModel,
  type AiMcpConnection,
  type AiRagDocument,
  type AiRagModel,
} from '../services/api';
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
import { Playground } from './ai/Playground';

/**
 * AI Integration — the create/edit/delete surface for the four AI instance kinds:
 * Chatbot (per-session bots), AI LLM (provider connections), RAG Vectorless (PageIndex-style
 * knowledge bases) and MCP Server (outbound tool servers), plus the Playground tab that probes an
 * active chatbot without writing on WhatsApp. Each resource tab is a card list with
 * create/edit/delete modals in the webhook style.
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
  // Sessions feed the chatbot binding select, the RAG scope picker and the Playground's probe
  // readout (which session a probe would answer from).
  const { data: sessions = [] } = useSessionsQuery();

  const loading = llmQuery.isLoading || chatbotsQuery.isLoading || ragQuery.isLoading || mcpQuery.isLoading;
  const loadError = [llmQuery, chatbotsQuery, ragQuery, mcpQuery].find(q => q.error)?.error as
    (Error & { status?: number }) | undefined;

  return (
    <div className="ai-page">
      <PageHeader
        title={t('ai.title')}
        subtitle={t('ai.subtitle')}
        actions={
          canWrite && (
            <button className="btn-primary" onClick={() => setCreating(true)}>
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
            <ChatbotsSection
              t={t}
              canWrite={canWrite}
              invalidate={invalidate}
              creating={creating}
              onCreated={() => setCreating(false)}
              mcpConnections={mcpQuery.data ?? []}
            />
          )}
          {section === 'llm' && (
            <LlmSection
              t={t}
              canWrite={canWrite}
              invalidate={invalidate}
              creating={creating}
              onCreated={() => setCreating(false)}
            />
          )}
          {section === 'rag' && (
            <RagSection
              t={t}
              canWrite={canWrite}
              invalidate={invalidate}
              creating={creating}
              onCreated={() => setCreating(false)}
            />
          )}
          {section === 'mcp' && (
            <McpSection
              t={t}
              canWrite={canWrite}
              invalidate={invalidate}
              creating={creating}
              onCreated={() => setCreating(false)}
            />
          )}
          {section === 'playground' && (
            <Playground
              t={t}
              chatbots={chatbotsQuery.data ?? []}
              llmModels={llmQuery.data ?? []}
              ragModels={ragQuery.data ?? []}
              sessionNames={sessions.map(s => ({ id: s.id, name: s.name }))}
            />
          )}
        </>
      )}
    </div>
  );
}

type Invalidate = (keys: Array<'llm' | 'chatbots' | 'rag' | 'mcp'>) => void;
type TFn = TFunction;

/** Shared ok/error toast helper for every AI mutation; resolves to what the call returned (null on failure). */
async function runMutation<T>(
  t: TFn,
  toast: ReturnType<typeof useToast>,
  what: () => Promise<T>,
  okMessage: string,
  invalidate?: Invalidate,
  keys?: Array<'llm' | 'chatbots' | 'rag' | 'mcp'>,
): Promise<T | null> {
  try {
    const value = await what();
    toast.success(t(okMessage));
    if (invalidate && keys) invalidate(keys);
    return value;
  } catch (err) {
    toast.error(t('ai.common.failed', { message: err instanceof Error ? err.message : String(err) }));
    return null;
  }
}

// ── Chatbots ──────────────────────────────────────────────────────────────────────────────────

function ChatbotsSection({
  t,
  canWrite,
  invalidate,
  creating,
  onCreated,
  mcpConnections,
}: {
  t: TFn;
  canWrite: boolean;
  invalidate: Invalidate;
  creating: boolean;
  onCreated: () => void;
  /** Enabled-filtered by the caller; the MCP servers whose tools the bots may be offered. */
  mcpConnections: AiMcpConnection[];
}) {
  const toast = useToast();
  const { data: chatbots = [] } = useAiChatbotsQuery(true);
  const { data: llmModels = [] } = useAiLlmModelsQuery(true);
  const { data: ragModels = [] } = useAiRagModelsQuery(true);
  const { data: sessions = [] } = useSessionsQuery();
  // Only enabled connections can contribute tools to a bot. The LIST itself comes from the page's
  // own MCP query via props (`mcpConnections`) — a second hook with the same key that lands in an
  // error state makes TanStack retry-on-mount on every section render, an observable refetch loop.

  // sessionId -> name of the bot that already serves it; the picker disables those checkboxes so
  // one session cannot be claimed twice (the backend refuses it too — this is the UX guard).
  const sessionOwners: Record<string, string> = {};
  for (const bot of chatbots) {
    for (const sessionId of bot.sessionIds) sessionOwners[sessionId] = bot.name;
  }

  const [editing, setEditing] = useState<AiChatbot | null>(null);
  const [deleting, setDeleting] = useState<AiChatbot | null>(null);
  const [draft, setDraft] = useState<AiChatbotDraft>(EMPTY_CHATBOT);

  const openEdit = (chatbot: AiChatbot) => {
    setEditing(chatbot);
    setDraft({
      sessionIds: chatbot.sessionIds,
      name: chatbot.name,
      llmModelId: chatbot.llmModelId,
      ragModelId: chatbot.ragModelId ?? '',
      persona: chatbot.persona ?? '',
      replyGroups: chatbot.replyGroups,
      mcpToolIds: chatbot.mcpToolIds ?? [],
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
          const names = bot.sessionIds.map(id => sessions.find(s => s.id === id)?.name ?? id.slice(0, 12));
          const sessionLabel = names.join(', ');
          return (
            <AiCard
              key={bot.id}
              title={bot.name}
              enabled={bot.enabled}
              icon={<Bot size={18} />}
              actions={
                <AiToggleActions
                  enabled={bot.enabled}
                  canWrite={canWrite}
                  onToggle={() =>
                    void runMutation(
                      t,
                      toast,
                      () => aiApi.updateChatbot(bot.id, { enabled: !bot.enabled }),
                      'ai.toasts.updated',
                      invalidate,
                      ['chatbots'],
                    )
                  }
                  onEdit={() => openEdit(bot)}
                  onDelete={() => setDeleting(bot)}
                />
              }
            >
              <div className="ai-meta">
                <AiMetaItem label={t('ai.chatbots.session')} value={sessionLabel} />
                <AiMetaItem
                  label={t('ai.chatbots.llmModel')}
                  value={llmModels.find(m => m.id === bot.llmModelId)?.name ?? bot.llmModelId.slice(0, 8)}
                />
                <AiMetaItem
                  label={t('ai.chatbots.ragModel')}
                  value={
                    bot.ragModelId
                      ? (ragModels.find(m => m.id === bot.ragModelId)?.name ?? '—')
                      : t('ai.chatbots.noRag')
                  }
                />
                <AiMetaItem
                  label={t('ai.chatbots.groups')}
                  value={bot.replyGroups ? t('common.yes') : t('common.no')}
                />
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
          mcpConnections={mcpConnections.filter(c => c.enabled)}
          sessions={sessions.map(s => ({ id: s.id, name: s.name }))}
          sessionOwners={sessionOwners}
          draft={draft}
          setDraft={setDraft}
          onClose={onCreated}
          onSubmit={async () => {
            const ok = await runMutation(
              t,
              toast,
              () => aiApi.createChatbot(toChatbotPayload(draft)),
              'ai.toasts.created',
              invalidate,
              ['chatbots'],
            );
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
          mcpConnections={mcpConnections.filter(c => c.enabled)}
          sessions={sessions.map(s => ({ id: s.id, name: s.name }))}
          sessionOwners={sessionOwners}
          editingId={editing.id}
          draft={draft}
          setDraft={setDraft}
          onClose={() => setEditing(null)}
          onSubmit={async () => {
            const ok = await runMutation(
              t,
              toast,
              () => aiApi.updateChatbot(editing.id, toChatbotPayload(draft)),
              'ai.toasts.updated',
              invalidate,
              ['chatbots'],
            );
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
                if (
                  await runMutation(t, toast, () => aiApi.deleteChatbot(deleting.id), 'ai.toasts.deleted', invalidate, [
                    'chatbots',
                  ])
                ) {
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
  /** The sessions this bot serves; a session owned by another bot is disabled in the picker. */
  sessionIds: string[];
  name: string;
  llmModelId: string;
  ragModelId: string;
  persona: string;
  replyGroups: boolean;
  /** `"<connectionId>:<toolName>"` the bot may call; empty = every tool the MCP servers offer. */
  mcpToolIds: string[];
  enabled: boolean;
}

const EMPTY_CHATBOT: AiChatbotDraft = {
  sessionIds: [],
  name: '',
  llmModelId: '',
  ragModelId: '',
  persona: '',
  replyGroups: false,
  mcpToolIds: [],
  enabled: true,
};

function toChatbotPayload(draft: AiChatbotDraft) {
  return {
    name: draft.name.trim(),
    sessionIds: draft.sessionIds,
    llmModelId: draft.llmModelId,
    ragModelId: draft.ragModelId || null,
    persona: draft.persona.trim() || null,
    replyGroups: draft.replyGroups,
    // An empty selection is stored as null: "every tool the enabled MCP servers advertise".
    mcpToolIds: draft.mcpToolIds.length > 0 ? draft.mcpToolIds : null,
    enabled: draft.enabled,
  };
}

function ChatbotModal({
  title,
  llmModels,
  ragModels,
  mcpConnections,
  sessions,
  sessionOwners,
  editingId,
  draft,
  setDraft,
  onClose,
  onSubmit,
  t,
}: {
  title: string;
  llmModels: AiLlmModel[];
  ragModels: AiRagModel[];
  mcpConnections: AiMcpConnection[];
  sessions: Array<{ id: string; name: string }>;
  /** sessionId -> name of the bot that already serves it (the bot being edited keeps its own). */
  sessionOwners: Record<string, string>;
  /** Id of the bot being edited (undefined when creating), so its own sessions stay selectable. */
  editingId?: string;
  draft: AiChatbotDraft;
  setDraft: (draft: AiChatbotDraft) => void;
  onClose: () => void;
  onSubmit: () => void;
  t: TFn;
}) {
  // Tool catalogues fetch live, once per connection the operator expands: the server may have
  // gained tools since the last visit, so a cached copy would lie about what can be offered.
  const [toolCatalogue, setToolCatalogue] = useState<Record<string, Array<{ name: string; description?: string }>>>({});
  const [fetchingTools, setFetchingTools] = useState<string | null>(null);
  const fetchTools = async (connectionId: string) => {
    setFetchingTools(connectionId);
    try {
      const { tools } = await aiApi.listMcpTools(connectionId);
      setToolCatalogue(previous => ({ ...previous, [connectionId]: tools }));
    } catch {
      setToolCatalogue(previous => ({ ...previous, [connectionId]: [] }));
    } finally {
      setFetchingTools(null);
    }
  };
  // A selection that came from the draft (an edit) starts with its connections already fetched.
  // Runtime drafts can predate the field (a stale state snapshot), so every read guards.
  const selected = draft.mcpToolIds ?? [];
  useEffect(() => {
    for (const toolId of selected) {
      const connectionId = toolId.split(':')[0];
      if (!toolCatalogue[connectionId] && fetchingTools !== connectionId) void fetchTools(connectionId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected.length]);
  const toggleTool = (connectionId: string, toolName: string) => {
    const toolId = `${connectionId}:${toolName}`;
    setDraft({
      ...draft,
      mcpToolIds: selected.includes(toolId) ? selected.filter(entry => entry !== toolId) : [...selected, toolId],
    });
  };
  const toggleSession = (sessionId: string) => {
    setDraft({
      ...draft,
      sessionIds: draft.sessionIds.includes(sessionId)
        ? draft.sessionIds.filter(entry => entry !== sessionId)
        : [...draft.sessionIds, sessionId],
    });
  };
  const valid = draft.sessionIds.length > 0 && draft.name.trim() && draft.llmModelId;
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
      <label htmlFor="ai-cb-sessions">{t('ai.chatbots.sessions')}</label>
      <div className="ai-mcp-tool-picker" id="ai-cb-sessions" role="group" aria-label={t('ai.chatbots.sessions')}>
        <span className="hint">{t('ai.chatbots.sessionsHint')}</span>
        {sessions.map(session => {
          const owned = sessionOwners[session.id];
          const mine = draft.sessionIds.includes(session.id);
          const disabledByOther = Boolean(owned && owned !== editingId);
          return (
            <label
              key={session.id}
              className="ai-checkbox-row ai-mcp-tool-row"
              title={disabledByOther ? t('ai.chatbots.sessionOwned', { bot: owned }) : undefined}
            >
              <input
                type="checkbox"
                checked={mine}
                disabled={disabledByOther}
                onChange={() => toggleSession(session.id)}
              />
              <span>{session.name}</span>
              {disabledByOther && <span className="hint">{t('ai.chatbots.sessionOwned', { bot: owned })}</span>}
            </label>
          );
        })}
      </div>
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
            {m.capabilities
              ? m.capabilities.vision
                ? ` · 👁 ${t('ai.llm.visionChip')}`
                : ` · ${t('ai.llm.visionChip')} ✕`
              : ''}
          </option>
        ))}
      </select>
      <span className="hint">{t('ai.chatbots.llmModelHint')}</span>
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
        className="ai-persona-input"
        rows={6}
        value={draft.persona}
        placeholder={t('ai.chatbots.personaPlaceholder')}
        onChange={e => setDraft({ ...draft, persona: e.target.value })}
      />
      <span className="ai-subhead">{t('ai.chatbots.mcpTools')}</span>
      <span className="hint">{t('ai.chatbots.mcpToolsHint')}</span>
      {mcpConnections.length === 0 ? (
        <p className="hint">{t('ai.chatbots.mcpNoConnections')}</p>
      ) : (
        <div className="ai-mcp-tool-picker">
          {mcpConnections.map(connection => {
            const catalogue = toolCatalogue[connection.id];
            const selectedHere = selected.filter(entry => entry.startsWith(`${connection.id}:`)).length;
            return (
              <details key={connection.id} className="ai-mcp-tool-group" open={selectedHere > 0}>
                <summary>
                  <span>{connection.name}</span>
                  <span className="ai-mcp-tool-count">
                    {catalogue
                      ? t('ai.chatbots.mcpSelectedOf', { selected: selectedHere, total: catalogue.length })
                      : t('ai.chatbots.mcpLoadTools')}
                  </span>
                </summary>
                {fetchingTools === connection.id && (
                  <p className="hint">
                    <Loader2 size={14} className="animate-spin" /> {t('ai.chatbots.mcpLoadingTools')}
                  </p>
                )}
                {catalogue && catalogue.length === 0 && <p className="hint">{t('ai.chatbots.mcpNoTools')}</p>}
                {catalogue?.map(tool => {
                  const toolId = `${connection.id}:${tool.name}`;
                  return (
                    <label key={tool.name} className="ai-checkbox-row ai-mcp-tool-row" title={tool.description}>
                      <input
                        type="checkbox"
                        checked={selected.includes(toolId)}
                        onChange={() => toggleTool(connection.id, tool.name)}
                      />
                      <code>{tool.name}</code>
                      {tool.description && <span className="hint">{tool.description.slice(0, 90)}</span>}
                    </label>
                  );
                })}
                {!catalogue && fetchingTools !== connection.id && (
                  <button type="button" className="btn-secondary" onClick={() => void fetchTools(connection.id)}>
                    {t('ai.chatbots.mcpLoadTools')}
                  </button>
                )}
              </details>
            );
          })}
        </div>
      )}
      <label className="ai-checkbox-row">
        <input
          type="checkbox"
          checked={draft.replyGroups}
          onChange={e => setDraft({ ...draft, replyGroups: e.target.checked })}
        />
        {t('ai.chatbots.replyGroups')}
      </label>
      <span className="hint">{t('ai.chatbots.replyGroupsHint')}</span>
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
            enabled={model.enabled}
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
                  void runMutation(
                    t,
                    toast,
                    () => aiApi.updateLlmModel(model.id, { enabled: !model.enabled }),
                    'ai.toasts.updated',
                    invalidate,
                    ['llm'],
                  )
                }
                onEdit={() => {
                  setDraft({
                    name: model.name,
                    endpointUrl: model.endpointUrl,
                    model: model.model,
                    parameters: model.parameters ?? {},
                  });
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
              <button className="btn-secondary" onClick={editing ? () => setEditing(null) : onCreated}>
                {t('common.cancel')}
              </button>
              <button
                className="btn-primary"
                disabled={!draft.name.trim() || !draft.endpointUrl.trim()}
                onClick={async () => {
                  const parameters = {
                    ...draft.parameters,
                    // Empty number fields fall back to the advertised defaults at save time, so a
                    // row created from a bare form still carries sensible sampling values.
                    temperature: draft.parameters.temperature ?? LLM_PARAM_DEFAULTS.temperature,
                    maxTokens: draft.parameters.maxTokens ?? LLM_PARAM_DEFAULTS.maxTokens,
                  };
                  const base = {
                    name: draft.name.trim(),
                    endpointUrl: draft.endpointUrl.trim(),
                    model: draft.model.trim(),
                    parameters,
                  };
                  const body = newKey ? { ...base, apiKey: newKey } : base;
                  const saved = editing
                    ? await runMutation(
                        t,
                        toast,
                        () => aiApi.updateLlmModel(editing.id, body),
                        'ai.toasts.updated',
                        invalidate,
                        ['llm'],
                      )
                    : await runMutation(
                        t,
                        toast,
                        () => aiApi.createLlmModel({ ...body, apiKey: newKey } as never),
                        'ai.toasts.created',
                        invalidate,
                        ['llm'],
                      );
                  if (saved) {
                    onCreated();
                    setEditing(null);
                    setDraft(EMPTY_LLM);
                    setNewKey('');
                    // Saving fired the backend's own background probe; this explicit test waits for
                    // the result so the operator learns at save time whether the id/key work — and
                    // whether the model can see customer photos.
                    try {
                      const result = await aiApi.testLlmModel(saved.id);
                      if (!result.ok) {
                        toast.error(t('ai.toasts.testFailed', { message: result.answer }));
                      } else if (result.capabilities?.vision) {
                        toast.info(t('ai.llm.visionYes'));
                      } else if (result.capabilities) {
                        toast.info(t('ai.llm.visionNoStrict'));
                      }
                      invalidate(['llm']);
                    } catch {
                      // The test endpoint refused (network, 403): the backend probe still runs.
                    }
                  }
                }}
              >
                {t('common.save')}
              </button>
            </>
          }
        >
          <label htmlFor="ai-llm-name">{t('ai.llm.name')}</label>
          <input
            id="ai-llm-name"
            type="text"
            value={draft.name}
            onChange={e => setDraft({ ...draft, name: e.target.value })}
          />
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
                placeholder="0.7"
                value={draft.parameters.temperature ?? ''}
                onChange={e =>
                  setDraft({
                    ...draft,
                    parameters: {
                      ...draft.parameters,
                      temperature: e.target.value === '' ? undefined : Number(e.target.value),
                    },
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
                placeholder="1024"
                value={draft.parameters.maxTokens ?? ''}
                onChange={e =>
                  setDraft({
                    ...draft,
                    parameters: {
                      ...draft.parameters,
                      maxTokens: e.target.value === '' ? undefined : Number(e.target.value),
                    },
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
                if (
                  await runMutation(
                    t,
                    toast,
                    () => aiApi.deleteLlmModel(deleting.id),
                    'ai.toasts.deleted',
                    invalidate,
                    ['llm'],
                  )
                ) {
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
  parameters: { temperature?: number; maxTokens?: number; topP?: number; stop?: string[] };
}

const EMPTY_LLM: LlmDraft = { name: '', endpointUrl: '', model: '', parameters: {} };

/** The defaults the placeholders advertise; a create without explicit values saves them. */
const LLM_PARAM_DEFAULTS = { temperature: 0.7, maxTokens: 1024 };

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

  // While an entry is ingesting (pending/processing), poll its model's document list so the
  // status badges move on their own. Stops when every entry settles.
  useEffect(() => {
    if (!expanded) return;
    const ingesting = () => documents.some(d => d.status === 'pending' || d.status === 'processing');
    if (!ingesting()) return;
    const timer = setInterval(() => {
      aiApi
        .listRagDocuments(expanded)
        .then(next => setDocuments(next))
        .catch(() => undefined);
    }, 2500);
    return () => clearInterval(timer);
  }, [expanded, documents]);

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
              enabled={model.enabled}
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
                    void runMutation(
                      t,
                      toast,
                      () => aiApi.updateRagModel(model.id, { enabled: !model.enabled }),
                      'ai.toasts.updated',
                      invalidate,
                      ['rag'],
                    )
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
                      documents={documents}
                      canWrite={canWrite}
                      t={t}
                      onAdd={payload => {
                        void runMutation(
                          t,
                          toast,
                          () => aiApi.addRagDocument(model.id, payload),
                          'ai.toasts.created',
                          invalidate,
                          ['rag'],
                        ).then(ok => {
                          if (ok) void loadDocuments(model.id);
                        });
                      }}
                      onDelete={documentId => {
                        void runMutation(
                          t,
                          toast,
                          () => aiApi.deleteRagDocument(model.id, documentId),
                          'ai.toasts.deleted',
                          invalidate,
                          ['rag'],
                        ).then(ok => {
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
                        ? draft.sessionIdsText
                            .split(',')
                            .map(s => s.trim())
                            .filter(Boolean)
                        : null,
                    llmModelId: draft.llmModelId || null,
                    topK: draft.topK,
                    maxContextChars: draft.maxContextChars,
                  };
                  const ok = editing
                    ? await runMutation(
                        t,
                        toast,
                        () => aiApi.updateRagModel(editing.id, body),
                        'ai.toasts.updated',
                        invalidate,
                        ['rag'],
                      )
                    : await runMutation(t, toast, () => aiApi.createRagModel(body), 'ai.toasts.created', invalidate, [
                        'rag',
                      ]);
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
          <input
            id="ai-rag-name"
            type="text"
            value={draft.name}
            onChange={e => setDraft({ ...draft, name: e.target.value })}
          />
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
                  const ids = draft.sessionIdsText
                    .split(',')
                    .map(x => x.trim())
                    .filter(Boolean);
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
                if (
                  await runMutation(
                    t,
                    toast,
                    () => aiApi.deleteRagModel(deleting.id),
                    'ai.toasts.deleted',
                    invalidate,
                    ['rag'],
                  )
                ) {
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
            enabled={connection.enabled}
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
                  void runMutation(
                    t,
                    toast,
                    () => aiApi.updateMcpConnection(connection.id, { enabled: !connection.enabled }),
                    'ai.toasts.updated',
                    invalidate,
                    ['mcp'],
                  )
                }
                onEdit={() => {
                  setDraft({
                    name: connection.name,
                    endpointUrl: connection.endpointUrl,
                    transport: connection.transport,
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
              <AiMetaItem label={t('ai.mcp.transport')} value={connection.transport} code />
              <AiMetaItem
                label={t('ai.mcp.auth')}
                value={
                  connection.authKind === 'none'
                    ? t('ai.mcp.authNone')
                    : `${connection.authKind} · ${connection.authCredentialMasked ?? '—'}`
                }
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
                    transport: draft.transport,
                    authKind: draft.authKind,
                    authHeader: draft.authKind === 'header' ? draft.authHeader.trim() : 'X-API-Key',
                    timeoutMs: draft.timeoutMs,
                  };
                  const ok = editing
                    ? await runMutation(
                        t,
                        toast,
                        () =>
                          aiApi.updateMcpConnection(
                            editing.id,
                            credential ? { ...base, authCredential: credential } : base,
                          ),
                        'ai.toasts.updated',
                        invalidate,
                        ['mcp'],
                      )
                    : await runMutation(
                        t,
                        toast,
                        () => aiApi.createMcpConnection(credential ? { ...base, authCredential: credential } : base),
                        'ai.toasts.created',
                        invalidate,
                        ['mcp'],
                      );
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
          <input
            id="ai-mcp-name"
            type="text"
            value={draft.name}
            onChange={e => setDraft({ ...draft, name: e.target.value })}
          />
          <label htmlFor="ai-mcp-url">{t('ai.mcp.endpoint')}</label>
          <input
            id="ai-mcp-url"
            type="url"
            placeholder="https://server.example.com/mcp"
            value={draft.endpointUrl}
            onChange={e => setDraft({ ...draft, endpointUrl: e.target.value })}
          />
          <label htmlFor="ai-mcp-transport">{t('ai.mcp.transport')}</label>
          <select
            id="ai-mcp-transport"
            value={draft.transport}
            onChange={e => setDraft({ ...draft, transport: e.target.value as typeof draft.transport })}
          >
            <option value="streamable-http">{t('ai.mcp.transportStreamable')}</option>
            <option value="sse">{t('ai.mcp.transportSse')}</option>
          </select>
          <span className="hint">{t('ai.mcp.transportHint')}</span>
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
                if (
                  await runMutation(
                    t,
                    toast,
                    () => aiApi.deleteMcpConnection(deleting.id),
                    'ai.toasts.deleted',
                    invalidate,
                    ['mcp'],
                  )
                ) {
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
  transport: 'streamable-http' | 'sse';
  authKind: 'none' | 'bearer' | 'header';
  authHeader: string;
  timeoutMs: number;
}

const EMPTY_MCP: McpDraft = {
  name: '',
  endpointUrl: '',
  transport: 'streamable-http',
  authKind: 'none',
  authHeader: 'X-API-Key',
  timeoutMs: 30000,
};
