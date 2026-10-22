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
import { DateTransformer } from '../../../common/transformers/date.transformer';
import { dateColumnType, jsonColumnType } from '../../../common/utils/column-types';

/** Longest display name. */
export const AI_CHATBOT_NAME_MAX_LENGTH = 100;

/** Bound on the reply length an LLM may produce, mirroring the text-message cap. */
export const AI_CHATBOT_REPLY_MAX_LENGTH = 4096;

/**
 * One chatbot instance: the binding between the inbound messages of ONE WhatsApp session and
 * everything the reply needs — an LLM model, an optional RAG model and the persona prompt.
 *
 * `sessionId` is varchar to match `sessions.id` (the same reasoning as `webhooks.sessionId`).
 *
 * Which chats the bot answers is per-chat state on the Chats page (`ai_chat_overrides`, keyed
 * `(chatbotId, chatId)`): the default is ON-for-every-chat when the bot is enabled, and the
 * operator turns a specific conversation off from the chat list instead of typing JIDs here.
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

  /**
   * The persona: the system prompt sent with every completion. THE one persona — the LLM model
   * row carries none, so there is exactly one place to edit it (chatbot) for the selected brain.
   */
  @Column({ type: 'text', nullable: true })
  persona!: string | null;

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
