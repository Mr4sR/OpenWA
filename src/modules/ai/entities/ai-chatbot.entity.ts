import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { DateTransformer } from '../../../common/transformers/date.transformer';
import { dateColumnType, jsonColumnType } from '../../../common/utils/column-types';

/** Longest display name. */
export const AI_CHATBOT_NAME_MAX_LENGTH = 100;

/** Bound on the reply length an LLM may produce, mirroring the text-message cap. */
export const AI_CHATBOT_REPLY_MAX_LENGTH = 4096;

/**
 * Longest persona (system prompt). Deliberately above the reply bound: a persona carries
 * instructions of any length (role rules, tone, DO/DONT lists), while a REPLY rides the
 * WhatsApp text-message cap. The column is `text`, so the limit is a validation choice only.
 */
export const AI_CHATBOT_PERSONA_MAX_LENGTH = 32_000;

/**
 * One chatbot instance: the binding between WS sessions and everything the reply needs — an LLM
 * model, an optional RAG model and the persona prompt — across ONE OR MANY WhatsApp sessions.
 *
 * The ownership rule the table enforces (in the service, by validation):
 *   - ONE chatbot may serve MANY sessions (`sessionIds` holds them all);
 *   - each SESSION answers with AT MOST ONE chatbot — a second bot claiming an already-owned
 *     session is refused, so an inbound message never has two candidate bots.
 *
 * `sessionIds` is a JSON array of session ids (varchar, matching `sessions.id`). A deleted session
 * is pruned from every bot's list at deletion time (the sessions module calls `pruneSessions`).
 *
 * Which chats the bot answers is per-chat state on the Chats page (`ai_chat_overrides`, keyed
 * `(chatbotId, chatId)`): the default is ON-for-every-chat when the bot is enabled, and the
 * operator turns a specific conversation off from the chat list instead of typing JIDs here.
 */
@Entity('ai_chatbots')
@Index('IDX_ai_chatbots_sessionIds', ['sessionIds'])
export class AiChatbot {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The sessions this bot answers. At least one; each session may appear on at most one bot. */
  @Column({ type: jsonColumnType() })
  sessionIds!: string[];

  @Column({ type: 'varchar', length: AI_CHATBOT_NAME_MAX_LENGTH })
  name!: string;

  /** FK to `ai_llm_models.id`. */
  @Column({ type: 'varchar', length: 36 })
  llmModelId!: string;

  /** Optional FK to `ai_rag_models.id` — knowledge injected into the reply context when set. */
  @Column({ type: 'varchar', length: 36, nullable: true })
  ragModelId!: string | null;

  /**
   * The persona: the system prompt sent with every completion. THE one persona — the LLM model
   * row carries none, so there is exactly one place to edit it (chatbot) for the selected brain.
   */
  @Column({ type: 'text', nullable: true })
  persona!: string | null;

  /**
   * Which MCP tools this bot may call, as `"<connectionId>:<toolName>"` entries.
   *
   * Empty (or null) means "every tool the enabled MCP connections advertise, re-read live": the
   * selection is an OPERATOR narrowing, never a requirement to pre-register a tool. Adding a tool
   * on the server then needs no edit here, and a tool that disappears from the server simply stops
   * being offered — the bot is never bound to one integration.
   */
  @Column({ type: jsonColumnType(), nullable: true })
  mcpToolIds!: string[] | null;

  /**
   * Answer group chats too. Off by default: a bot that speaks in a group answers in front of
   * every member (and can ping-pong with another bot in the group), which is a conscious opt-in.
   * Channels / broadcast lists / status are never answered.
   */
  @Column({ type: 'boolean', default: false })
  replyGroups!: boolean;

  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  /** Diagnostics: the last time this bot answered any chat. */
  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  lastRepliedAt!: Date | null;

  /** Free-form diagnostics of the last failing reply (redacted error text). */
  @Column({ type: 'text', nullable: true })
  lastError!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
