// The Chats page switch is only real if the inbound path honors it under BOTH id dialects the
// engine can use for one 1:1 chat, and if a conversation a human holds is left alone by every bot.
// These run against a real in-memory DB so the override lookup is exercised end-to-end (aliases,
// the unique pair, the cascade), with the lid store and the handover port as narrow fakes.
import { DataSource } from 'typeorm';
import { AiChatbotService } from './ai-chatbot.service';
import { AiChatbot } from './entities/ai-chatbot.entity';
import { AiChatOverride } from './entities/ai-chat-override.entity';
import { AiLlmModel } from './entities/ai-llm-model.entity';
import { AiRagModel } from './entities/ai-rag-model.entity';
import { Message } from '../message/entities/message.entity';
import { Session, SessionStatus } from '../session/entities/session.entity';
// The service takes the CONCRETE store (a DI class), not the structural interface the engine
// utilities accept; the fake is cast at construction because only two lookups are exercised.
import type { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import type { ModuleRef } from '@nestjs/core';
import type { ConfigService } from '@nestjs/config';
import type { AuditService } from '../audit/audit.service';
import type { AiRagService } from './ai-rag.service';

const SESSION = 'sess-1';
const LID = '111222333';
const PHONE = '628111222333';
const LID_CHAT = `${LID}@lid`;
const PHONE_CHAT = `${PHONE}@c.us`;

describe('AiChatbotService — per-chat switches and the operator-managed gate', () => {
  let ds: DataSource;
  let service: AiChatbotService;
  let bot: AiChatbot;
  let sends: Array<{ sessionId: string; chatId: string; text: string }>;
  let lidStore: LidMappingStoreService;
  let handover: { pluginId: string; handoverState: 'bot' | 'human' | 'closed' } | null;

  const makeService = (lid?: LidMappingStoreService): AiChatbotService => {
    const moduleRef = {
      get: (token: unknown) => {
        if (String(token).includes('CONVERSATION_MAPPING')) {
          return { findHandoverForChat: () => Promise.resolve(handover) };
        }
        return {
          sendText: (sessionId: string, dto: { chatId: string; text: string }) => {
            sends.push({ sessionId, chatId: dto.chatId, text: dto.text });
            return Promise.resolve({ id: 'wamid.out' });
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
      { complete: () => Promise.resolve('answer'), completeWithTools: () => Promise.resolve({ content: 'answer', toolCalls: [], rawAssistant: null }) } as never,
      { findAll: () => Promise.resolve([]), listTools: () => Promise.resolve([]), callTool: () => Promise.resolve({}) } as never,
      { retrieve: () => Promise.resolve({ context: '', nodes: [], warnings: [] }) } as unknown as AiRagService,
      { logInfo: () => Promise.resolve() } as unknown as AuditService,
      { get: (_key: string, def?: unknown) => def } as unknown as ConfigService,
      moduleRef,
      lid,
    );
  };

  const inbound = (chatId: string) => ({ chatId, body: 'hello', fromMe: false });

  beforeEach(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Session, AiChatbot, AiChatOverride, AiLlmModel, AiRagModel, Message],
      synchronize: true,
    });
    await ds.initialize();
    const sessions = ds.getRepository(Session);
    await sessions.save(sessions.create({ id: SESSION, name: SESSION, status: SessionStatus.READY, config: {} }));
    const llmId = '00000000-0000-4000-8000-000000000001';
    await ds.getRepository(AiLlmModel).insert({ id: llmId, name: 'llm', endpointUrl: 'http://x', apiKey: '' });
    bot = await ds.getRepository(AiChatbot).save(
      ds.getRepository(AiChatbot).create({
        sessionIds: [SESSION],
        name: 'Support',
        llmModelId: llmId,
        enabled: true,
      }),
    );
    sends = [];
    handover = null;
    // A lid resolves to its phone, and the phone back to that lid: the two forms of one chat.
    // The REAL store strips the domain (its lookup runs `userPart(jid)`), and the shared candidate
    // helper passes the bare user-part — so the fake must match digits, not a full JID.
    lidStore = {
      findPhoneForLid: (jid: string) => Promise.resolve(jid.split('@')[0] === LID ? PHONE : null),
      findLidsForPhone: (phone: string) => Promise.resolve(phone === PHONE ? [LID] : []),
    } as unknown as LidMappingStoreService;
    service = makeService(lidStore);
  });

  afterEach(async () => {
    await ds.destroy();
  });

  describe('a muted conversation stays muted under both id dialects', () => {
    it('stores nothing for a conversation it just muted, but reports the mute on refresh', async () => {
      await service.setChatOverride(SESSION, bot.id, PHONE_CHAT, true);
      const states = await service.getChatOverrides(SESSION, [PHONE_CHAT]);
      expect(states.get(PHONE_CHAT)).toEqual([bot.id]);
    });

    it('a mute written under the lid governs an inbound message that carries the phone', async () => {
      await service.setChatOverride(SESSION, bot.id, LID_CHAT, true);
      await service.evaluateInbound(SESSION, inbound(PHONE_CHAT));
      expect(sends).toEqual([]);
    });

    it('a mute written under the phone governs an inbound message that carries the lid', async () => {
      await service.setChatOverride(SESSION, bot.id, PHONE_CHAT, true);
      await service.evaluateInbound(SESSION, inbound(LID_CHAT));
      expect(sends).toEqual([]);
    });

    it('the refresh read reports a lid-recorded mute under the phone the sidebar shows, and vice versa', async () => {
      await service.setChatOverride(SESSION, bot.id, LID_CHAT, true);
      expect((await service.getChatOverrides(SESSION, [PHONE_CHAT])).get(PHONE_CHAT)).toEqual([bot.id]);
      expect((await service.getChatOverrides(SESSION, [LID_CHAT])).get(LID_CHAT)).toEqual([bot.id]);
    });

    it('enabling the bot again removes the row and lets the answer through', async () => {
      await service.setChatOverride(SESSION, bot.id, PHONE_CHAT, true);
      await service.setChatOverride(SESSION, bot.id, PHONE_CHAT, false);
      expect(await service.getChatOverrides(SESSION, [PHONE_CHAT])).toEqual(new Map());
      await service.evaluateInbound(SESSION, inbound(PHONE_CHAT));
      expect(sends.map(s => s.chatId)).toEqual([PHONE_CHAT]);
    });

    it('without the lid store only the literal id matches — the pre-aliased behavior', async () => {
      const plain = makeService(undefined);
      await plain.setChatOverride(SESSION, bot.id, LID_CHAT, true);
      await plain.evaluateInbound(SESSION, inbound(PHONE_CHAT));
      expect(sends.map(s => s.chatId)).toEqual([PHONE_CHAT]);
    });
  });

  describe('a conversation a human holds is answered by nobody', () => {
    it.each(['human', 'closed'] as const)('suppresses every bot while the handover is %s', async state => {
      handover = { pluginId: 'chatwoot', handoverState: state };
      await service.evaluateInbound(SESSION, inbound(PHONE_CHAT));
      expect(sends).toEqual([]);
    });

    it('answers again once the conversation is handed back to the bot', async () => {
      handover = { pluginId: 'chatwoot', handoverState: 'human' };
      await service.evaluateInbound(SESSION, inbound(PHONE_CHAT));
      handover = null;
      await service.evaluateInbound(SESSION, inbound(PHONE_CHAT));
      expect(sends.map(s => s.chatId)).toEqual([PHONE_CHAT]);
    });

    it('fail-open: a dead handover lookup does not silence the bot', async () => {
      const moduleRef = {
        get: (token: unknown) => {
          if (String(token).includes('CONVERSATION_MAPPING')) {
            return { findHandoverForChat: () => Promise.reject(new Error('mappings table gone')) };
          }
          return {
            sendText: (sessionId: string, dto: { chatId: string; text: string }) => {
              sends.push({ sessionId, chatId: dto.chatId, text: dto.text });
              return Promise.resolve({ id: 'wamid.out' });
            },
          };
        },
      } as unknown as ModuleRef;
      const svc = new AiChatbotService(
        ds.getRepository(AiChatbot),
        ds.getRepository(AiChatOverride),
        ds.getRepository(Session),
        ds.getRepository(AiLlmModel),
        ds.getRepository(AiRagModel),
        ds.getRepository(Message),
      { complete: () => Promise.resolve('answer'), completeWithTools: () => Promise.resolve({ content: 'answer', toolCalls: [], rawAssistant: null }) } as never,
      { findAll: () => Promise.resolve([]), listTools: () => Promise.resolve([]), callTool: () => Promise.resolve({}) } as never,
      { retrieve: () => Promise.resolve({ context: '', nodes: [], warnings: [] }) } as unknown as AiRagService,
        { logInfo: () => Promise.resolve() } as unknown as AuditService,
        undefined,
        moduleRef,
        lidStore,
      );
      await svc.evaluateInbound(SESSION, inbound(PHONE_CHAT));
      expect(sends.map(s => s.chatId)).toEqual([PHONE_CHAT]);
    });
  });
});
