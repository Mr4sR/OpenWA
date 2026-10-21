import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RequireRole, RequireUnscopedKey } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { AiLlmModelsService } from './ai-llm-models.service';
import { AiLlmModelResponseDto, CreateAiLlmModelDto, UpdateAiLlmModelDto } from './dto/ai-llm-model.dto';

/**
 * LLM provider connections. ADMIN-only: a row holds a provider credential, and every chatbot in
 * the gateway spends it. The chatbot instances themselves are OPERATOR-scoped (they only reference
 * a model by id).
 */
// Deployment-global (no session dimension): the guard's route-param session fence can never bite,
// so session-scoped keys are rejected outright at class level (the infra controllers' posture).
@RequireUnscopedKey()
@Controller('ai/llm-models')
export class AiLlmModelController {
  constructor(private readonly models: AiLlmModelsService) {}

  @Post()
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Create an LLM provider connection' })
  @ApiResponse({ status: 201, description: 'Model created.', type: AiLlmModelResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid endpoint URL, or the model limit is reached.' })
  async create(@Body() dto: CreateAiLlmModelDto): Promise<AiLlmModelResponseDto> {
    return AiLlmModelResponseDto.fromEntity(await this.models.create(dto));
  }

  @Get()
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'List the configured LLM provider connections' })
  @ApiResponse({ status: 200, description: 'The models.', type: [AiLlmModelResponseDto] })
  async findAll(): Promise<AiLlmModelResponseDto[]> {
    return AiLlmModelResponseDto.fromEntities(await this.models.findAll());
  }

  @Get(':id')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Get one LLM provider connection' })
  @ApiParam({ name: 'id', description: 'Model ID' })
  @ApiResponse({ status: 200, description: 'The model.', type: AiLlmModelResponseDto })
  @ApiResponse({ status: 404, description: 'No such model.' })
  async findOne(@Param('id') id: string): Promise<AiLlmModelResponseDto> {
    return AiLlmModelResponseDto.fromEntity(await this.models.findOne(id));
  }

  @Put(':id')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Update an LLM provider connection' })
  @ApiParam({ name: 'id', description: 'Model ID' })
  @ApiResponse({ status: 200, description: 'Updated model.', type: AiLlmModelResponseDto })
  @ApiResponse({ status: 404, description: 'No such model.' })
  async update(@Param('id') id: string, @Body() dto: UpdateAiLlmModelDto): Promise<AiLlmModelResponseDto> {
    return AiLlmModelResponseDto.fromEntity(await this.models.update(id, dto));
  }

  @Delete(':id')
  @RequireRole(ApiKeyRole.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an LLM provider connection' })
  @ApiParam({ name: 'id', description: 'Model ID' })
  @ApiResponse({ status: 204, description: 'Model deleted.' })
  @ApiResponse({ status: 404, description: 'No such model.' })
  async remove(@Param('id') id: string): Promise<void> {
    await this.models.remove(id);
  }

  @Post(':id/test')
  @RequireRole(ApiKeyRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Test the connection to the provider (one minimal completion)' })
  @ApiParam({ name: 'id', description: 'Model ID' })
  @ApiResponse({ status: 200, description: 'The provider answered.' })
  @ApiResponse({ status: 400, description: 'The provider refused the call.' })
  @ApiResponse({ status: 404, description: 'No such model.' })
  async test(@Param('id') id: string): Promise<{ ok: boolean; answer: string }> {
    const model = await this.models.findOne(id);
    try {
      const answer = await this.models.complete(model, [{ role: 'user', content: 'ping' }]);
      await this.models.recordStatus(id, { ok: true });
      return { ok: true, answer: answer.slice(0, 200) };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.models.recordStatus(id, { ok: false, error: detail.slice(0, 300) });
      return { ok: false, answer: detail.slice(0, 300) };
    }
  }
}
