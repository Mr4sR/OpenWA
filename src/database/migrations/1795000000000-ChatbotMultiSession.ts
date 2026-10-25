import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Chatbot ⇄ session ownership becomes many-to-one: ONE chatbot may serve MANY sessions, and each
 * session is served by AT MOST ONE bot.
 *
 * Two dialects, two strategies:
 *
 * **SQLite** declares a FOREIGN KEY on the old `sessionId` column, and SQLite refuses
 * `DROP COLUMN` while any constraint still names the column. DROP TABLE on a parent whose child
 * (`ai_chat_overrides`) still declares the FK also trips SQLite's constraint checker (it resolves
 * the child's reference mid-rebuild and fails on the already-dropped `sessions`). So the children
 * are parked first:
 *
 *   1. copy `ai_chat_overrides` into a staging table,
 *   2. drop the child TABLE (dropping its FK with it),
 *   3. rebuild `ai_chatbots` in the new shape (`sessionIds` JSON array, one row per bot),
 *   4. recreate `ai_chat_overrides` with its FK pointed at the new `ai_chatbots`,
 *   5. restore the staged rows.
 *
 * PRAGMA foreign_keys is toggled around the work so the rebuild never depends on the enforcement
 * mode the host booted with.
 *
 * **PostgreSQL** disallows PRAGMA entirely (the failure that motivated this branch): the table is
 * rebuilt with `ALTER TABLE ... RENAME` + plain CREATE/INSERT/DROP, which Postgres handles without
 * disabling anything — dropping a child table's FK never blocks a parent-table rename/rebuild
 * there. `sessionIds` is built with Postgres's own `jsonb_build_array` (always available, no
 * string surgery), and `down()` extracts the FIRST array element back to a plain `sessionId`
 * column with the `->> 0` operator. Timestamps keep `timestamp` + `NOW()` defaults, booleans
 * `true`/`false`, per the baseline AI tables' Postgres shapes.
 */
export class ChatbotMultiSession1795000000000 implements MigrationInterface {
  name = 'ChatbotMultiSession1795000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasColumn('ai_chatbots', 'sessionIds')) return;
    await this.rebuildToSessionIds(queryRunner);
  }

  private async rebuildToSessionIds(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.dataSource.options.type === 'postgres';
    const hadOverrides = await queryRunner.hasTable('ai_chat_overrides');

    if (isPostgres) {
      const hadOverridesOldShape = hadOverrides && (await queryRunner.hasColumn('ai_chat_overrides', 'chatbotId'));

      // The overrides table keeps its shape and its FK survives the parent swap untouched on
      // Postgres: the FK references `ai_chatbots.id` BY NAME, so a drop + create (not rename),
      // done in one transaction by the MigrationExecutor, is safe — the constraint revalidates
      // against the new table that carries the same ids.
      await queryRunner.query(
        `CREATE TABLE "ai_chatbots_new" (` +
          `"id" varchar PRIMARY KEY NOT NULL, ` +
          `"sessionIds" text NOT NULL DEFAULT '[]', ` +
          `"name" varchar(100) NOT NULL, ` +
          `"llmModelId" varchar(36) NOT NULL, ` +
          `"ragModelId" varchar(36), ` +
          `"persona" text, ` +
          `"mcpToolIds" text, ` +
          `"replyGroups" boolean NOT NULL DEFAULT false, ` +
          `"enabled" boolean NOT NULL DEFAULT true, ` +
          `"lastRepliedAt" timestamp, ` +
          `"lastError" text, ` +
          `"createdAt" timestamp NOT NULL DEFAULT NOW(), ` +
          `"updatedAt" timestamp NOT NULL DEFAULT NOW()` +
          `)`,
      );
      // jsonb_build_array(sessionId)::text → `["<id>"]`, exactly the simple-json shape the entity
      // writes (JSON.stringify of a one-element string array).
      await queryRunner.query(
        `INSERT INTO "ai_chatbots_new" ` +
          `("id", "sessionIds", "name", "llmModelId", "ragModelId", "persona", "mcpToolIds", "replyGroups", "enabled", "lastRepliedAt", "lastError", "createdAt", "updatedAt") ` +
          `SELECT "id", jsonb_build_array("sessionId")::text, "name", "llmModelId", "ragModelId", "persona", "mcpToolIds", "replyGroups", "enabled", "lastRepliedAt", "lastError", "createdAt", "updatedAt" FROM "ai_chatbots"`,
      );
      await queryRunner.query(`DROP TABLE "ai_chatbots"`);
      await queryRunner.query(`ALTER TABLE "ai_chatbots_new" RENAME TO "ai_chatbots"`);
      await queryRunner.query(`CREATE INDEX "IDX_ai_chatbots_sessionIds" ON "ai_chatbots" ("sessionIds")`);

      if (hadOverrides && !hadOverridesOldShape) {
        // The overrides table was staged away in an earlier FAILED attempt of this migration and
        // never restored (the old SQLite-first script ran its PRAGMA and aborted). Recreate it.
        await this.createOverridesPostgres(queryRunner);
      }
      return;
    }

    // ── SQLite ──
    await queryRunner.query('PRAGMA foreign_keys = OFF');
    try {
      if (hadOverrides) {
        await queryRunner.query(`CREATE TABLE "ai_chat_overrides_stage" AS SELECT * FROM "ai_chat_overrides"`);
        await queryRunner.query(`DROP TABLE "ai_chat_overrides"`);
      }

      await queryRunner.query(
        `CREATE TABLE "ai_chatbots_new" (` +
          `"id" varchar PRIMARY KEY NOT NULL, ` +
          `"sessionIds" text NOT NULL DEFAULT '[]', ` +
          `"name" varchar(100) NOT NULL, ` +
          `"llmModelId" varchar(36) NOT NULL, ` +
          `"ragModelId" varchar(36), ` +
          `"persona" text, ` +
          `"mcpToolIds" text, ` +
          `"replyGroups" boolean NOT NULL DEFAULT 0, ` +
          `"enabled" boolean NOT NULL DEFAULT 1, ` +
          `"lastRepliedAt" datetime, ` +
          `"lastError" text, ` +
          `"createdAt" datetime NOT NULL DEFAULT (datetime('now')), ` +
          `"updatedAt" datetime NOT NULL DEFAULT (datetime('now'))` +
          `)`,
      );
      // '[' + '"' + id + '"' + ']' by concatenation: JSON1's JSON_ARRAY is not on every build.
      await queryRunner.query(
        `INSERT INTO "ai_chatbots_new" ` +
          `("id", "sessionIds", name, "llmModelId", "ragModelId", persona, "mcpToolIds", "replyGroups", enabled, "lastRepliedAt", "lastError", "createdAt", "updatedAt") ` +
          `SELECT id, '[' || CHAR(34) || "sessionId" || CHAR(34) || ']', name, "llmModelId", "ragModelId", persona, "mcpToolIds", "replyGroups", enabled, "lastRepliedAt", "lastError", "createdAt", "updatedAt" FROM "ai_chatbots"`,
      );
      await queryRunner.query(`DROP TABLE "ai_chatbots"`);
      await queryRunner.query(`ALTER TABLE "ai_chatbots_new" RENAME TO "ai_chatbots"`);
      await queryRunner.query(`CREATE INDEX "IDX_ai_chatbots_sessionIds" ON "ai_chatbots" ("sessionIds")`);

      if (hadOverrides) {
        await this.createOverridesSqlite(queryRunner);
        await queryRunner.query(
          `INSERT INTO "ai_chat_overrides" ("id", "chatbotId", "chatId", "chatbotDisabled", "createdAt", "updatedAt") ` +
            `SELECT "id", "chatbotId", "chatId", "chatbotDisabled", "createdAt", "updatedAt" FROM "ai_chat_overrides_stage"`,
        );
        await queryRunner.query(`DROP TABLE "ai_chat_overrides_stage"`);
        await queryRunner.query(`CREATE INDEX "IDX_ai_chat_overrides_chatbotId" ON "ai_chat_overrides" ("chatbotId")`);
      }
    } finally {
      await queryRunner.query('PRAGMA foreign_keys = ON');
    }
  }

  private async createOverridesPostgres(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "ai_chat_overrides" (` +
        `"id" varchar PRIMARY KEY NOT NULL, ` +
        `"chatbotId" varchar(36) NOT NULL, ` +
        `"chatId" varchar(255) NOT NULL, ` +
        `"chatbotDisabled" boolean NOT NULL DEFAULT false, ` +
        `"createdAt" timestamp NOT NULL DEFAULT NOW(), ` +
        `"updatedAt" timestamp NOT NULL DEFAULT NOW(), ` +
        `CONSTRAINT "UQ_ai_chat_overrides_chatbot_chat" UNIQUE ("chatbotId", "chatId"), ` +
        `CONSTRAINT "FK_ai_chat_overrides_chatbot" FOREIGN KEY ("chatbotId") REFERENCES "ai_chatbots" ("id") ON DELETE CASCADE ON UPDATE NO ACTION` +
        `)`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_ai_chat_overrides_chatbotId" ON "ai_chat_overrides" ("chatbotId")`);
  }

  private async createOverridesSqlite(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "ai_chat_overrides" (` +
        `"id" varchar PRIMARY KEY NOT NULL, ` +
        `"chatbotId" varchar(36) NOT NULL, ` +
        `"chatId" varchar(255) NOT NULL, ` +
        `"chatbotDisabled" boolean NOT NULL DEFAULT 0, ` +
        `"createdAt" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `"updatedAt" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `CONSTRAINT "UQ_ai_chat_overrides_chatbot_chat" UNIQUE ("chatbotId", "chatId"), ` +
        `CONSTRAINT "FK_ai_chat_overrides_chatbot" FOREIGN KEY ("chatbotId") REFERENCES "ai_chatbots" ("id") ON DELETE CASCADE ON UPDATE NO ACTION` +
        `)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasColumn('ai_chatbots', 'sessionId')) return;

    const isPostgres = queryRunner.dataSource.options.type === 'postgres';
    const hadOverrides = await queryRunner.hasTable('ai_chat_overrides');

    if (isPostgres) {
      // First-session-wins collapse: an array-shaped bot that served N sessions becomes ONE bot on
      // its first (oldest by array position, which pushes append order) session id.
      await queryRunner.query(
        `CREATE TABLE "ai_chatbots_old" (` +
          `"id" varchar PRIMARY KEY NOT NULL, ` +
          `"sessionId" varchar NOT NULL, ` +
          `"name" varchar(100) NOT NULL, ` +
          `"llmModelId" varchar(36) NOT NULL, ` +
          `"ragModelId" varchar(36), ` +
          `"persona" text, ` +
          `"mcpToolIds" text, ` +
          `"replyGroups" boolean NOT NULL DEFAULT false, ` +
          `"enabled" boolean NOT NULL DEFAULT true, ` +
          `"lastRepliedAt" timestamp, ` +
          `"lastError" text, ` +
          `"createdAt" timestamp NOT NULL DEFAULT NOW(), ` +
          `"updatedAt" timestamp NOT NULL DEFAULT NOW()` +
          `)`,
      );
      await queryRunner.query(
        `INSERT INTO "ai_chatbots_old" ` +
          `("id", "sessionId", "name", "llmModelId", "ragModelId", "persona", "mcpToolIds", "replyGroups", "enabled", "lastRepliedAt", "lastError", "createdAt", "updatedAt") ` +
          `SELECT "id", "sessionIds"::jsonb ->> 0, "name", "llmModelId", "ragModelId", "persona", "mcpToolIds", "replyGroups", "enabled", "lastRepliedAt", "lastError", "createdAt", "updatedAt" FROM "ai_chatbots"`,
      );
      await queryRunner.query(`DROP TABLE "ai_chatbots"`);
      await queryRunner.query(`ALTER TABLE "ai_chatbots_old" RENAME TO "ai_chatbots"`);
      await queryRunner.query(`CREATE INDEX "IDX_ai_chatbots_sessionId" ON "ai_chatbots" ("sessionId")`);
      return;
    }

    await queryRunner.query('PRAGMA foreign_keys = OFF');
    try {
      if (hadOverrides) {
        await queryRunner.query(`CREATE TABLE "ai_chat_overrides_stage" AS SELECT * FROM "ai_chat_overrides"`);
        await queryRunner.query(`DROP TABLE "ai_chat_overrides"`);
      }

      await queryRunner.query(
        `CREATE TABLE "ai_chatbots_old" (` +
          `"id" varchar PRIMARY KEY NOT NULL, ` +
          `"sessionId" varchar NOT NULL, ` +
          `"name" varchar(100) NOT NULL, ` +
          `"llmModelId" varchar(36) NOT NULL, ` +
          `"ragModelId" varchar(36), ` +
          `"persona" text, ` +
          `"mcpToolIds" text, ` +
          `"replyGroups" boolean NOT NULL DEFAULT 0, ` +
          `"enabled" boolean NOT NULL DEFAULT 1, ` +
          `"lastRepliedAt" datetime, ` +
          `"lastError" text, ` +
          `"createdAt" datetime NOT NULL DEFAULT (datetime('now')), ` +
          `"updatedAt" datetime NOT NULL DEFAULT (datetime('now'))` +
          `)`,
      );
      // Keep the FIRST session of each bot (string surgery: JSON1 may be unavailable).
      await queryRunner.query(
        `INSERT INTO "ai_chatbots_old" ` +
          `("id", "sessionId", name, "llmModelId", "ragModelId", persona, "mcpToolIds", "replyGroups", enabled, "lastRepliedAt", "lastError", "createdAt", "updatedAt") ` +
          `SELECT id, REPLACE(REPLACE(RTRIM("sessionIds", ']'), '[', ''), CHAR(34), ''), name, "llmModelId", "ragModelId", persona, "mcpToolIds", "replyGroups", enabled, "lastRepliedAt", "lastError", "createdAt", "updatedAt" FROM "ai_chatbots"`,
      );
      await queryRunner.query(`DROP TABLE "ai_chatbots"`);
      await queryRunner.query(`ALTER TABLE "ai_chatbots_old" RENAME TO "ai_chatbots"`);
      await queryRunner.query(`CREATE INDEX "IDX_ai_chatbots_sessionId" ON "ai_chatbots" ("sessionId")`);

      if (hadOverrides) {
        await this.createOverridesSqlite(queryRunner);
        await queryRunner.query(
          `INSERT INTO "ai_chat_overrides" ("id", "chatbotId", "chatId", "chatbotDisabled", "createdAt", "updatedAt") ` +
            `SELECT "id", "chatbotId", "chatId", "chatbotDisabled", "createdAt", "updatedAt" FROM "ai_chat_overrides_stage"`,
        );
        await queryRunner.query(`DROP TABLE "ai_chat_overrides_stage"`);
        await queryRunner.query(`CREATE INDEX "IDX_ai_chat_overrides_chatbotId" ON "ai_chat_overrides" ("chatbotId")`);
      }
    } finally {
      await queryRunner.query('PRAGMA foreign_keys = ON');
    }
  }
}
