import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Copy, Loader2, Send, Sparkles } from 'lucide-react';
import type { TFunction } from 'i18next';
import { aiApi, type AiChatbot, type AiChatbotTestResult, type AiLlmModel, type AiRagModel } from '../../services/api';
import { AiCard, AiStatusDot } from './AiShared';

interface PlaygroundMessage {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  result?: AiChatbotTestResult;
  error?: string;
}

/**
 * The Playground: talk to an active chatbot from the dashboard, before (or instead of) writing on
 * WhatsApp. Each turn goes through `POST /sessions/:sid/ai-chatbots/:id/test`, which assembles the
 * production prompt — persona, RAG knowledge, history — and returns the answer WITHOUT sending it.
 * The transcript lives in component state only: nothing here is stored, and the server keeps no
 * rows for a preview.
 */
export function Playground({
  chatbots,
  llmModels,
  ragModels,
  t,
}: {
  chatbots: AiChatbot[];
  llmModels: AiLlmModel[];
  ragModels: AiRagModel[];
  t: TFunction;
}) {
  const [selectedId, setSelectedId] = useState<string>('');
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<PlaygroundMessage[]>([]);
  const [pending, setPending] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const nextId = useRef(1);

  // Default to the first bot the operator can actually test (enabled, with an enabled LLM).
  const testable = useMemo(
    () => chatbots.filter(bot => bot.enabled && llmModels.some(llm => llm.id === bot.llmModelId && llm.enabled)),
    [chatbots, llmModels],
  );

  useEffect(() => {
    if (!selectedId && testable.length > 0) setSelectedId(testable[0].id);
    if (selectedId && !chatbots.some(bot => bot.id === selectedId)) setSelectedId(testable[0]?.id ?? '');
  }, [chatbots, selectedId, testable]);

  // Switching the bot starts a fresh conversation: one transcript may not mix two bots' answers.
  useEffect(() => {
    setMessages([]);
  }, [selectedId]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight });
  }, [messages, pending]);

  const bot = chatbots.find(candidate => candidate.id === selectedId) ?? null;
  const llm = bot ? llmModels.find(model => model.id === bot.llmModelId) ?? null : null;
  const rag = bot?.ragModelId ? ragModels.find(model => model.id === bot.ragModelId) ?? null : null;

  const send = async () => {
    const text = input.trim();
    if (!bot || !text || pending) return;
    const userTurn: PlaygroundMessage = { id: nextId.current++, role: 'user', text };
    setMessages(previous => [...previous, userTurn]);
    setInput('');
    setPending(true);
    setActiveId(bot.id);
    try {
      const result = await aiApi.testChatbot(bot.sessionId, bot.id, text);
      setMessages(previous => [...previous, { id: nextId.current++, role: 'assistant', text: result.reply, result }]);
    } catch (error) {
      setMessages(previous => [
        ...previous,
        {
          id: nextId.current++,
          role: 'assistant',
          text: '',
          error: error instanceof Error ? error.message : String(error),
        },
      ]);
    } finally {
      setPending(false);
      setActiveId(null);
    }
  };

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text);
  };

  if (chatbots.length === 0) {
    return (
      <div className="empty-table-state">
        <Sparkles size={48} strokeWidth={1} />
        <h3>{t('ai.playground.emptyTitle')}</h3>
        <p>{t('ai.playground.emptyDescription')}</p>
      </div>
    );
  }

  return (
    <div className="ai-playground">
      <AiCard title={t('ai.playground.title')} icon={<Sparkles size={18} />}>
        <label htmlFor="ai-pg-bot">{t('ai.playground.bot')}</label>
        <select id="ai-pg-bot" value={selectedId} onChange={event => setSelectedId(event.target.value)}>
          <option value="">{t('ai.playground.selectBot')}</option>
          {chatbots.map(candidate => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
              {candidate.enabled ? '' : ` (${t('ai.status.disabled')})`}
            </option>
          ))}
        </select>

        {bot && (
          <div className="ai-meta ai-playground-meta">
            <span className="ai-playground-state">
              <AiStatusDot enabled={bot.enabled} />
              {bot.enabled ? t('ai.status.enabled') : t('ai.status.disabled')}
            </span>
            <span className="ai-playground-state">
              <AiStatusDot enabled={Boolean(llm?.enabled)} />
              {t('ai.playground.llm')}: {llm ? llm.name : t('ai.playground.missingLlm')}
            </span>
            {rag && (
              <span className="ai-playground-state">
                <AiStatusDot enabled={rag.hasIndex} />
                {t('ai.playground.rag')}: {rag.name}
              </span>
            )}
          </div>
        )}

        {bot && !bot.enabled && (
          <div className="error-banner" role="alert">
            <AlertCircle size={18} />
            <span className="error-banner-text">{t('ai.playground.inactiveWarning')}</span>
          </div>
        )}

        <div className="ai-playground-transcript" ref={transcriptRef} aria-live="polite">
          {messages.length === 0 ? (
            <p className="hint ai-playground-hint">{t('ai.playground.hint')}</p>
          ) : (
            messages.map(message =>
              message.role === 'user' ? (
                <div key={message.id} className="ai-playground-msg user">
                  <span className="ai-playground-role">{t('ai.playground.you')}</span>
                  <p>{message.text}</p>
                </div>
              ) : (
                <div key={message.id} className={`ai-playground-msg bot ${message.error ? 'failed' : ''}`}>
                  <span className="ai-playground-role">
                    {bot?.name ?? t('ai.playground.bot')}
                    {!message.error && message.text && (
                      <button
                        type="button"
                        className="icon-btn ai-playground-copy"
                        title={t('ai.playground.copy')}
                        aria-label={t('ai.playground.copy')}
                        onClick={() => copy(message.text)}
                      >
                        <Copy size={14} />
                      </button>
                    )}
                  </span>
                  {message.error ? (
                    <p>
                      <AlertCircle size={14} /> {message.error}
                    </p>
                  ) : (
                    <p>{message.text}</p>
                  )}
                  {message.result && (message.result.sources.length > 0 || message.result.warnings.length > 0) && (
                    <div className="ai-playground-sources">
                      {message.result.sources.length > 0 && (
                        <span>
                          {t('ai.playground.sources')}: {message.result.sources.join(', ')}
                        </span>
                      )}
                      {message.result.warnings.map(warning => (
                        <span key={warning} className="ai-playground-warning">
                          <AlertCircle size={12} /> {warning}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ),
            )
          )}
          {pending && (
            <div className="ai-playground-msg bot">
              <span className="ai-playground-role">{bot?.name ?? t('ai.playground.bot')}</span>
              <p className="ai-playground-typing">
                <Loader2 size={14} className="animate-spin" /> {t('ai.playground.thinking')}
              </p>
            </div>
          )}
        </div>

        <div className="ai-playground-composer">
          <textarea
            aria-label={t('ai.playground.inputLabel')}
            placeholder={t('ai.playground.inputPlaceholder')}
            rows={3}
            value={input}
            onChange={event => setInput(event.target.value)}
            onKeyDown={event => {
              // Enter sends, Shift+Enter is a newline — the chat convention.
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <button
            type="button"
            className="btn-primary"
            disabled={!bot || !input.trim() || pending}
            onClick={() => void send()}
          >
            {activeId === selectedId ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
            {t('ai.playground.send')}
          </button>
        </div>
        <p className="hint">{t('ai.playground.note')}</p>
      </AiCard>
    </div>
  );
}
