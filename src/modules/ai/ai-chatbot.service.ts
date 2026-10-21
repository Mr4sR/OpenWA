import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { createLogger } from '../../common/services/logger.service';
import { PLUGIN_MESSAGE_PORT, type PluginMessagePort } from '../../core/plugins/plugin-host-ports';
import { AiChatbot } from './entities/ai-chatbot.entity';
import { AiLlmModel } from './entities/ai-llm-model.entity';
import { AiRagModel } from './entities/ai-rag-model.entity';
import { Session } from '../session/entities/session.entity';
import { Message, MessageDirection } from '../message/entities/message.entity';
import { AiLlmModelsService } from './ai-llm-models.service';
import { AiRagService } from './ai-rag.service';
import { CreateAiChatbotDto, UpdateAiChatbotDto, normalizeChatbotChatIds } from './dto/ai-chatbot.dto';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';

/** Per-session cap on chatbot instances: every inbound message is evaluated against each of them. */
export const AI_CHATBOTS_MAX_PER_SESSION = 8;

/**
 * Messages older than this are never answered. A reconnect replays the offline backlog through the
 * same inbound path, and a bot that answers it bursts into every stale message at once.
 */
const MAX_MESSAGE_AGE_SECONDS = 300;

/** Chat kinds a bot answers only when it was explicitly bound to a chat of that kind. */
const OPT_IN_CHAT_KINDS: ReadonlySet<string> = new Set(['channel', 'broadcast', 'status']);

/**
 * The cooldown map is swept of entries older than the longest allowed cooldown once it reaches this
 * size, and after a sweep only once it doubles again.
 */
const COOLDOWN_SWEEP_THRESHOLD = 10_000;

/** The fields of an inbound message the chatbot evaluation needs. */
export interface ChatbotInboundMessage {
  id?: string;
  chatId: string;
  body: string;
  fromMe?: boolean;
  timestamp?: number;
  kind?: string;
}

/** One turn of the conversation history given to the model. */
interface ChatTurn {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Chatbot instances: the CRUD behind "AI Integration > Chatbot", plus the inbound evaluation that
 * answers a chat through the ordinary send path.
 *
 * The reply is sent via the plugin message port (bound to `MessageService.sendText` by
 * MessageModule), which the module graph cannot inject directly: `MessageModule` imports
 * `SessionModule`, and this module is imported BY `SessionModule` (the projector calls
 * `evaluateInbound`), so a constructor dependency here would close a module cycle. `ModuleRef.get(
 * …, { strict: false })` resolves the core-owned token lazily at first use instead — the same
 * shape the automation rules use.
 */
@Injectable()
export class AiChatbotService {
  private readonly logger = createLogger('AiChatbotService');

  /**
   * `${chatbotId}:${chatId}` -> when the bot last answered that chat. Per-process, and judged
   * against the CURRENT cooldownSeconds, so an edit takes effect on a window already running.
   */
  private readonly cooldowns = new Map<string, number>();
  private nextCooldownSweepAt = COOLDOWN_SWEEP_THRESHOLD;

  private messagePort?: PluginMessagePort;

  constructor(
    @InjectRepository(AiChatbot, 'data')
    private readonly repository: Repository<AiChatbot>,
    @InjectRepository(Session, 'data')
    private readonly sessionRepository: Repository<Session>,
    @InjectRepository(AiLlmModel, 'data')
    private readonly llmRepository: Repository<AiLlmModel>,
    @InjectRepository(AiRagModel, 'data')
    private readonly ragRepository: Repository<AiRagModel>,
    @InjectRepository(Message, 'data')
    private readonly messageRepository: Repository<Message>,
    private readonly llmModels: AiLlmModelsService,
    private readonly rag: AiRagService,
    private readonly audit: AuditService,
    @Optional()
    private readonly configService?: ConfigService,
    // Optional so the projector can construct the service stand-alone in specs and in any wiring
    // that predates the chatbot. Absent simply disables the lazy message-port resolution.
    @Optional()
    private readonly moduleRef?: ModuleRef,
  ) {}

  async create(sessionId: string, dto: CreateAiChatbotDto): Promise<AiChatbot> {
    if (!(await this.sessionRepository.exists({ where: { id: sessionId } }))) {
      throw new NotFoundException(`Session with id '${sessionId}' not found`);
    }
    const existing = await this.repository.count({ where: { sessionId } });
    const max =
      this.configService?.get<number>('ai.chatbotsMaxPerSession', AI_CHATBOTS_MAX_PER_SESSION) ??
      AI_CHATBOTS_MAX_PER_SESSION;
    if (max > 0 && existing >= max) {
      throw new BadRequestException(
        `Chatbot limit reached for this session (${existing}/${max}); delete one before adding another`,
      );
    }
    await this.assertModelRefs(dto.llmModelId, dto.ragModelId ?? null);
    const chatbot = this.repository.create({
      sessionId,
      name: dto.name,
      llmModelId: dto.llmModelId,
      ragModelId: dto.ragModelId ?? null,
      persona: dto.persona ?? null,
      chatIds: normalizeChatbotChatIds(dto.chatIds),
      cooldownSeconds: dto.cooldownSeconds ?? 60,
      contextMessages: dto.contextMessages ?? 8,
      enabled: dto.enabled ?? true,
    });
    const saved = await this.repository.save(chatbot);
    void this.audit.logInfo(AuditAction.AI_CHATBOT_CREATED, {
      sessionId,
      metadata: { chatbotId: saved.id, chatbotName: saved.name },
    });
    return saved;
  }

  async findAll(sessionId?: string): Promise<AiChatbot[]> {
    return this.repository.find({
      where: sessionId ? { sessionId } : {},
      order: { createdAt: 'ASC', id: 'ASC' },
    });
  }

  /** The chatbots of the sessions a scoped key may see, unfiltered for an unrestricted key. */
  async findAllForSessions(sessionIds: string[] | null | undefined): Promise<AiChatbot[]> {
    if (sessionIds != null && sessionIds.length === 0) return [];
    return this.repository.find({
      where: sessionIds ? { sessionId: In(sessionIds) } : {},
      order: { createdAt: 'ASC', id: 'ASC' },
    });
  }

  async findOne(sessionId: string, id: string): Promise<AiChatbot> {
    const chatbot = await this.repository.findOne({ where: { id, sessionId } });
    if (!chatbot) {
      throw new NotFoundException(`Chatbot ${id} not found in session ${sessionId}`);
    }
    return chatbot;
  }

  async update(sessionId: string, id: string, dto: UpdateAiChatbotDto): Promise<AiChatbot> {
    const chatbot = await this.findOne(sessionId, id);
    if (dto.llmModelId !== undefined || dto.ragModelId !== undefined) {
      const llmModelId = dto.llmModelId ?? chatbot.llmModelId;
      const ragModelId = dto.ragModelId === undefined ? chatbot.ragModelId : dto.ragModelId;
      await this.assertModelRefs(llmModelId, ragModelId);
    }
    if (dto.name !== undefined) chatbot.name = dto.name;
    if (dto.llmModelId !== undefined) chatbot.llmModelId = dto.llmModelId;
    if (dto.ragModelId !== undefined) chatbot.ragModelId = dto.ragModelId;
    if (dto.persona !== undefined) chatbot.persona = dto.persona;
    if (dto.chatIds !== undefined) chatbot.chatIds = normalizeChatbotChatIds(dto.chatIds);
    if (dto.cooldownSeconds !== undefined) chatbot.cooldownSeconds = dto.cooldownSeconds;
    if (dto.contextMessages !== undefined) chatbot.contextMessages = dto.contextMessages;
    if (dto.enabled !== undefined) chatbot.enabled = dto.enabled;
    const saved = await this.repository.save(chatbot);
    void this.audit.logInfo(AuditAction.AI_CHATBOT_UPDATED, {
      sessionId: chatbot.sessionId,
      metadata: { chatbotId: saved.id, chatbotName: saved.name },
    });
    return saved;
  }

  async remove(sessionId: string, id: string): Promise<void> {
    const chatbot = await this.findOne(sessionId, id);
    await this.repository.remove(chatbot);
    void this.audit.logInfo(AuditAction.AI_CHATBOT_DELETED, {
      sessionId: chatbot.sessionId,
      metadata: { chatbotId: id, chatbotName: chatbot.name },
    });
  }

  /**
   * Evaluate one inbound message against the session's chatbots; the first matching bot answers.
   *
   * Called fire-and-forget from the projector's dispatch stage, which runs at most once per inbound
   * message (the UNIQUE(sessionId, waMessageId) insert oracle) — so a bot sees no engine re-fires.
   * Everything here swallows its own failures: a broken bot, a dead DB or a refused send must
   * never surface into the receive path.
   */
  async evaluateInbound(sessionId: string, message: ChatbotInboundMessage): Promise<void> {
    if (message.fromMe === true) return;
    if (!message.chatId || !message.body?.trim()) return;
    const timestamp = typeof message.timestamp === 'number' ? message.timestamp : null;
    if (timestamp !== null && Date.now() / 1000 - timestamp > MAX_MESSAGE_AGE_SECONDS) return;

    let chatbots: AiChatbot[];
    try {
      chatbots = await this.repository.find({
        where: { sessionId, enabled: true },
        order: { createdAt: 'ASC', id: 'ASC' },
      });
    } catch (error) {
      this.logger.warn('Chatbot lookup failed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (chatbots.length === 0) return;

    const optInOnly = OPT_IN_CHAT_KINDS.has(message.kind ?? 'individual');

    for (const chatbot of chatbots) {
      // A bot answers only the chats its allowlist names; no allowlist answers every chat.
      if (!this.chatAllowed(chatbot, message.chatId)) continue;
      // A channel / broadcast / status chat is answered only when a bot was bound to it
      // explicitly: a reply into a channel is published to every follower when the account is an
      // admin there, which is not something a catch-all bot should ever do.
      if (optInOnly && (chatbot.chatIds?.length ?? 0) === 0) continue;
      if (this.inCooldown(chatbot, message.chatId)) continue;
      // Enter the cooldown BEFORE the send: a burst of matching messages must collapse to one reply
      // even while the first send is still in flight.
      this.enterCooldown(chatbot, message.chatId);
      const answered = await this.answer(chatbot, message);
      if (answered) return;
    }
  }

  /**
   * Produce and send one answer. Returns true when a reply was sent — the caller then stops, so
   * one inbound message never produces two bot replies.
   */
  private async answer(chatbot: AiChatbot, message: ChatbotInboundMessage): Promise<boolean> {
    try {
      const llm = await this.llmRepository.findOne({ where: { id: chatbot.llmModelId } });
      if (!llm || !llm.enabled) {
        await this.recordError(chatbot, 'the linked LLM model is missing or disabled');
        return false;
      }
      const systemPrompt = await this.buildSystemPrompt(chatbot, llm, message.body);
      const history = await this.buildHistory(chatbot, message);
      const turns: ChatTurn[] = [
        ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
        ...history,
        { role: 'user' as const, content: message.body },
      ];
      const text = (await this.llmModels.complete(llm, turns)).trim();
      if (!text) {
        await this.recordError(chatbot, 'the model returned an empty answer');
        return false;
      }
      const messagePort = this.resolveMessagePort();
      if (!messagePort) {
        await this.recordError(chatbot, 'the message service is not resolvable');
        return false;
      }
      await messagePort.sendText(chatbot.sessionId, { chatId: message.chatId, text });
      chatbot.lastRepliedAt = new Date();
      chatbot.lastError = null;
      await this.repository.save(chatbot);
      this.logger.debug('Chatbot replied', { sessionId: chatbot.sessionId, chatbotId: chatbot.id });
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.recordError(chatbot, detail.slice(0, 500));
      this.logger.warn('Chatbot reply failed', {
        sessionId: chatbot.sessionId,
        chatbotId: chatbot.id,
        error: detail,
      });
      return false;
    }
  }

  /**
   * The system prompt: the bot's persona (falling back to the LLM model's), the retrieved
   * knowledge of the linked RAG model, and the WhatsApp-answer instruction.
   */
  private async buildSystemPrompt(chatbot: AiChatbot, llm: AiLlmModel, question: string): Promise<string> {
    const persona = (chatbot.persona ?? llm.persona ?? '').trim();
    const sections: string[] = [];
    if (persona) sections.push(persona);
    if (chatbot.ragModelId) {
      const retrieval = await this.rag.retrieve(chatbot.ragModelId, question, { fallbackLlm: llm });
      if (retrieval.context) {
        sections.push(
          `Knowledge from the business documents (cite the source names when you use them):\n${retrieval.context}`,
        );
      }
      if (retrieval.warnings.length > 0) {
        this.logger.debug('Chatbot RAG warnings', { chatbotId: chatbot.id, warnings: retrieval.warnings });
      }
    }
    sections.push(
      'You are answering inside a WhatsApp chat. Reply with the answer only — no markdown headings, ' +
        'no code fences, and keep it short enough to read on a phone.',
    );
    return sections.join('\n\n');
  }

  /**
   * The recent messages of the chat, oldest first, as conversation history. The inbound message
   * itself is excluded (it is the user turn the caller appends).
   */
  private async buildHistory(chatbot: AiChatbot, message: ChatbotInboundMessage): Promise<ChatTurn[]> {
    if (chatbot.contextMessages <= 0) return [];
    try {
      const rows = await this.messageRepository.find({
        where: { sessionId: chatbot.sessionId, chatId: message.chatId },
        order: { createdAt: 'DESC', id: 'DESC' },
        take: chatbot.contextMessages,
      });
      return rows
        .filter(row => message.id === undefined || row.waMessageId !== message.id)
        .reverse()
        .map(row => ({
          role: (row.direction === MessageDirection.OUTGOING ? 'assistant' : 'user') as 'assistant' | 'user',
          content: (row.body ?? '').trim(),
        }))
        .filter(entry => entry.content.length > 0);
    } catch (error) {
      // A missing history is not a failed reply: the model still answers the current question.
      this.logger.warn('Chatbot history lookup failed', {
        sessionId: chatbot.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  private chatAllowed(chatbot: AiChatbot, chatId: string): boolean {
    const allowlist = chatbot.chatIds ?? [];
    if (allowlist.length === 0) return true;
    if (allowlist.includes(chatId)) return true;
    // A bare number in the allowlist matches the `@c.us` and `@lid` forms of the same chat; a lid
    // entry matches its phone form and vice versa.
    const digits = chatId.split('@')[0];
    return allowlist.some(entry => entry.split('@')[0] === digits);
  }

  private inCooldown(chatbot: AiChatbot, chatId: string): boolean {
    if (!chatbot.cooldownSeconds) return false;
    const firedAt = this.cooldowns.get(`${chatbot.id}:${chatId}`);
    return firedAt !== undefined && firedAt + chatbot.cooldownSeconds * 1000 > Date.now();
  }

  private enterCooldown(chatbot: AiChatbot, chatId: string): void {
    if (!chatbot.cooldownSeconds) return;
    const now = Date.now();
    if (this.cooldowns.size >= this.nextCooldownSweepAt) {
      for (const [key, firedAt] of this.cooldowns) {
        if (firedAt + chatbot.cooldownSeconds * 1000 <= now) this.cooldowns.delete(key);
      }
      this.nextCooldownSweepAt = Math.max(COOLDOWN_SWEEP_THRESHOLD, this.cooldowns.size * 2);
    }
    this.cooldowns.set(`${chatbot.id}:${chatId}`, now);
  }

  /** Record the failure reason for the operator. Never throws. */
  private async recordError(chatbot: AiChatbot, error: string): Promise<void> {
    try {
      chatbot.lastError = error;
      await this.repository.save(chatbot);
    } catch (saveError) {
      this.logger.warn('Failed to record the chatbot error', {
        chatbotId: chatbot.id,
        error: saveError instanceof Error ? saveError.message : String(saveError),
      });
    }
  }

  private resolveMessagePort(): PluginMessagePort | undefined {
    if (!this.messagePort) {
      try {
        this.messagePort = this.moduleRef?.get<typeof PLUGIN_MESSAGE_PORT, PluginMessagePort>(PLUGIN_MESSAGE_PORT, {
          strict: false,
        });
      } catch (error) {
        this.logger.warn('MessageService is not resolvable; chatbot replies are disabled', {
          error: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      }
    }
    return this.messagePort;
  }

  /** The referenced LLM/RAG models must exist: a chatbot pointing at a missing model can never answer. */
  private async assertModelRefs(llmModelId: string, ragModelId: string | null): Promise<void> {
    if (!(await this.llmRepository.exists({ where: { id: llmModelId } }))) {
      throw new BadRequestException(`LLM model ${llmModelId} not found`);
    }
    if (ragModelId && !(await this.ragRepository.exists({ where: { id: ragModelId } }))) {
      throw new BadRequestException(`RAG model ${ragModelId} not found`);
    }
  }
}
