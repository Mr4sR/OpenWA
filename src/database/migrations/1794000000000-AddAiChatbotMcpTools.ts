import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Gives an AI chatbot a list of MCP tools it may call.
 *
 * `ai_chatbots.mcpToolIds` is a JSON array of `"<connectionId>:<toolName>"` — the narrowing an
 * operator applies on the bot. `NULL` (every existing row) means "every tool the enabled MCP
 * connections advertise", so the feature turns on for existing bots with no manual setup; tools
 * are read live from each server at reply time, so a server gaining a tool needs no migration and
 * no edit to the bot.
 */
export class AddAiChatbotMcpTools1794000000000 implements MigrationInterface {
  name = 'AddAiChatbotMcpTools1794000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // `simple-json` storage: JSON.stringify'd TEXT, dialect-portable (the baseline AI tables use
    // the same shape). TEXT with no default — not `DEFAULT '[]'` — is what makes existing rows
    // read as "every tool", the turn-it-on-with-zero-setup posture this migration wants.
    if (!(await queryRunner.hasColumn('ai_chatbots', 'mcpToolIds'))) {
      await queryRunner.query(`ALTER TABLE "ai_chatbots" ADD COLUMN "mcpToolIds" text`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasColumn('ai_chatbots', 'mcpToolIds')) {
      await queryRunner.query(`ALTER TABLE "ai_chatbots" DROP COLUMN "mcpToolIds"`);
    }
  }
}
