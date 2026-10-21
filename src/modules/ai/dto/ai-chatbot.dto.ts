import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Expose, plainToInstance } from 'class-transformer';
import { IsArray, IsBoolean, IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { ToStrictBoolean, ToStrictNumber } from '../../../common/utils/strict-boolean';
import { MaxCodePoints } from '../../../common/validation/max-code-points';
import { NoNulCharacter } from '../../../common/validation/no-nul-character';
import { normalizeChatAllowList } from '../../../common/security/chat-scope';
import {
  AI_CHATBOT_NAME_MAX_LENGTH,
  AI_CHATBOT_REPLY_MAX_LENGTH,
  AiChatbot,
  CHATBOT_CONTEXT_MAX,
} from '../entities/ai-chatbot.entity';

export const AI_COOLDOWN_MAX_SECONDS = 86_400;

export class CreateAiChatbotDto {
  @ApiProperty({ description: 'Display name', example: 'Support bot', maxLength: AI_CHATBOT_NAME_MAX_LENGTH })
  @IsString()
  @IsNotEmpty()
  @MaxCodePoints(AI_CHATBOT_NAME_MAX_LENGTH)
  @NoNulCharacter()
  name!: string;

  @ApiProperty({ description: 'LLM model this chatbot answers with (`ai_llm_models.id`)' })
  @IsString()
  @IsNotEmpty()
  llmModelId!: string;

  @ApiPropertyOptional({ description: 'Optional RAG model whose knowledge rides along (`ai_rag_models.id`)' })
  @IsOptional()
  @IsString()
  ragModelId?: string | null;

  @ApiPropertyOptional({
    description: 'Persona for THIS bot; overrides the LLM model persona when set',
    maxLength: AI_CHATBOT_REPLY_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MaxCodePoints(AI_CHATBOT_REPLY_MAX_LENGTH)
  @NoNulCharacter()
  persona?: string | null;

  @ApiPropertyOptional({
    description:
      'Chat allowlist: only these chats of the session are answered (JIDs or bare phone numbers). Null/empty answers every chat.',
    example: ['628123456789@c.us'],
    type: [String],
    nullable: true,
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  chatIds?: string[] | null;

  @ApiPropertyOptional({
    description: 'Quiet period per chat, in seconds, after the bot answers (default 60, 0 disables)',
    default: 60,
    minimum: 0,
    maximum: AI_COOLDOWN_MAX_SECONDS,
  })
  @IsOptional()
  @ToStrictNumber()
  @IsInt()
  @Min(0)
  @Max(AI_COOLDOWN_MAX_SECONDS)
  cooldownSeconds?: number;

  @ApiPropertyOptional({
    description: 'Prior chat messages included as conversation history (default 8, 0-20)',
    default: 8,
    minimum: 0,
    maximum: CHATBOT_CONTEXT_MAX,
  })
  @IsOptional()
  @ToStrictNumber()
  @IsInt()
  @Min(0)
  @Max(CHATBOT_CONTEXT_MAX)
  contextMessages?: number;

  @ApiPropertyOptional({ description: 'Whether the bot is active', default: true })
  @IsOptional()
  @ToStrictBoolean()
  @IsBoolean()
  enabled?: boolean;
}

export class UpdateAiChatbotDto {
  @ApiPropertyOptional({ description: 'Display name', maxLength: AI_CHATBOT_NAME_MAX_LENGTH })
  @ValidateIf((o: UpdateAiChatbotDto) => o.name !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxCodePoints(AI_CHATBOT_NAME_MAX_LENGTH)
  @NoNulCharacter()
  name?: string;

  @ApiPropertyOptional({ description: 'LLM model to answer with' })
  @ValidateIf((o: UpdateAiChatbotDto) => o.llmModelId !== undefined)
  @IsString()
  @IsNotEmpty()
  llmModelId?: string;

  @ApiPropertyOptional({ description: 'RAG model to consult; null detaches', nullable: true })
  @ValidateIf((o: UpdateAiChatbotDto) => o.ragModelId !== undefined)
  @IsString()
  ragModelId?: string | null;

  @ApiPropertyOptional({ description: 'Persona; null falls back to the LLM model persona', nullable: true })
  @ValidateIf((o: UpdateAiChatbotDto) => o.persona !== undefined)
  @IsString()
  @MaxCodePoints(AI_CHATBOT_REPLY_MAX_LENGTH)
  @NoNulCharacter()
  persona?: string | null;

  @ApiPropertyOptional({ description: 'Chat allowlist; null/empty answers every chat', nullable: true })
  @ValidateIf((o: UpdateAiChatbotDto) => o.chatIds !== undefined)
  @IsArray()
  @IsString({ each: true })
  chatIds?: string[] | null;

  @ApiPropertyOptional({ description: 'Quiet period per chat in seconds', minimum: 0, maximum: AI_COOLDOWN_MAX_SECONDS })
  @ValidateIf((o: UpdateAiChatbotDto) => o.cooldownSeconds !== undefined)
  @ToStrictNumber()
  @IsInt()
  @Min(0)
  @Max(AI_COOLDOWN_MAX_SECONDS)
  cooldownSeconds?: number;

  @ApiPropertyOptional({ description: 'Conversation history length', minimum: 0, maximum: CHATBOT_CONTEXT_MAX })
  @ValidateIf((o: UpdateAiChatbotDto) => o.contextMessages !== undefined)
  @ToStrictNumber()
  @IsInt()
  @Min(0)
  @Max(CHATBOT_CONTEXT_MAX)
  contextMessages?: number;

  @ApiPropertyOptional({ description: 'Whether the bot is active' })
  @ValidateIf((o: UpdateAiChatbotDto) => o.enabled !== undefined)
  @ToStrictBoolean()
  @IsBoolean()
  enabled?: boolean;
}

export class AiChatbotResponseDto {
  @Expose()
  @ApiProperty()
  id!: string;

  @Expose()
  @ApiProperty()
  sessionId!: string;

  @Expose()
  @ApiProperty()
  name!: string;

  @Expose()
  @ApiProperty()
  llmModelId!: string;

  @Expose()
  @ApiPropertyOptional({ nullable: true })
  ragModelId!: string | null;

  @Expose()
  @ApiPropertyOptional({ nullable: true })
  persona!: string | null;

  @Expose()
  @ApiProperty({ nullable: true, type: [String] })
  chatIds!: string[] | null;

  @Expose()
  @ApiProperty()
  cooldownSeconds!: number;

  @Expose()
  @ApiProperty()
  contextMessages!: number;

  @Expose()
  @ApiProperty()
  enabled!: boolean;

  @Expose()
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  lastRepliedAt!: Date | null;

  @Expose()
  @ApiPropertyOptional({ nullable: true })
  lastError!: string | null;

  @Expose()
  @ApiProperty()
  createdAt!: Date;

  @Expose()
  @ApiProperty()
  updatedAt!: Date;

  static fromEntity(entity: AiChatbot): AiChatbotResponseDto {
    return plainToInstance(AiChatbotResponseDto, entity, { excludeExtraneousValues: true });
  }

  static fromEntities(entities: AiChatbot[]): AiChatbotResponseDto[] {
    return entities.map(entity => AiChatbotResponseDto.fromEntity(entity));
  }
}

/** Qualify bare numbers so a saved allowlist entry matches the chats it must answer. */
export function normalizeChatbotChatIds(list: string[] | null | undefined): string[] | null {
  return normalizeChatAllowList(list);
}
