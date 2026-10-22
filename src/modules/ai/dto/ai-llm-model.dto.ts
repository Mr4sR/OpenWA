import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Expose, plainToInstance } from 'class-transformer';
import {
  IsBoolean,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { ToStrictBoolean } from '../../../common/utils/strict-boolean';
import { MaxCodePoints } from '../../../common/validation/max-code-points';
import { NoNulCharacter } from '../../../common/validation/no-nul-character';
import {
  AiLlmModel,
  LLM_API_KEY_MAX_LENGTH,
  LLM_ENDPOINT_MAX_LENGTH,
  LLM_NAME_MAX_LENGTH,
  LLM_PERSONA_MAX_LENGTH,
} from '../entities/ai-llm-model.entity';
import { maskSecret } from '../ai-secrets';

export class CreateAiLlmModelDto {
  @ApiProperty({ description: 'Display name', example: 'OpenAI production', maxLength: LLM_NAME_MAX_LENGTH })
  @IsString()
  @IsNotEmpty()
  @MaxCodePoints(LLM_NAME_MAX_LENGTH)
  @NoNulCharacter()
  name!: string;

  @ApiProperty({
    description:
      'OpenAI-compatible chat-completions base URL. The `/chat/completions` suffix is appended to it, so the value ends at the API root (`https://api.openai.com/v1`).',
    example: 'https://api.openai.com/v1',
    maxLength: LLM_ENDPOINT_MAX_LENGTH,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(LLM_ENDPOINT_MAX_LENGTH)
  @NoNulCharacter()
  endpointUrl!: string;

  @ApiPropertyOptional({
    description: 'API key sent as `Authorization: Bearer …`. Never returned; masked in every response.',
    maxLength: LLM_API_KEY_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MaxCodePoints(LLM_API_KEY_MAX_LENGTH)
  @NoNulCharacter()
  apiKey?: string;

  @ApiPropertyOptional({ description: 'Model id at the provider', example: 'gpt-4o-mini', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @NoNulCharacter()
  model?: string;

  @ApiPropertyOptional({
    description:
      'Sampling parameters. Temperature defaults to 0.7 and maxTokens to 1024 when omitted (these are also the placeholders in the dashboard form).',
    example: { temperature: 0.7, maxTokens: 1024 },
  })
  @IsOptional()
  @IsObject()
  parameters?: {
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    stop?: string[];
  };

  @ApiPropertyOptional({ description: 'Extra HTTP headers on every completion call' })
  @IsOptional()
  @IsObject()
  headers?: Record<string, string>;

  @ApiPropertyOptional({ description: 'Whether the model may be used', default: true })
  @IsOptional()
  @ToStrictBoolean()
  @IsBoolean()
  enabled?: boolean;
}

export class UpdateAiLlmModelDto {
  @ApiPropertyOptional({ description: 'Display name', maxLength: LLM_NAME_MAX_LENGTH })
  @ValidateIf((o: UpdateAiLlmModelDto) => o.name !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxCodePoints(LLM_NAME_MAX_LENGTH)
  @NoNulCharacter()
  name?: string;

  @ApiPropertyOptional({
    description: 'OpenAI-compatible chat-completions base URL',
    maxLength: LLM_ENDPOINT_MAX_LENGTH,
  })
  @ValidateIf((o: UpdateAiLlmModelDto) => o.endpointUrl !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxLength(LLM_ENDPOINT_MAX_LENGTH)
  @NoNulCharacter()
  endpointUrl?: string;

  @ApiPropertyOptional({
    description: 'New API key. Omit to keep the stored one; an empty string removes it.',
    maxLength: LLM_API_KEY_MAX_LENGTH,
  })
  @ValidateIf((o: UpdateAiLlmModelDto) => o.apiKey !== undefined)
  @IsString()
  @MaxCodePoints(LLM_API_KEY_MAX_LENGTH)
  @NoNulCharacter()
  apiKey?: string;

  @ApiPropertyOptional({ description: 'Model id at the provider', maxLength: 200 })
  @ValidateIf((o: UpdateAiLlmModelDto) => o.model !== undefined)
  @IsString()
  @MaxLength(200)
  @NoNulCharacter()
  model?: string;

  @ApiPropertyOptional({ description: 'Sampling parameters; null clears them', nullable: true })
  @ValidateIf((o: UpdateAiLlmModelDto) => o.parameters !== undefined)
  @IsObject()
  parameters?: { temperature?: number; maxTokens?: number; topP?: number; stop?: string[] } | null;

  @ApiPropertyOptional({ description: 'Extra HTTP headers; replaces the stored map' })
  @ValidateIf((o: UpdateAiLlmModelDto) => o.headers !== undefined)
  @IsObject()
  headers?: Record<string, string>;

  @ApiPropertyOptional({ description: 'Whether the model may be used' })
  @ValidateIf((o: UpdateAiLlmModelDto) => o.enabled !== undefined)
  @ToStrictBoolean()
  @IsBoolean()
  enabled?: boolean;
}

/**
 * The public shape of an LLM model row. `apiKey` and `headers` are write-only: the api key is
 * masked to `apiKeyMasked` and the header map is reduced to the `hasHeaders` flag, so no route can
 * leak the credential that authenticates the provider.
 */
export class AiLlmModelResponseDto {
  @Expose()
  @ApiProperty()
  id!: string;

  @Expose()
  @ApiProperty()
  name!: string;

  @Expose()
  @ApiProperty()
  endpointUrl!: string;

  @Expose()
  @ApiProperty({ description: 'Whether an api key is stored' })
  hasApiKey!: boolean;

  @Expose()
  @ApiProperty({ description: 'Stored api key, masked', example: 'sk-p…3f2a', nullable: true })
  apiKeyMasked!: string | null;

  @Expose()
  @ApiProperty()
  model!: string;

  @Expose()
  @ApiPropertyOptional({ nullable: true })
  parameters!: { temperature?: number; maxTokens?: number; topP?: number; stop?: string[] } | null;

  @Expose()
  @ApiProperty({ description: 'Whether custom headers are stored (values are never returned)' })
  hasHeaders!: boolean;

  @Expose()
  @ApiProperty()
  enabled!: boolean;

  @Expose()
  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'When the connection was last tested',
  })
  lastTestedAt?: Date | null;

  @Expose()
  @ApiPropertyOptional({ nullable: true })
  lastStatus?: { ok: boolean; at: string; error?: string } | null;

  @Expose()
  @ApiProperty()
  createdAt!: Date;

  @Expose()
  @ApiProperty()
  updatedAt!: Date;

  static fromEntity(entity: AiLlmModel): AiLlmModelResponseDto {
    const dto = plainToInstance(AiLlmModelResponseDto, entity, { excludeExtraneousValues: true });
    dto.hasApiKey = entity.apiKey.length > 0;
    dto.apiKeyMasked = maskSecret(entity.apiKey);
    dto.hasHeaders = Object.keys(entity.headers ?? {}).length > 0;
    return dto;
  }

  static fromEntities(entities: AiLlmModel[]): AiLlmModelResponseDto[] {
    return entities.map(entity => AiLlmModelResponseDto.fromEntity(entity));
  }
}
