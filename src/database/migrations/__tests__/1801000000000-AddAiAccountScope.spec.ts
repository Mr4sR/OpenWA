import { AddAiAccountScope1801000000000 } from '../1801000000000-AddAiAccountScope';
import { DataSource } from 'typeorm';

/**
 * The migration adds + backfills five AI tables. Ownerless tables (llm/rag/mcp) simply gain a NULL
 * column; derived tables (documents, overrides) copy their parent's account.
 */
describe('AddAiAccountScope1801000000000 on SQLite', () => {
  let ds: DataSource;

  beforeEach(async () => {
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:' });
    await ds.initialize();
    await ds.query(`CREATE TABLE "ai_llm_models" ("id" varchar PRIMARY KEY, "name" varchar(100) NOT NULL)`);
    await ds.query(
      `CREATE TABLE "ai_rag_models" ("id" varchar PRIMARY KEY, "name" varchar(100) NOT NULL, "llmModelId" varchar(36))`,
    );
    await ds.query(
      `CREATE TABLE "ai_rag_documents" ("id" varchar PRIMARY KEY, "ragModelId" varchar(36) NOT NULL, "sourceType" varchar(10) NOT NULL)`,
    );
    await ds.query(`CREATE TABLE "ai_mcp_connections" ("id" varchar PRIMARY KEY, "name" varchar(100) NOT NULL)`);
    await ds.query(`CREATE TABLE "ai_chatbots" ("id" varchar PRIMARY KEY, "accountId" varchar(36), "name" varchar(100) NOT NULL)`);
    await ds.query(
      `CREATE TABLE "ai_chat_overrides" ("id" varchar PRIMARY KEY, "chatbotId" varchar NOT NULL, "chatId" varchar(255) NOT NULL, "chatbotDisabled" boolean NOT NULL DEFAULT (0))`,
    );
    await ds.query(`INSERT INTO "ai_llm_models" VALUES ('llm1','m')`);
    await ds.query(`INSERT INTO "ai_rag_models" VALUES ('rag1','r1','llm1')`);
    await ds.query(`INSERT INTO "ai_rag_documents" VALUES ('doc1','rag1','text')`);
    await ds.query(`INSERT INTO "ai_mcp_connections" VALUES ('mcp1','srv')`);
    await ds.query(`INSERT INTO "ai_chatbots" VALUES ('bot1','acc-1','bot')`);
    await ds.query(`INSERT INTO "ai_chat_overrides" VALUES ('ov1','bot1','111@c.us',1)`);
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it('backfills documents/overrides from their parents, leaves ownerless rows NULL, and is idempotent', async () => {
    const migration = new AddAiAccountScope1801000000000();
    await migration.up(ds.createQueryRunner());
    // Second run must not throw (probes see the column/index already present) nor double-apply.
    await migration.up(ds.createQueryRunner());

    const llms = (await ds.query(`SELECT "accountId" FROM "ai_llm_models"`)) as Array<{ accountId: string }>;
    expect(llms).toEqual([{ accountId: null }]);

    const docs = (await ds.query(`SELECT "id", "accountId" FROM "ai_rag_documents"`)) as Array<{ id: string; accountId: string }>;
    // The parent RAG model has no owner, so the entry stays global.
    expect(docs).toEqual([{ id: 'doc1', accountId: null }]);

    const overrides = (await ds.query(`SELECT "accountId" FROM "ai_chat_overrides"`)) as Array<{ accountId: string }>;
    expect(overrides).toEqual([{ accountId: 'acc-1' }]);

    const indexes = (await ds.query(
      `SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'IDX_ai_%_accountId' ORDER BY name`,
    )) as Array<{ name: string }>;
    expect(indexes.map(i => i.name)).toEqual([
      'IDX_ai_chat_overrides_accountId',
      'IDX_ai_llm_models_accountId',
      'IDX_ai_mcp_connections_accountId',
      'IDX_ai_rag_documents_accountId',
      'IDX_ai_rag_models_accountId',
    ]);
  });

  it('a tenant claiming its parent after the migration keeps its rows in-tenant', async () => {
    // Upgrade-day rows are backfilled once (previous test). This proves the POST-migration flow a
    // live tenant hits: the parent is claimed (the service stamps accountId on create), and its
    // documents carry the same owner from the moment they are written.
    await new AddAiAccountScope1801000000000().up(ds.createQueryRunner());
    await ds.query(
      `INSERT INTO "ai_rag_models" ("id","name","llmModelId","accountId") VALUES ('rag2','r2',NULL,'acc-2')`,
    );
    await ds.query(
      `INSERT INTO "ai_rag_documents" ("id","ragModelId","sourceType","accountId") VALUES ('doc2','rag2','text','acc-2')`,
    );

    const docs = (await ds.query(`SELECT "id", "accountId" FROM "ai_rag_documents" ORDER BY "id"`)) as Array<{
      id: string;
      accountId: string;
    }>;
    expect(docs).toEqual([
      { id: 'doc1', accountId: null },
      { id: 'doc2', accountId: 'acc-2' },
    ]);
  });

  it('down removes every account column and index', async () => {
    const migration = new AddAiAccountScope1801000000000();
    await migration.up(ds.createQueryRunner());
    await migration.down(ds.createQueryRunner());
    const indexes = (await ds.query(
      `SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'IDX_ai_%_accountId'`,
    )) as Array<{ name: string }>;
    expect(indexes).toEqual([]);
    const llmCols = (await ds.query(`PRAGMA table_info("ai_llm_models")`)) as Array<{ name: string }>;
    expect(llmCols.map(c => c.name)).not.toContain('accountId');
  });
});
