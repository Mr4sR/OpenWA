import { DataSource } from 'typeorm';
import { ChatbotMultiSession1795000000000 } from '../1795000000000-ChatbotMultiSession';

/**
 * This migration failed on a production Postgres deployment with `syntax error at or near
 * "PRAGMA"`: it had been written SQLite-first and executed SQLite-only DDL unconditionally.
 * These tests pin BOTH paths.
 *
 * - SQLite: the real table-swap against a real schema (rows survive as `["<id>"]` sessionIds
 *   arrays, overrides rebuilt with its FK, idempotent re-run, reversible down()).
 * - Postgres: a statement-recording runner, because no Postgres server is available here. The
 *   assertion is the SQL SURFACE: no PRAGMA dialect leak, `jsonb_build_array` builds the array,
 *   no `datetime('now')`, and the overrides table is never dropped (its FK survives a parent swap
 *   on Postgres).
 */
describe('ChatbotMultiSession migration (both dialects)', () => {
  describe('SQLite (real schema swap)', () => {
    let ds: DataSource;

    beforeEach(async () => {
      ds = new DataSource({ type: 'better-sqlite3', database: ':memory:' });
      await ds.initialize();
      // Shape after 1793/1794: replyGroups and mcpToolIds exist, sessionId is still single-valued.
      await ds.query(
        `CREATE TABLE "ai_chatbots" (` +
          `"id" varchar PRIMARY KEY NOT NULL, "sessionId" varchar NOT NULL, "name" varchar(100) NOT NULL, ` +
          `"llmModelId" varchar(36) NOT NULL, "ragModelId" varchar(36), "persona" text, "mcpToolIds" text, ` +
          `"replyGroups" boolean NOT NULL DEFAULT 0, ` +
          `"enabled" boolean NOT NULL DEFAULT 1, "lastRepliedAt" datetime, "lastError" text, ` +
          `"createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`,
      );
      await ds.query(
        `CREATE TABLE "ai_chat_overrides" ("id" varchar PRIMARY KEY NOT NULL, "chatbotId" varchar(36) NOT NULL, ` +
          `"chatId" varchar(255) NOT NULL, "chatbotDisabled" boolean NOT NULL DEFAULT 0, ` +
          `"createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`,
      );
      await ds.query(
        `INSERT INTO "ai_chatbots" ("id","sessionId","name","llmModelId") VALUES ('b1','sess-1','Ops bot','llm-1'), ('b2','sess-2','Sales bot','llm-1')`,
      );
      await ds.query(
        `INSERT INTO "ai_chat_overrides" ("id","chatbotId","chatId","chatbotDisabled") VALUES ('o1','b1','628111@c.us',1)`,
      );
    });

    afterEach(async () => {
      await ds.destroy();
    });

    it('rebuilds each bot with a one-element sessionIds array and preserves the overrides rows', async () => {
      await new ChatbotMultiSession1795000000000().up(ds.createQueryRunner());

      const bots = (await ds.query(`SELECT "id", "sessionIds" FROM "ai_chatbots" ORDER BY "id"`)) as Array<{
        id: string;
        sessionIds: string;
      }>;
      expect(bots).toEqual([
        { id: 'b1', sessionIds: '["sess-1"]' },
        { id: 'b2', sessionIds: '["sess-2"]' },
      ]);

      const overrides = (await ds.query(
        `SELECT "id", "chatbotId", "chatId", "chatbotDisabled" FROM "ai_chat_overrides"`,
      )) as Array<{ id: string; chatbotId: string; chatId: string; chatbotDisabled: number }>;
      expect(overrides).toEqual([{ id: 'o1', chatbotId: 'b1', chatId: '628111@c.us', chatbotDisabled: 1 }]);
    });

    it('is idempotent and down() restores the single-session shape', async () => {
      const migration = new ChatbotMultiSession1795000000000();
      await migration.up(ds.createQueryRunner());
      // hasColumn('sessionIds') now answers true, so a re-run returns without touching data.
      await expect(migration.up(ds.createQueryRunner())).resolves.toBeUndefined();

      await migration.down(ds.createQueryRunner());
      const bots = (await ds.query(`SELECT "id", "sessionId" FROM "ai_chatbots" ORDER BY "id"`)) as Array<{
        id: string;
        sessionId: string;
      }>;
      expect(bots).toEqual([
        { id: 'b1', sessionId: 'sess-1' },
        { id: 'b2', sessionId: 'sess-2' },
      ]);
    });
  });

  describe('Postgres (statement-recording runner)', () => {
    /**
     * Answers probes like a PRE-UP Postgres deployment (no sessionIds, sessionId present) or, with
     * `preDown`, like a PRE-DOWN one (sessionIds present, no sessionId). Both shapes matter: the
     * migration skips ADD/DROP COLUMN when the column is already in the expected state.
     */
    const makeRunner = (preDown = false) => {
      const executed: string[] = [];
      const runner = {
        dataSource: { options: { type: 'postgres' } },
        async hasColumn(_table: string, column: string): Promise<boolean> {
          if (column === 'sessionIds') return preDown;
          if (column === 'sessionId') return !preDown;
          return column === 'chatbotId';
        },
        async hasTable(table: string): Promise<boolean> {
          return table === 'ai_chat_overrides';
        },
        async query(sql: string): Promise<unknown> {
          executed.push(sql);
          return [];
        },
      };
      return { runner, executed };
    };

    it('up() converts in place: no PRAGMA, no parent DROP, ADD COLUMN + jsonb backfill + DROP COLUMN', async () => {
      const { runner, executed } = makeRunner();
      await new ChatbotMultiSession1795000000000().up(runner as never);

      expect(executed.some(sql => /PRAGMA/i.test(sql))).toBe(false);
      // The production failure: dropping the parent while ai_chat_overrides still references it.
      expect(executed.some(sql => /DROP TABLE "ai_chatbots"/i.test(sql))).toBe(false);
      expect(executed.some(sql => /CREATE TABLE "ai_chatbots_new"/i.test(sql))).toBe(false);
      expect(executed.some(sql => /DROP TABLE IF EXISTS "ai_chatbots_new"/i.test(sql))).toBe(true);
      expect(executed.some(sql => /ADD COLUMN "sessionIds" text/.test(sql))).toBe(true);
      expect(executed.some(sql => /jsonb_build_array\("sessionId"\)/.test(sql))).toBe(true);
      expect(executed.some(sql => /ALTER COLUMN "sessionIds" SET NOT NULL/.test(sql))).toBe(true);
      expect(executed.some(sql => /CREATE INDEX (IF NOT EXISTS )?"IDX_ai_chatbots_sessionIds"/.test(sql))).toBe(true);
      expect(executed.some(sql => /DROP COLUMN "sessionId"/.test(sql))).toBe(true);
      // The old column goes LAST, so the backfill ran before it disappeared.
      const backfillAt = executed.findIndex(sql => /jsonb_build_array\("sessionId"\)/.test(sql));
      const dropAt = executed.findIndex(sql => /DROP COLUMN "sessionId"/.test(sql));
      expect(backfillAt).toBeGreaterThan(-1);
      expect(dropAt).toBeGreaterThan(backfillAt);
      expect(executed.some(sql => /datetime\('now'\)/i.test(sql))).toBe(false);
    });

    it('down() restores the single-value column in place with the ->> 0 backfill and re-adds the sessions FK', async () => {
      const { runner, executed } = makeRunner(true);
      await new ChatbotMultiSession1795000000000().down(runner as never);

      expect(executed.some(sql => /PRAGMA/i.test(sql))).toBe(false);
      expect(executed.some(sql => /DROP TABLE "ai_chatbots"/i.test(sql))).toBe(false);
      expect(executed.some(sql => /ADD COLUMN "sessionId" varchar/.test(sql))).toBe(true);
      expect(executed.some(sql => /"sessionIds"::jsonb ->> 0/.test(sql))).toBe(true);
      expect(executed.some(sql => /ADD CONSTRAINT "FK_ai_chatbots_sessionId"/.test(sql))).toBe(true);
      expect(executed.some(sql => /DROP COLUMN "sessionIds"/.test(sql))).toBe(true);
      expect(executed.some(sql => /datetime\('now'\)/i.test(sql))).toBe(false);
    });
  });
});
