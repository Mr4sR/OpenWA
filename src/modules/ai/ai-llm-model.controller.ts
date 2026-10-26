import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentApiKey, RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKey, ApiKeyRole } from '../auth/entities/api-key.entity';
import { AiLlmModelsService } from './ai-llm-models.service';
import { AiLlmModelResponseDto, CreateAiLlmModelDto, UpdateAiLlmModelDto } from './dto/ai-llm-model.dto';

/**
 * LLM provider connections. A row holds a provider credential, so the write surface stays
 * ADMIN-only, but every row is tenant-owned: an account key reaches ONLY the models of its own
 * account; a NULL-account (platform/global) key reaches the unclaimed deployment-global rows.
 * `apiKey?.accountId ?? null` is the owning account, as on the session surface.
 */
@ApiTags('ai')
@Controller('ai/llm-models')
export class AiLlmModelController {
  constructor(private readonly models: AiLlmModelsService) {}

  @Post()
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Create an LLM provider connection owned by the calling key’s account' })
  @ApiResponse({ status: 201, description: 'Model created.', type: AiLlmModelResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid endpoint URL, or the model limit is reached.' })
  async create(@Body() dto: CreateAiLlmModelDto, @CurrentApiKey() apiKey?: ApiKey): Promise<AiLlmModelResponseDto> {
    return AiLlmModelResponseDto.fromEntity(await this.models.create(dto, apiKey?.accountId ?? null));
  }

  @Get()
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'List the LLM provider connections visible to the calling key' })
  @ApiResponse({ status: 200, description: 'The models.', type: [AiLlmModelResponseDto] })
  async findAll(@CurrentApiKey() apiKey?: ApiKey): Promise<AiLlmModelResponseDto[]> {
    return AiLlmModelResponseDto.fromEntities(await this.models.findAll(apiKey?.accountId ?? null));
  }

  @Get(':id')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Get one LLM provider connection' })
  @ApiParam({ name: 'id', description: 'Model ID' })
  @ApiResponse({ status: 200, description: 'The model.', type: AiLlmModelResponseDto })
  @ApiResponse({ status: 404, description: 'No such model (including a model of another account).' })
  async findOne(@Param('id') id: string, @CurrentApiKey() apiKey?: ApiKey): Promise<AiLlmModelResponseDto> {
    return AiLlmModelResponseDto.fromEntity(await this.models.findOne(id, apiKey?.accountId ?? null));
  }

  @Put(':id')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Update an LLM provider connection' })
  @ApiParam({ name: 'id', description: 'Model ID' })
  @ApiResponse({ status: 200, description: 'Updated model.', type: AiLlmModelResponseDto })
  @ApiResponse({ status: 404, description: 'No such model (including a model of another account).' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateAiLlmModelDto,
    @CurrentApiKey() apiKey?: ApiKey,
  ): Promise<AiLlmModelResponseDto> {
    return AiLlmModelResponseDto.fromEntity(await this.models.update(id, dto, apiKey?.accountId ?? null));
  }

  @Delete(':id')
  @RequireRole(ApiKeyRole.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an LLM provider connection' })
  @ApiParam({ name: 'id', description: 'Model ID' })
  @ApiResponse({ status: 204, description: 'Model deleted.' })
  @ApiResponse({ status: 404, description: 'No such model (including a model of another account).' })
  async remove(@Param('id') id: string, @CurrentApiKey() apiKey?: ApiKey): Promise<void> {
    await this.models.remove(id, apiKey?.accountId ?? null);
  }

  @Post(':id/test')
  @RequireRole(ApiKeyRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Test the connection and probe capabilities (one text completion + one image completion)',
  })
  @ApiParam({ name: 'id', description: 'Model ID' })
  @ApiResponse({ status: 200, description: 'The probe ran; `ok` and `capabilities` say what passed.' })
  @ApiResponse({ status: 404, description: 'No such model (including a model of another account).' })
  async test(@Param('id') id: string, @CurrentApiKey() apiKey?: ApiKey): Promise<{
    ok: boolean;
    answer: string;
    capabilities: { vision: boolean; at: string } | null;
  }> {
    const accountId = apiKey?.accountId ?? null;
    const model = await this.models.findOne(id, accountId);
    const result = await this.models.test(model);
    await this.models.recordStatus(
      id,
      {
        ok: result.ok,
        capabilities: result.capabilities ?? undefined,
        ...(result.ok ? {} : { error: result.answer }),
      },
      accountId,
    );
    return result;
  }
}
