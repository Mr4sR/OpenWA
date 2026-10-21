import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  ManyToOne,
  JoinColumn,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Session } from '../../session/entities/session.entity';
import { jsonColumnType } from '../../../common/utils/column-types';

/** Longest display name. */
export const AI_CHATBOT_NAME_MAX_LENGTH = 100;

/** Bound on the reply length an LLM may produce, mirroring the text-message cap. */
export const AI_CHATBOT_REPLY_MAX_LENGTH = 4096;

/**
 * Longest per-chat conversation history kept for the system prompt (in messages). Bounds the token
 * spend of one reply: history beyond the newest N turns is dropped, oldest first.
 */
export const CHATBOT_CONTEXT_MAX = 20;

/**
 * One chatbot instance: the binding between the inbound messages of ONE WhatsApp session and
 * everything the reply needs — an LLM model, an optional RAG model, the persona prompt and the
 * chat fence the bot is allowed to speak in.
 *
 * `sessionId` is varchar to match `sessions.id` (the same reasoning as `webhooks.sessionId`);
 * `chatIds` is the per-instance allowlist, independent of any API key scope — null/empty answers
 * every chat of the session (channel / broadcast / status never answered, like the automation rules).
 *
 * `lastRepliedAt` per (chatbot, chat) cooldown lives in-process (see AiChatbotService); only the
 * most recent send time is persisted, for diagnostics.
 */
@Entity('ai_chatbots')
@Index('IDX_ai_chatbots_sessionId', ['sessionId'])
export class AiChatbot {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar' })
  sessionId!: string;

  @ManyToOne(() => Session, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sessionId' })
  session!: Session;

  @Column({ type: 'varchar', length: AI_CHATBOT_NAME_MAX_LENGTH })
  name!: string;

  /** FK to `ai_llm_models.id`. */
  @Column({ type: 'varchar', length: 36 })
  llmModelId!: string;

  /** Optional FK to `ai_rag_models.id` — knowledge injected into the reply context when set. */
  @Column({ type: 'varchar', length: 36, nullable: true })
  ragModelId!: string | null;

  /** Optional persona; overrides the LLM model's own persona when set (chatbot wins). */
  @Column({ type: 'text', nullable: true })
  persona!: string | null;

  /**
   * Chat allowlist. Null or empty answers every chat of the session; non-null filters the inbound
   * messages the bot reacts to. WhatsApp JIDs or bare phone numbers (qualified to `<digits>@c.us`
   * on save, like the chat-scope list).
   */
  @Column({ type: 'simple-array', nullable: true })
  chatIds!: string[] | null;

  /** A chat the bot answered stays silent for this long (per chat), 0 disables. */
  @Column({ type: 'int', default: 60 })
  cooldownSeconds!: number;

  /**
   * How many prior messages of the chat ride along as conversation history (default 8, 0 disables).
   */
  @Column({ type: 'int', default: 8 })
  contextMessages!: number;

  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  /** Diagnostics: the last time this bot answered any chat. */
  @Column({ type: 'datetime', nullable: true })
  lastRepliedAt!: Date | null;

  /** Free-form diagnostics of the last failing reply (redacted error text). */
  @Column({ type: 'text', nullable: true })
  lastError!: string | null;

  /** Operator tuning recorded verbatim, e.g. which RAG node citations were last used. */
  @Column({ type: jsonColumnType(), nullable: true })
  metadata!: Record<string, unknown> | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
