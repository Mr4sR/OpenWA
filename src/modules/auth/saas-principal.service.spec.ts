import { DataSource } from 'typeorm';
import { UnauthorizedException } from '@nestjs/common';
import { UsersService } from './users.service';
import { SessionTokenService } from './session-token.service';
import { SaasPrincipalService } from './saas-principal.service';
import { ApiKeyRole } from './entities/api-key.entity';
import { User, UserRole } from './entities/user.entity';
import { Plan } from './entities/plan.entity';

/**
 * A dashboard session token IS a wire credential: the guard resolves `Authorization: Bearer
 * <saas-jwt>` to the token holder's LIVE tenant principal, so a SaaS login can create sessions and
 * configure its own AI models without a hand-issued API key. These run against a real in-memory
 * schema because the whole point is the live user row: role, account and enablement come from the
 * database, never from the token's claims.
 */
describe('SaasPrincipalService (token → tenant principal)', () => {
  let ds: DataSource;
  let svc: SaasPrincipalService;
  let tokens: SessionTokenService;
  let adminA: User;
  let memberA: User;
  let emailLess: User;

  beforeAll(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [User, Plan],
      synchronize: true,
    });
    await ds.initialize();
    await ds.query(
      `CREATE TABLE "accounts" ("id" varchar PRIMARY KEY, "status" varchar(20) NOT NULL DEFAULT 'active', "planSlug" varchar(30) NOT NULL DEFAULT 'free')`,
    );
    await ds.query(`INSERT INTO "accounts" ("id") VALUES ('acc-a')`);
    tokens = new SessionTokenService();
    const users = new UsersService(ds.getRepository(User), ds.getRepository(Plan), tokens);
    svc = new SaasPrincipalService(tokens, users);

    const repo = ds.getRepository(User);
    adminA = await repo.save(
      repo.create({ email: 'admin-a@x.test', name: 'A', passwordHash: 'x', role: UserRole.ACCOUNT_ADMIN, accountId: 'acc-a' }),
    );
    memberA = await repo.save(
      repo.create({ email: 'member-a@x.test', name: 'M', passwordHash: 'x', role: UserRole.ACCOUNT_MEMBER, accountId: 'acc-a' }),
    );
    emailLess = await repo.save(
      repo.create({ email: 'ops@x.test', name: 'Ops', passwordHash: 'x', role: UserRole.PLATFORM_ADMIN, accountId: null }),
    );
  });

  afterAll(async () => {
    await ds.destroy();
  });

  const tokenFor = (user: User): string =>
    tokens.issue({ sub: user.id, email: user.email, role: user.role, accountId: user.accountId }).token;

  it('recognizes a dashboard token and rejects a plain API key', () => {
    expect(svc.isSessionToken(tokenFor(adminA))).toBe(true);
    expect(svc.isSessionToken('owa_k1_deadbeef')).toBe(false);
    expect(svc.isSessionToken('')).toBe(false);
  });

  it('maps account_admin to an ADMIN principal stamped with the tenant, never session-scoped', async () => {
    const { apiKey, user } = await svc.resolve(tokenFor(adminA));
    expect(user.id).toBe(adminA.id);
    expect(apiKey.role).toBe(ApiKeyRole.ADMIN);
    expect(apiKey.accountId).toBe('acc-a');
    // A null allowlist is what makes POST /sessions reachable: the guard only refuses
    // @RequireUnscopedKey when a key carries an account AND the route does not @AllowAccountKeys.
    expect(apiKey.allowedSessions).toBeNull();
    expect(apiKey.isActive).toBe(true);
  });

  it('maps account_member to an OPERATOR principal (create allowed, no admin writes)', async () => {
    const { apiKey } = await svc.resolve(tokenFor(memberA));
    expect(apiKey.role).toBe(ApiKeyRole.OPERATOR);
    expect(apiKey.accountId).toBe('acc-a');
  });

  it('refuses the platform operator: the technical surface stays API-key based', async () => {
    await expect(svc.resolve(tokenFor(emailLess))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('derives a stable per-user principal and a different one per user', async () => {
    const a = (await svc.resolve(tokenFor(adminA))).apiKey.keyHash;
    const b = (await svc.resolve(tokenFor(adminA))).apiKey.keyHash;
    const m = (await svc.resolve(tokenFor(memberA))).apiKey.keyHash;
    expect(a).toBe(b);
    expect(a).not.toBe(m);
  });

  it('reads the LIVE role: a demotion applies to a token minted before it', async () => {
    const token = tokenFor(adminA);
    await ds.getRepository(User).update({ id: adminA.id }, { role: UserRole.ACCOUNT_MEMBER });
    const { apiKey } = await svc.resolve(token);
    expect(apiKey.role).toBe(ApiKeyRole.OPERATOR);
    await ds.getRepository(User).update({ id: adminA.id }, { role: UserRole.ACCOUNT_ADMIN });
  });

  it('refuses a token whose user was disabled', async () => {
    const token = tokenFor(memberA);
    await ds.getRepository(User).update({ id: memberA.id }, { isActive: false });
    await expect(svc.resolve(token)).rejects.toBeInstanceOf(UnauthorizedException);
    await ds.getRepository(User).update({ id: memberA.id }, { isActive: true });
  });
});
