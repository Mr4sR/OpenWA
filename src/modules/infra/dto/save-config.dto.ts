import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Min, ValidateNested } from 'class-validator';
import { ToStrictBoolean, ToStrictNumber } from '../../../common/utils/strict-boolean';

/**
 * Body for PUT /infra/config (saveConfig). Every section is optional: an absent section leaves the
 * stored keys for that section untouched, and within a section an absent field leaves its stored
 * key untouched — a partial payload only changes what it explicitly carries.
 *
 * Booleans use @ToStrictBoolean (and poolSize @ToStrictNumber) because the global ValidationPipe
 * runs with enableImplicitConversion: a form-encoded body delivers scalars as strings, and
 * class-transformer's implicit cast turns ANY non-empty string — including 'false' — into `true`
 * before @IsBoolean() ever runs. Without the strict transform, saving the Infrastructure form
 * URL-encoded would persist 'true' for every unchecked toggle. Only 'true'/'false'/real booleans
 * are accepted; any other spelling is rejected 400.
 */
export class DatabaseConfigDto {
  @ApiProperty({ enum: ['sqlite', 'postgres'] })
  @IsIn(['sqlite', 'postgres'])
  type!: 'sqlite' | 'postgres';

  @ApiPropertyOptional()
  @ToStrictBoolean()
  @IsOptional()
  @IsBoolean()
  builtIn?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  host?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  port?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  username?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  password?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  database?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  schema?: string;

  @ApiPropertyOptional()
  @ToStrictNumber()
  @IsOptional()
  @IsNumber()
  poolSize?: number;

  @ApiPropertyOptional()
  @ToStrictBoolean()
  @IsOptional()
  @IsBoolean()
  sslEnabled?: boolean;

  @ApiPropertyOptional()
  @ToStrictBoolean()
  @IsOptional()
  @IsBoolean()
  sslRejectUnauthorized?: boolean;
}

export class RedisConfigDto {
  @ApiPropertyOptional()
  @ToStrictBoolean()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional()
  @ToStrictBoolean()
  @IsOptional()
  @IsBoolean()
  builtIn?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  host?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  port?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  password?: string;
}

export class QueueConfigDto {
  @ApiPropertyOptional()
  @ToStrictBoolean()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class StorageConfigDto {
  @ApiProperty({ enum: ['local', 's3'] })
  @IsIn(['local', 's3'])
  type!: 'local' | 's3';

  @ApiPropertyOptional()
  @ToStrictBoolean()
  @IsOptional()
  @IsBoolean()
  builtIn?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  localPath?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  s3Bucket?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  s3Region?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  s3AccessKey?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  s3SecretKey?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  s3Endpoint?: string;
}

export class EngineConfigDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  type?: string;

  @ApiPropertyOptional()
  @ToStrictBoolean()
  @IsOptional()
  @IsBoolean()
  headless?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  sessionDataPath?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  browserArgs?: string;
}

/**
 * AI Integration settings. The per-model configuration (LLM connections, chatbots, RAG knowledge,
 * MCP servers) lives in its own tables and its own dashboard page; what belongs HERE is the
 * deployment-level switch and the resource caps, because both are read at BOOT (the MCP server
 * module is mounted or not by a flag) and are therefore env-shaped like every other infra setting.
 */
export class AiConfigDto {
  @ApiPropertyOptional({
    description: 'Expose the OpenWA MCP server (agent tool server) at POST /mcp',
  })
  @ToStrictBoolean()
  @IsOptional()
  @IsBoolean()
  mcpEnabled?: boolean;

  @ApiPropertyOptional({
    description: 'Serve only read-only MCP tools (no sends, no mutations)',
  })
  @ToStrictBoolean()
  @IsOptional()
  @IsBoolean()
  mcpReadonly?: boolean;

  @ApiPropertyOptional({ description: 'Max LLM provider connections' })
  @ToStrictNumber()
  @IsOptional()
  @IsInt()
  @Min(0)
  llmModelsMax?: number;

  @ApiPropertyOptional({ description: 'Max outbound MCP server connections' })
  @ToStrictNumber()
  @IsOptional()
  @IsInt()
  @Min(0)
  mcpConnectionsMax?: number;

  @ApiPropertyOptional({
    description:
      'Allow outbound AI calls to private/loopback addresses (a self-hosted Ollama or vLLM on the same network). Off by default: the SSRF guard blocks them.',
  })
  @ToStrictBoolean()
  @IsOptional()
  @IsBoolean()
  allowPrivateAiEndpoints?: boolean;
}

export class SaveConfigDto {
  @ApiPropertyOptional({ type: () => DatabaseConfigDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => DatabaseConfigDto)
  database?: DatabaseConfigDto;

  @ApiPropertyOptional({ type: () => RedisConfigDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => RedisConfigDto)
  redis?: RedisConfigDto;

  @ApiPropertyOptional({ type: () => QueueConfigDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => QueueConfigDto)
  queue?: QueueConfigDto;

  @ApiPropertyOptional({ type: () => StorageConfigDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => StorageConfigDto)
  storage?: StorageConfigDto;

  @ApiPropertyOptional({ type: () => EngineConfigDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => EngineConfigDto)
  engine?: EngineConfigDto;

  @ApiPropertyOptional({ type: () => AiConfigDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => AiConfigDto)
  ai?: AiConfigDto;
}
