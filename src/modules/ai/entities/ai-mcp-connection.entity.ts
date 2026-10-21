import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { jsonColumnType } from '../../../common/utils/column-types';

/** Longest display name. */
export const AI_MCP_NAME_MAX_LENGTH = 100;

/** Bound for an MCP server endpoint URL (same width as the LLM endpoint). */
export const AI_MCP_ENDPOINT_MAX_LENGTH = 2048;

/**
 * Header-auth kinds an MCP connection may use. `none` connects without any credential; the SDK's
 * OAuth 2.1 flow is deliberately out of scope — a static credential (header or bearer) is the
 * self-hosted norm, mirroring OpenWA's own MCP server.
 */
export type AiMcpAuthKind = 'none' | 'bearer' | 'header';

/**
 * One outbound MCP server connection: an endpoint OpenWA's LLM chatbot can call tools on, via the
 * Streamable-HTTP transport (CONNECT first, tools/list, then tools/call on demand).
 *
 * `authCredential` is write-only (masked on read) and carries the bearer token or the header value
 * depending on `authKind`; `authHeader` names the header for `authKind === 'header'` (default
 * `X-API-Key`).
 */
@Entity('ai_mcp_connections')
@Index('UQ_ai_mcp_connections_name', ['name'], { unique: true })
export class AiMcpConnection {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: AI_MCP_NAME_MAX_LENGTH })
  name!: string;

  /** MCP endpoint, e.g. `https://server.example.com/mcp`. */
  @Column({ type: 'varchar', length: AI_MCP_ENDPOINT_MAX_LENGTH })
  endpointUrl!: string;

  @Column({ type: 'varchar', length: 10, default: 'none' })
  authKind!: AiMcpAuthKind;

  /** Header name used when `authKind === 'header'`. */
  @Column({ type: 'varchar', length: 100, default: 'X-API-Key' })
  authHeader!: string;

  /** Bearer token or header value. Write-only; masked on read. */
  @Column({ type: 'varchar', length: 2048, default: '' })
  authCredential!: string;

  /**
   * Extra HTTP headers on every MCP request (tenancy/routing). Write-only, same posture as the
   * LLM model's headers.
   */
  @Column({ type: jsonColumnType(), default: '{}' })
  headers!: Record<string, string>;

  /** Timeout for one tools/list or tools/call round trip (ms). */
  @Column({ type: 'int', default: 30000 })
  timeoutMs!: number;

  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  /** Diagnostics of the last connection test / tool listing. */
  @Column({ type: jsonColumnType(), nullable: true })
  lastStatus!: {
    at: string;
    serverName?: string;
    serverVersion?: string;
    toolCount?: number;
    error?: string;
  } | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
