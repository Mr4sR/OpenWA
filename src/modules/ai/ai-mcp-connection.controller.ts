import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentApiKey, RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKey, ApiKeyRole } from '../auth/entities/api-key.entity';
import { AiMcpConnectionsService } from './ai-mcp-connections.service';
import {
  AiMcpConnectionResponseDto,
  CreateAiMcpConnectionDto,
  UpdateAiMcpConnectionDto,
} from './dto/ai-mcp-connection.dto';

/**
 * Outbound MCP server connections. A row may hold a credential for an external server, so the write
 * surface stays ADMIN-only, but every row is tenant-owned: an account key reaches ONLY the
 * connections of its own account; a NULL-account (platform/global) key reaches the unclaimed
 * deployment-global rows. `apiKey?.accountId ?? null` is the owning account, as on the session
 * surface.
 */
@ApiTags('ai')
@Controller('ai/mcp-connections')
export class AiMcpConnectionController {
  constructor(private readonly connections: AiMcpConnectionsService) {}

  @Post()
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Create an MCP server connection owned by the calling key’s account' })
  @ApiResponse({ status: 201, description: 'Connection created.', type: AiMcpConnectionResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid endpoint URL, header name, or the connection limit is reached.' })
  async create(@Body() dto: CreateAiMcpConnectionDto, @CurrentApiKey() apiKey?: ApiKey): Promise<AiMcpConnectionResponseDto> {
    return AiMcpConnectionResponseDto.fromEntity(await this.connections.create(dto, apiKey?.accountId ?? null));
  }

  @Get()
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'List the MCP server connections visible to the calling key' })
  @ApiResponse({ status: 200, description: 'The connections.', type: [AiMcpConnectionResponseDto] })
  async findAll(@CurrentApiKey() apiKey?: ApiKey): Promise<AiMcpConnectionResponseDto[]> {
    return AiMcpConnectionResponseDto.fromEntities(await this.connections.findAll(apiKey?.accountId ?? null));
  }

  @Get(':id')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Get one MCP server connection' })
  @ApiParam({ name: 'id', description: 'Connection ID' })
  @ApiResponse({ status: 200, description: 'The connection.', type: AiMcpConnectionResponseDto })
  @ApiResponse({ status: 404, description: 'No such connection (including one of another account).' })
  async findOne(@Param('id') id: string, @CurrentApiKey() apiKey?: ApiKey): Promise<AiMcpConnectionResponseDto> {
    return AiMcpConnectionResponseDto.fromEntity(await this.connections.findOne(id, apiKey?.accountId ?? null));
  }

  @Put(':id')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Update an MCP server connection' })
  @ApiParam({ name: 'id', description: 'Connection ID' })
  @ApiResponse({ status: 200, description: 'Updated connection.', type: AiMcpConnectionResponseDto })
  @ApiResponse({ status: 404, description: 'No such connection (including one of another account).' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateAiMcpConnectionDto,
    @CurrentApiKey() apiKey?: ApiKey,
  ): Promise<AiMcpConnectionResponseDto> {
    return AiMcpConnectionResponseDto.fromEntity(await this.connections.update(id, dto, apiKey?.accountId ?? null));
  }

  @Delete(':id')
  @RequireRole(ApiKeyRole.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an MCP server connection' })
  @ApiParam({ name: 'id', description: 'Connection ID' })
  @ApiResponse({ status: 204, description: 'Connection deleted.' })
  @ApiResponse({ status: 404, description: 'No such connection (including one of another account).' })
  async remove(@Param('id') id: string, @CurrentApiKey() apiKey?: ApiKey): Promise<void> {
    await this.connections.remove(id, apiKey?.accountId ?? null);
  }

  @Post(':id/test')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Connect to the MCP server and list its tools (records the outcome as diagnostics)',
  })
  @ApiParam({ name: 'id', description: 'Connection ID' })
  @ApiResponse({ status: 200, description: 'Connected; the tool catalogue follows.' })
  @ApiResponse({ status: 400, description: 'The server refused the connection.' })
  @ApiResponse({ status: 404, description: 'No such connection (including one of another account).' })
  async test(
    @Param('id') id: string,
    @CurrentApiKey() apiKey?: ApiKey,
  ): Promise<{ ok: boolean; serverName?: string; serverVersion?: string; tools: Array<{ name: string; description?: string }>; error?: string }> {
    try {
      const result = await this.connections.test(id, apiKey?.accountId ?? null);
      return {
        ok: true,
        serverName: result.serverName,
        serverVersion: result.serverVersion,
        tools: result.tools.map(tool => ({ name: tool.name, description: tool.description })),
      };
    } catch (error) {
      return { ok: false, tools: [], error: (error instanceof Error ? error.message : String(error)).slice(0, 300) };
    }
  }

  @Get(':id/tools')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'List the tools the MCP server advertises (live call)' })
  @ApiParam({ name: 'id', description: 'Connection ID' })
  @ApiResponse({ status: 200, description: 'The tool catalogue.' })
  @ApiResponse({ status: 400, description: 'The server refused the connection.' })
  @ApiResponse({ status: 404, description: 'No such connection (including one of another account).' })
  async tools(
    @Param('id') id: string,
    @CurrentApiKey() apiKey?: ApiKey,
  ): Promise<{ tools: Array<{ name: string; description?: string }> }> {
    const tools = await this.connections.listTools(id, apiKey?.accountId ?? null);
    return { tools: tools.map(tool => ({ name: tool.name, description: tool.description })) };
  }
}
