import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Expose, plainToInstance } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { ToStrictBoolean, ToStrictNumber } from '../../../common/utils/strict-boolean';
import { MaxCodePoints } from '../../../common/validation/max-code-points';
import { NoNulCharacter } from '../../../common/validation/no-nul-character';
import { AiRagDocument, AiRagModel, AI_RAG_NAME_MAX_LENGTH } from '../entities/ai-rag-model.entity';

export const AI_RAG_SESSION_SCOPES = ['all', 'selected', 'none'] as const;

/** Cap on one extracted knowledge body stored per document row (2 MiB of text). */
export const AI_RAG_CONTENT_MAX_LENGTH = 2_000_000;

/** Per-RAG-model knowledge-entry cap: indexing is a per-model LLM walk, so the count is bounded. */
export const AI_RAG_DOCUMENTS_MAX = 100;

export class CreateAiRagModelDto {
  @ApiProperty({ description: 'Display name', example: 'Product FAQ', maxLength: AI_RAG_NAME_MAX_LENGTH })
  @IsString()
  @IsNotEmpty()
  @MaxCodePoints(AI_RAG_NAME_MAX_LENGTH)
  @NoNulCharacter()
  name!: string;

  @ApiPropertyOptional({
    description:
      'Where the model may be attached: `all` (every AI chatbot), `selected` (`sessionIds`), or `none` (detached)',
    enum: AI_RAG_SESSION_SCOPES,
    default: 'all',
  })
  @IsOptional()
  @IsIn(AI_RAG_SESSION_SCOPES)
  sessionScope?: (typeof AI_RAG_SESSION_SCOPES)[number];

  @ApiPropertyOptional({
    description: 'Session ids when `sessionScope` is `selected`',
    type: [String],
  })
  @IsOptional()
  @IsString({ each: true })
  sessionIds?: string[] | null;

  @ApiPropertyOptional({ description: 'Optional LLM used for the indexing/retrieval reasoning steps' })
  @IsOptional()
  @IsString()
  llmModelId?: string | null;

  @ApiPropertyOptional({ description: 'Retrieved leaf nodes per query (default 4, 1-10)', default: 4 })
  @IsOptional()
  @ToStrictNumber()
  @IsInt()
  @Min(1)
  @Max(10)
  topK?: number;

  @ApiPropertyOptional({ description: 'Max characters of retrieved text per reply (default 4000, 500-20000)', default: 4000 })
  @IsOptional()
  @ToStrictNumber()
  @IsInt()
  @Min(500)
  @Max(20_000)
  maxContextChars?: number;

  @ApiPropertyOptional({ description: 'Whether the model is usable', default: true })
  @IsOptional()
  @ToStrictBoolean()
  @IsBoolean()
  enabled?: boolean;
}

export class UpdateAiRagModelDto {
  @ApiPropertyOptional({ description: 'Display name', maxLength: AI_RAG_NAME_MAX_LENGTH })
  @ValidateIf((o: UpdateAiRagModelDto) => o.name !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxCodePoints(AI_RAG_NAME_MAX_LENGTH)
  @NoNulCharacter()
  name?: string;

  @ApiPropertyOptional({ description: 'Session scope of the model', enum: AI_RAG_SESSION_SCOPES })
  @ValidateIf((o: UpdateAiRagModelDto) => o.sessionScope !== undefined)
  @IsIn(AI_RAG_SESSION_SCOPES)
  sessionScope?: (typeof AI_RAG_SESSION_SCOPES)[number];

  @ApiPropertyOptional({ description: 'Session ids when `sessionScope` is `selected`' })
  @ValidateIf((o: UpdateAiRagModelDto) => o.sessionIds !== undefined)
  @IsString({ each: true })
  sessionIds?: string[] | null;

  @ApiPropertyOptional({ description: 'LLM for the reasoning steps; null falls back to the chatbot LLM', nullable: true })
  @ValidateIf((o: UpdateAiRagModelDto) => o.llmModelId !== undefined)
  @IsString()
  llmModelId?: string | null;

  @ApiPropertyOptional({ description: 'Retrieved leaf nodes per query (1-10)' })
  @ValidateIf((o: UpdateAiRagModelDto) => o.topK !== undefined)
  @ToStrictNumber()
  @IsInt()
  @Min(1)
  @Max(10)
  topK?: number;

  @ApiPropertyOptional({ description: 'Max characters of retrieved text per reply (500-20000)' })
  @ValidateIf((o: UpdateAiRagModelDto) => o.maxContextChars !== undefined)
  @ToStrictNumber()
  @IsInt()
  @Min(500)
  @Max(20_000)
  maxContextChars?: number;

  @ApiPropertyOptional({ description: 'Whether the model is usable' })
  @ValidateIf((o: UpdateAiRagModelDto) => o.enabled !== undefined)
  @ToStrictBoolean()
  @IsBoolean()
  enabled?: boolean;
}

export class CreateAiRagDocumentDto {
  @ApiProperty({
    description: 'Knowledge source: `text` (pasted words/information), `url` (one page), `site` (site crawl), `file` (upload)',
    enum: ['text', 'url', 'site', 'file'],
  })
  @IsIn(['text', 'url', 'site', 'file'])
  sourceType!: 'text' | 'url' | 'site' | 'file';

  @ApiPropertyOptional({ description: 'Entry title; defaults derived from the source when blank', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  @NoNulCharacter()
  title?: string | null;

  @ApiPropertyOptional({ description: 'Source URL for url/site entries', maxLength: 2048 })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  sourceUrl?: string;

  @ApiPropertyOptional({
    description: 'Knowledge body for text entries (or a paste-over of an extracted one)',
    maxLength: AI_RAG_CONTENT_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MaxLength(AI_RAG_CONTENT_MAX_LENGTH)
  @NoNulCharacter()
  content?: string;

  @ApiPropertyOptional({ description: 'Storage key of an uploaded file (file entries)' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  storageKey?: string;
}

export class UpdateAiRagDocumentDto {
  @ApiPropertyOptional({ description: 'Entry title', maxLength: 255 })
  @ValidateIf((o: UpdateAiRagDocumentDto) => o.title !== undefined)
  @IsString()
  @MaxLength(255)
  @NoNulCharacter()
  title?: string | null;

  @ApiPropertyOptional({ description: 'Source URL for url/site entries', maxLength: 2048 })
  @ValidateIf((o: UpdateAiRagDocumentDto) => o.sourceUrl !== undefined)
  @IsString()
  @MaxLength(2048)
  sourceUrl?: string;

  @ApiPropertyOptional({ description: 'Knowledge body', maxLength: AI_RAG_CONTENT_MAX_LENGTH })
  @ValidateIf((o: UpdateAiRagDocumentDto) => o.content !== undefined)
  @IsString()
  @MaxLength(AI_RAG_CONTENT_MAX_LENGTH)
  @NoNulCharacter()
  content?: string;
}

export class AiRagDocumentResponseDto {
  @Expose()
  @ApiProperty()
  id!: string;

  @Expose()
  @ApiProperty()
  ragModelId!: string;

  @Expose()
  @ApiProperty({ enum: ['text', 'url', 'site', 'file'] })
  sourceType!: 'text' | 'url' | 'site' | 'file';

  @Expose()
  @ApiPropertyOptional({ nullable: true })
  title!: string | null;

  @Expose()
  @ApiPropertyOptional({ nullable: true, description: 'Source URL (url/site/file entries)' })
  sourceUrl!: string | null;

  @Expose()
  @ApiProperty({
    description: 'Ingestion state: ready, pending (queued), processing (fetching) or failed',
    enum: ['ready', 'pending', 'processing', 'failed'],
  })
  status!: 'ready' | 'pending' | 'processing' | 'failed';

  @Expose()
  @ApiPropertyOptional({ nullable: true, description: 'Why the ingestion failed' })
  statusError!: string | null;

  @Expose()
  @ApiProperty({ description: 'Stored knowledge text (truncated preview for list views)' })
  contentPreview!: string | null;

  @Expose()
  @ApiProperty({ description: 'Total characters of stored knowledge text' })
  contentLength!: number;

  @Expose()
  @ApiPropertyOptional({ nullable: true })
  metadata!: Record<string, unknown> | null;

  @Expose()
  @ApiProperty()
  createdAt!: Date;

  @Expose()
  @ApiProperty()
  updatedAt!: Date;

  static fromEntity(entity: AiRagDocument): AiRagDocumentResponseDto {
    const dto = plainToInstance(AiRagDocumentResponseDto, entity, { excludeExtraneousValues: true });
    dto.contentPreview = entity.content ? entity.content.slice(0, 400) : null;
    dto.contentLength = entity.content ? entity.content.length : 0;
    return dto;
  }

  static fromEntities(entities: AiRagDocument[]): AiRagDocumentResponseDto[] {
    return entities.map(entity => AiRagDocumentResponseDto.fromEntity(entity));
  }
}

/** The PageIndex-style tree node shape stored inside `AiRagModel.index`. */
export class AiRagNodeDto {
  @ApiProperty()
  nodeId!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  summary!: string;

  @ApiPropertyOptional({ description: 'Raw source text; present on leaves only' })
  text?: string;

  @ApiPropertyOptional({ type: () => [AiRagNodeDto], nullable: true })
  nodes?: AiRagNodeDto[] | null;
}

export class AiRagModelResponseDto {
  @Expose()
  @ApiProperty()
  id!: string;

  @Expose()
  @ApiProperty()
  name!: string;

  @Expose()
  @ApiProperty({ enum: AI_RAG_SESSION_SCOPES })
  sessionScope!: (typeof AI_RAG_SESSION_SCOPES)[number];

  @Expose()
  @ApiProperty({ nullable: true, type: [String] })
  sessionIds!: string[] | null;

  @Expose()
  @ApiPropertyOptional({ nullable: true })
  llmModelId!: string | null;

  @Expose()
  @ApiProperty()
  enabled!: boolean;

  @Expose()
  @ApiProperty()
  topK!: number;

  @Expose()
  @ApiProperty()
  maxContextChars!: number;

  @Expose()
  @ApiProperty({ description: 'Whether a tree index has been built' })
  hasIndex!: boolean;

  @Expose()
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  indexedAt!: Date | null;

  @Expose()
  @ApiPropertyOptional({ nullable: true })
  lastIndexError!: string | null;

  @Expose()
  @ApiProperty({ description: 'Knowledge entry count' })
  documentCount!: number;

  @Expose()
  @ApiPropertyOptional({ type: AiRagNodeDto, nullable: true, description: 'Top level of the tree index (truncated summaries)' })
  indexPreview!: { docName: string; docDescription?: string; structure?: AiRagNodeDto[] } | null;

  @Expose()
  @ApiProperty()
  createdAt!: Date;

  @Expose()
  @ApiProperty()
  updatedAt!: Date;

  static fromEntity(entity: AiRagModel, documentCount = 0): AiRagModelResponseDto {
    const dto = plainToInstance(AiRagModelResponseDto, entity, { excludeExtraneousValues: true });
    dto.hasIndex = entity.index != null && entity.indexedAt != null;
    dto.documentCount = documentCount;
    if (entity.index && typeof entity.index === 'object') {
      const doc = entity.index as { docName?: string; docDescription?: string; structure?: unknown };
      // Summaries are long; a list view needs the shape, not the payload.
      dto.indexPreview = {
        docName: typeof doc.docName === 'string' ? doc.docName : entity.name,
        ...(typeof doc.docDescription === 'string' ? { docDescription: doc.docDescription } : {}),
        ...(Array.isArray(doc.structure) ? { structure: truncateNodes(doc.structure) } : {}),
      };
    } else {
      dto.indexPreview = null;
    }
    return dto;
  }

  static fromEntities(entities: Array<{ model: AiRagModel; documentCount: number }>): AiRagModelResponseDto[] {
    return entities.map(({ model, documentCount }) => AiRagModelResponseDto.fromEntity(model, documentCount));
  }
}

/** Cap every node summary to a readable preview, recursively. */
function truncateNodes(nodes: unknown[], depth = 0): AiRagNodeDto[] {
  return nodes.slice(0, 12).map(node => {
    const n = node as { nodeId?: string; title?: string; summary?: string; text?: string; nodes?: unknown[] };
    return {
      nodeId: typeof n.nodeId === 'string' ? n.nodeId : '',
      title: typeof n.title === 'string' ? n.title : '',
      summary: typeof n.summary === 'string' ? n.summary.slice(0, 280) : '',
      ...(depth >= 1 || !Array.isArray(n.nodes) ? {} : { nodes: truncateNodes(n.nodes, depth + 1) }),
    } as AiRagNodeDto;
  });
}

/** Request body of the knowledge (re)index run. */
export class IndexAiRagModelDto {}

/** Request body of the retrieval probe. */
export class QueryAiRagModelDto {
  @ApiProperty({ description: 'Question to retrieve knowledge for', maxLength: 4000 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  @NoNulCharacter()
  query!: string;
}

export class AiRagQueryResultDto {
  @ApiProperty({ description: 'The question, as answered from the index' })
  query!: string;

  @ApiProperty({ type: () => [AiRagNodeDto], description: 'Leaf nodes the reasoning walk selected, with their source text' })
  nodes!: AiRagNodeDto[];

  @ApiProperty({ description: 'Concatenated retrieval context actually injected into a chatbot reply' })
  context!: string;

  @ApiPropertyOptional({ description: 'Non-fatal retrieval notes (e.g. index missing)' })
  warnings?: string[];
}
