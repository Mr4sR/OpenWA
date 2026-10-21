import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RequireRole, RequireUnscopedKey } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { AiMcpConnectionsService } from './ai-mcp-connections.service';
import {
  AiMcpConnectionResponseDto,
  CreateAiMcpConnectionDto,
  UpdateAiMcpConnectionDto,
} from './dto/ai-mcp-connection.dto';

/**
 * Outbound MCP server connections. ADMIN-only like the LLM connections: a row may hold a
 * credential for an external server, and tool calls fan out to it.
 */
@ApiTags('ai')
// Deployment-global (no session dimension): the guard's route-param session fence can never bite,
// so session-scoped keys are rejected outright at class level (the infra controllers' posture).
@RequireUnscopedKey()
@Controller('ai/mcp-connections')
export class AiMcpConnectionController {
  constructor(private readonly connections: AiMcpConnectionsService) {}

  @Post()
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Create an MCP server connection' })
  @ApiResponse({ status: 201, description: 'Connection created.', type: AiMcpConnectionResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid endpoint URL, header name, or the connection limit is reached.' })
  async create(@Body() dto: CreateAiMcpConnectionDto): Promise<AiMcpConnectionResponseDto> {
    return AiMcpConnectionResponseDto.fromEntity(await this.connections.create(dto));
  }

  @Get()
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'List the configured MCP server connections' })
  @ApiResponse({ status: 200, description: 'The connections.', type: [AiMcpConnectionResponseDto] })
  async findAll(): Promise<AiMcpConnectionResponseDto[]> {
    return AiMcpConnectionResponseDto.fromEntities(await this.connections.findAll());
  }

  @Get(':id')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Get one MCP server connection' })
  @ApiParam({ name: 'id', description: 'Connection ID' })
  @ApiResponse({ status: 200, description: 'The connection.', type: AiMcpConnectionResponseDto })
  @ApiResponse({ status: 404, description: 'No such connection.' })
  async findOne(@Param('id') id: string): Promise<AiMcpConnectionResponseDto> {
    return AiMcpConnectionResponseDto.fromEntity(await this.connections.findOne(id));
  }

  @Put(':id')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Update an MCP server connection' })
  @ApiParam({ name: 'id', description: 'Connection ID' })
  @ApiResponse({ status: 200, description: 'Updated connection.', type: AiMcpConnectionResponseDto })
  @ApiResponse({ status: 404, description: 'No such connection.' })
  async update(@Param('id') id: string, @Body() dto: UpdateAiMcpConnectionDto): Promise<AiMcpConnectionResponseDto> {
    return AiMcpConnectionResponseDto.fromEntity(await this.connections.update(id, dto));
  }

  @Delete(':id')
  @RequireRole(ApiKeyRole.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an MCP server connection' })
  @ApiParam({ name: 'id', description: 'Connection ID' })
  @ApiResponse({ status: 204, description: 'Connection deleted.' })
  @ApiResponse({ status: 404, description: 'No such connection.' })
  async remove(@Param('id') id: string): Promise<void> {
    await this.connections.remove(id);
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
  @ApiResponse({ status: 404, description: 'No such connection.' })
  async test(
    @Param('id') id: string,
  ): Promise<{ ok: boolean; serverName?: string; serverVersion?: string; tools: Array<{ name: string; description?: string }>; error?: string }> {
    try {
      const result = await this.connections.test(id);
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
  @ApiResponse({ status: 404, description: 'No such connection.' })
  async tools(@Param('id') id: string): Promise<{ tools: Array<{ name: string; description?: string }> }> {
    const tools = await this.connections.listTools(id);
    return { tools: tools.map(tool => ({ name: tool.name, description: tool.description })) };
  }
}
