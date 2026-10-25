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

  /**
   * The old `sessionId` column carries a FOREIGN KEY (`FK_ai_chatbots_sessionId` → sessions.id).
   * On Postgres, dropping the PARENT table while the `ai_chat_overrides` child table still
   * references it is refused (`cannot drop table ai_chatbots because other objects depend on it` —
   * the exact production failure that motivated this branch). The right Postgres move is an
   * IN-PLACE conversion: ADD COLUMN + backfill + DROP COLUMN. The table identity never changes, so
   * both the sessions FK and the overrides child FK stay valid throughout. A stale
   * `ai_chatbots_new` staging table from the previously-shipped, failed attempt is dropped first
   * so a rerun begins clean.
   */
  private async rebuildToSessionIds(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.dataSource.options.type === 'postgres';

    if (isPostgres) {
      // Cleanup of the previously-shipped attempt: a run that failed at its DROP TABLE left
      // ai_chatbots_new (and possibly a staged overrides copy) behind. The live ai_chat_overrides
      // was never dropped on Postgres, so there is nothing to restore.
      await queryRunner.query(`DROP TABLE IF EXISTS "ai_chatbots_new"`);
      await queryRunner.query(`DROP TABLE IF EXISTS "ai_chat_overrides_stage"`);

      // Idempotent against a PARTIAL earlier failure (the boot retry loop reruns the whole
      // migration after any statement rolls back, but a previous RELEASE's interrupted run can
      // leave column or index behind): each step probes before acting.
      const hasSessionIds = await queryRunner.hasColumn('ai_chatbots', 'sessionIds');
      if (!hasSessionIds) {
        // 1. The new column, nullable for the backfill (NOT NULL arrives after the fill below).
        await queryRunner.query(`ALTER TABLE "ai_chatbots" ADD COLUMN "sessionIds" text`);
      }
      // 2. `jsonb_build_array(sessionId)::text` → `["<id>"]`, the exact simple-json shape the
      //    entity writes (JSON.stringify of a one-element string array). WHERE guards the rerun
      //    where sessionId is already gone: rows keep their filled sessionIds, nothing is nulled.
      await queryRunner.query(
        `UPDATE "ai_chatbots" SET "sessionIds" = jsonb_build_array("sessionId")::text WHERE "sessionId" IS NOT NULL`,
      );
      // 3. Tighten the column and add the index the new shape needs (IF NOT EXISTS: a rerun after
      //    a failed DROP COLUMN would otherwise double-create the index).
      await queryRunner.query(`ALTER TABLE "ai_chatbots" ALTER COLUMN "sessionIds" SET NOT NULL`);
      await queryRunner.query(`ALTER TABLE "ai_chatbots" ALTER COLUMN "sessionIds" SET DEFAULT '[]'`);
      await queryRunner.query(
        `CREATE INDEX IF NOT EXISTS "IDX_ai_chatbots_sessionIds" ON "ai_chatbots" ("sessionIds")`,
      );
      // 4. The old column is dropped LAST; its sessions FK (`FK_ai_chatbots_sessionId`) disappears
      //    with it. Dropping a child-side column never touches the referenced sessions rows: bots
      //    keep their rows and overrides rows keep their chatbotId. No child parking needed.
      if (await queryRunner.hasColumn('ai_chatbots', 'sessionId')) {
        await queryRunner.query(`ALTER TABLE "ai_chatbots" DROP COLUMN "sessionId"`);
      }
      return;
    }

    // ── SQLite: the table-swap dance must stay — SQLite refuses DROP COLUMN while a FK constraint
    // still names the column, and dropping the parent under a live child trips its checker.
    const hadOverrides = await queryRunner.hasTable('ai_chat_overrides');
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

    if (isPostgres) {
      // In-place, mirroring up(): ADD the single-value column, fill it with the FIRST array
      // element (`->> 0`), drop the array. Bots that served more than one session collapse to the
      // first (the array appends in bind order). The sessions FK is re-declared explicitly — the
      // column drop in up() removed it together with the column.
      await queryRunner.query(`ALTER TABLE "ai_chatbots" ADD COLUMN "sessionId" varchar`);
      await queryRunner.query(`UPDATE "ai_chatbots" SET "sessionId" = "sessionIds"::jsonb ->> 0`);
      await queryRunner.query(`DELETE FROM "ai_chatbots" WHERE "sessionId" IS NULL`);
      await queryRunner.query(`ALTER TABLE "ai_chatbots" ALTER COLUMN "sessionId" SET NOT NULL`);
      await queryRunner.query(`CREATE INDEX "IDX_ai_chatbots_sessionId" ON "ai_chatbots" ("sessionId")`);
      await queryRunner.query(`ALTER TABLE "ai_chatbots" DROP COLUMN "sessionIds"`);
      await queryRunner.query(
        `ALTER TABLE "ai_chatbots" ADD CONSTRAINT "FK_ai_chatbots_sessionId" ` +
          `FOREIGN KEY ("sessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
      );
      return;
    }
    await queryRunner.query('PRAGMA foreign_keys = OFF');
    try {
      const hadOverrides = await queryRunner.hasTable('ai_chat_overrides');
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
