import { AddWebhookAccount1799500000000 } from '../1799500000000-AddWebhookAccount';
import { AddChatbotAccount1800000000000 } from '../1800000000000-AddChatbotAccount';
import { DataSource } from 'typeorm';

/**
 * These two migrations shipped with a bare `sqlite_master` probe, which broke EVERY PostgreSQL boot
 * (`relation "sqlite_master" does not exist`) — a data-connection dialect leak that no SQLite test
 * could see. These tests pin the dialect surface: on a Postgres runner no SQLite-only catalog is
 * ever queried, and the schema probe uses information_schema / pg_indexes instead.
 */
describe.each([
  ['AddWebhookAccount', new AddWebhookAccount1799500000000(), 'webhooks', 'IDX_webhooks_accountId'],
  ['AddChatbotAccount', new AddChatbotAccount1800000000000(), 'ai_chatbots', 'IDX_ai_chatbots_accountId'],
])('%s under a Postgres runner', (_label, migration, table, indexName) => {
  const makeRunner = () => {
    const statements: string[] = [];
    const runner = {
      dataSource: { options: { type: 'postgres' } },
      async query(sql: string): Promise<unknown> {
        statements.push(sql);
        // Shape the probes: column absent, index absent → both DDL steps are exercised.
        if (/information_schema\.columns/.test(sql)) return [];
        if (/pg_indexes/.test(sql)) return [];
        return [];
      },
    };
    return { runner, statements };
  };

  it('never touches a SQLite-only catalog', async () => {
    const { runner, statements } = makeRunner();
    await migration.up(runner as never);

    const sqliteOnly = statements.filter(sql => /sqlite_master|PRAGMA/i.test(sql));
    expect(sqliteOnly).toEqual([]);
    expect(statements.some(sql => /information_schema\.columns/.test(sql))).toBe(true);
    expect(statements.some(sql => /pg_indexes/.test(sql))).toBe(true);
  });

  it('adds the column, backfills it, and creates the index', async () => {
    const { runner, statements } = makeRunner();
    await migration.up(runner as never);

    expect(statements.some(sql => new RegExp(`ALTER TABLE "${table}" ADD COLUMN "accountId"`).test(sql))).toBe(true);
    expect(statements.some(sql => /UPDATE "[a-z_]+" SET "accountId" =/.test(sql))).toBe(true);
    expect(statements.some(sql => sql.includes(`CREATE INDEX "${indexName}"`))).toBe(true);
    // Postgres cannot run a SQLite-only DDL form.
    expect(statements.some(sql => /datetime\('now'\)/i.test(sql))).toBe(false);
  });

  it('down() removes the index and column through dialect-aware existence probes', async () => {
    const statements: string[] = [];
    const runner = {
      dataSource: { options: { type: 'postgres' } },
      async query(sql: string): Promise<unknown> {
        statements.push(sql);
        // Present, so both drops are attempted.
        if (/information_schema\.columns/.test(sql)) return [{ '?column?': 1 }];
        if (/pg_indexes/.test(sql)) return [{ '?column?': 1 }];
        return [];
      },
    };
    await migration.down(runner as never);

    expect(statements.filter(sql => /sqlite_master|PRAGMA/i.test(sql))).toEqual([]);
    expect(statements.some(sql => sql.includes(`DROP INDEX "${indexName}"`))).toBe(true);
    expect(statements.some(sql => new RegExp(`ALTER TABLE "${table}" DROP COLUMN "accountId"`).test(sql))).toBe(true);
  });
});

/**
 * SQLite side (the real dialect this dev box runs): the column is added, backfilled from the
 * session, and indexed against a real in-memory schema.
 */
describe('AddWebhookAccount / AddChatbotAccount on SQLite', () => {
  let ds: DataSource;

  beforeEach(async () => {
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:' });
    await ds.initialize();
    await ds.query(`CREATE TABLE "sessions" ("id" varchar PRIMARY KEY, "accountId" varchar(36))`);
    await ds.query(
      `CREATE TABLE "webhooks" ("id" varchar PRIMARY KEY, "sessionId" varchar NOT NULL, "url" varchar(2048) NOT NULL)`,
    );
    await ds.query(
      `CREATE TABLE "ai_chatbots" ("id" varchar PRIMARY KEY, "sessionIds" text NOT NULL DEFAULT '[]', "name" varchar(100) NOT NULL, "llmModelId" varchar(36) NOT NULL)`,
    );
    await ds.query(`INSERT INTO "sessions" VALUES ('s1','acc-1')`);
    await ds.query(`INSERT INTO "webhooks" VALUES ('w1','s1','http://x/hook')`);
    await ds.query(`INSERT INTO "ai_chatbots" VALUES ('c1','["s1"]','bot','llm-1')`);
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it('backfills both tables from the owning session and is idempotent', async () => {
    await new AddWebhookAccount1799500000000().up(ds.createQueryRunner());
    await new AddChatbotAccount1800000000000().up(ds.createQueryRunner());
    // Second run must not throw (probes see the column/index already present).
    await new AddWebhookAccount1799500000000().up(ds.createQueryRunner());
    await new AddChatbotAccount1800000000000().up(ds.createQueryRunner());

    const hooks = (await ds.query(`SELECT "accountId" FROM "webhooks"`)) as Array<{ accountId: string }>;
    const bots = (await ds.query(`SELECT "accountId" FROM "ai_chatbots"`)) as Array<{ accountId: string }>;
    expect(hooks).toEqual([{ accountId: 'acc-1' }]);
    expect(bots).toEqual([{ accountId: 'acc-1' }]);
  });
});
