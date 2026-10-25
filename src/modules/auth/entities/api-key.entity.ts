import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

export enum ApiKeyRole {
  ADMIN = 'admin',
  OPERATOR = 'operator',
  VIEWER = 'viewer',
}

@Entity('api_keys')
export class ApiKey {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  keyHash!: string;

  // 12 to fit the 12-char prefix that auth.service writes (was varchar(8); harmless on the
  // hardcoded-SQLite `main` connection, but kept consistent with the code).
  @Column({ type: 'varchar', length: 12 })
  keyPrefix!: string;

  @Column({
    type: 'varchar',
    length: 20,
    default: ApiKeyRole.OPERATOR,
  })
  role!: ApiKeyRole;

  @Column({ type: 'simple-array', nullable: true })
  allowedIps!: string[] | null;

  @Column({ type: 'simple-array', nullable: true })
  allowedSessions!: string[] | null;

  /**
   * The account (tenant) this key acts for, or NULL for the global surface — the seeded master
   * key and every key written before accounts existed. A key bound to an account only reaches
   * that account's sessions (guard fence) and only issues credentials for that account; a global
   * key keeps reaching everything, which is what keeps a single-tenant install unchanged.
   */
  @Index('IDX_api_keys_accountId', ['accountId'], { where: '"accountId" IS NOT NULL' })
  @Column({ type: 'varchar', length: 36, nullable: true })
  accountId!: string | null;

  /**
   * The LOGIN that minted this key (SaaS): NULL for the seeded master key and pre-SaaS rows.
   * A key belongs to the account of the user who created it; deleting/removing the user revokes
   * its keys. Display-only for attribution — enforcement stays on `accountId`.
   */
  @Column({ type: 'varchar', length: 36, nullable: true })
  userId!: string | null;

  // Chat-level allowlist, independent of allowedSessions and the same fail-open semantic: NULL or
  // empty means "every chat". Entries are WhatsApp chat ids (a group `<id>@g.us`, a contact
  // `<phone>@c.us` / `<lid>@lid`, or a bare phone number). Enforced on the read surface and on
  // sends; see src/common/security/chat-scope.ts.
  @Column({ type: 'simple-array', nullable: true })
  allowedChats!: string[] | null;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ type: 'datetime', nullable: true })
  expiresAt!: Date | null;

  @Column({ type: 'datetime', nullable: true })
  lastUsedAt!: Date | null;

  @Column({ type: 'int', default: 0 })
  usageCount!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
