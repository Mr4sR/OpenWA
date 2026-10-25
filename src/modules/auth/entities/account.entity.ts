import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

/** Longest account display name. */
export const ACCOUNT_NAME_MAX_LENGTH = 80;

/**
 * One tenant ("account") of this gateway: a named owner who holds their own WhatsApp sessions and
 * their own API keys. An account never logs in by itself — it is reached through an API key bound
 * to it (`api_keys.accountId`), and every session it owns carries the same id
 * (`sessions.accountId`), so tenant A's key can never resolve tenant B's session.
 *
 * A NULL account on a key/session is the GLOBAL (single-tenant) surface: the seeded master key and
 * every row written before this feature keep working unchanged, and a global key still reaches
 * account-owned sessions (an administrator's view). The reverse is never true: an account key is
 * fenced to its own account everywhere the guard can see the session (and to the account's rows on
 * every account-dimension listing).
 */
@Entity('accounts')
@Index('UQ_accounts_name', ['name'], { unique: true })
export class Account {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: ACCOUNT_NAME_MAX_LENGTH })
  name!: string;

  /** Free-form operator note (who this tenant is for). Never rendered by default. */
  @Column({ type: 'varchar', length: 500, nullable: true })
  note!: string | null;

  /** The tariff this account subscribes to (`plans.slug`). */
  @Column({ type: 'varchar', length: 30, default: 'free' })
  planSlug!: string;

  /**
   * A suspended account refuses LOGIN for every user in it and its API keys answer 401 — the
   * enforcement sites are auth.service (login + key validate) and plan-limits.service on create
   * paths. A suspension never deletes data.
   */
  @Column({ type: 'varchar', length: 20, default: 'active' })
  status!: 'active' | 'suspended';

  /** Trial / subscription lapse marker: a past expiry behaves like suspended until extended. */
  @Column({ type: 'datetime', nullable: true })
  planExpiresAt!: Date | null;

  /** When the current plan started (display-only). */
  @Column({ type: 'datetime', nullable: true })
  planStartedAt!: Date | null;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
