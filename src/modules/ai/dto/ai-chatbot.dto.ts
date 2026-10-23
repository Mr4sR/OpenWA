import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Expose, plainToInstance } from 'class-transformer';
import { IsBoolean, IsInt, IsNotEmpty, IsOptional, IsString, Max, Min, ValidateIf } from 'class-validator';
import { ToStrictBoolean, ToStrictNumber } from '../../../common/utils/strict-boolean';
import { MaxCodePoints } from '../../../common/validation/max-code-points';
import { NoNulCharacter } from '../../../common/validation/no-nul-character';
import {
  AI_CHATBOT_NAME_MAX_LENGTH,
  AI_CHATBOT_PERSONA_MAX_LENGTH,
  AI_CHATBOT_REPLY_MAX_LENGTH,
  AiChatbot,
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
    description:
      'The persona: the system prompt sent with every completion. Leave empty for a plain assistant. This is the ONLY persona — the LLM connection carries none.',
    maxLength: AI_CHATBOT_PERSONA_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MaxCodePoints(AI_CHATBOT_PERSONA_MAX_LENGTH)
  @NoNulCharacter()
  persona?: string | null;

  @ApiPropertyOptional({
    description:
      'Answer group chats too. Off by default: in a group the bot speaks in front of every member. Individual chats are always answered while the bot is enabled.',
    default: false,
  })
  @IsOptional()
  @ToStrictBoolean()
  @IsBoolean()
  replyGroups?: boolean;

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
  @ValidateIf((o: UpdateAiChatbotDto) => o.llmModelId !== undefined && o.llmModelId !== null)
  @IsString()
  @IsNotEmpty()
  llmModelId?: string | null;

  @ApiPropertyOptional({ description: 'RAG model to consult; null detaches', nullable: true })
  @ValidateIf((o: UpdateAiChatbotDto) => o.ragModelId !== undefined && o.ragModelId !== null)
  @IsString()
  ragModelId?: string | null;

  @ApiPropertyOptional({ description: 'The persona (system prompt); null or an empty string clears it', nullable: true })
  @ValidateIf((o: UpdateAiChatbotDto) => o.persona !== undefined && o.persona !== null)
  @IsString()
  @MaxCodePoints(AI_CHATBOT_PERSONA_MAX_LENGTH)
  @NoNulCharacter()
  persona?: string | null;

  @ApiPropertyOptional({ description: 'Answer group chats too', default: false })
  @ValidateIf((o: UpdateAiChatbotDto) => o.replyGroups !== undefined)
  @ToStrictBoolean()
  @IsBoolean()
  replyGroups?: boolean;

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
  @ApiProperty()
  replyGroups!: boolean;

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

/**
 * The per-chat switch the Chats page writes. `chatbotDisabled: true` means "this bot stays out of
 * this conversation", even though the bot itself is enabled for the session.
 */
export class SetAiChatOverrideDto {
  @ApiProperty({ description: 'The chatbot the switch belongs to (`ai_chatbots.id`)' })
  @IsString()
  @IsNotEmpty()
  chatbotId!: string;

  @ApiProperty({ description: 'The chat id exactly as the inbound path carries it' })
  @IsString()
  @IsNotEmpty()
  @MaxCodePoints(255)
  @NoNulCharacter()
  chatId!: string;

  @ApiProperty({ description: 'True = the bot stays silent in this chat', default: false })
  @ToStrictBoolean()
  @IsBoolean()
  chatbotDisabled!: boolean;
}

/** The state of one conversation for the Chats page: which bots answer it, and which do not. */
export class AiChatStateDto {
  @Expose()
  @ApiProperty()
  chatbotId!: string;

  @Expose()
  @ApiProperty()
  chatId!: string;

  @Expose()
  @ApiProperty({ description: 'True = the bot is switched off for this chat' })
  chatbotDisabled!: boolean;

  static fromRow(row: { chatbotId: string; chatId: string; chatbotDisabled: boolean }): AiChatStateDto {
    const dto = new AiChatStateDto();
    dto.chatbotId = row.chatbotId;
    dto.chatId = row.chatId;
    dto.chatbotDisabled = row.chatbotDisabled;
    return dto;
  }
}

/**
 * One Playground probe: the message the operator would type into a chat. Bounded by the same
 * cap the reply carries, so a probe cannot smuggle in a document-sized prompt.
 */
export class AiChatbotTestDto {
  @ApiProperty({ description: 'The message to answer, as if it arrived in a chat', maxLength: AI_CHATBOT_REPLY_MAX_LENGTH })
  @IsString()
  @IsNotEmpty()
  @MaxCodePoints(AI_CHATBOT_REPLY_MAX_LENGTH)
  @NoNulCharacter()
  message!: string;
}

/**
 * The Playground answer. `ok: false` is not expected on the wire (a failure is a 400 whose message
 * names the reason), but the shape stays explicit so a client can render both outcomes uniformly.
 */
export class AiChatbotTestResponseDto {
  @Expose()
  @ApiProperty()
  ok!: boolean;

  @Expose()
  @ApiProperty({ description: 'The reply the bot would send' })
  reply!: string;

  @Expose()
  @ApiProperty({ description: 'RAG nodes the reply stood on (titles only)', type: [String] })
  sources!: string[];

  @Expose()
  @ApiProperty({ description: 'RAG retrieval warnings, empty when the knowledge answered cleanly', type: [String] })
  warnings!: string[];

  static ok(result: { reply: string; sources: Array<{ title: string }>; warnings: string[] }): AiChatbotTestResponseDto {
    return plainToInstance(
      AiChatbotTestResponseDto,
      { ok: true, reply: result.reply, sources: result.sources.map(source => source.title), warnings: result.warnings },
      { excludeExtraneousValues: true },
    );
  }
}
