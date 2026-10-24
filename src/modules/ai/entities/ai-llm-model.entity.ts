import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { DateTransformer } from '../../../common/transformers/date.transformer';
import { jsonColumnType, dateColumnType } from '../../../common/utils/column-types';

/**
 * Longest LLM provider api key we accept. Keys are bearer tokens — OpenAI's `sk-…` runs ~164
 * chars, Anthropic ~108 — so 512 leaves every real provider headroom while keeping a fat-fingered
 * paste (a whole config file) out of the column.
 */
export const LLM_API_KEY_MAX_LENGTH = 512;

/** Upper bound for the endpoint base URL, matching the webhook url column width. */
export const LLM_ENDPOINT_MAX_LENGTH = 2048;

/** Longest persona/system-prompt text. A persona is a paragraph or three, not a knowledge base. */
export const LLM_PERSONA_MAX_LENGTH = 8000;

/** Longest display name. */
export const LLM_NAME_MAX_LENGTH = 100;

/**
 * One configured LLM provider connection: base endpoint URL, api key, model id and the sampling
 * parameters the chat completions call sends. This is the "which brain" half of a chatbot — a
 * chatbot instance references one of these rows — so nothing here knows about sessions or WhatsApp.
 *
 * `apiKey` is write-only: it is stored plaintext (the gateway must present it verbatim as a bearer
 * token) and never returned by any route — the response carries `hasApiKey` and the masked tail
 * instead, the same posture as the webhook `secret`.
 */
@Entity('ai_llm_models')
@Index('UQ_ai_llm_models_name', ['name'], { unique: true })
export class AiLlmModel {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: LLM_NAME_MAX_LENGTH })
  name!: string;

  /** OpenAI-compatible chat-completions base URL, e.g. `https://api.openai.com/v1`. */
  @Column({ type: 'varchar', length: LLM_ENDPOINT_MAX_LENGTH })
  endpointUrl!: string;

  /** Bearer token for the endpoint. Write-only; masked on read. */
  @Column({ type: 'varchar', length: LLM_API_KEY_MAX_LENGTH, default: '' })
  apiKey!: string;

  /** Model id the provider expects, e.g. `gpt-4o-mini` or `claude-sonnet-4-5`. */
  @Column({ type: 'varchar', length: 200, default: '' })
  model!: string;

  /**
   * Sampling parameters sent with each completion call. Only the fields the operator set are sent;
   * the provider defaults apply otherwise.
   */
  @Column({ type: jsonColumnType(), nullable: true })
  parameters!: {
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    /** Stop sequences (provider `stop`). */
    stop?: string[];
  } | null;

  /**
   * Extra HTTP headers sent with every completion call — provider tenancy headers, gateway
   * routing headers. Never returned by any route (same write-only posture as `apiKey`).
   */
  @Column({ type: jsonColumnType(), default: '{}' })
  headers!: Record<string, string>;

  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  /** Diagnostics of the last connection test (`POST .../test`). */
  @Column({ type: jsonColumnType(), nullable: true })
  lastStatus!: { ok: boolean; at: string; error?: string } | null;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  lastTestedAt!: Date | null;

  /**
   * Capabilities the provider proved during a connection test. `vision` is proven by answering a
   * tiny image-input completion; null means the model has not been tested with the current
   * endpoint/model id (a save re-probes).
   */
  @Column({ type: jsonColumnType(), nullable: true })
  capabilities!: { vision: boolean; at: string } | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
