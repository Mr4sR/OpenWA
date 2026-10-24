import { Test, type TestingModule } from '@nestjs/testing';
import { getRepositoryToken, type FindOperator } from '@nestjs/typeorm';
import { AiChatbotService } from './ai-chatbot.service';
import { AiChatOverride } from './entities/ai-chat-override.entity';
import { AiChatbot } from './entities/ai-chatbot.entity';
import { AiLlmModel } from './entities/ai-llm-model.entity';
import { AiRagModel } from './entities/ai-rag-model.entity';
import { Session } from '../session/entities/session.entity';
import { Message } from '../message/entities/message.entity';
import { AiLlmModelsService } from './ai-llm-models.service';
import { AiMcpConnectionsService } from './ai-mcp-connections.service';
import { AiRagService } from './ai-rag.service';
import { AuditService } from '../audit/audit.service';
import { PLUGIN_MESSAGE_PORT, PLUGIN_SESSION_PORT } from '../../core/plugins/plugin-host-ports';
import type { LidMappingStore } from '../../engine/identity/lid-mapping-store.service';

/**
 * Two regressions around the per-chat AI switch and the reply path:
 *
 * 1. THE STUCK SWITCH — `setChatOverride(disabled: false)` used to look the stored row up by the
 *    literal chat id the dashboard sent, while a 1:1 conversation's id flips between `<lid>@lid`
 *    and `<phone>@c.us` as the engine learns the mapping. A mute written under one form then never
 *    matched the removal under the other: the row survived and the chip stayed OFF forever. The
 *    fix removes EVERY alias dialect stored for the chat.
 *
 * 2. THE TYPING INDICATOR — the reply path shows a real `typing` presence while the LLM turn runs
 *    (refreshed so it outlives WhatsApp's ~6 s expiry) and closes it with `paused` — but only when
 *    a typing frame actually went out, never blocking the send on a presence failure.
 */
describe('AiChatbotService setChatOverride dialect fix + typing indicator', () => {
  let overrides: Array<{ chatbotId: string; chatId: string; chatbotDisabled: boolean }>;
  let overrideRepository: {
    findOne: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    delete: jest.Mock;
    exists: jest.Mock;
  };
  let sendChatState: jest.Mock;

  beforeEach(async () => {
    overrides = [];
    sendChatState = jest.fn().mockResolvedValue(undefined);
    overrideRepository = {
      findOne: jest.fn(async ({ where }: { where: { chatbotId: string; chatId: string | FindOperator<string[]> } }) =>
        overrides.find(
          row =>
            row.chatbotId === where.chatbotId &&
            (typeof where.chatId === 'string' ? row.chatId === where.chatId : where.chatId.value.includes(row.chatId)),
        ) ?? null,
      ),
      save: jest.fn(async (row: { chatbotId: string; chatId: string; chatbotDisabled: boolean }) => {
        // A "found then mutated in place" save must REPLACE the stored row, not add a second one.
        const at = overrides.findIndex(candidate => candidate.chatbotId === row.chatbotId && candidate.chatId === row.chatId);
        if (at >= 0) overrides[at] = { ...row };
        else overrides.push({ ...row });
        return row;
      }),
      create: jest.fn((row: { chatbotId: string; chatId: string; chatbotDisabled: boolean }) => ({ ...row })),
      delete: jest.fn(async ({ chatbotId, chatId }: { chatbotId: string; chatId: FindOperator<string[]> }) => {
        // TypeORM's `delete` receives `In([...])`; reproducing that removes every matching row.
        const doomed = new Set(chatId.value);
        for (let i = overrides.length - 1; i >= 0; i--) {
          if (overrides[i].chatbotId === chatbotId && doomed.has(overrides[i].chatId)) overrides.splice(i, 1);
        }
        return {};
      }),
      exists: jest.fn(async ({ where: { chatId } }: { where: { chatId: string[] } }) =>
        overrides.some(row => chatId.includes(row.chatId) && row.chatbotDisabled),
      ),
    };
  });

  /** A service whose repositories are in-memory doubles; `lidStore` may inject the alias directory. */
  const build = async (options: {
    lidStore?: LidMappingStore;
    complete?: jest.Mock;
    sessionPort?: { sendChatState: jest.Mock };
  } = {}): Promise<AiChatbotService> => {
    // The bot the repositories serve; `evaluateInbound` reads the session's enabled bots through
    // `find`, the switch paths read one bot through `findOne`
    const bot = {
      id: 'bot-1',
      sessionIds: ['s1'],
      name: 'Support bot',
      llmModelId: 'm1',
      enabled: true,
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiChatbotService,
        { provide: getRepositoryToken(AiChatOverride, 'data'), useValue: overrideRepository },
        { provide: getRepositoryToken(AiChatbot, 'data'), useValue: { findOne: jest.fn().mockResolvedValue(bot), find: jest.fn().mockResolvedValue([bot]), save: jest.fn().mockResolvedValue(undefined) } },
        { provide: getRepositoryToken(Session, 'data'), useValue: { exists: jest.fn() } },
        { provide: getRepositoryToken(AiLlmModel, 'data'), useValue: { findOne: jest.fn().mockResolvedValue({ id: 'm1', enabled: true }) } },
        { provide: getRepositoryToken(AiRagModel, 'data'), useValue: { exists: jest.fn() } },
        { provide: getRepositoryToken(Message, 'data'), useValue: { find: jest.fn().mockResolvedValue([]) } },
        { provide: AiLlmModelsService, useValue: { complete: options.complete ?? jest.fn().mockResolvedValue('ok'), completeWithTools: jest.fn() } },
        { provide: AiMcpConnectionsService, useValue: { findAll: jest.fn().mockResolvedValue([]), listTools: jest.fn().mockResolvedValue([]), callTool: jest.fn() } },
        { provide: AiRagService, useValue: { retrieve: jest.fn().mockResolvedValue({ nodes: [], context: '', warnings: [] }) } },
        { provide: AuditService, useValue: { logInfo: jest.fn() } },
        { provide: PLUGIN_MESSAGE_PORT, useValue: { sendText: jest.fn().mockResolvedValue({}) } },
        // The chat states ride the session port; the typing indicator reads the same socket.
        { provide: PLUGIN_SESSION_PORT, useValue: { sendChatState: (options.sessionPort ?? { sendChatState }).sendChatState } },
      ],
    }).compile();
    module.useLogger(false);
    const svc = await module.resolve(AiChatbotService);
    // The lid store rides an @Optional constructor parameter the DI container cannot satisfy in a
    // unit construction; supplying it directly is what lets these tests drive the aliasing logic.
    svc['lidMappingStore'] = options.lidStore;
    return svc;
  };

  it('mute OFF then ON removes the stored row under the same id', async () => {
    const service = await build();
    await service.setChatOverride('s1', 'bot-1', '628111@c.us', true);
    expect(overrides).toEqual([{ chatbotId: 'bot-1', chatId: '628111@c.us', chatbotDisabled: true }]);

    await service.setChatOverride('s1', 'bot-1', '628111@c.us', false);
    expect(overrides).toEqual([]);
  });

  it('mute under @lid then unmute from the @c.us form clears the store (the stuck-switch fix)', async () => {
    // The mapping learned: lid 100… resolves to phone 628111. A mute recorded before the flip
    // lives under the lid dialect; the chat now arrives as the phone.
    const lidStore: LidMappingStore = {
      findPhoneForLid: async (jid: string) => (jid.startsWith('100') ? '628111' : null),
      findLidsForPhone: async (phone: string) => (phone === '628111' ? ['100'] : []),
    };
    const aliased = await build({ lidStore });
    await aliased.setChatOverride('s1', 'bot-1', '100@lid', true);
    expect(overrides).toHaveLength(1);

    await aliased.setChatOverride('s1', 'bot-1', '628111@c.us', false);

    expect(overrides).toEqual([]);
  });

  it('re-muting still writes the row the page literally asked for', async () => {
    const service = await build();
    await service.setChatOverride('s1', 'bot-1', '628111@c.us', true);
    await service.setChatOverride('s1', 'bot-1', '628111@c.us', true);
    expect(overrides).toEqual([{ chatbotId: 'bot-1', chatId: '628111@c.us', chatbotDisabled: true }]);
  });

  it('shows typing while generating and pauses when the reply lands', async () => {
    jest.useFakeTimers();
    try {
      const { promise: completion, resolve: releaseCompletion } = Promise.withResolvers<string>();
      const slow = await build({ complete: jest.fn(() => completion) });
      const done = slow.evaluateInbound('s1', { chatId: '628111@c.us', body: 'hi', fromMe: false });
      // The first typing frame goes out immediately (a detached async call — let its promises run).
      await jest.advanceTimersByTimeAsync(0);
      expect(sendChatState.mock.calls.filter(([, , s]) => s === 'typing')).toHaveLength(1);
      // A refresh tick keeps the indicator alive while the model still runs.
      await jest.advanceTimersByTimeAsync(8_500);
      expect(sendChatState.mock.calls.filter(([, , s]) => s === 'typing').length).toBeGreaterThanOrEqual(2);
      releaseCompletion('  The answer.  ');
      await done;
      expect(sendChatState).toHaveBeenLastCalledWith('s1', '628111@c.us', 'paused');
    } finally {
      jest.useRealTimers();
    }
  });

  it('never pauses an indicator that was never shown, and never blocks the send on presence failure', async () => {
    const failingPresence = {
      sendChatState: jest.fn(async (_sid: string, _chat: string, state: string) => {
        if (state === 'typing') throw new Error('no name present, ignoring presence update request');
      }),
    };
    const failing = await build({ sessionPort: failingPresence });
    await failing.evaluateInbound('s1', { chatId: '628111@c.us', body: 'hi', fromMe: false });
    // The reply still went out (no throw) and only typing frames were attempted: a `paused` after
    // a failed `typing` would be a stray write for an indicator nobody saw.
    expect(failingPresence.sendChatState.mock.calls.every(([, , s]) => s === 'typing')).toBe(true);
  });
});
