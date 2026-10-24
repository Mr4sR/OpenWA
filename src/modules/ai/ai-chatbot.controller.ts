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
 * AI chatbots: ONE bot may serve MANY sessions; each session is served by AT MOST ONE bot. The
 * routes live flat under /api/ai/chatbots (a bot is no longer owned by a session), and the
 * ApiKeyGuard's session fence still scopes the views to the key's allowed sessions.
 */
@ApiTags('ai')
@Controller('ai/chatbots')
export class AiChatbotController {
  constructor(
    private readonly chatbots: AiChatbotService,
    private readonly llmModels: AiLlmModelsService,
    private readonly rag: AiRagService,
  ) {}

  @Post()
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Create a chatbot bound to one or many sessions' })
  @ApiResponse({ status: 201, description: 'Chatbot created.', type: AiChatbotResponseDto })
  @ApiResponse({
    status: 400,
    description: 'Unknown LLM/RAG model or session, invalid body, or a requested session is already served by another chatbot.',
  })
  async create(@Body() dto: CreateAiChatbotDto): Promise<AiChatbotResponseDto> {
    return AiChatbotResponseDto.fromEntity(await this.chatbots.create(dto));
  }

  @Get()
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'List chatbots (scoped to the key’s allowed sessions)' })
  @ApiQuery({ name: 'sessionId', required: false, description: 'Filter to bots serving this session' })
  @ApiResponse({ status: 200, description: 'Chatbots in creation order.', type: [AiChatbotResponseDto] })
  async findAll(@CurrentApiKey() apiKey?: ApiKey, @Query('sessionId') sessionId?: string): Promise<AiChatbotResponseDto[]> {
    const bots = await this.chatbots.findAllForSessions(apiKey?.allowedSessions ?? null);
    const filtered = sessionId ? bots.filter(bot => bot.sessionIds.includes(sessionId)) : bots;
    return AiChatbotResponseDto.fromEntities(filtered);
  }

  @Get(':chatbotId')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Get one chatbot' })
  @ApiParam({ name: 'chatbotId', description: 'Chatbot ID' })
  @ApiResponse({ status: 200, description: 'The chatbot.', type: AiChatbotResponseDto })
  @ApiResponse({ status: 404, description: 'No such chatbot.' })
  @ApiResponse({ status: 403, description: 'The bot serves no session this key may see.' })
  async findOne(@Param('chatbotId') chatbotId: string, @CurrentApiKey() apiKey?: ApiKey): Promise<AiChatbotResponseDto> {
    const bot = await this.chatbots.findOne(chatbotId);
    this.assertReadable(bot, apiKey);
    return AiChatbotResponseDto.fromEntity(bot);
  }

  @Put(':chatbotId')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Update a chatbot (sessions, model, persona, tools…)' })
  @ApiParam({ name: 'chatbotId', description: 'Chatbot ID' })
  @ApiResponse({ status: 200, description: 'Updated chatbot.', type: AiChatbotResponseDto })
  @ApiResponse({ status: 400, description: 'Unknown model/session, or a requested session is owned by another bot.' })
  @ApiResponse({ status: 404, description: 'No such chatbot.' })
  async update(
    @Param('chatbotId') chatbotId: string,
    @Body() dto: UpdateAiChatbotDto,
    @CurrentApiKey() apiKey?: ApiKey,
  ): Promise<AiChatbotResponseDto> {
    await this.assertWritable(chatbotId, apiKey);
    return AiChatbotResponseDto.fromEntity(await this.chatbots.update(chatbotId, dto));
  }

  @Delete(':chatbotId')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a chatbot' })
  @ApiParam({ name: 'chatbotId', description: 'Chatbot ID' })
  @ApiResponse({ status: 204, description: 'Chatbot deleted.' })
  @ApiResponse({ status: 404, description: 'No such chatbot.' })
  async remove(@Param('chatbotId') chatbotId: string, @CurrentApiKey() apiKey?: ApiKey): Promise<void> {
    await this.assertWritable(chatbotId, apiKey);
    await this.chatbots.remove(chatbotId);
  }

  /**
   * The AI Integration playground: one production-shaped reply for a pasted message, without
   * sending anything. OPERATOR like the CRU(D) around it; the session fence scopes the id.
   */
  @Post(':chatbotId/test')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Produce one playground answer for a message without sending it' })
  @ApiParam({ name: 'chatbotId', description: 'Chatbot ID' })
  @ApiQuery({ name: 'sessionId', required: false, description: 'History source session; defaults to the bot’s first' })
  @ApiResponse({ status: 200, description: 'The answer the bot would send, with RAG citations.', type: AiChatbotTestResponseDto })
  @ApiResponse({ status: 400, description: 'Empty message, or the bot failed to answer (the reason is in the response).' })
  @ApiResponse({ status: 404, description: 'No such chatbot.' })
  async test(
    @Param('chatbotId') chatbotId: string,
    @Body() dto: AiChatbotTestDto,
    @CurrentApiKey() apiKey?: ApiKey,
    @Query('sessionId') sessionId?: string,
  ): Promise<AiChatbotTestResponseDto> {
    const bot = await this.chatbots.findOne(chatbotId);
    this.assertReadable(bot, apiKey);
    const probeSession = sessionId && bot.sessionIds.includes(sessionId) ? sessionId : bot.sessionIds[0];
    try {
      const result = await this.chatbots.previewReply(bot, dto.message, probeSession);
      void this.chatbots.auditTest(bot);
      return AiChatbotTestResponseDto.ok(result);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new BadRequestException(detail.slice(0, 300));
    }
  }

  /** A bot is readable when any of its sessions is inside the key's session fence. */
  private assertReadable(bot: { sessionIds: string[] }, apiKey?: ApiKey): void {
    const allowed = apiKey?.allowedSessions ?? null;
    if (allowed != null && !bot.sessionIds.some(sessionId => allowed.includes(sessionId))) {
      throw new NotFoundException(`Chatbot not found`);
    }
  }

  /** Writable has the same fence as readable, resolved through the stored bot. */
  private async assertWritable(chatbotId: string, apiKey?: ApiKey): Promise<void> {
    const bot = await this.chatbots.findOne(chatbotId);
    this.assertReadable(bot, apiKey);
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
    const bots = await this.chatbots.findAllForSessions(allowed);
    if (!sessionId) return AiChatbotResponseDto.fromEntities(bots);
    if (allowed != null && allowed.length > 0 && !allowed.includes(sessionId)) return [];
    return AiChatbotResponseDto.fromEntities(bots.filter(bot => bot.sessionIds.includes(sessionId)));
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
    await this.chatbots.setChatOverride(undefined, dto.chatbotId, dto.chatId, dto.chatbotDisabled);
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
