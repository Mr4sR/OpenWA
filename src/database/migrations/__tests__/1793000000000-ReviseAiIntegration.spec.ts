import { DataSource } from 'typeorm';
import { AddAiIntegration1792000000000 } from '../1792000000000-AddAiIntegration';
import { ReviseAiIntegration1793000000000 } from '../1793000000000-ReviseAiIntegration';

describe('ReviseAiIntegration migration', () => {
  let ds: DataSource;

  beforeEach(async () => {
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:' });
    await ds.initialize();
    const runner = ds.createQueryRunner();
    await new AddAiIntegration1792000000000().up(runner);
    await runner.release();
  });

  afterEach(async () => {
    await ds.destroy();
  });

  const columnsOf = async (table: string): Promise<string[]> =>
    (await ds.query(`PRAGMA table_info("${table}")`)).map((r: { name: string }) => r.name).sort();

  it('drops the persona / chatIds / cooldown / history columns and adds replyGroups + overrides + statuses', async () => {
    const runner = ds.createQueryRunner();
    await new ReviseAiIntegration1793000000000().up(runner);
    await runner.release();

    const llm = await columnsOf('ai_llm_models');
    expect(llm).not.toContain('persona');

    const chatbots = await columnsOf('ai_chatbots');
    expect(chatbots).not.toContain('chatIds');
    expect(chatbots).not.toContain('cooldownSeconds');
    expect(chatbots).not.toContain('contextMessages');
    expect(chatbots).toContain('replyGroups');

    const overrides = await columnsOf('ai_chat_overrides');
    expect(overrides).toEqual(expect.arrayContaining(['id', 'chatbotId', 'chatId', 'chatbotDisabled']));

    const documents = await columnsOf('ai_rag_documents');
    expect(documents).toContain('status');
    expect(documents).toContain('statusError');

    const connections = await columnsOf('ai_mcp_connections');
    expect(connections).toContain('transport');
  });

  it('is idempotent (a re-run is a no-op) and down restores the old shape', async () => {
    const runner = ds.createQueryRunner();
    const migration = new ReviseAiIntegration1793000000000();
    await migration.up(runner);
    await expect(migration.up(runner)).resolves.toBeUndefined();

    await migration.down(runner);
    const chatbots = await columnsOf('ai_chatbots');
    expect(chatbots).toContain('chatIds');
    expect(chatbots).toContain('cooldownSeconds');
    expect((await columnsOf('ai_llm_models'))).toContain('persona');
    expect((await ds.query("SELECT name FROM sqlite_master WHERE type='table' AND name='ai_chat_overrides'")).length).toBe(0);
    await runner.release();
  });
});
