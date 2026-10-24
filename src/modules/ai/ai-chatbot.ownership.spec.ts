import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AiChatbotService } from './ai-chatbot.service';
import { AiChatbot } from './entities/ai-chatbot.entity';
import { AiChatOverride } from './entities/ai-chat-override.entity';
import { AiLlmModel } from './entities/ai-llm-model.entity';
import { AiRagModel } from './entities/ai-rag-model.entity';
import { Session, SessionStatus } from '../session/entities/session.entity';
import { Message } from '../message/entities/message.entity';
import type { AuditService } from '../audit/audit.service';
import type { AiRagService } from './ai-rag.service';
import type { ModuleRef } from '@nestjs/core';
import type { ConfigService } from '@nestjs/config';

/**
 * The ownership contract: ONE chatbot may serve MANY sessions, and each session is served by AT
 * MOST ONE chatbot. The service must refuse a second bot claiming an owned session (create AND
 * update), and evaluateInbound must route a session's message to exactly its one bot.
 */
describe('AiChatbotService session ownership (one bot per session, many sessions per bot)', () => {
  let ds: DataSource;
  let service: AiChatbotService;
  let sentTo: Array<{ sessionId: string; chatId: string }>;
  const SESSION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const SESSION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const LLM_ID = '00000000-0000-4000-8000-000000000001';

  const makeService = (): AiChatbotService => {
    const moduleRef = {
      get: (token: unknown) => {
        if (String(token).includes('CONVERSATION_MAPPING')) return { findHandoverForChat: () => Promise.resolve(null) };
        return {
          sendText: (sessionId: string, dto: { chatId: string }) => {
            sentTo.push({ sessionId, chatId: dto.chatId });
            return Promise.resolve({ id: 'w' });
          },
        };
      },
    } as unknown as ModuleRef;
    return new AiChatbotService(
      ds.getRepository(AiChatbot),
      ds.getRepository(AiChatOverride),
      ds.getRepository(Session),
      ds.getRepository(AiLlmModel),
      ds.getRepository(AiRagModel),
      ds.getRepository(Message),
      {
        complete: () => Promise.resolve('answer'),
        completeWithTools: () => Promise.resolve({ content: 'answer', toolCalls: [], rawAssistant: null }),
      } as never,
      { findAll: () => Promise.resolve([]), listTools: () => Promise.resolve([]), callTool: () => Promise.resolve({}) } as never,
      { retrieve: () => Promise.resolve({ context: '', nodes: [], warnings: [] }) } as unknown as AiRagService,
      { logInfo: () => Promise.resolve() } as unknown as AuditService,
      { get: (_k: string, d?: unknown) => d } as unknown as ConfigService,
      moduleRef,
    );
  };

  beforeEach(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Session, AiChatbot, AiChatOverride, AiLlmModel, AiRagModel, Message],
      synchronize: true,
    });
    await ds.initialize();
    await ds.getRepository(Session).save([
      ds.getRepository(Session).create({ id: SESSION_A, name: 'A', status: SessionStatus.READY, config: {} }),
      ds.getRepository(Session).create({ id: SESSION_B, name: 'B', status: SessionStatus.READY, config: {} }),
    ]);
    await ds.getRepository(AiLlmModel).insert({ id: LLM_ID, name: 'llm', endpointUrl: 'http://x', apiKey: '' });
    sentTo = [];
    service = makeService();
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it('one bot can serve two sessions, and each session routes to that single bot', async () => {
    const bot = await service.create({ name: 'Multi', llmModelId: LLM_ID, sessionIds: [SESSION_A, SESSION_B] });
    expect(bot.sessionIds).toEqual([SESSION_A, SESSION_B]);

    await service.evaluateInbound(SESSION_A, { chatId: '111@c.us', body: 'hi', fromMe: false });
    expect(sentTo).toEqual([{ sessionId: SESSION_A, chatId: '111@c.us' }]);

    await service.evaluateInbound(SESSION_B, { chatId: '222@c.us', body: 'hi', fromMe: false });
    expect(sentTo).toEqual([
      { sessionId: SESSION_A, chatId: '111@c.us' },
      { sessionId: SESSION_B, chatId: '222@c.us' },
    ]);
  });

  it('a second bot claiming an owned session is refused on create, and nothing partial is stored', async () => {
    await service.create({ name: 'First', llmModelId: LLM_ID, sessionIds: [SESSION_A] });
    await expect(
      service.create({ name: 'Second', llmModelId: LLM_ID, sessionIds: [SESSION_A, SESSION_B] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    // B was free, but the refusal covers the whole request: no partial claims.
    expect(await service.findAll()).toHaveLength(1);
  });

  it('update cannot steal a session another bot holds', async () => {
    const first = await service.create({ name: 'First', llmModelId: LLM_ID, sessionIds: [SESSION_A] });
    await service.create({ name: 'Second', llmModelId: LLM_ID, sessionIds: [SESSION_B] });

    await expect(service.update(first.id, { sessionIds: [SESSION_A, SESSION_B] })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect((await service.findOne(first.id)).sessionIds).toEqual([SESSION_A]);
  });

  it('a bot may keep its own sessions while growing, and unknown sessions are refused', async () => {
    const bot = await service.create({ name: 'Multi', llmModelId: LLM_ID, sessionIds: [SESSION_A] });
    await expect(service.update(bot.id, { sessionIds: [SESSION_A, SESSION_B] })).resolves.toMatchObject({
      sessionIds: [SESSION_A, SESSION_B],
    });
    await expect(service.update(bot.id, { sessionIds: [SESSION_A, 'nope'] })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('pruneSession drops a deleted session; the last removal deletes the bot', async () => {
    const multi = await service.create({ name: 'Multi', llmModelId: LLM_ID, sessionIds: [SESSION_A, SESSION_B] });
    await service.pruneSession(SESSION_A);
    expect((await service.findOne(multi.id)).sessionIds).toEqual([SESSION_B]);

    await service.pruneSession(SESSION_B);
    await expect(service.findOne(multi.id)).rejects.toBeInstanceOf(NotFoundException);
  });
});
