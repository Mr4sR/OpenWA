import { Column, CreateDateColumn, Entity, Index, ManyToOne, JoinColumn, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { AiChatbot } from './ai-chatbot.entity';

/**
 * Per-chat AI switch, written from the Chats page. When a chatbot is enabled, EVERY conversation
 * of its session is answered by default; the operator turns a specific conversation off here
 * (a noisy group, a VIP they answer themselves) instead of the bot carrying a JID allowlist.
 *
 * One row per (chatbotId, chatId). A missing row means "follow the bot's default (on)".
 */
@Entity('ai_chat_overrides')
@Index('IDX_ai_chat_overrides_chatbotId', ['chatbotId'])
@Index('UQ_ai_chat_overrides_chatbot_chat', ['chatbotId', 'chatId'], { unique: true })
export class AiChatOverride {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** FK to `ai_chatbots.id` — a plain varchar, like the other AI FKs. */
  @Column({ type: 'varchar' })
  chatbotId!: string;

  @ManyToOne(() => AiChatbot, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'chatbotId' })
  chatbot!: AiChatbot;

  /** The WhatsApp chat id exactly as it arrives on the inbound path (`…@c.us`, `…@g.us`, `…@lid`). */
  @Column({ type: 'varchar', length: 255 })
  chatId!: string;

  /** True = the bot stays silent in this chat even though it is enabled on the session. */
  @Column({ type: 'boolean', default: false })
  chatbotDisabled!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
