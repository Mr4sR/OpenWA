import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Expose, plainToInstance } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
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
import { AiMcpConnection, AI_MCP_ENDPOINT_MAX_LENGTH, AI_MCP_NAME_MAX_LENGTH } from '../entities/ai-mcp-connection.entity';

export const AI_MCP_AUTH_KINDS = ['none', 'bearer', 'header'] as const;

/** The two client transports the MCP SDK ships: the modern Streamable HTTP and the legacy SSE. */
export const AI_MCP_TRANSPORTS = ['streamable-http', 'sse'] as const;

/** Bound for the bearer token / header value. */
export const AI_MCP_CREDENTIAL_MAX_LENGTH = 2048;

export class CreateAiMcpConnectionDto {
  @ApiProperty({ description: 'Display name', example: 'Internal tools', maxLength: AI_MCP_NAME_MAX_LENGTH })
  @IsString()
  @IsNotEmpty()
  @MaxCodePoints(AI_MCP_NAME_MAX_LENGTH)
  @NoNulCharacter()
  name!: string;

  @ApiProperty({
    description: 'MCP server endpoint (Streamable HTTP transport)',
    example: 'https://tools.example.com/mcp',
    maxLength: AI_MCP_ENDPOINT_MAX_LENGTH,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(AI_MCP_ENDPOINT_MAX_LENGTH)
  @NoNulCharacter()
  endpointUrl!: string;

  @ApiPropertyOptional({
    description:
      'Transport: `streamable-http` (the modern one) or `sse` (the legacy EventSource transport, for older servers)',
    enum: AI_MCP_TRANSPORTS,
    default: 'streamable-http',
  })
  @IsOptional()
  @IsIn(AI_MCP_TRANSPORTS)
  transport?: (typeof AI_MCP_TRANSPORTS)[number];

  @ApiPropertyOptional({
    description: 'Authentication: `none`, `bearer` (Authorization header) or `header` (custom header)',
    enum: AI_MCP_AUTH_KINDS,
    default: 'none',
  })
  @IsOptional()
  @IsIn(AI_MCP_AUTH_KINDS)
  authKind?: (typeof AI_MCP_AUTH_KINDS)[number];

  @ApiPropertyOptional({
    description: 'Header name used when `authKind` is `header`',
    example: 'X-API-Key',
    default: 'X-API-Key',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @NoNulCharacter()
  authHeader?: string;

  @ApiPropertyOptional({
    description: 'Bearer token or header value. Never returned; masked in every response.',
    maxLength: AI_MCP_CREDENTIAL_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MaxLength(AI_MCP_CREDENTIAL_MAX_LENGTH)
  @NoNulCharacter()
  authCredential?: string;

  @ApiPropertyOptional({ description: 'Extra HTTP headers on every MCP request' })
  @IsOptional()
  @IsObject()
  headers?: Record<string, string>;

  @ApiPropertyOptional({ description: 'Timeout of one MCP round trip in ms (default 30000, 1000-120000)' })
  @IsOptional()
  @ToStrictNumber()
  @IsInt()
  @Min(1000)
  @Max(120_000)
  timeoutMs?: number;

  @ApiPropertyOptional({ description: 'Whether the connection may be used', default: true })
  @IsOptional()
  @ToStrictBoolean()
  @IsBoolean()
  enabled?: boolean;
}

export class UpdateAiMcpConnectionDto {
  @ApiPropertyOptional({ description: 'Display name', maxLength: AI_MCP_NAME_MAX_LENGTH })
  @ValidateIf((o: UpdateAiMcpConnectionDto) => o.name !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxCodePoints(AI_MCP_NAME_MAX_LENGTH)
  @NoNulCharacter()
  name?: string;

  @ApiPropertyOptional({ description: 'MCP server endpoint', maxLength: AI_MCP_ENDPOINT_MAX_LENGTH })
  @ValidateIf((o: UpdateAiMcpConnectionDto) => o.endpointUrl !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxLength(AI_MCP_ENDPOINT_MAX_LENGTH)
  @NoNulCharacter()
  endpointUrl?: string;

  @ApiPropertyOptional({ description: 'Transport', enum: AI_MCP_TRANSPORTS })
  @ValidateIf((o: UpdateAiMcpConnectionDto) => o.transport !== undefined)
  @IsIn(AI_MCP_TRANSPORTS)
  transport?: (typeof AI_MCP_TRANSPORTS)[number];

  @ApiPropertyOptional({ description: 'Authentication kind', enum: AI_MCP_AUTH_KINDS })
  @ValidateIf((o: UpdateAiMcpConnectionDto) => o.authKind !== undefined)
  @IsIn(AI_MCP_AUTH_KINDS)
  authKind?: (typeof AI_MCP_AUTH_KINDS)[number];

  @ApiPropertyOptional({ description: 'Header name for `authKind: header`', maxLength: 100 })
  @ValidateIf((o: UpdateAiMcpConnectionDto) => o.authHeader !== undefined)
  @IsString()
  @MaxLength(100)
  @NoNulCharacter()
  authHeader?: string;

  @ApiPropertyOptional({
    description: 'New credential. Omit to keep the stored one; an empty string removes it.',
    maxLength: AI_MCP_CREDENTIAL_MAX_LENGTH,
  })
  @ValidateIf((o: UpdateAiMcpConnectionDto) => o.authCredential !== undefined)
  @IsString()
  @MaxLength(AI_MCP_CREDENTIAL_MAX_LENGTH)
  @NoNulCharacter()
  authCredential?: string;

  @ApiPropertyOptional({ description: 'Extra HTTP headers; replaces the stored map' })
  @ValidateIf((o: UpdateAiMcpConnectionDto) => o.headers !== undefined)
  @IsObject()
  headers?: Record<string, string>;

  @ApiPropertyOptional({ description: 'Timeout of one MCP round trip in ms (1000-120000)' })
  @ValidateIf((o: UpdateAiMcpConnectionDto) => o.timeoutMs !== undefined)
  @ToStrictNumber()
  @IsInt()
  @Min(1000)
  @Max(120_000)
  timeoutMs?: number;

  @ApiPropertyOptional({ description: 'Whether the connection may be used' })
  @ValidateIf((o: UpdateAiMcpConnectionDto) => o.enabled !== undefined)
  @ToStrictBoolean()
  @IsBoolean()
  enabled?: boolean;
}

/**
 * The public shape of an MCP connection row. The credential and the header map are write-only: the
 * response carries `hasCredential` and the masked tail only.
 */
export class AiMcpConnectionResponseDto {
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
  @ApiProperty({ enum: AI_MCP_TRANSPORTS })
  transport!: (typeof AI_MCP_TRANSPORTS)[number];

  @Expose()
  @ApiProperty({ enum: AI_MCP_AUTH_KINDS })
  authKind!: (typeof AI_MCP_AUTH_KINDS)[number];

  @Expose()
  @ApiProperty()
  authHeader!: string;

  @Expose()
  @ApiProperty({ description: 'Whether a credential is stored' })
  hasCredential!: boolean;

  @Expose()
  @ApiProperty({ description: 'Stored credential, masked', nullable: true })
  authCredentialMasked!: string | null;

  @Expose()
  @ApiProperty({ description: 'Whether custom headers are stored (values are never returned)' })
  hasHeaders!: boolean;

  @Expose()
  @ApiProperty()
  timeoutMs!: number;

  @Expose()
  @ApiProperty()
  enabled!: boolean;

  @Expose()
  @ApiPropertyOptional({ nullable: true })
  lastStatus!: {
    ok: boolean;
    at: string;
    serverName?: string;
    serverVersion?: string;
    toolCount?: number;
    error?: string;
  } | null;

  @Expose()
  @ApiProperty()
  createdAt!: Date;

  @Expose()
  @ApiProperty()
  updatedAt!: Date;

  static fromEntity(entity: AiMcpConnection): AiMcpConnectionResponseDto {
    const dto = plainToInstance(AiMcpConnectionResponseDto, entity, { excludeExtraneousValues: true });
    dto.hasCredential = entity.authCredential.length > 0;
    dto.authCredentialMasked = entity.authCredential ? maskMcpCredential(entity.authCredential) : null;
    dto.hasHeaders = Object.keys(entity.headers ?? {}).length > 0;
    return dto;
  }

  static fromEntities(entities: AiMcpConnection[]): AiMcpConnectionResponseDto[] {
    return entities.map(entity => AiMcpConnectionResponseDto.fromEntity(entity));
  }
}

function maskMcpCredential(credential: string): string {
  if (credential.length <= 8) return '••••••••';
  return `${credential.slice(0, 4)}…${credential.slice(-4)}`;
}
