import { Entity, Column, CreateDateColumn, UpdateDateColumn, Index, PrimaryGeneratedColumn } from 'typeorm';

/** Longest user display name. */
export const USER_NAME_MAX_LENGTH = 80;
/** Longest accepted email. RFC allows longer; a SaaS UI never needs more. */
export const USER_EMAIL_MAX_LENGTH = 254;

/** The two kinds of login: a platform operator (developer) and an account tenant. */
export enum UserRole {
  PLATFORM_ADMIN = 'platform_admin',
  ACCOUNT_ADMIN = 'account_admin',
  ACCOUNT_MEMBER = 'account_member',
}

/**
 * A SaaS login identity. `platform_admin` is the DEVELOPER surface: it sees every account, every
 * plan, and manages registration + suspension. `account_admin`/`account_member` belong to exactly
 * one account (accountId NOT NULL at the service layer); their data is scoped through it.
 *
 * Passwords are stored as scrypt hashes (`password-hash.ts`): `scrypt<N=16384,r=8,p=1>$<salt>$<hash>`,
 * verified in constant time. No plaintext ever leaves the login route.
 */
@Entity('users')
@Index('UQ_users_email', ['email'], { unique: true })
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Lowercased at the service layer — the uniqueness contract. */
  @Column({ type: 'varchar', length: USER_EMAIL_MAX_LENGTH })
  email!: string;

  @Column({ type: 'varchar', length: USER_NAME_MAX_LENGTH })
  name!: string;

  /** `scrypt$N$r$p$salt$hash` — see password-hash.ts. NEVER returned by any route. */
  @Column({ type: 'varchar', length: 400 })
  passwordHash!: string;

  @Column({ type: 'varchar', length: 30, default: UserRole.ACCOUNT_MEMBER })
  role!: UserRole;

  /** NULL for the platform operator; the owning tenant for account logins. */
  @Column({ type: 'varchar', length: 36, nullable: true })
  accountId!: string | null;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  /** Bounded: login timestamps are diagnostics, not forensic (audit log covers that). */
  @Column({ type: 'datetime', nullable: true })
  lastLoginAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
