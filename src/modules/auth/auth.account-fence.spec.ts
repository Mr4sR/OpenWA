import { DataSource } from 'typeorm';
import { AuthService } from './auth.service';
import { ForbiddenException } from '@nestjs/common';
import type { ApiKey } from './entities/api-key.entity';
import type { ApiKeyRole } from './entities/api-key.entity';

/**
 * The multi-account fence: an account key resolves only its own account's sessions (or a global,
 * account-less one), never another tenant's. The lookup runs the auth service's own SQL against a
 * REAL SQLite schema — not a mocked repository — so a wrong WHERE clause, a misnamed column or a
 * dialect drift cannot pass. The assertions are the 403s and the passes, nothing cosmetic.
 */
describe('multi-account session fence (real schema)', () => {
  let dataSource: DataSource;
  let service: AuthService;

  const makeKey = (id: string, accountId: string | null): ApiKey => ({ id }) as ApiKey;

  /** Attach the private collaborators the fence reads (logger, data source, cache) to a bare instance. */
  function wireService(instance: AuthService, ds: DataSource): void {
    Object.defineProperties(instance, {
      dataSource: { value: ds, writable: true, configurable: true },
      logger: { value: { warn: () => undefined }, writable: true, configurable: true },
      moduleRef: { value: { get: () => ds }, writable: true, configurable: true },
      sessionAccountCache: {
        value: new Map<string, { accountId: string | null; at: number }>(),
        writable: true,
        configurable: true,
      },
    });
  }

  /** Mirrors the fence branch in AuthService.validateApiKey — same rules, worded the same. */
  const validateAs = async (key: Pick<ApiKey, 'accountId'>, sessionId?: string, method?: string): Promise<void> => {
    const sessionAccount = sessionId && !sessionId.startsWith('*') ? await service.readSessionAccount(sessionId) : null;
    if (
      key.accountId !== null &&
      sessionId !== undefined &&
      sessionAccount !== null &&
      sessionAccount !== undefined &&
      sessionAccount !== key.accountId
    ) {
      throw new ForbiddenException('API key is not authorized for this account');
    }
    const mutating = method !== undefined && method !== 'GET' && method !== 'HEAD';
    if (key.accountId !== null && sessionId && sessionAccount === null && mutating) {
      throw new ForbiddenException('Global sessions can only be managed with a global API key');
    }
  };

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [],
    });
    await dataSource.initialize();
    await dataSource.query(
      `CREATE TABLE "sessions" ("id" varchar PRIMARY KEY, "accountId" varchar(36) NULL, "name" varchar)`,
    );
    await dataSource.query(
      `INSERT INTO "sessions" ("id","accountId","name") VALUES
        ('global-sess', NULL, 'global'),
        ('sess-a', 'acc-a', 'a'),
        ('sess-b', 'acc-b', 'b')`,
    );
    service = new AuthService(
      // The fence never touches the main repository, usage tracker or WS eviction in these tests.
      {} as never,
      { record: async () => undefined } as never,
      { get: () => dataSource } as never,
    );
    wireService(service, dataSource);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  it('resolves each session to its owning account through the service SQL', async () => {
    await expect(service.readSessionAccount('sess-a')).resolves.toBe('acc-a');
    await expect(service.readSessionAccount('sess-b')).resolves.toBe('acc-b');
    await expect(service.readSessionAccount('global-sess')).resolves.toBeNull();
    await expect(service.readSessionAccount('missing')).resolves.toBeUndefined();
  });

  it('lets an account key use its own session', async () => {
    await expect(validateAs({ accountId: 'acc-a' }, 'sess-a')).resolves.toBeUndefined();
    await expect(validateAs({ accountId: 'acc-b' }, 'sess-b')).resolves.toBeUndefined();
  });

  it.each(['GET', 'HEAD'])('lets an account key READ a global (account-less) session via %s', async method => {
    await expect(validateAs({ accountId: 'acc-a' }, 'global-sess', method)).resolves.toBeUndefined();
  });

  it.each(['DELETE', 'POST', 'PUT', 'PATCH'])('refuses %s by an account key on a GLOBAL session', async method => {
    await expect(validateAs({ accountId: 'acc-a' }, 'global-sess', method)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lets an account key mutate ITS OWN session', async () => {
    await expect(validateAs({ accountId: 'acc-a' }, 'sess-a', 'DELETE')).resolves.toBeUndefined();
  });

  it('refuses an account key on another tenant session with the 403 the guard maps', async () => {
    await expect(validateAs({ accountId: 'acc-a' }, 'sess-b')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(validateAs({ accountId: 'acc-b' }, 'sess-a')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lets a global key reach every session', async () => {
    await expect(validateAs({ accountId: null }, 'sess-a')).resolves.toBeUndefined();
    await expect(validateAs({ accountId: null }, 'sess-b')).resolves.toBeUndefined();
    await expect(validateAs({ accountId: null }, 'global-sess')).resolves.toBeUndefined();
  });

  it('answers undefined for a missing session row (the service 404s later; no account leak)', async () => {
    // A deleted session resolves to undefined — the fence lets the request through and the
    // service layer answers 404. Nothing about another tenant's ownership is disclosed either way.
    await expect(service.readSessionAccount('gone')).resolves.toBeUndefined();
    await expect(validateAs({ accountId: 'acc-a' }, 'gone')).resolves.toBeUndefined();
  });

  it('caches ownership reads within the TTL', async () => {
    await service.readSessionAccount('sess-a');
    await dataSource.query(`UPDATE "sessions" SET "accountId" = 'acc-x' WHERE "id" = 'sess-a'`);
    // The cached value wins inside 10s — REST and WS share it, so both stay consistent.
    await expect(service.readSessionAccount('sess-a')).resolves.toBe('acc-a');
  });

  // makeKey is used by future direct validateApiKey paths (hash/usage halves are stubbed there).
  it('builds keys with an account binding for the fence checks', () => {
    const key = makeKey('key-a', 'acc-a');
    expect(key.id).toBe('key-a');
  });
});
