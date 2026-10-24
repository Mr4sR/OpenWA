import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Records what a provider connection proved it can do at test time.
 *
 * `ai_llm_models.capabilities` is a JSON object `{ vision: boolean, at: ISO string }` — `vision`
 * is proven by sending a tiny base64 image through a chat-completions call and getting any answer
 * back. NULL (every existing row) means "never probed with this endpoint/model id", the same
 * posture the row starts in before its first `POST .../test`; saving a model from the dashboard
 * re-probes it, so the flag turns on without any manual step.
 */
export class AddAiLlmModelCapabilities1796000000000 implements MigrationInterface {
  name = 'AddAiLlmModelCapabilities1796000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasColumn('ai_llm_models', 'capabilities'))) {
      await queryRunner.query(`ALTER TABLE "ai_llm_models" ADD COLUMN "capabilities" text`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasColumn('ai_llm_models', 'capabilities')) {
      await queryRunner.query(`ALTER TABLE "ai_llm_models" DROP COLUMN "capabilities"`);
    }
  }
}
