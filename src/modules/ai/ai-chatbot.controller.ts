import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RequireRole, CurrentApiKey } from '../auth/decorators/auth.decorators';
import { ApiKey, ApiKeyRole } from '../auth/entities/api-key.entity';
import { AiChatbotService } from './ai-chatbot.service';
import { AiLlmModelsService } from './ai-llm-models.service';
import { AiRagService } from './ai-rag.service';
import {
  AiChatbotResponseDto,
  AiChatStateDto,
  AiChatbotTestDto,
  AiChatbotTestResponseDto,
  CreateAiChatbotDto,
  SetAiChatOverrideDto,
  UpdateAiChatbotDto,
} from './dto/ai-chatbot.dto';
import { AiRagModelResponseDto } from './dto/ai-rag-model.dto';

/**
 * AI chatbots: one instance per (session, bot). The create/update/delete routes live under the
 * session they belong to, mirroring the webhook and automation-rule controllers, so the
 * ApiKeyGuard's session fence applies with no extra code.
 */
@ApiTags('ai')
@Controller('sessions/:sessionId/ai-chatbots')
export class AiChatbotController {
  constructor(
    private readonly chatbots: AiChatbotService,
    private readonly llmModels: AiLlmModelsService,
    private readonly rag: AiRagService,
  ) {}

  @Post()
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Create a chatbot for the session' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({ status: 201, description: 'Chatbot created.', type: AiChatbotResponseDto })
  @ApiResponse({
    status: 400,
    description: 'Unknown LLM/RAG model, invalid body, or the per-session chatbot limit is reached.',
  })
  @ApiResponse({ status: 404, description: 'No session with this id.' })
  async create(
    @Param('sessionId') sessionId: string,
    @Body() dto: CreateAiChatbotDto,
  ): Promise<AiChatbotResponseDto> {
    return AiChatbotResponseDto.fromEntity(await this.chatbots.create(sessionId, dto));
  }

  @Get()
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'List the session’s chatbots' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({ status: 200, description: 'Chatbots in creation order.', type: [AiChatbotResponseDto] })
  async findAll(@Param('sessionId') sessionId: string): Promise<AiChatbotResponseDto[]> {
    return AiChatbotResponseDto.fromEntities(await this.chatbots.findAll(sessionId));
  }

  @Get(':chatbotId')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Get one chatbot' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'chatbotId', description: 'Chatbot ID' })
  @ApiResponse({ status: 200, description: 'The chatbot.', type: AiChatbotResponseDto })
  @ApiResponse({ status: 404, description: 'No such chatbot in this session.' })
  async findOne(
    @Param('sessionId') sessionId: string,
    @Param('chatbotId') chatbotId: string,
  ): Promise<AiChatbotResponseDto> {
    return AiChatbotResponseDto.fromEntity(await this.chatbots.findOne(sessionId, chatbotId));
  }

  @Put(':chatbotId')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Update a chatbot' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'chatbotId', description: 'Chatbot ID' })
  @ApiResponse({ status: 200, description: 'Updated chatbot.', type: AiChatbotResponseDto })
  @ApiResponse({ status: 404, description: 'No such chatbot in this session.' })
  async update(
    @Param('sessionId') sessionId: string,
    @Param('chatbotId') chatbotId: string,
    @Body() dto: UpdateAiChatbotDto,
  ): Promise<AiChatbotResponseDto> {
    return AiChatbotResponseDto.fromEntity(await this.chatbots.update(sessionId, chatbotId, dto));
  }

  @Delete(':chatbotId')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a chatbot' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'chatbotId', description: 'Chatbot ID' })
  @ApiResponse({ status: 204, description: 'Chatbot deleted.' })
  @ApiResponse({ status: 404, description: 'No such chatbot in this session.' })
  async remove(@Param('sessionId') sessionId: string, @Param('chatbotId') chatbotId: string): Promise<void> {
    await this.chatbots.remove(sessionId, chatbotId);
  }

  /**
   * The AI Integration playground: one production-shaped reply for a pasted message, without
   * sending anything. OPERATOR like the CRU(D) around it; the session fence scopes the id.
   */
  @Post(':chatbotId/test')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Produce one playground answer for a message without sending it' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'chatbotId', description: 'Chatbot ID' })
  @ApiResponse({ status: 200, description: 'The answer the bot would send, with RAG citations.', type: AiChatbotTestResponseDto })
  @ApiResponse({ status: 400, description: 'Empty message, or the bot failed to answer (the reason is in the response).' })
  @ApiResponse({ status: 404, description: 'No such chatbot in this session.' })
  async test(
    @Param('sessionId') sessionId: string,
    @Param('chatbotId') chatbotId: string,
    @Body() dto: AiChatbotTestDto,
  ): Promise<AiChatbotTestResponseDto> {
    const chatbot = await this.chatbots.findOne(sessionId, chatbotId);
    try {
      const result = await this.chatbots.previewReply(chatbot, dto.message);
      void this.chatbots.auditTest(chatbot);
      return AiChatbotTestResponseDto.ok(result);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new BadRequestException(detail.slice(0, 300));
    }
  }
}

/**
 * Cross-session listing of chatbot instances (the AI Integration page shows every bot at once),
 * scoped to the calling key's `allowedSessions`, and the reference data the bot forms need.
 */
@ApiTags('ai')
@Controller('ai')
export class AiIntegrationController {
  constructor(
    private readonly chatbots: AiChatbotService,
    private readonly rag: AiRagService,
    private readonly llmModels: AiLlmModelsService,
  ) {}

  @Get('chatbots')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'List chatbots visible to the calling key (scoped to its allowed sessions)' })
  @ApiQuery({ name: 'sessionId', required: false, description: 'Filter to a single session' })
  @ApiResponse({ status: 200, description: 'Chatbots.', type: [AiChatbotResponseDto] })
  async chatbotsIndex(
    @CurrentApiKey() apiKey?: ApiKey,
    @Query('sessionId') sessionId?: string,
  ): Promise<AiChatbotResponseDto[]> {
    const allowed = apiKey?.allowedSessions ?? null;
    if (sessionId) {
      const visible = allowed == null || allowed.length === 0 || allowed.includes(sessionId);
      if (!visible) return [];
      return AiChatbotResponseDto.fromEntities(await this.chatbots.findAll(sessionId));
    }
    return AiChatbotResponseDto.fromEntities(await this.chatbots.findAllForSessions(allowed));
  }

  /**
   * The AI switches of one session's conversations, for the Chats page: which bots are switched
   * OFF per chat. Chats without an entry are ON (the bot's own `enabled` state governs them).
   */
  @Get('chat-states')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: "Per-chat AI switch state for the session's conversations (Chats page)" })
  @ApiQuery({ name: 'sessionId', required: true, description: 'Session ID' })
  @ApiQuery({ name: 'chatIds', required: true, description: 'Comma-separated chat ids to resolve' })
  @ApiResponse({ status: 200, description: 'Map of chatId -> chatbotIds switched OFF for that chat.' })
  async chatStates(
    @CurrentApiKey() apiKey?: ApiKey,
    @Query('sessionId') sessionId?: string,
    @Query('chatIds') chatIds?: string,
  ): Promise<{ overrides: Record<string, string[]> }> {
    if (!sessionId || !chatIds) return { overrides: {} };
    const allowed = apiKey?.allowedSessions ?? null;
    if (allowed != null && allowed.length > 0 && !allowed.includes(sessionId)) return { overrides: {} };
    const ids = chatIds
      .split(',')
      .map(c => c.trim())
      .filter(Boolean)
      .slice(0, 200);
    const map = await this.chatbots.getChatOverrides(sessionId, ids);
    const overrides: Record<string, string[]> = {};
    for (const [chatId, botIds] of map) overrides[chatId] = botIds;
    return { overrides };
  }

  /** Flip ONE (chatbot, chat) switch from the Chats page. The bot must be inside the caller's session fence. */
  @Post('chat-state')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Flip the per-chat AI switch of one chatbot for one conversation' })
  @ApiResponse({ status: 200, description: 'The switch was stored, or removed when enabling.', type: AiChatStateDto })
  @ApiResponse({ status: 404, description: 'No such chatbot.' })
  async setChatState(
    @Body() dto: SetAiChatOverrideDto,
    @CurrentApiKey() apiKey?: ApiKey,
  ): Promise<AiChatStateDto> {
    const chatbot = (await this.chatbots.findAllForSessions(apiKey?.allowedSessions ?? null)).find(
      candidate => candidate.id === dto.chatbotId,
    );
    if (!chatbot) throw new NotFoundException(`Chatbot ${dto.chatbotId} not found`);
    await this.chatbots.setChatOverride(chatbot.sessionId, dto.chatbotId, dto.chatId, dto.chatbotDisabled);
    return AiChatStateDto.fromRow({
      chatbotId: dto.chatbotId,
      chatId: dto.chatId,
      chatbotDisabled: dto.chatbotDisabled,
    });
  }

  @Get('rag-models')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'List the RAG models (with knowledge counts and index state)' })
  @ApiResponse({ status: 200, description: 'RAG models.', type: [AiRagModelResponseDto] })
  async ragIndex(): Promise<AiRagModelResponseDto[]> {
    return AiRagModelResponseDto.fromEntities(await this.rag.findModels());
  }
}
