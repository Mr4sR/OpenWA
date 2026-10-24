import { Test, type TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AiChatbotService, mcpToolFqName, parseMcpToolFqName } from './ai-chatbot.service';
import { AiChatOverride } from './entities/ai-chat-override.entity';
import { AiChatbot } from './entities/ai-chatbot.entity';
import { AiLlmModel } from './entities/ai-llm-model.entity';
import { AiRagModel } from './entities/ai-rag-model.entity';
import { Session } from '../session/entities/session.entity';
import { Message } from '../message/entities/message.entity';
import { AiLlmModelsService, type ChatCompletionMessage } from './ai-llm-models.service';
import { AiMcpConnectionsService } from './ai-mcp-connections.service';
import { AiRagService } from './ai-rag.service';
import { AuditService } from '../audit/audit.service';
import { PLUGIN_MESSAGE_PORT, PLUGIN_SESSION_PORT } from '../../core/plugins/plugin-host-ports';

/**
 * The MCP tool loop end to end over in-memory doubles: the model's tool_calls must reach the right
 * MCP connection with parsed arguments, the tool result must ride back as a `tool` turn paired to
 * the same call id, and the WhatsApp chat must receive the TEXTUAL answer that only exists after
 * the tools have answered. Also pinned here: the operator's per-bot narrowing, the round budget
 * (a model chaining tool calls forever is cut off and forced to answer), and every failure shape —
 * a down server, a malformedarguments payload, a model-invented tool name — none of which may
 * surface as a thrown reply.
 */
describe('AiChatbotService MCP tool loop', () => {
  const CONNECTION_ID = 'a1111111-1111-4111-8111-111111111111';
  const connMcp = { id: CONNECTION_ID, name: 'Billing MCP', enabled: true };
  const chatbot = {
    id: 'bot-1',
    sessionIds: ['s1'],
    llmModelId: 'm1',
    ragModelId: null,
    persona: null,
    replyGroups: false,
    enabled: true,
    mcpToolIds: null,
  } as AiChatbot;

  let completeWithTools: jest.Mock;
  let complete: jest.Mock;
  let mcpFindAll: jest.Mock;
  let mcpListTools: jest.Mock;
  let mcpCallTool: jest.Mock;
  let sendText: jest.Mock;
  let sendChatState: jest.Mock;
  let lastTurns: ChatCompletionMessage[] | undefined;

  beforeEach(() => {
    completeWithTools = jest.fn();
    complete = jest.fn().mockResolvedValue('final answer');
    mcpFindAll = jest.fn().mockResolvedValue([connMcp]);
    mcpListTools = jest.fn().mockResolvedValue([
      {
        name: 'cek_tagihan',
        description: 'Cek tagihan pelanggan by id',
        inputSchema: { type: 'object', properties: { customer_id: { type: 'string' } }, required: ['customer_id'] },
      },
    ]);
    mcpCallTool = jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'Tagihan: Rp150.000, jatuh tempo 25-11.' }] });
    sendText = jest.fn().mockResolvedValue({ id: 'wa-1' });
    sendChatState = jest.fn().mockResolvedValue(undefined);
    lastTurns = undefined;
  });

  /** One model turn: ask for the billing tool with the pasted customer id. */
  const toolCallTurn = (): { content: string | null; toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>; rawAssistant: unknown } => ({
    content: null,
    toolCalls: [{ id: 'call_1', name: mcpToolFqName(CONNECTION_ID, 'cek_tagihan'), args: { customer_id: 'GSR01000015' } }],
    rawAssistant: {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: mcpToolFqName(CONNECTION_ID, 'cek_tagihan'), arguments: '{"customer_id":"GSR01000015"}' } },
      ],
    },
  });

  const build = async (botOverrides: Partial<AiChatbot> = {}): Promise<AiChatbotService> => {
    const bot = { ...chatbot, ...botOverrides };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiChatbotService,
        {
          provide: getRepositoryToken(AiChatbot, 'data'),
          useValue: {
            findOne: jest.fn().mockResolvedValue(bot),
            // `evaluateInbound` reads the session's enabled bots through `find`.
            find: jest.fn().mockResolvedValue([bot]),
            save: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: getRepositoryToken(AiChatOverride, 'data'),
          useValue: { exists: jest.fn().mockResolvedValue(false), find: jest.fn().mockResolvedValue([]) },
        },
        { provide: getRepositoryToken(Session, 'data'), useValue: { exists: jest.fn() } },
        { provide: getRepositoryToken(AiLlmModel, 'data'), useValue: { findOne: jest.fn().mockResolvedValue({ id: 'm1', enabled: true }) } },
        { provide: getRepositoryToken(AiRagModel, 'data'), useValue: { exists: jest.fn() } },
        { provide: getRepositoryToken(Message, 'data'), useValue: { find: jest.fn().mockResolvedValue([]) } },
        {
          provide: AiLlmModelsService,
          useValue: {
            complete,
            // NO implementation at construction: each test owns the script via mockImplementation*,
            // and setting one here would overwrite it. `lastTurns` is captured per call instead.
            completeWithTools: (model: unknown, turns: ChatCompletionMessage[], tools: unknown) => {
              lastTurns = turns;
              return completeWithTools(model, turns, tools);
            },
          },
        },
        { provide: AiMcpConnectionsService, useValue: { findAll: mcpFindAll, listTools: mcpListTools, callTool: mcpCallTool } },
        { provide: AiRagService, useValue: { retrieve: jest.fn().mockResolvedValue({ nodes: [], context: '', warnings: [] }) } },
        { provide: AuditService, useValue: { logInfo: jest.fn() } },
        { provide: PLUGIN_MESSAGE_PORT, useValue: { sendText } },
        { provide: PLUGIN_SESSION_PORT, useValue: { sendChatState } },
      ],
    }).compile();
    module.useLogger(false);
    return module.resolve(AiChatbotService);
  };

  it('routes a tool_call to the right MCP connection, feeds the result back, and sends the final text', async () => {
    completeWithTools
      .mockImplementationOnce(() => Promise.resolve(toolCallTurn()))
      .mockImplementationOnce(() => Promise.resolve({ content: 'Tagihan Anda Rp150.000.', toolCalls: [], rawAssistant: null }));

    const service = await build();
    await service.evaluateInbound('s1', { chatId: '628111@c.us', body: 'Cek tagihan GSR01000015', fromMe: false });

    expect(mcpCallTool).toHaveBeenCalledWith(CONNECTION_ID, 'cek_tagihan', { customer_id: 'GSR01000015' });
    // The second model call carries the assistant tool_call turn + the paired tool result.
    expect(lastTurns?.some(turn => (turn as { role: string }).role === 'assistant')).toBe(true);
    const toolTurn = lastTurns?.find(turn => (turn as { role: string }).role === 'tool') as { tool_call_id: string; content: string } | undefined;
    expect(toolTurn?.tool_call_id).toBe('call_1');
    expect(toolTurn?.content).toContain('Rp150.000');
    // The chat received the TEXT answer, not a tool artifact.
    expect(sendText).toHaveBeenCalledWith('s1', { chatId: '628111@c.us', text: 'Tagihan Anda Rp150.000.' });
  });

  it('offers every advertised tool when the bot narrows nothing, and only the selection when it does', async () => {
    completeWithTools.mockResolvedValue({ content: 'ok', toolCalls: [], rawAssistant: null });
    const unrestricted = await build();
    await unrestricted.evaluateInbound('s1', { chatId: '628111@c.us', body: 'hi', fromMe: false });
    const offeredAll = completeWithTools.mock.calls[0][2] as Array<{ function: { name: string } }>;
    expect(offeredAll.map(t => t.function.name)).toContain(mcpToolFqName(CONNECTION_ID, 'cek_tagihan'));

    completeWithTools.mockClear();
    const narrowed = await build({ mcpToolIds: [`${CONNECTION_ID}:other_tool`] });
    await narrowed.evaluateInbound('s1', { chatId: '628111@c.us', body: 'hi', fromMe: false });
    const offeredNarrow = completeWithTools.mock.calls[0]?.[2] as Array<{ function: { name: string } }> | undefined;
    expect(offeredNarrow ?? []).toHaveLength(0);
  });

  it('a down MCP server shrinks the surface and the reply rides the plain path', async () => {
    mcpListTools.mockRejectedValue(new Error('MCP connect failed: connection refused'));
    complete.mockResolvedValue('SEPERTI BIASA');
    const service = await build();
    await service.evaluateInbound('s1', { chatId: '628111@c.us', body: 'hi', fromMe: false });
    // Every server down means an empty tool surface, so the tool loop never starts.
    expect(completeWithTools).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith('s1', { chatId: '628111@c.us', text: 'SEPERTI BIASA' });
  });

  it('a tool failure lands back to the model as an error turn, and the reply still goes out', async () => {
    mcpCallTool.mockRejectedValue(new Error('MCP tool call failed: timeout'));
    completeWithTools
      .mockImplementationOnce(() => Promise.resolve(toolCallTurn()))
      .mockImplementationOnce(() => Promise.resolve({ content: 'Maaf, sistem tagihan sedang tidak bisa dihubungi.', toolCalls: [], rawAssistant: null }));
    const service = await build();
    await service.evaluateInbound('s1', { chatId: '628111@c.us', body: 'cek', fromMe: false });
    const toolTurn = lastTurns?.find(turn => (turn as { role: string }).role === 'tool') as { content: string } | undefined;
    expect(toolTurn?.content).toContain('Error');
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it('the round budget forces a plain-completion answer instead of chaining forever', async () => {
    const chattyTurn = () => ({
      content: null,
      toolCalls: [{ id: `call_${Math.random()}`, name: mcpToolFqName(CONNECTION_ID, 'cek_tagihan'), args: {} }],
      rawAssistant: { role: 'assistant', content: null, tool_calls: [] },
    });
    completeWithTools.mockImplementation(() => Promise.resolve(chattyTurn()));
    complete.mockResolvedValue('Berikut ringkasannya.');
    const service = await build();
    await service.evaluateInbound('s1', { chatId: '628111@c.us', body: 'hi', fromMe: false });
    // 5 tool rounds happened, then the forced plain completion.
    expect(completeWithTools).toHaveBeenCalledTimes(5);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith('s1', { chatId: '628111@c.us', text: 'Berikut ringkasannya.' });
  });

  it('a model-invented tool name is answered with an error turn, not a throw', async () => {
    completeWithTools
      .mockImplementationOnce(() => Promise.resolve({ content: null, toolCalls: [{ id: 'c9', name: 'mcp_nosuch_tool', args: {} }], rawAssistant: null }))
      .mockImplementationOnce(() => Promise.resolve({ content: 'Tidak ditemukan.', toolCalls: [], rawAssistant: null }));
    const service = await build();
    await service.evaluateInbound('s1', { chatId: '628111@c.us', body: 'hi', fromMe: false });
    expect(mcpCallTool).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith('s1', { chatId: '628111@c.us', text: 'Tidak ditemukan.' });
  });

  it('no enabled MCP connections means the plain completion path with zero tool traffic', async () => {
    mcpFindAll.mockResolvedValue([]);
    completeWithTools.mockClear();
    const service = await build();
    await service.evaluateInbound('s1', { chatId: '628111@c.us', body: 'hi', fromMe: false });
    expect(completeWithTools).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(mcpListTools).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it('namespaces and restores tool names across the connection id', () => {
    const fq = mcpToolFqName(CONNECTION_ID, 'cek_tagihan');
    expect(fq).toMatch(/^mcp_[0-9a-f_]+_cek_tagihan$/);
    expect(parseMcpToolFqName(fq)).toEqual({ connectionId: CONNECTION_ID, toolName: 'cek_tagihan' });
    expect(parseMcpToolFqName('mcp_nosuch_tool')).toBeNull();
  });
});
