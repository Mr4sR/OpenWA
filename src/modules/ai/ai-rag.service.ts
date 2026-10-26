import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { createLogger } from '../../common/services/logger.service';
import { withSafeFetch, redactSsrfError } from '../../common/security/ssrf-guard';
import { StorageService } from '../../common/storage/storage.service';
import { AiLlmModel } from './entities/ai-llm-model.entity';
import { AiRagDocument, AiRagModel } from './entities/ai-rag-model.entity';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { AiLlmModelsService, LLM_REQUEST_TIMEOUT_MS } from './ai-llm-models.service';

// ── PageIndex-style vectorless RAG ──────────────────────────────────────────────────────────────
//
// The knowledge of a RAG model is a list of documents (pasted text, fetched URLs, uploaded files).
// "Indexing" builds ONE hierarchical tree over the concatenated knowledge, PageIndex-style:
//
//   1. SEGMENT  — the raw text is split into pages (≈2000 chars at paragraph boundaries) the way a
//                 PDF indexer produces pages; every page becomes a leaf with its source text.
//   2. TREE     — consecutive pages are grouped into sections (≈6 leaves), sections into chapters,
//                 until one root remains. No LLM needed for the shape itself.
//   3. SUMMARIZE— an LLM writes a short summary per node (bottom-up). The summaries are what the
//                 retrieval walk reads; the leaves also keep their raw `text`.
//
// "Retrieval" answers a question with LLM REASONING over the tree instead of an embedding search:
// starting at the root, the model is shown the summaries of the current node's children and picks
// the branches worth following; the leaves it reaches are the cited context. No vectors, no
// chunk-size tuning, and every answer traces to explicit nodes.
//
// Walls that keep this bounded: one index build runs at most this many completion calls
// (`MAX_SUMMARY_CALLS`),/tree depth is capped, and a build with no reachable LLM fails with a
// clear error instead of index-less silence.

/** Characters of one leaf (a "page") of source text. */
const LEAF_CHAR_TARGET = 2000;
/** Leaves grouped under one intermediate node. */
const BRANCHING_FACTOR = 6;
/** Depth guard: taller trees cost a completion call per level per walk. */
const MAX_TREE_DEPTH = 4;
/** Upper bound on completion calls one index build may spend. */
const MAX_SUMMARY_CALLS = 120;
/** Summary length target per node, in characters. */
const SUMMARY_CHAR_TARGET = 600;
/** Completion-call ceiling of one retrieval walk (root-to-leaf reasoning steps). */
const MAX_WALK_CALLS = 4;

interface RagNode {
  nodeId: string;
  title: string;
  summary: string;
  /** Raw source text; present on leaves only. */
  text?: string;
  nodes?: RagNode[] | null;
}

interface RagIndex {
  docName: string;
  docDescription: string;
  structure: RagNode[];
}

export interface RetrieveOptions {
  /** The chatbot's LLM, used when the RAG model names none of its own. */
  fallbackLlm?: AiLlmModel;
}

export interface RetrievalResult {
  nodes: Array<RagNode & { sourceTitle?: string }>;
  context: string;
  warnings: string[];
}

/**
 * Vectorless RAG models: CRUD for the model + its knowledge entries, the PageIndex-style
 * index build, and the reasoning-based retrieval the chatbots consult.
 */
@Injectable()
export class AiRagService {
  private readonly logger = createLogger('AiRagService');

  constructor(
    @InjectRepository(AiRagModel, 'data')
    private readonly repository: Repository<AiRagModel>,
    @InjectRepository(AiRagDocument, 'data')
    private readonly documentsRepository: Repository<AiRagDocument>,
    private readonly llmModels: AiLlmModelsService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    @Optional()
    private readonly moduleRef?: ModuleRef,
  ) {}

  // ── Model CRUD ────────────────────────────────────────────────────────────────────────────────

  /**
   * Create a knowledge base owned by `accountId` (NULL = the platform/global surface). A named LLM
   * must be visible to the SAME account, so a tenant cannot bind another tenant's brain.
   */
  async createModel(
    input: {
      name: string;
      sessionScope: string;
      sessionIds: string[] | null;
      llmModelId: string | null;
      topK: number;
      maxContextChars: number;
      enabled: boolean;
    },
    accountId: string | null = null,
  ): Promise<AiRagModel> {
    await this.assertLlmRef(input.llmModelId, accountId);
    const model = this.repository.create({
      accountId,
      name: input.name,
      sessionScope: input.sessionScope as AiRagModel['sessionScope'],
      sessionIds: input.sessionScope === 'selected' ? (input.sessionIds ?? []) : null,
      llmModelId: input.llmModelId,
      topK: input.topK,
      maxContextChars: input.maxContextChars,
      enabled: input.enabled,
    });
    const saved = await this.repository.save(model);
    void this.audit.logInfo(AuditAction.AI_RAG_MODEL_CREATED, {
      metadata: { ragModelId: saved.id, ragModelName: saved.name, accountId },
    });
    return saved;
  }

  async findModels(accountId: string | null = null): Promise<Array<{ model: AiRagModel; documentCount: number }>> {
    const models = await this.repository.find({
      where: accountId === null ? { accountId: IsNull() } : { accountId },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
    const counts = await this.documentsRepository
      .createQueryBuilder('doc')
      .select('doc.ragModelId', 'ragModelId')
      .addSelect('COUNT(doc.id)', 'count')
      .where(accountId === null ? 'doc.accountId IS NULL' : 'doc.accountId = :accountId', accountId === null ? {} : { accountId })
      .groupBy('doc.ragModelId')
      .getRawMany<{ ragModelId: string; count: string }>();
    const byModel = new Map(counts.map(row => [row.ragModelId, Number(row.count)]));
    return models.map(model => ({ model, documentCount: byModel.get(model.id) ?? 0 }));
  }

  /** RAG models usable by the given session, inside ONE account surface (`accountId`). */
  async findModelsForSession(sessionId: string, accountId: string | null = null): Promise<AiRagModel[]> {
    const models = await this.repository.find({
      where: { enabled: true, ...(accountId === null ? { accountId: IsNull() } : { accountId }) },
    });
    return models.filter(
      model => model.sessionScope === 'all' || (model.sessionIds ?? []).includes(sessionId),
    );
  }

  /**
   * One model, visible only to its owner: another account's row is a NotFound, so a tenant cannot
   * even confirm a foreign knowledge base exists. NULL (global) key sees NULL rows only.
   */
  async findModel(id: string, accountId: string | null = null): Promise<AiRagModel> {
    const model = await this.repository.findOne({
      where: accountId === null ? { id, accountId: IsNull() } : { id, accountId },
    });
    if (!model) throw new NotFoundException(`RAG model ${id} not found`);
    return model;
  }

  async updateModel(
    id: string,
    accountId: string | null,
    patch: Partial<Pick<AiRagModel, 'name' | 'sessionScope' | 'sessionIds' | 'llmModelId' | 'topK' | 'maxContextChars' | 'enabled'>>,
  ): Promise<AiRagModel> {
    const model = await this.findModel(id, accountId);
    if (patch.name !== undefined) model.name = patch.name;
    if (patch.sessionScope !== undefined) {
      model.sessionScope = patch.sessionScope;
      if (patch.sessionScope !== 'selected') model.sessionIds = null;
    }
    if (patch.sessionIds !== undefined) model.sessionIds = patch.sessionIds;
    if (patch.llmModelId !== undefined) {
      await this.assertLlmRef(patch.llmModelId, accountId);
      model.llmModelId = patch.llmModelId;
    }
    if (patch.topK !== undefined) model.topK = patch.topK;
    if (patch.maxContextChars !== undefined) model.maxContextChars = patch.maxContextChars;
    if (patch.enabled !== undefined) model.enabled = patch.enabled;
    const saved = await this.repository.save(model);
    void this.audit.logInfo(AuditAction.AI_RAG_MODEL_UPDATED, {
      metadata: { ragModelId: saved.id, ragModelName: saved.name, accountId },
    });
    return saved;
  }

  async removeModel(id: string, accountId: string | null = null): Promise<void> {
    const model = await this.findModel(id, accountId);
    await this.repository.remove(model);
    void this.audit.logInfo(AuditAction.AI_RAG_MODEL_DELETED, {
      metadata: { ragModelId: id, ragModelName: model.name },
    });
  }

  // ── Knowledge entries ─────────────────────────────────────────────────────────────────────────

  async findDocuments(ragModelId: string, accountId: string | null = null): Promise<AiRagDocument[]> {
    await this.assertModel(ragModelId, accountId);
    return this.documentsRepository.find({ where: { ragModelId }, order: { createdAt: 'ASC', id: 'ASC' } });
  }

  async createDocument(
    ragModelId: string,
    accountId: string | null,
    input: { sourceType: string; title: string | null; sourceUrl: string | null; content: string | null; storageKey: string | null },
  ): Promise<AiRagDocument> {
    // The parent model is resolved inside the caller's surface first: a foreign model id is a 404.
    const model = await this.findModel(ragModelId, accountId);
    const sourceType = input.sourceType as AiRagDocument['sourceType'];
    // A text entry is its own content and becomes ready immediately. A url/site/file entry is
    // ingested in the BACKGROUND — the row lands right away as `pending` (the dashboard shows the
    // badge and polls), so a slow site never wedges the HTTP request that adds it.
    const needsIngestion = sourceType !== 'text';
    if (sourceType === 'text' && !input.content?.trim()) {
      throw new BadRequestException('A text entry requires content');
    }
    if ((sourceType === 'url' || sourceType === 'site') && !input.sourceUrl) {
      throw new BadRequestException('A url/site entry requires sourceUrl');
    }
    if (sourceType === 'file' && !input.storageKey && !input.content) {
      throw new BadRequestException('A file entry requires storageKey or content');
    }
    const document = await this.documentsRepository.save(
      this.documentsRepository.create({
        // The entry belongs to whoever owns the model it was added to (NULL stays global).
        accountId: model.accountId,
        ragModelId,
        sourceType,
        title: input.title?.trim() || null,
        sourceUrl: input.sourceUrl ?? null,
        content: input.content ?? null,
        storageKey: input.storageKey ?? null,
        status: needsIngestion ? 'pending' : 'ready',
        metadata: needsIngestion ? null : { contentLength: input.content?.length ?? 0 },
      }),
    );
    if (needsIngestion) {
      // Fire-and-forget: the row is already stored as pending; any failure is recorded on the
      // row (status=failed + statusError) instead of failing the HTTP add.
      void this.ingestDocument(document.id).catch(() => undefined);
    }
    void this.audit.logInfo(AuditAction.AI_RAG_DOCUMENT_CREATED, {
      metadata: { ragModelId, ragDocumentId: document.id, sourceType, accountId },
    });
    return document;
  }

  /**
   * The background half of an async knowledge add: fetch/extract the text and mark the row ready,
   * or mark it failed with the reason. Runs outside the request that created the row.
   */
  private async ingestDocument(documentId: string): Promise<void> {
    const document = await this.documentsRepository.findOne({ where: { id: documentId } });
    if (!document) return;
    document.status = 'processing';
    await this.documentsRepository.save(document);
    try {
      let content: string | null = null;
      if (document.sourceType === 'url' || document.sourceType === 'site') {
        content = await this.fetchUrlText(document.sourceUrl!);
      } else if (document.sourceType === 'file') {
        content = document.content ?? (document.storageKey ? await this.readStoredFile(document.storageKey) : null);
      }
      if (!content?.trim()) throw new Error('no text could be extracted from the source');
      document.content = content;
      document.status = 'ready';
      document.statusError = null;
      document.metadata = {
        ...(document.metadata ?? {}),
        contentLength: content.length,
        ingestedAt: new Date().toISOString(),
      };
      await this.documentsRepository.save(document);
    } catch (error) {
      document.status = 'failed';
      document.statusError = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      await this.documentsRepository.save(document).catch(() => undefined);
    }
  }

  async updateDocument(
    ragModelId: string,
    documentId: string,
    accountId: string | null,
    patch: { title?: string | null; content?: string; sourceUrl?: string },
  ): Promise<AiRagDocument> {
    // The parent model check IS the tenant fence: a 404 before the document is even looked up.
    await this.assertModel(ragModelId, accountId);
    const document = await this.documentsRepository.findOne({ where: { id: documentId, ragModelId } });
    if (!document) throw new NotFoundException(`RAG document ${documentId} not found`);
    if (patch.title !== undefined) document.title = patch.title?.trim() || null;
    if (patch.sourceUrl !== undefined) document.sourceUrl = patch.sourceUrl;
    if (patch.content !== undefined) {
      document.content = patch.content;
      document.metadata = { ...(document.metadata ?? {}), contentLength: patch.content.length };
    }
    const saved = await this.documentsRepository.save(document);
    void this.audit.logInfo(AuditAction.AI_RAG_DOCUMENT_UPDATED, {
      metadata: { ragModelId, ragDocumentId: documentId, accountId },
    });
    return saved;
  }

  async removeDocument(ragModelId: string, documentId: string, accountId: string | null): Promise<void> {
    // The parent model check IS the tenant fence: a 404 before the document is even looked up.
    await this.assertModel(ragModelId, accountId);
    const document = await this.documentsRepository.findOne({ where: { id: documentId, ragModelId } });
    if (!document) throw new NotFoundException(`RAG document ${documentId} not found`);
    await this.documentsRepository.remove(document);
    void this.audit.logInfo(AuditAction.AI_RAG_DOCUMENT_DELETED, {
      metadata: { ragModelId, ragDocumentId: documentId, accountId },
    });
  }


  /**
   * Build (or rebuild) the knowledge tree. Requires at least one knowledge entry and a reachable
   * LLM (the model's own or the fallback). The previous index is kept until the new one commits,
   * so a failed rebuild never leaves the model worse than it was.
   */
  async indexModel(ragModelId: string, accountId: string | null = null, fallbackLlm?: AiLlmModel): Promise<AiRagModel> {
    const model = await this.findModel(ragModelId, accountId);
    const documents = await this.documentsRepository.find({ where: { ragModelId }, order: { createdAt: 'ASC', id: 'ASC' } });
    if (documents.length === 0) {
      throw new BadRequestException('Add knowledge before indexing');
    }
    const llm = await this.resolveLlm(model, fallbackLlm);

    // 1 + 2 — segment into leaves, group into a tree.
    const leaves = this.buildLeaves(documents);
    const structure = this.groupLeaves(leaves);

    // 3 — summaries, bottom-up, bounded.
    let calls = 0;
    try {
      await this.summarizeTree(structure, llm, () => ++calls <= MAX_SUMMARY_CALLS);
    } catch (error) {
      const detail = redactSsrfError(error).slice(0, 500);
      await this.repository.update({ id: model.id }, { lastIndexError: detail });
      // NestJS turns a bare Error into an empty "Internal server error" 500; the operator reads the
      // failure from this card's lastIndexError anyway, and a 400 keeps the real message on the wire.
      throw new BadRequestException(`Indexing failed: ${detail}`);
    }

    const index: RagIndex = {
      docName: model.name,
      docDescription: `Knowledge base of ${documents.length} source(s) for ${model.name}.`,
      structure,
    };
    model.index = index as unknown as Record<string, unknown>;
    model.indexedAt = new Date();
    model.lastIndexError = null;
    const saved = await this.repository.save(model);
    void this.audit.logInfo(AuditAction.AI_RAG_MODEL_INDEXED, {
      metadata: { ragModelId: saved.id, ragModelName: saved.name, documentCount: documents.length },
    });
    return saved;
  }

  /** Every document becomes (a) leaf page(s); titles carry through so citations can name them. */
  private buildLeaves(documents: AiRagDocument[]): RagNode[] {
    const leaves: RagNode[] = [];
    let counter = 0;
    for (const document of documents) {
      const text = (document.content ?? '').trim();
      if (!text) continue;
      const sourceTitle = document.title ?? document.sourceUrl ?? document.sourceType;
      const pages = segmentPages(text, LEAF_CHAR_TARGET);
      pages.forEach((page, pageIndex) => {
        leaves.push({
          nodeId: `doc${counter++}`,
          title: pages.length > 1 ? `${sourceTitle} (part ${pageIndex + 1}/${pages.length})` : sourceTitle,
          summary: '',
          text: page,
        });
      });
    }
    return leaves;
  }

  /** Group leaves into a balanced-ish tree of `BRANCHING_FACTOR`; leaves keep their text. */
  private groupLeaves(leaves: RagNode[]): RagNode[] {
    if (leaves.length <= BRANCHING_FACTOR) return leaves;
    let level = leaves;
    let depth = 0;
    while (level.length > BRANCHING_FACTOR && depth < MAX_TREE_DEPTH) {
      const next: RagNode[] = [];
      for (let i = 0; i < level.length; i += BRANCHING_FACTOR) {
        next.push({
          nodeId: `grp${next.length}`,
          title: '',
          summary: '',
          nodes: level.slice(i, i + BRANCHING_FACTOR),
        });
      }
      level = next;
      depth += 1;
    }
    return level;
  }

  /** Summarize every node bottom-up; leaves summarize their own text. */
  private async summarizeTree(nodes: RagNode[], llm: AiLlmModel, budget: () => boolean): Promise<void> {
    for (const node of nodes) {
      if (node.nodes?.length) {
        await this.summarizeTree(node.nodes, llm, budget);
      }
      if (!budget()) {
        throw new Error(`the index exceeded the summary budget of ${MAX_SUMMARY_CALLS} LLM calls`);
      }
      const childSummary = node.nodes?.length
        ? node.nodes.map(child => `- ${child.title}: ${firstSentence(child.summary)}`).join('\n')
        : '';
      const prompt = node.nodes?.length
        ? `These are section summaries of a knowledge base. Write one concise summary (max ${SUMMARY_CHAR_TARGET} characters) of what this section covers:\n${childSummary}`
        : `Summarize this knowledge excerpt in max ${SUMMARY_CHAR_TARGET} characters, keeping the key facts:\n${(node.text ?? '').slice(0, LEAF_CHAR_TARGET)}`;
      node.summary = (await this.llmModels.complete(llm, [{ role: 'user', content: prompt }]))
        .trim()
        .slice(0, SUMMARY_CHAR_TARGET * 2);
      if (!node.title) node.title = firstSentence(node.summary) || node.nodeId;
    }
  }

  /** The model's own LLM, else the fallback, else a clear failure. */
  private async resolveLlm(model: AiRagModel, fallbackLlm?: AiLlmModel): Promise<AiLlmModel> {
    if (model.llmModelId) {
      // The LLM entity lives on the same data connection, so the manager resolves it without a
      // second injected repository.
      const found = await this.repository.manager.getRepository(AiLlmModel).findOne({
        where: { id: model.llmModelId },
      });
      if (found) return found;
    }
    if (fallbackLlm) return fallbackLlm;
    throw new BadRequestException('The RAG model has no LLM of its own and the caller provides none');
  }

  /**
   * Answer a question from the index: walk the tree with the LLM, collect the leaves it reaches,
   * return their raw text. Pure function of (model, question) — no session state.
   */
  async retrieve(
    ragModelId: string,
    query: string,
    options: RetrieveOptions = {},
    accountId: string | null = null,
  ): Promise<RetrievalResult> {
    const model = await this.findModel(ragModelId, accountId);
    const warnings: string[] = [];
    if (!model.enabled) {
      return { nodes: [], context: '', warnings: ['the RAG model is disabled'] };
    }
    if (!model.index || !model.indexedAt) {
      return { nodes: [], context: '', warnings: ['the RAG model has no index yet; run the index build'] };
    }
    const llm = await this.resolveLlm(model, options.fallbackLlm);
    const structure = ((model.index as unknown as RagIndex).structure ?? []) as RagNode[];
    if (structure.length === 0) {
      return { nodes: [], context: '', warnings: ['the index is empty'] };
    }

    const picked: RagNode[] = [];
    let level: RagNode[] = structure;
    for (let depth = 0; depth <= MAX_TREE_DEPTH && level.length > 0; depth += 1) {
      const atLeaves = level.every(node => !node.nodes?.length);
      const chosen = level.length === 1 ? [level[0]] : await this.pickBranches(llm, query, level, model.topK);
      if (chosen.length === 0) {
        warnings.push('the reasoning walk found nothing relevant at this level');
        break;
      }
      if (atLeaves) {
        picked.push(...chosen);
        break;
      }
      level = chosen.flatMap(node => node.nodes ?? []);
      if (depth === MAX_TREE_DEPTH) {
        // Depth guard hit on an internal level: take the summaries of what we reached instead of
        // nothing, so a slightly-too-tall tree still answers.
        picked.push(...chosen);
        warnings.push('the walk reached the depth cap; section summaries are used as context');
      }
    }

    let budget = 0;
    const contextParts: string[] = [];
    for (const node of picked) {
      const text = node.text ?? node.summary;
      if (!text) continue;
      if (budget >= model.maxContextChars) break;
      const slice = text.slice(0, model.maxContextChars - budget);
      budget += slice.length;
      contextParts.push(`[${node.title}]\n${slice}`);
    }
    return {
      nodes: picked.map(node => ({ ...node })),
      context: contextParts.join('\n\n'),
      warnings,
    };
  }

  /** One reasoning step: which of these branches can answer the question? */
  private async pickBranches(llm: AiLlmModel, query: string, candidates: RagNode[], topK: number): Promise<RagNode[]> {
    if (candidates.length <= topK) return candidates;
    const listing = candidates
      .map((node, i) => `${i + 1}. ${node.title || node.nodeId}: ${firstSentence(node.summary)}`)
      .join('\n');
    const answer = await this.llmModels.complete(llm, [
      {
        role: 'system',
        content:
          'You navigate a knowledge-base tree. Given a question and numbered sections, reply with ONLY the ' +
          `numbers (comma-separated, max ${topK}) of the sections that could contain the answer.`,
      },
      { role: 'user', content: `Question: ${query}\n\nSections:\n${listing}` },
    ]);
    const picks = new Set(
      (answer.match(/\d+/g) ?? [])
        .map(Number)
        .filter(n => n >= 1 && n <= candidates.length)
        .slice(0, topK),
    );
    if (picks.size === 0) return [];
    return candidates.filter((_, i) => picks.has(i + 1));
  }

  // ── Source fetching ───────────────────────────────────────────────────────────────────────────

  /** Fetch a URL and return its readable text (HTML tags stripped). */
  private async fetchUrlText(rawUrl: string): Promise<string> {
    let text: string;
    try {
      text = await withSafeFetch(
        rawUrl,
        { method: 'GET', signal: AbortSignal.timeout(LLM_REQUEST_TIMEOUT_MS) },
        async response => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const body = await response.text();
          return body;
        },
        { guard: process.env.WEBHOOK_SSRF_PROTECT !== 'false', followRedirects: true },
      );
    } catch (error) {
      throw new BadRequestException(`Fetching ${redactSsrfError(error).slice(0, 200)}`);
    }
    const extracted = htmlToText(text);
    if (!extracted.trim()) throw new BadRequestException('The URL returned no extractable text');
    return extracted.slice(0, 2_000_000);
  }

  /** Read a previously uploaded file from StorageService as text. */
  private async readStoredFile(storageKey: string): Promise<string> {
    let buffer: Buffer;
    try {
      buffer = await this.storage.getFile(storageKey);
    } catch (error) {
      throw new BadRequestException(
        `Reading the stored file failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`,
      );
    }
    const text = buffer.toString('utf8');
    if (!text.trim()) throw new BadRequestException('The stored file has no extractable text');
    return text.slice(0, 2_000_000);
  }

  /** Tenant-fenced existence check: the model must exist INSIDE the caller's account surface. */
  private async assertModel(ragModelId: string, accountId: string | null = null): Promise<void> {
    const where = accountId === null ? { id: ragModelId, accountId: IsNull() } : { id: ragModelId, accountId };
    if (!(await this.repository.exists({ where }))) {
      throw new NotFoundException(`RAG model ${ragModelId} not found`);
    }
  }

  /**
   * The referenced LLM must exist and be visible to the SAME account: a tenant RAG model cannot
   * bind another tenant's provider credential. A global model binds global rows only.
   */
  private async assertLlmRef(llmModelId: string | null, accountId: string | null): Promise<void> {
    if (!llmModelId) return;
    const where = accountId === null ? { id: llmModelId, accountId: IsNull() } : { id: llmModelId, accountId };
    const found = await this.repository.manager.getRepository(AiLlmModel).findOne({ where });
    if (!found) throw new NotFoundException(`LLM model ${llmModelId} not found`);
  }
}

/** Split text into ~target-char pages at paragraph boundaries. */
function segmentPages(text: string, target: number): string[] {
  if (text.length <= target) return [text];
  const paragraphs = text.split(/\n{2,}/);
  const pages: string[] = [];
  let current = '';
  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length + 2 > target) {
      pages.push(current.trim());
      current = '';
    }
    current += (current ? '\n\n' : '') + paragraph;
  }
  if (current.trim()) pages.push(current.trim());
  return pages;
}

function firstSentence(text: string): string {
  const idx = text.search(/[.!?](\s|$)/);
  return (idx > 0 ? text.slice(0, idx + 1) : text).slice(0, 160);
}

/** Minimal HTML → text: drop script/style, strip tags, collapse whitespace. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#?\w+;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
