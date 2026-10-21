import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createLogger } from '../../common/services/logger.service';
import { redactSsrfError, resolveSafeFetchTarget } from '../../common/security/ssrf-guard';
import { sanitizeHeaderMap } from './ai-secrets';
import { AiMcpConnection } from './entities/ai-mcp-connection.entity';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { CreateAiMcpConnectionDto, UpdateAiMcpConnectionDto } from './dto/ai-mcp-connection.dto';

/** Per-instance cap: MCP tool calls fan out to external servers, so the count is bounded. */
export const AI_MCP_CONNECTIONS_MAX = 50;

interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** The raw headers every MCP request carries, before the operator's custom ones. */
function baseHeaders(connection: AiMcpConnection): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    ...(connection.authKind === 'bearer' && connection.authCredential
      ? { authorization: `Bearer ${connection.authCredential}` }
      : {}),
    ...(connection.authKind === 'header' && connection.authCredential
      ? { [connection.authHeader]: connection.authCredential }
      : {}),
  };
  return { ...headers, ...sanitizeHeaderMap(connection.headers) };
}

/**
 * Outbound MCP server connections (the client side of the protocol — OpenWA's own `/mcp` mount is
 * the server side). CRUD plus three verbs over the SDK's Streamable-HTTP client transport:
 * `test` (connect + initialize), `listTools` (the advertised tool catalogue) and `callTool`
 * (one tool invocation, used by an AI chatbot that was given tools).
 */
@Injectable()
export class AiMcpConnectionsService {
  private readonly logger = createLogger('AiMcpConnectionsService');

  constructor(
    @InjectRepository(AiMcpConnection, 'data')
    private readonly repository: Repository<AiMcpConnection>,
    private readonly audit: AuditService,
    @Optional()
    private readonly configService?: ConfigService,
  ) {}

  async create(dto: CreateAiMcpConnectionDto): Promise<AiMcpConnection> {
    const existing = await this.repository.count();
    const max =
      this.configService?.get<number>('ai.mcpConnectionsMax', AI_MCP_CONNECTIONS_MAX) ?? AI_MCP_CONNECTIONS_MAX;
    if (max > 0 && existing >= max) {
      throw new BadRequestException(
        `MCP connection limit reached (${existing}/${max}); delete one before adding another`,
      );
    }
    // Same rule the update path enforces, and for the same reason: the stored string becomes a
    // literal HTTP header name on every tool call.
    const authHeader = dto.authKind === 'header' ? (dto.authHeader ?? 'X-API-Key') : 'X-API-Key';
    if (/[^a-zA-Z0-9-]/.test(authHeader.trim())) {
      throw new BadRequestException('authHeader must be a valid HTTP header name');
    }
    const connection = this.repository.create({
      name: dto.name,
      endpointUrl: dto.endpointUrl.replace(/\/+$/, ''),
      authKind: dto.authKind ?? 'none',
      // A named header only makes sense with the header auth kind; keep the default otherwise.
      authHeader,
      authCredential: dto.authCredential ?? '',
      headers: sanitizeHeaderMap(dto.headers ?? {}),
      timeoutMs: dto.timeoutMs ?? 30_000,
      enabled: dto.enabled ?? true,
    });
    const saved = await this.repository.save(connection);
    void this.audit.logInfo(AuditAction.AI_MCP_CONNECTION_CREATED, {
      metadata: { mcpConnectionId: saved.id, mcpConnectionName: saved.name },
    });
    return saved;
  }

  async findAll(): Promise<AiMcpConnection[]> {
    return this.repository.find({ order: { createdAt: 'ASC', id: 'ASC' } });
  }

  async findOne(id: string): Promise<AiMcpConnection> {
    const connection = await this.repository.findOne({ where: { id } });
    if (!connection) throw new NotFoundException(`MCP connection ${id} not found`);
    return connection;
  }

  async update(id: string, dto: UpdateAiMcpConnectionDto): Promise<AiMcpConnection> {
    const connection = await this.findOne(id);
    if (dto.name !== undefined) connection.name = dto.name;
    if (dto.endpointUrl !== undefined) {
      assertHttpUrl(dto.endpointUrl);
      connection.endpointUrl = dto.endpointUrl.replace(/\/+$/, '');
    }
    if (dto.authKind !== undefined) {
      connection.authKind = dto.authKind;
      // Switching away from header auth re-homes the stored credential to the bearer slot's
      // semantics automatically (both are `authCredential`); only the header NAME resets.
      if (dto.authKind !== 'header') connection.authHeader = 'X-API-Key';
    }
    if (dto.authHeader !== undefined) {
      if (/[^a-zA-Z0-9-]/.test(dto.authHeader.trim())) {
        throw new BadRequestException('authHeader must be a valid HTTP header name');
      }
      connection.authHeader = dto.authHeader;
    }
    if (dto.authCredential !== undefined) connection.authCredential = dto.authCredential;
    if (dto.headers !== undefined) connection.headers = sanitizeHeaderMap(dto.headers);
    if (dto.timeoutMs !== undefined) connection.timeoutMs = dto.timeoutMs;
    if (dto.enabled !== undefined) connection.enabled = dto.enabled;
    const saved = await this.repository.save(connection);
    void this.audit.logInfo(AuditAction.AI_MCP_CONNECTION_UPDATED, {
      metadata: { mcpConnectionId: saved.id, mcpConnectionName: saved.name },
    });
    return saved;
  }

  async remove(id: string): Promise<void> {
    const connection = await this.findOne(id);
    await this.repository.remove(connection);
    void this.audit.logInfo(AuditAction.AI_MCP_CONNECTION_DELETED, {
      metadata: { mcpConnectionId: id, mcpConnectionName: connection.name },
    });
  }

  /**
   * Connect, initialize, list tools, disconnect — and record the outcome on the row. The open
   * connection lives only for the duration of the call; MCP client state is not kept in memory.
   */
  async test(id: string): Promise<{ serverName?: string; serverVersion?: string; tools: McpToolInfo[] }> {
    const connection = await this.findOne(id);
    try {
      const result = await this.listToolsInternal(connection);
      await this.recordStatus(id, {
        ok: true,
        serverName: result.serverName,
        serverVersion: result.serverVersion,
        toolCount: result.tools.length,
      });
      return result;
    } catch (error) {
      const detail = redactSsrfError(error).slice(0, 500);
      await this.recordStatus(id, { ok: false, error: detail });
      throw error instanceof Error && error.message.startsWith('MCP') ? error : new Error(`MCP test failed: ${detail}`);
    }
  }

  /** The advertised tools of a connection (a fresh connect per call). */
  async listTools(id: string): Promise<McpToolInfo[]> {
    const connection = await this.findOne(id);
    return (await this.listToolsInternal(connection)).tools;
  }

  /** Call one tool on the server. `args` is validated against the tool's schema by the server. */
  async callTool(id: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const connection = await this.findOne(id);
    if (!connection.enabled) throw new BadRequestException('the MCP connection is disabled');
    const client = await this.connect(connection);
    try {
      const result = await client.callTool({ name: toolName, arguments: args }, undefined, {
        timeout: connection.timeoutMs,
      });
      return result;
    } catch (error) {
      throw new Error(`MCP tool call failed: ${redactSsrfError(error).slice(0, 300)}`);
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  // ── internals ────────────────────────────────────────────────────────────────────────────────

  private async listToolsInternal(
    connection: AiMcpConnection,
  ): Promise<{ serverName?: string; serverVersion?: string; tools: McpToolInfo[] }> {
    if (!connection.enabled) throw new BadRequestException('the MCP connection is disabled');
    const client = await this.connect(connection);
    try {
      const serverVersion = client.getServerVersion();
      const listed = await client.listTools(undefined, { timeout: connection.timeoutMs });
      const tools: McpToolInfo[] = (listed.tools ?? []).slice(0, 200).map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as Record<string, unknown> | undefined,
      }));
      return {
        serverName: serverVersion?.name,
        serverVersion: serverVersion?.version,
        tools,
      };
    } catch (error) {
      throw new Error(`MCP tools/list failed: ${redactSsrfError(error).slice(0, 300)}`);
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  /** One fresh client+transport per operation (the transport is stateless HTTP; close() after). */
  private async connect(connection: AiMcpConnection): Promise<Client> {
    // Validate the host once (SSRF posture matches every other outbound fetch of the gateway);
    // the transport then talks to the literal URL over its own fetch.
    try {
      await resolveSafeFetchTarget(connection.endpointUrl, AbortSignal.timeout(10_000));
    } catch (error) {
      throw new Error(`MCP endpoint refused by the SSRF guard: ${redactSsrfError(error)}`);
    }
    const client = new Client({ name: 'openwa', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(connection.endpointUrl), {
      requestInit: { headers: baseHeaders(connection) },
    });
    try {
      await client.connect(transport, { timeout: connection.timeoutMs });
      return client;
    } catch (error) {
      await client.close().catch(() => undefined);
      throw new Error(`MCP connect failed: ${redactSsrfError(error).slice(0, 300)}`);
    }
  }

  private async recordStatus(
    id: string,
    status: { ok: boolean; serverName?: string; serverVersion?: string; toolCount?: number; error?: string },
  ): Promise<void> {
    try {
      const nextStatus = {
        ok: status.ok,
        at: new Date().toISOString(),
        ...(status.serverName ? { serverName: status.serverName } : {}),
        ...(status.serverVersion ? { serverVersion: status.serverVersion } : {}),
        ...(status.toolCount !== undefined ? { toolCount: status.toolCount } : {}),
        ...(status.error ? { error: status.error } : {}),
      };
      await this.repository.update({ id }, { lastStatus: nextStatus as AiMcpConnection['lastStatus'] });
      void this.audit.logInfo(AuditAction.AI_MCP_CONNECTION_TESTED, {
        metadata: {
          mcpConnectionId: id,
          ok: status.ok,
          ...(status.serverName ? { serverName: status.serverName } : {}),
          ...(status.toolCount !== undefined ? { toolCount: status.toolCount } : {}),
          ...(status.error ? { error: status.error.slice(0, 200) } : {}),
        },
      });
    } catch (error) {
      this.logger.warn('Failed to record the MCP connection status', {
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function assertHttpUrl(rawUrl: string): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BadRequestException('Endpoint URL is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BadRequestException('Endpoint URL must use http or https');
  }
}
