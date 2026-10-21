import { DataSource } from 'typeorm';
import { AiChatbot } from './entities/ai-chatbot.entity';
import { AiLlmModel } from './entities/ai-llm-model.entity';
import { AiRagModel, AiRagDocument } from './entities/ai-rag-model.entity';
import { AiMcpConnection } from './entities/ai-mcp-connection.entity';
import { Session } from '../session/entities/session.entity';
import { Message } from '../message/entities/message.entity';
import { AiChatbotService } from './ai-chatbot.service';
import { AiLlmModelsService } from './ai-llm-models.service';
import { AiRagService } from './ai-rag.service';
import { StorageService } from '../../common/storage/storage.service';
import { PLUGIN_MESSAGE_PORT, type PluginMessagePort } from '../../core/plugins/plugin-host-ports';

/**
 * Behaviour spec for the chatbot evaluation path, mirroring the shape of the automation-rules spec:
 * a real in-memory better-sqlite3 data source, a fake message port capturing sendText, and a
 * stubbed LLM completion.
 */
describe('AiChatbotService', () => {
  let ds: DataSource;
  let service: AiChatbotService;
  let llmModels: { complete: jest.Mock };
  let sent: Array<{ sessionId: string; dto: { chatId: string; text: string } }>;
  let llmModelId: string;
  let sessionId: string;
  const createSession = async (id: string): Promise<void> => {
    await ds.getRepository(Session).save({ id, name: `s-${id}` });
  };

  beforeEach(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Session, Message, AiChatbot, AiLlmModel, AiRagModel, AiRagDocument, AiMcpConnection],
      synchronize: true,
    });
    await ds.initialize();

    sent = [];
    const messagePort = {
      sendText: async (sessionId: string, dto: { chatId: string; text: string }) => {
        sent.push({ sessionId, dto });
        return { id: 'm1' } as never;
      },
      reply: async () => ({ id: 'm1' }) as never,
    } as unknown as PluginMessagePort;

    const llmRepository = ds.getRepository(AiLlmModel);
    const model = await llmRepository.save(
      llmRepository.create({ name: 'm', endpointUrl: 'http://llm.test/v1', apiKey: 'k', model: 'gpt-x' }),
    );
    llmModelId = model.id;

    llmModels = { complete: jest.fn().mockResolvedValue('hello from the bot') };
    const storage = { getFile: jest.fn() } as unknown as StorageService;
    const audit = { logInfo: jest.fn().mockResolvedValue(null) } as never;
    const rag = new AiRagService(
      ds.getRepository(AiRagModel),
      ds.getRepository(AiRagDocument),
      llmModels as unknown as AiLlmModelsService,
      storage,
      audit,
      undefined,
    );

    service = new AiChatbotService(
      ds.getRepository(AiChatbot),
      ds.getRepository(Session),
      llmRepository,
      ds.getRepository(AiRagModel),
      ds.getRepository(Message),
      llmModels as unknown as AiLlmModelsService,
      rag,
      audit,
      undefined,
      {
        get: (token: unknown) => (token === PLUGIN_MESSAGE_PORT ? messagePort : undefined),
      } as never,
    );
  });

  afterEach(async () => {
    await ds.destroy();
  });

  const createBot = async (patch: Partial<{ cooldownSeconds: number; chatIds: string[] | null; contextMessages: number }> = {}) => {
    sessionId = 's1';
    await createSession(sessionId);
    const created = await service.create(sessionId, {
      name: 'bot',
      llmModelId,
      chatIds: patch.chatIds ?? null,
      cooldownSeconds: patch.cooldownSeconds ?? 0,
      contextMessages: patch.contextMessages ?? 0,
    });
    return created;
  };

  it('answers the first inbound message through the message port', async () => {
    await createBot();
    await service.evaluateInbound(sessionId, { chatId: '6281@c.us', body: 'hi', timestamp: Date.now() / 1000 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ sessionId, dto: { chatId: '6281@c.us', text: 'hello from the bot' } });
    expect(llmModels.complete).toHaveBeenCalledTimes(1);
  });

  it('does not answer its own messages (fromMe)', async () => {
    await createBot();
    await service.evaluateInbound(sessionId, { chatId: '6281@c.us', body: 'hi', fromMe: true });
    expect(sent).toHaveLength(0);
  });

  it('answers only the chats of a non-empty allowlist', async () => {
    await createBot({ chatIds: ['6282@c.us'] });
    await service.evaluateInbound(sessionId, { chatId: '6281@c.us', body: 'hi' });
    expect(sent).toHaveLength(0);
    await service.evaluateInbound(sessionId, { chatId: '6282@c.us', body: 'hi' });
    expect(sent).toHaveLength(1);
  });

  it('a bare phone allowlist entry matches the @c.us chat id', async () => {
    await createBot({ chatIds: ['6282'] });
    await service.evaluateInbound(sessionId, { chatId: '6282@c.us', body: 'hi' });
    expect(sent).toHaveLength(1);
  });

  it('keeps the per-(bot, chat) cooldown', async () => {
    await createBot({ cooldownSeconds: 60 });
    const message = { chatId: '6281@c.us', body: 'hi', timestamp: Date.now() / 1000 };
    await service.evaluateInbound(sessionId, message);
    await service.evaluateInbound(sessionId, { ...message, body: 'again' });
    expect(sent).toHaveLength(1);
  });

  it('ignores stale messages (the reconnect backlog)', async () => {
    await createBot();
    await service.evaluateInbound(sessionId, { chatId: '6281@c.us', body: 'hi', timestamp: Date.now() / 1000 - 3600 });
    expect(sent).toHaveLength(0);
  });

  it('records the failure on the bot row when the model call fails, without throwing', async () => {
    await createBot();
    llmModels.complete.mockRejectedValueOnce(new Error('LLM HTTP 503'));
    await expect(
      service.evaluateInbound(sessionId, { chatId: '6281@c.us', body: 'hi' }),
    ).resolves.toBeUndefined();
    expect(sent).toHaveLength(0);
    const bot = await ds.getRepository(AiChatbot).findOne({ where: { name: 'bot' } });
    expect(bot?.lastError).toContain('LLM HTTP 503');
  });

  it('refuses to create a chatbot for a missing session', async () => {
    await expect(service.create('nope', { name: 'b', llmModelId })).rejects.toMatchObject({ status: 404 });
  });

  it('refuses a chatbot pointing at a missing LLM model', async () => {
    await createSession('s2');
    await expect(service.create('s2', { name: 'b', llmModelId: 'missing' })).rejects.toMatchObject({ status: 400 });
  });
});
