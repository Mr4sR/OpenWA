import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { createLogger } from '../../common/services/logger.service';
import {
  PLUGIN_CONVERSATION_MAPPING_PORT,
  PLUGIN_MESSAGE_PORT,
  PLUGIN_SESSION_PORT,
  type PluginConversationMappingPort,
  type PluginMessagePort,
  type PluginSessionPort,
} from '../../core/plugins/plugin-host-ports';
import { resolveJidCandidates } from '../../engine/identity/jid-candidates';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { AiChatbot } from './entities/ai-chatbot.entity';
import { AiChatOverride } from './entities/ai-chat-override.entity';
import { AiLlmModel } from './entities/ai-llm-model.entity';
import { AiRagModel } from './entities/ai-rag-model.entity';
import { Session } from '../session/entities/session.entity';
import { Message, MessageDirection } from '../message/entities/message.entity';
import { AiLlmModelsService, type ChatCompletionMessage, type ToolCallRequest } from './ai-llm-models.service';
import { AiMcpConnectionsService } from './ai-mcp-connections.service';
import { AiRagService, type RetrievalResult } from './ai-rag.service';
import { CreateAiChatbotDto, UpdateAiChatbotDto } from './dto/ai-chatbot.dto';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';

/** Per-session cap on chatbot instances: every inbound message is evaluated against each of them. */
export const AI_CHATBOTS_MAX_PER_SESSION = 8;

/** Default conversation history (prior messages) carried into the prompt. Not operator-tuned. */
const CHATBOT_HISTORY_MESSAGES = 8;

/**
 * Messages older than this are never answered. A reconnect replays the offline backlog through the
 * same inbound path, and a bot that answers it bursts into every stale message at once. Also the
 * reply loop guard: answering another bot's message would ping-pong until one side ages out.
 */
const MAX_MESSAGE_AGE_SECONDS = 300;

/** Chat kinds a bot answers only when `replyGroups`-style opt-in applies (see evaluateInbound). */
const GROUP_KIND = 'group';

/**
 * WhatsApp expires a typing presence after ~6 s, but an LLM turn can run longer. The indicator is
 * re-armed at this period so "typing…" stays up from the inbound message to the outgoing reply.
 */
const TYPING_REFRESH_MS = 4_000;

/** Tool round-trips one reply may spend before the model must answer from what it has. */
const MCP_TOOL_ROUNDS = 5;

/** OpenAI restricts tool names to this grammar; the MCP names are namespaced to fit inside it. */
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/** The OpenAI tool name for one MCP tool: the dash-stripped connection id + tool name. */
export function mcpToolFqName(connectionId: string, toolName: string): string {
  // Dashes stripped: an OpenAI tool name may carry `_`, and parsing must be unambiguous, so the
  // first `mcp_<32hex>_` prefix is the whole id and everything after it is the server's tool name.
  return `mcp_${connectionId.replace(/-/g, '')}_${toolName}`;
}

/** Inverse of {@link mcpToolFqName}; null when the model invented a name that maps to nothing. */
export function parseMcpToolFqName(fqName: string): { connectionId: string; toolName: string } | null {
  const match = /^mcp_([0-9a-f]{32})_(.+)$/.exec(fqName);
  if (!match) return null;
  const hex = match[1];
  const connectionId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return { connectionId, toolName: match[2] };
}

/** Flatten an MCP tool result into the text the model reads back. */
function summarizeToolResult(result: unknown): string {
  const content = (result as { content?: unknown } | null)?.content;
  if (Array.isArray(content)) {
    const text = content
      .map(part => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part && typeof (part as { text: unknown }).text === 'string') {
          return (part as { text: string }).text;
        }
        return '';
      })
      .join('\n')
      .trim();
    if (text) return text.slice(0, 4000);
  }
  return JSON.stringify(result ?? {}).slice(0, 2000);
}

/**
 * Normalize the operator's tool selection: trim, drop empties and duplicates, cap at 200. `null`
 * and an empty array both mean "no narrowing" and store the same thing: nothing.
 */
function normalizeMcpToolIds(value: string[] | null | undefined): string[] | null {
  if (value == null) return null;
  const normalized = [...new Set(value.map(entry => entry.trim()).filter(entry => entry.length > 0))];
  return normalized.length > 0 ? normalized.slice(0, 200) : null;
}

/**
 * The history key for a playground (preview) request: a synthetic chat id no real conversation
 * uses, so a preview reads an empty history instead of leaking another chat's transcript into
 * what the operator is testing.
 */
const PLAYGROUND_CHAT_ID = 'playground@c.us';

/** One Playground probe: the answer the bot produced, with the RAG citations it stood on. */
export interface ChatbotPreview {
  reply: string;
  sources: Array<{ title: string }>;
  warnings: string[];
}

/** The fields of an inbound message the chatbot evaluation needs. */
export interface ChatbotInboundMessage {
  id?: string;
  chatId: string;
  body: string;
  fromMe?: boolean;
  timestamp?: number;
  kind?: string;
  isGroup?: boolean;
}

/**
 * Chatbot instances: the CRUD behind "AI Integration > Chatbot", the per-chat overrides behind the
 * Chats page switches, and the inbound evaluation that answers a chat through the ordinary send
 * path.
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

  /** In-memory cache of (chatbotId, chatId) → disabled, refreshed per inbound batch. */
  private messagePort?: PluginMessagePort;

  /** Lazy session port for the chatbot's typing indicator (resolved like the message port). */
  private sessionPort?: PluginSessionPort;

  /** Lazy conversation-mapping port for the human-takeover gate (resolved like the message port). */
  private conversationMappings?: PluginConversationMappingPort;

  constructor(
    @InjectRepository(AiChatbot, 'data')
    private readonly repository: Repository<AiChatbot>,
    @InjectRepository(AiChatOverride, 'data')
    private readonly overrideRepository: Repository<AiChatOverride>,
    @InjectRepository(Session, 'data')
    private readonly sessionRepository: Repository<Session>,
    @InjectRepository(AiLlmModel, 'data')
    private readonly llmRepository: Repository<AiLlmModel>,
    @InjectRepository(AiRagModel, 'data')
    private readonly ragRepository: Repository<AiRagModel>,
    @InjectRepository(Message, 'data')
    private readonly messageRepository: Repository<Message>,
    private readonly llmModels: AiLlmModelsService,
    private readonly mcpConnections: AiMcpConnectionsService,
    private readonly rag: AiRagService,
    private readonly audit: AuditService,
    @Optional()
    private readonly configService?: ConfigService,
    @Optional()
    private readonly moduleRef?: ModuleRef,
    /**
     * Optional identity context: an @Optional() dep keeps unit constructions (tests) working, and
     * evaluation degrades there to literal-chatId matching — the pre-aliased behavior. The lid
     * store is an EngineModule (@Global) provider, so no module import is needed.
     */
    @Optional()
    private readonly lidMappingStore?: LidMappingStoreService,
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
      replyGroups: dto.replyGroups ?? false,
      mcpToolIds: normalizeMcpToolIds(dto.mcpToolIds),
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
    // The LLM binding is required: a null there can never answer, so it is refused rather than
    // cleared. The RAG binding and the persona are optional — null detaches/clears them.
    if (dto.llmModelId === null) {
      throw new BadRequestException('llmModelId is required: a chatbot cannot answer without its LLM model');
    }
    if (dto.llmModelId !== undefined || dto.ragModelId !== undefined) {
      const llmModelId = dto.llmModelId ?? chatbot.llmModelId;
      const ragModelId = dto.ragModelId === undefined ? chatbot.ragModelId : dto.ragModelId;
      await this.assertModelRefs(llmModelId, ragModelId);
    }
    if (dto.name !== undefined) chatbot.name = dto.name;
    if (dto.llmModelId !== undefined) chatbot.llmModelId = dto.llmModelId;
    if (dto.ragModelId !== undefined) chatbot.ragModelId = dto.ragModelId;
    if (dto.persona !== undefined) chatbot.persona = dto.persona === '' ? null : dto.persona;
    if (dto.replyGroups !== undefined) chatbot.replyGroups = dto.replyGroups;
    // `undefined` leaves the selection alone; `null`/`[]` clears it back to "every advertised tool".
    if (dto.mcpToolIds !== undefined) chatbot.mcpToolIds = normalizeMcpToolIds(dto.mcpToolIds);
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
   * The playground: produce the answer the bot would give, without sending anything. Reuses the
   * exact production prompt assembly — persona, RAG retrieval, chat history and the WhatsApp
   * instruction — over a synthetic chat id, so what the operator tests is what a real inbound
   * message gets. Returns the reply text plus RAG citations/warnings for the dashboard.
   */
  async previewReply(chatbot: AiChatbot, body: string): Promise<ChatbotPreview> {
    const llm = await this.llmRepository.findOne({ where: { id: chatbot.llmModelId } });
    if (!llm || !llm.enabled) {
      throw new BadRequestException('the linked LLM model is missing or disabled');
    }
    if (!body.trim()) {
      throw new BadRequestException('message is required');
    }
    let retrieval: RetrievalResult | null = null;
    if (chatbot.ragModelId) {
      retrieval = await this.rag.retrieve(chatbot.ragModelId, body, { fallbackLlm: undefined });
    }
    const systemPrompt = await this.buildSystemPrompt(chatbot, body, retrieval);
    const history = await this.buildHistory(chatbot, { chatId: PLAYGROUND_CHAT_ID, body });
    const turns: ChatCompletionMessage[] = [
      ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
      ...history,
      { role: 'user' as const, content: body },
    ];
    const reply = await this.completeWithMcpTools(chatbot, llm, turns);
    if (!reply) {
      throw new BadRequestException('the model returned an empty answer');
    }
    return {
      reply,
      sources: (retrieval?.nodes ?? []).map(node => ({ title: node.title })),
      warnings: retrieval?.warnings ?? [],
    };
  }

  /** Audit the playground probe like the LLM/MCP tests: a diagnostic run, recorded best-effort. */
  async auditTest(chatbot: AiChatbot): Promise<void> {
    void this.audit.logInfo(AuditAction.AI_CHATBOT_TESTED, {
      sessionId: chatbot.sessionId,
      metadata: { chatbotId: chatbot.id, chatbotName: chatbot.name },
    });
  }

  // ── Per-chat overrides (the Chats page switches) ─────────────────────────────────────────────

  /**
   * The AI switches of the given session's chatbots for exactly the chats the page asks for. Chats
   * without a row are implicitly ON (the bot's `enabled` state governs them), so only the OFF
   * conversations are stored. Resolved through the chat's id aliases: a mute written under one
   * dialect is reported on the other too, or the chip flips back ON at the next page load.
   */
  async getChatOverrides(sessionId: string, chatIds: string[]): Promise<Map<string, string[]>> {
    const bots = await this.repository.find({ where: { sessionId } });
    const byChat = new Map<string, string[]>();
    if (bots.length === 0 || chatIds.length === 0) return byChat;
    const botIds = bots.map(b => b.id);
    for (const chatId of chatIds) {
      const rows = await this.overrideRepository.find({
        where: { chatbotId: In(botIds), chatId: In(await this.chatIdAliases(chatId)), chatbotDisabled: true },
      });
      const muted = [...new Set(rows.map(row => row.chatbotId))];
      if (muted.length > 0) byChat.set(chatId, muted);
    }
    return byChat;
  }

  /**
   * Flip one (chatbot, chat) switch. `chatbotDisabled: true` stores a row; false removes it.
   *
   * The removal matches EVERY alias of the chat, not just the literal id the page sent. A 1:1
   * conversation flips between `<lid>@lid` and `<phone>@c.us` as the engine learns the mapping, so a
   * mute written under one form reads back under the other; looking up only the literal id left
   * the alias row in place, and the switch stuck OFF no matter how often it was turned back on.
   */
  async setChatOverride(
    sessionId: string,
    chatbotId: string,
    chatId: string,
    chatbotDisabled: boolean,
  ): Promise<void> {
    await this.findOne(sessionId, chatbotId);
    const aliases = await this.chatIdAliases(chatId);
    if (chatbotDisabled) {
      const existing = await this.overrideRepository.findOne({ where: { chatbotId, chatId: In(aliases) } });
      if (existing) {
        existing.chatbotDisabled = true;
        await this.overrideRepository.save(existing);
      } else {
        await this.overrideRepository.save(this.overrideRepository.create({ chatbotId, chatId, chatbotDisabled }));
      }
    } else {
      // Remove every stored form of this conversation, so a mute recorded under another dialect
      // cannot survive the switch that turns the bot back on.
      await this.overrideRepository.delete({ chatbotId, chatId: In(aliases) });
    }
  }

  // ── Inbound evaluation ────────────────────────────────────────────────────────────────────────

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

    // A conversation a human holds (or one a relay closed) stays out of every bot's hands: checked
    // once per message, before the bot loop, exactly like the plugin hook gate silences its bots.
    // Fail-open inside the helper keeps a dead mapping read from breaking the receive path.
    if (await this.isChatHumanHeld(sessionId, message.chatId)) return;

    const isGroup = message.isGroup ?? ((message.kind ?? 'individual') === GROUP_KIND || message.chatId.endsWith('@g.us'));
    for (const chatbot of chatbots) {
      // A group needs the operator's explicit opt-in: the bot speaks in front of every member.
      if (isGroup && !chatbot.replyGroups) continue;
      // Channel / broadcast / status are never answered.
      if (['channel', 'broadcast', 'status'].includes(message.kind ?? '')) continue;
      if (await this.isChatDisabled(chatbot.id, message.chatId)) continue;
      const answered = await this.answer(chatbot, message);
      if (answered) return;
    }
  }

  /**
   * True when the Chats page switch turned this bot off for this conversation. Matched against the
   * chat's id aliases, so a mute recorded under either dialect silences the conversation under
   * both.
   */
  private async isChatDisabled(chatbotId: string, chatId: string): Promise<boolean> {
    try {
      return await this.overrideRepository.exists({
        where: { chatbotId, chatId: In(await this.chatIdAliases(chatId)), chatbotDisabled: true },
      });
    } catch (error) {
      // Fail open: a dead override read must not silence every bot.
      this.logger.warn('Chat-override lookup failed', {
        chatbotId,
        chatId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * The chat id plus its other individual-dialect forms: the phone behind a lid and the sibling
   * lids of that phone. A 1:1 chat's neutral id flips between `<lid>@lid` and `<phone>@c.us` as
   * the engine learns the mapping, so an override written from the Chats page under one form must
   * govern the conversation under the other as well. Mirrors the aliasing
   * `ConversationMappingService` applies to human takeovers; the lid store may be absent in unit
   * constructions, where only the literal id matches.
   */
  private async chatIdAliases(chatId: string): Promise<string[]> {
    // Delegated to the shared helper so the chatbot cannot disagree with the message filter or the
    // API-key chat scope about which ids name the same conversation (it also covers
    // `@s.whatsapp.net` and a bare number, not just the two forms the inference originally mapped).
    const store = this.lidMappingStore;
    return resolveJidCandidates(
      chatId,
      store
        ? {
            resolveLid: lid => store.findPhoneForLid?.(lid),
            lidsForPhone: phone => store.findLidsForPhone?.(phone) ?? [],
          }
        : undefined,
    );
  }

  /**
   * True when a human agent (or a closed conversation downstream, e.g. a Chatwoot relay) currently
   * holds the chat. A handover silences every OTHER responder on it — the plugin gate exempts the
   * owning plugin and the AI chatbot is never the owner — so it is always silenced. Fail-open like
   * the plugin hook gate: a dead mapping read must not break the receive path.
   */
  private async isChatHumanHeld(sessionId: string, chatId: string): Promise<boolean> {
    const mappings = this.resolveConversationMappings();
    if (!mappings) return false;
    try {
      const handover = await mappings.findHandoverForChat(sessionId, chatId);
      return handover != null && handover.handoverState !== 'bot';
    } catch (error) {
      this.logger.warn('Handover lookup failed; the AI chatbot answer is not suppressed', {
        sessionId,
        chatId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Produce and send one answer. Returns true when a reply was sent — the caller then stops, so
   * one inbound message never produces two bot replies.
   *
   * The chat is shown a real typing indicator for the whole generation (`sendChatState('typing')`,
   * the same chassis as the manual-send humanising pause) and it is kept alive with refresh ticks
   * until the reply actually goes out, because an LLM turn can outlast WhatsApp's ~6 s presence
   * expiry. Strictly best-effort: the send below never waits on a presence failure, and `paused`
   * is only sent when the typing itself was shown — an *indicator the operator never saw* must not
   * become another outbound write.
   */
  private async answer(chatbot: AiChatbot, message: ChatbotInboundMessage): Promise<boolean> {
    // The typing ticks run detached: `sendChatState` resolves against a live session port that is
    // resolved once and reused, so the timer cannot outlive the module or fire on a stopped engine
    // (a presence call on one is swallowed as best-effort).
    const stopTyping = this.startTypingIndicator(chatbot.sessionId, message.chatId);
    try {
      const llm = await this.llmRepository.findOne({ where: { id: chatbot.llmModelId } });
      if (!llm || !llm.enabled) {
        await this.recordError(chatbot, 'the linked LLM model is missing or disabled');
        return false;
      }
      const systemPrompt = await this.buildSystemPrompt(chatbot, message.body);
      const history = await this.buildHistory(chatbot, message);
      const turns: ChatCompletionMessage[] = [
        ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
        ...history,
        { role: 'user' as const, content: message.body },
      ];
      const text = await this.completeWithMcpTools(chatbot, llm, turns);
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
    } finally {
      await stopTyping();
    }
  }

  /**
   * One completion, with the bot's MCP tools available — the flexible half of the feature.
   *
   * Every ENABLED MCP connection's advertised tools are offered to the model (namespaced
   * `mcp_<connectionId>_<toolName>` so two servers exposing `search` never collide). The model
   * decides WHEN a tool is relevant from its own name/description: a "cek tagihan" question only
   * reaches the billing tool if the model judges it useful. When it calls one, the gateway
   * executes it against the MCP server, feeds the result back as a `tool` turn, and asks again —
   * up to {@link MCP_TOOL_ROUNDS} rounds, so a chatty model cannot chain a reply forever.
   *
   * The operator narrows the surface with the bot's `mcpToolIds` selection; a bot with an EMPTY
   * selection gets every advertised tool. A tool that fails (server down, unknown tool, bad
   * arguments) lands back to the model as an error string so it can answer from what it has —
   * the failure never surfaces as a thrown reply.
   */
  private async completeWithMcpTools(chatbot: AiChatbot, llm: AiLlmModel, turns: ChatCompletionMessage[]): Promise<string> {
    const tools = await this.resolveChatbotTools(chatbot);
    if (tools.length === 0) {
      // No MCP tools reachable (none configured, none enabled, or every server failed): the
      // answer is just the plain completion the bot always made.
      return (await this.llmModels.complete(llm, turns as Array<{ role: 'system' | 'user' | 'assistant'; content: string }>)).trim();
    }
    const conversation: ChatCompletionMessage[] = [...turns];
    for (let round = 0; round < MCP_TOOL_ROUNDS; round++) {
      const { content, toolCalls, rawAssistant } = await this.llmModels.completeWithTools(llm, conversation, tools);
      if (toolCalls.length === 0) return (content ?? '').trim();
      // The assistant's tool-call turn must ride the conversation so the `tool` results below pair
      // with it (OpenAI validates id parity).
      conversation.push(rawAssistant as ChatCompletionMessage);
      for (const call of toolCalls) {
        conversation.push(await this.executeToolCall(chatbot, call));
      }
    }
    // Budget spent: force a textual answer with the knowledge already gathered.
    conversation.push({ role: 'user', content: 'Finish now: answer the user with the information you already have, in one short message.' });
    const final = await this.llmModels.complete(
      llm,
      conversation.filter((turn): turn is { role: 'system' | 'user' | 'assistant'; content: string } => 'content' in turn),
    );
    return final.trim();
  }

  /**
   * The OpenAI `tools` array from the chatbot's MCP surface: every tool of every enabled
   * connection, minus the operator's per-bot narrowing when one is set.
   */
  private async resolveChatbotTools(
    chatbot: AiChatbot,
  ): Promise<Array<{ type: 'function'; function: { name: string; description?: string; parameters: Record<string, unknown> } }>> {
    let connections: Awaited<ReturnType<AiMcpConnectionsService['findAll']>>;
    try {
      connections = await this.mcpConnections.findAll();
    } catch {
      return []; // A dead MCP table must not break the plain reply path.
    }
    const enabled = connections.filter(connection => connection.enabled);
    if (enabled.length === 0) return [];
    const selected = new Set(chatbot.mcpToolIds ?? []);
    const tools: Array<{ type: 'function'; function: { name: string; description?: string; parameters: Record<string, unknown> } }> = [];
    for (const connection of enabled) {
      let advertised: Awaited<ReturnType<AiMcpConnectionsService['listTools']>>;
      try {
        advertised = await this.mcpConnections.listTools(connection.id);
      } catch (error) {
        // One down server shrinks the surface; the rest still answer.
        this.logger.warn('MCP tools/list failed for the chatbot', {
          chatbotId: chatbot.id,
          connectionId: connection.id,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      for (const tool of advertised) {
        if (!TOOL_NAME_PATTERN.test(tool.name)) continue;
        const fqName = mcpToolFqName(connection.id, tool.name);
        if (selected.size > 0 && !selected.has(fqName)) continue;
        tools.push({
          type: 'function',
          function: {
            name: fqName,
            description: tool.description ?? `Tool ${tool.name} on MCP server ${connection.name}.`,
            parameters: tool.inputSchema ?? { type: 'object', properties: {} },
          },
        });
      }
    }
    return tools;
  }

  /** Run one model-requested tool against the MCP server and shape the `tool` result turn. */
  private async executeToolCall(chatbot: AiChatbot, call: ToolCallRequest): Promise<ChatCompletionMessage> {
    const parsed = parseMcpToolFqName(call.name);
    if (!parsed) {
      return { role: 'tool', tool_call_id: call.id, content: `Error: unknown tool ${call.name}.` };
    }
    try {
      const result = await this.mcpConnections.callTool(parsed.connectionId, parsed.toolName, call.args);
      const text = summarizeToolResult(result);
      return { role: 'tool', tool_call_id: call.id, content: call.parseError ? `Error: ${call.parseError}.` : text };
    } catch (error) {
      // Surface the failure to the MODEL, not as a thrown reply: it can apologize or answer
      // without the tool.
      const detail = error instanceof Error ? error.message : String(error);
      return { role: 'tool', tool_call_id: call.id, content: `Error: tool call failed. ${detail.slice(0, 300)}` };
    }
  }

  /**
   * Show the typing indicator now and re-arm it every {@link TYPING_REFRESH_MS} so a slow LLM turn
   * still reads as "typing" to the recipient. Returns the closer: one best-effort `paused`
   * (only when a typing frame actually went out), timer cleared. Never throws.
   */
  private startTypingIndicator(sessionId: string, chatId: string): () => Promise<void> {
    let shown = false;
    let stopped = false;
    const sendState = async (state: 'typing' | 'paused'): Promise<void> => {
      try {
        await this.sendChatState(sessionId, chatId, state);
        if (state === 'typing') shown = true;
      } catch (error) {
        // Presence failures are cosmetic; the reply must not depend on them.
        this.logger.debug('Chatbot presence update skipped', {
          sessionId,
          chatId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    void sendState('typing');
    const timer: ReturnType<typeof setInterval> = setInterval(() => {
      if (!stopped) void sendState('typing');
    }, TYPING_REFRESH_MS);
    // Never keep the process alive for a cosmetic presence tick.
    timer.unref?.();
    return async () => {
      stopped = true;
      clearInterval(timer);
      // Only close an indicator the recipient actually saw: a presence failure means no typing
      // frame ever went out, and `paused` would be a stray write.
      if (shown) await sendState('paused');
    };
  }

  /**
   * Publish one chat state through the session port (`SessionService.sendChatState`), resolved
   * lazily like the message port for the same module-cycle reason. Throws when the session has no
   * live engine; callers here treat that as "no indicator shown".
   */
  private async sendChatState(sessionId: string, chatId: string, state: 'typing' | 'paused'): Promise<void> {
    if (!this.sessionPort) {
      this.sessionPort = this.moduleRef?.get<typeof PLUGIN_SESSION_PORT, PluginSessionPort>(PLUGIN_SESSION_PORT, {
        strict: false,
      });
    }
    if (!this.sessionPort) throw new Error('the session service is not resolvable');
    await this.sessionPort.sendChatState(sessionId, chatId, state);
  }

  /**
   * The system prompt: the chatbot's persona (THE one persona — the LLM connection carries none),
   * the retrieved knowledge of the linked RAG model, and the WhatsApp-answer instruction. A caller
   * that already ran the retrieval (the playground) passes it in, so one question is embedded and
   * walked once.
   */
  private async buildSystemPrompt(
    chatbot: AiChatbot,
    question: string,
    prefetched?: RetrievalResult | null,
  ): Promise<string> {
    const persona = (chatbot.persona ?? '').trim();
    const sections: string[] = [];
    if (persona) sections.push(persona);
    if (chatbot.ragModelId) {
      const retrieval =
        prefetched ?? (await this.rag.retrieve(chatbot.ragModelId, question, { fallbackLlm: undefined }));
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
  private async buildHistory(chatbot: AiChatbot, message: ChatbotInboundMessage): Promise<ChatCompletionMessage[]> {
    try {
      const rows = await this.messageRepository.find({
        where: { sessionId: chatbot.sessionId, chatId: message.chatId },
        order: { createdAt: 'DESC', id: 'DESC' },
        take: CHATBOT_HISTORY_MESSAGES,
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

  /**
   * The conversation-mapping port, resolved lazily like the message port: the handover gate is
   * optional (a unit construction has no ModuleRef), and a missing binding must degrade to "no
   * takeover recorded", never break the receive path.
   */
  private resolveConversationMappings(): PluginConversationMappingPort | undefined {
    if (!this.conversationMappings) {
      try {
        this.conversationMappings = this.moduleRef?.get<
          typeof PLUGIN_CONVERSATION_MAPPING_PORT,
          PluginConversationMappingPort
        >(PLUGIN_CONVERSATION_MAPPING_PORT, { strict: false });
      } catch (error) {
        this.logger.warn('ConversationMappingService is not resolvable; handover suppression is off', {
          error: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      }
    }
    return this.conversationMappings;
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
