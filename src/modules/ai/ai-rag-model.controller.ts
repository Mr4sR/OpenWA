import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentApiKey, RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKey, ApiKeyRole } from '../auth/entities/api-key.entity';
import { AiRagService } from './ai-rag.service';
import {
  AiRagDocumentResponseDto,
  AiRagModelResponseDto,
  AiRagQueryResultDto,
  CreateAiRagDocumentDto,
  CreateAiRagModelDto,
  IndexAiRagModelDto,
  QueryAiRagModelDto,
  UpdateAiRagDocumentDto,
  UpdateAiRagModelDto,
} from './dto/ai-rag-model.dto';

/**
 * Vectorless RAG models (PageIndex-style): CRUD, knowledge entries, the index build and the
 * retrieval probe. Every row is tenant-owned: an account key reaches ONLY the models (and their
 * knowledge) of its own account; a NULL-account (platform/global) key reaches the unclaimed
 * deployment-global rows. `apiKey?.accountId ?? null` is the owning account, as on the session
 * surface.
 */
@ApiTags('ai')
@Controller('ai/rag-models')
export class AiRagModelController {
  constructor(private readonly rag: AiRagService) {}

  @Post()
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Create a RAG model (a named vectorless knowledge base) owned by the calling key’s account' })
  @ApiResponse({ status: 201, description: 'RAG model created.', type: AiRagModelResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid body, a sessionId outside the calling key scope, or a foreign LLM binding.' })
  async create(
    @Body() dto: CreateAiRagModelDto,
    @CurrentApiKey() apiKey?: ApiKey,
  ): Promise<AiRagModelResponseDto> {
    if (dto.sessionScope === 'selected') {
      assertSessionsInScope(apiKey?.allowedSessions, dto.sessionIds ?? []);
    }
    return AiRagModelResponseDto.fromEntity(
      await this.rag.createModel(
        {
          name: dto.name,
          sessionScope: dto.sessionScope ?? 'all',
          sessionIds: dto.sessionIds ?? null,
          llmModelId: dto.llmModelId ?? null,
          topK: dto.topK ?? 4,
          maxContextChars: dto.maxContextChars ?? 4000,
          enabled: dto.enabled ?? true,
        },
        apiKey?.accountId ?? null,
      ),
    );
  }

  @Get()
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'List the RAG models visible to the calling key (with knowledge counts)' })
  @ApiResponse({ status: 200, description: 'The RAG models.', type: [AiRagModelResponseDto] })
  async findAll(@CurrentApiKey() apiKey?: ApiKey): Promise<AiRagModelResponseDto[]> {
    return AiRagModelResponseDto.fromEntities(await this.rag.findModels(apiKey?.accountId ?? null));
  }

  @Get(':id')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Get one RAG model' })
  @ApiParam({ name: 'id', description: 'RAG model ID' })
  @ApiResponse({ status: 200, description: 'The RAG model.', type: AiRagModelResponseDto })
  @ApiResponse({ status: 404, description: 'No such RAG model (including one of another account).' })
  async findOne(@Param('id') id: string, @CurrentApiKey() apiKey?: ApiKey): Promise<AiRagModelResponseDto> {
    const accountId = apiKey?.accountId ?? null;
    const models = await this.rag.findModels(accountId);
    const found = models.find(entry => entry.model.id === id);
    if (!found) {
      // Distinguishes "exists but never indexed" from "not yours/not there" — both surface as 404
      // through the scoped read when the id is foreign or unknown.
      const model = await this.rag.findModel(id, accountId);
      return AiRagModelResponseDto.fromEntity(model);
    }
    return AiRagModelResponseDto.fromEntity(found.model, found.documentCount);
  }

  @Put(':id')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Update a RAG model (activation scope, retrieval tuning, LLM override)' })
  @ApiParam({ name: 'id', description: 'RAG model ID' })
  @ApiResponse({ status: 200, description: 'Updated RAG model.', type: AiRagModelResponseDto })
  @ApiResponse({ status: 404, description: 'No such RAG model (including one of another account).' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateAiRagModelDto,
    @CurrentApiKey() apiKey?: ApiKey,
  ): Promise<AiRagModelResponseDto> {
    if (dto.sessionIds != null) {
      assertSessionsInScope(apiKey?.allowedSessions, dto.sessionIds);
    }
    const model = await this.rag.updateModel(id, apiKey?.accountId ?? null, {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.sessionScope !== undefined ? { sessionScope: dto.sessionScope } : {}),
      ...(dto.sessionIds !== undefined ? { sessionIds: dto.sessionIds } : {}),
      ...(dto.llmModelId !== undefined ? { llmModelId: dto.llmModelId } : {}),
      ...(dto.topK !== undefined ? { topK: dto.topK } : {}),
      ...(dto.maxContextChars !== undefined ? { maxContextChars: dto.maxContextChars } : {}),
      ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
    });
    return AiRagModelResponseDto.fromEntity(model);
  }

  @Delete(':id')
  @RequireRole(ApiKeyRole.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a RAG model (its knowledge entries go with it)' })
  @ApiParam({ name: 'id', description: 'RAG model ID' })
  @ApiResponse({ status: 204, description: 'RAG model deleted.' })
  @ApiResponse({ status: 404, description: 'No such RAG model (including one of another account).' })
  async remove(@Param('id') id: string, @CurrentApiKey() apiKey?: ApiKey): Promise<void> {
    await this.rag.removeModel(id, apiKey?.accountId ?? null);
  }

  /** The index build: segments the knowledge, builds the tree, summarizes every node with the LLM. */
  @Post(':id/index')
  @RequireRole(ApiKeyRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Build (or rebuild) the PageIndex-style tree index. LLM-mediated; can take minutes on large knowledge.',
  })
  @ApiParam({ name: 'id', description: 'RAG model ID' })
  @ApiResponse({ status: 200, description: 'Index built.', type: AiRagModelResponseDto })
  @ApiResponse({ status: 400, description: 'No knowledge added, or the LLM call failed.' })
  @ApiResponse({ status: 404, description: 'No such RAG model (including one of another account).' })
  async index(
    @Param('id') id: string,
    @Body() _dto: IndexAiRagModelDto,
    @CurrentApiKey() apiKey?: ApiKey,
  ): Promise<AiRagModelResponseDto> {
    return AiRagModelResponseDto.fromEntity(await this.rag.indexModel(id, apiKey?.accountId ?? null));
  }

  /** The retrieval probe: walks the tree with the LLM and returns the cited nodes. */
  @Post(':id/query')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Retrieve knowledge for a question (the reasoning walk, without a reply)' })
  @ApiParam({ name: 'id', description: 'RAG model ID' })
  @ApiResponse({ status: 200, description: 'The cited nodes and the composed context.', type: AiRagQueryResultDto })
  @ApiResponse({ status: 400, description: 'Empty query.' })
  @ApiResponse({ status: 404, description: 'No such RAG model (including one of another account).' })
  async query(
    @Param('id') id: string,
    @Body() dto: QueryAiRagModelDto,
    @CurrentApiKey() apiKey?: ApiKey,
  ): Promise<AiRagQueryResultDto> {
    const result = await this.rag.retrieve(id, dto.query, {}, apiKey?.accountId ?? null);
    return {
      query: dto.query,
      nodes: result.nodes.map(node => ({
        nodeId: node.nodeId,
        title: node.title,
        summary: node.summary.slice(0, 400),
        ...(node.text ? { text: node.text.slice(0, 2000) } : {}),
      })),
      context: result.context,
      ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
    };
  }

  // ── knowledge entries ───────────────────────────────────────────────────────────────────────

  @Post(':id/documents')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Add a knowledge entry (text/url/site/file)' })
  @ApiParam({ name: 'id', description: 'RAG model ID' })
  @ApiResponse({ status: 201, description: 'Entry added.', type: AiRagDocumentResponseDto })
  @ApiResponse({ status: 400, description: 'Source fetch failed, or the entry has no content.' })
  @ApiResponse({ status: 404, description: 'No such RAG model (including one of another account).' })
  async addDocument(
    @Param('id') id: string,
    @Body() dto: CreateAiRagDocumentDto,
    @CurrentApiKey() apiKey?: ApiKey,
  ): Promise<AiRagDocumentResponseDto> {
    return AiRagDocumentResponseDto.fromEntity(
      await this.rag.createDocument(
        id,
        apiKey?.accountId ?? null,
        {
          sourceType: dto.sourceType,
          title: dto.title ?? null,
          sourceUrl: dto.sourceUrl ?? null,
          content: dto.content ?? null,
          storageKey: dto.storageKey ?? null,
        },
      ),
    );
  }

  @Get(':id/documents')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'List the knowledge entries of a RAG model' })
  @ApiParam({ name: 'id', description: 'RAG model ID' })
  @ApiResponse({ status: 200, description: 'The entries.', type: [AiRagDocumentResponseDto] })
  @ApiResponse({ status: 404, description: 'No such RAG model (including one of another account).' })
  async documents(@Param('id') id: string, @CurrentApiKey() apiKey?: ApiKey): Promise<AiRagDocumentResponseDto[]> {
    return AiRagDocumentResponseDto.fromEntities(await this.rag.findDocuments(id, apiKey?.accountId ?? null));
  }

  @Put(':id/documents/:documentId')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Update a knowledge entry (title/content/sourceUrl)' })
  @ApiParam({ name: 'id', description: 'RAG model ID' })
  @ApiParam({ name: 'documentId', description: 'Document ID' })
  @ApiResponse({ status: 200, description: 'Updated entry.', type: AiRagDocumentResponseDto })
  @ApiResponse({ status: 404, description: 'No such entry.' })
  async updateDocument(
    @Param('id') id: string,
    @Param('documentId') documentId: string,
    @Body() dto: UpdateAiRagDocumentDto,
    @CurrentApiKey() apiKey?: ApiKey,
  ): Promise<AiRagDocumentResponseDto> {
    return AiRagDocumentResponseDto.fromEntity(
      await this.rag.updateDocument(id, documentId, apiKey?.accountId ?? null, {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.content !== undefined ? { content: dto.content } : {}),
        ...(dto.sourceUrl !== undefined ? { sourceUrl: dto.sourceUrl } : {}),
      }),
    );
  }

  @Delete(':id/documents/:documentId')
  @RequireRole(ApiKeyRole.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a knowledge entry' })
  @ApiParam({ name: 'id', description: 'RAG model ID' })
  @ApiParam({ name: 'documentId', description: 'Document ID' })
  @ApiResponse({ status: 204, description: 'Entry deleted.' })
  @ApiResponse({ status: 404, description: 'No such entry.' })
  async removeDocument(
    @Param('id') id: string,
    @Param('documentId') documentId: string,
    @CurrentApiKey() apiKey?: ApiKey,
  ): Promise<void> {
    await this.rag.removeDocument(id, documentId, apiKey?.accountId ?? null);
  }
}

/**
 * The activation scope names the sessions the model may ride on. A session-restricted key must
 * not widen its own fence by binding a model to a session outside its allowlist (the same
 * body-scope fence the integration-instance provisioning route enforces via sessionScopeVisible).
 * An unrestricted key (null/empty allowlist) may name any session.
 */
function assertSessionsInScope(allowedSessions: string[] | null | undefined, requested: string[]): void {
  if (allowedSessions == null || allowedSessions.length === 0) return;
  const outside = requested.filter(id => !allowedSessions.includes(id));
  if (outside.length > 0) {
    throw new BadRequestException(
      `sessionId(s) outside this API key's session scope: ${outside.slice(0, 3).join(', ')}`,
    );
  }
}
