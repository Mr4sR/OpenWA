import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { DateTransformer } from '../../../common/transformers/date.transformer';
import { dateColumnType, jsonColumnType } from '../../../common/utils/column-types';

/** Longest display name. */
export const AI_RAG_NAME_MAX_LENGTH = 100;

/**
 * Session-activation scope values. `'all'` binds the model to every session that has an AI chatbot;
 * `'selected'` restricts it to the ids in `sessionIds`.
 */
export type AiRagSessionScope = 'all' | 'selected' | 'none';

/**
 * One vectorless RAG model (PageIndex-style): a named collection of knowledge entries that are
 * indexed into a hierarchical tree and retrieved by LLM reasoning over that tree — no embeddings,
 * no vector store.
 *
 * Knowledge arrives as flat text notes, pasted documents, fetched URLs or uploaded files; the
 * indexer pages/sections the text, asks the linked LLM for per-node summaries, and stores the tree
 * as JSON on the row itself (`index`). Retrieval walks the tree with the chatbot's LLM, then
 * returns the raw source text of the winning nodes as citations.
 */
@Entity('ai_rag_models')
@Index('UQ_ai_rag_models_name', ['name'], { unique: true })
export class AiRagModel {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * The tenant owning this knowledge base — the account of the key that created it (stamped on
   * create). NULL for pre-SaaS rows: global, reachable by a NULL-account (platform) key only.
   * Its knowledge entries inherit the owner at create time (the migration backfills the copy).
   */
  @Index('IDX_ai_rag_models_accountId')
  @Column({ type: 'varchar', length: 36, nullable: true })
  accountId!: string | null;

  @Column({ type: 'varchar', length: AI_RAG_NAME_MAX_LENGTH })
  name!: string;

  /** When the knowledge may be attached to chatbots: every session, selected ones, or none. */
  @Column({ type: 'varchar', length: 10, default: 'all' })
  sessionScope!: AiRagSessionScope;

  /** Session ids when `sessionScope === 'selected'`; ignored otherwise. */
  @Column({ type: 'simple-array', nullable: true })
  sessionIds!: string[] | null;

  /**
   * Optional FK to `ai_llm_models.id`. Overrides the calling chatbot's LLM for the retrieval
   * reasoning steps (tree walk) when set.
   */
  @Column({ type: 'varchar', length: 36, nullable: true })
  llmModelId!: string | null;

  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  /** Number of leaf nodes the retriever returns (the citation set). */
  @Column({ type: 'int', default: 4 })
  topK!: number;

  /** Max characters of retrieved source text injected into the reply prompt. */
  @Column({ type: 'int', default: 4000 })
  maxContextChars!: number;

  /**
   * The PageIndex-style tree: `{ docName, docDescription, structure: [...] }` — one entry per
   * knowledge document, nodes carrying `nodeId`, `title`, `summary`, `text` (the leaf's raw
   * source) and child `nodes`. Rebuilt on every index run; absent while never indexed.
   */
  @Column({ type: jsonColumnType(), nullable: true })
  index!: Record<string, unknown> | null;

  /** When the last successful (re)index finished; null while never indexed. */
  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  indexedAt!: Date | null;

  /** Redacted failure text of the last failed (re)index. */
  @Column({ type: 'text', nullable: true })
  lastIndexError!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

/** One knowledge entry of a RAG model, before indexing. */
@Entity('ai_rag_documents')
@Index('IDX_ai_rag_documents_ragModelId', ['ragModelId'])
export class AiRagDocument {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * The tenant owning this entry, copied from its RAG model at create (backfilled by migration
   * 1801000000000). NULL when the parent model is NULL: global, platform-key reachable.
   */
  @Index('IDX_ai_rag_documents_accountId')
  @Column({ type: 'varchar', length: 36, nullable: true })
  accountId!: string | null;

  /** FK to `ai_rag_models.id`. */
  @Column({ type: 'varchar', length: 36 })
  ragModelId!: string;

  /** `text` (words/information), `url` (one page, fetched), `site` (a handful of pages), `file` (upload). */
  @Column({ type: 'varchar', length: 10 })
  sourceType!: 'text' | 'url' | 'site' | 'file';

  /** Title the operator gave; defaults derived per source type when blank. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  title!: string | null;

  /** For url/site/file sources. Stored for re-fetch diagnostics; never returned raw by list routes. */
  @Column({ type: 'varchar', length: 2048, nullable: true })
  sourceUrl!: string | null;

  /** The knowledge body: pasted text, or extracted text for url/site/file sources. */
  @Column({ type: 'text', nullable: true })
  content!: string | null;

  /** Uploaded file's storage key (StorageService) for `file` entries. */
  @Column({ type: 'varchar', length: 512, nullable: true })
  storageKey!: string | null;

  /**
   * Ingestion state. A `url`/`site`/`file` entry is fetched and extracted in the BACKGROUND, so
   * the row lands as `pending` and the dashboard polls it until it reaches `ready` (or `failed`,
   * with the reason in `statusError`). A `text` entry is `ready` immediately.
   */
  @Column({ type: 'varchar', length: 12, default: 'ready' })
  status!: 'pending' | 'processing' | 'ready' | 'failed';

  /** Why the ingestion failed (fetch refused, extraction empty). */
  @Column({ type: 'text', nullable: true })
  statusError!: string | null;

  /** Extracted-text diagnostics: characters consumed into the index, fetch timestamp. */
  @Column({ type: jsonColumnType(), nullable: true })
  metadata!: Record<string, unknown> | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
