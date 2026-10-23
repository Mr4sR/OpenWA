import { BadRequestException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AiChatbotService } from './ai-chatbot.service';
import { AiChatbot } from './entities/ai-chatbot.entity';
import { AiChatOverride } from './entities/ai-chat-override.entity';
import { AiLlmModel } from './entities/ai-llm-model.entity';
import { AiRagModel } from './entities/ai-rag-model.entity';
import { Session } from '../session/entities/session.entity';
import { Message, MessageDirection } from '../message/entities/message.entity';
import { AiLlmModelsService } from './ai-llm-models.service';
import { AiMcpConnectionsService } from './ai-mcp-connections.service';
import { AiRagService, type RetrievalResult } from './ai-rag.service';
import { AuditService } from '../audit/audit.service';

/**
 * The Playground preview must assemble the reply EXACTLY like the live path — persona + RAG
 * knowledge + history + the WhatsApp instruction — while never touching the send path: no message
 * port, no `lastRepliedAt`/`lastError` write. A preview that sent (or that skipped the RAG context)
 * would make the playground certify behavior the bot does not have at runtime.
 */
describe('AiChatbotService.previewReply', () => {
  const chatbot = {
    id: 'bot-1',
    sessionId: 'session-1',
    llmModelId: 'model-1',
    ragModelId: 'rag-1',
    persona: 'You are an assistant.',
    replyGroups: false,
    enabled: true,
  } as AiChatbot;

  const retrieval: RetrievalResult = {
    nodes: [{ nodeId: 'doc0', title: 'Return policy', summary: 'how returns work', text: 'x' }],
    context: '[Return policy]\nhow returns work',
    warnings: [],
  };

  let llmRepository: { findOne: jest.Mock };
  let messageRepository: { find: jest.Mock };
  let chatbotRepository: { save: jest.Mock };
  let ragRetrieve: jest.Mock;
  let complete: jest.Mock;
  let service: AiChatbotService;

  const build = async (): Promise<AiChatbotService> => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiChatbotService,
        { provide: getRepositoryToken(AiChatbot, 'data'), useValue: { findOne: jest.fn(), ...chatbotRepository } },
        { provide: getRepositoryToken(AiChatOverride, 'data'), useValue: {} },
        { provide: getRepositoryToken(Session, 'data'), useValue: { exists: jest.fn() } },
        { provide: getRepositoryToken(AiLlmModel, 'data'), useValue: llmRepository },
        { provide: getRepositoryToken(AiRagModel, 'data'), useValue: { exists: jest.fn() } },
        { provide: getRepositoryToken(Message, 'data'), useValue: messageRepository },
        { provide: AiLlmModelsService, useValue: { complete } },
        { provide: AiMcpConnectionsService, useValue: { findAll: jest.fn().mockResolvedValue([]), listTools: jest.fn().mockResolvedValue([]), callTool: jest.fn() } },
        { provide: AiRagService, useValue: { retrieve: ragRetrieve } },
        { provide: AuditService, useValue: { logInfo: jest.fn() } },
      ],
    }).compile();
    module.useLogger(false);
    return module.resolve(AiChatbotService);
  };

  beforeEach(async () => {
    llmRepository = { findOne: jest.fn().mockResolvedValue({ id: 'model-1', enabled: true }) };
    messageRepository = { find: jest.fn().mockResolvedValue([]) };
    chatbotRepository = { save: jest.fn() };
    ragRetrieve = jest.fn().mockResolvedValue(retrieval);
    complete = jest.fn().mockResolvedValue('  The answer is 42.  ');
    service = await build();
  });

  it('composes persona, RAG context, history and the WhatsApp instruction into one completion', async () => {
    messageRepository.find.mockResolvedValue([
      { body: 'earlier question', direction: MessageDirection.INCOMING, waMessageId: 'wa-1' },
    ]);

    const result = await service.previewReply(chatbot, 'what is your return policy?');

    expect(result).toEqual({ reply: 'The answer is 42.', sources: [{ title: 'Return policy' }], warnings: [] });
    expect(ragRetrieve).toHaveBeenCalledTimes(1);
    expect(ragRetrieve).toHaveBeenCalledWith('rag-1', 'what is your return policy?', { fallbackLlm: undefined });

    const [, turns] = complete.mock.calls[0] as [AiLlmModel, Array<{ role: string; content: string }>];
    expect(turns).toHaveLength(3);
    expect(turns[0].role).toBe('system');
    expect(turns[0].content).toContain('You are an assistant.');
    expect(turns[0].content).toContain('Knowledge from the business documents');
    expect(turns[0].content).toContain('[Return policy]');
    expect(turns[0].content).toContain('answering inside a WhatsApp chat');
    expect(turns[1]).toEqual({ role: 'user', content: 'earlier question' });
    expect(turns[2]).toEqual({ role: 'user', content: 'what is your return policy?' });
  });

  it('never sends and never writes diagnostics', async () => {
    const saveSpy = jest.spyOn(chatbotRepository, 'save');
    await service.previewReply(chatbot, 'hello');
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('refuses an empty message and a disabled LLM without completing', async () => {
    await expect(service.previewReply(chatbot, '   ')).rejects.toBeInstanceOf(BadRequestException);
    llmRepository.findOne.mockResolvedValue({ id: 'model-1', enabled: false });
    await expect(service.previewReply(chatbot, 'hello')).rejects.toBeInstanceOf(BadRequestException);
    expect(complete).not.toHaveBeenCalled();
  });

  it('surfaces an empty model answer as a 400', async () => {
    complete.mockResolvedValue('   ');
    await expect(service.previewReply(chatbot, 'hello')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('skips retrieval for a bot without a RAG model and still sends persona + instruction', async () => {
    await service.previewReply({ ...chatbot, ragModelId: null }, 'hi');

    expect(ragRetrieve).not.toHaveBeenCalled();
    const [, turns] = complete.mock.calls.at(-1) as [AiLlmModel, Array<{ role: string; content: string }>];
    expect(turns[0].content).toContain('You are an assistant.');
    expect(turns[0].content).toContain('answering inside a WhatsApp chat');
  });
});
