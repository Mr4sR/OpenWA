// Render test for the AI Integration page under the bare `node --test` runner (the Webhooks.test.ts
// harness). The four tabs share one page; a failed read must render the error state rather than an
// empty list, and the four instance kinds must list and expose their create action.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

let llmList: unknown[] = [];
let chatbotList: unknown[] = [];
let ragList: unknown[] = [];
let mcpList: unknown[] = [];
let sessionList: unknown[] = [];
let aiStatus = 200;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function installFetchStub(): void {
  globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    if (aiStatus !== 200 && path.startsWith('/api/ai/')) {
      return Promise.resolve(jsonResponse({ message: 'Insufficient permissions. Required: admin' }, aiStatus));
    }
    if (path === '/api/sessions') return Promise.resolve(jsonResponse(sessionList));
    if (path === '/api/ai/llm-models') return Promise.resolve(jsonResponse(llmList));
    if (path === '/api/ai/chatbots') return Promise.resolve(jsonResponse(chatbotList));
    if (path === '/api/ai/rag-models') return Promise.resolve(jsonResponse(ragList));
    if (path === '/api/ai/mcp-connections') return Promise.resolve(jsonResponse(mcpList));
    if (/^\/api\/sessions\/[^/]+\/ai-chatbots\/[^/]+\/test$/.test(path)) {
      return Promise.resolve(jsonResponse({ ok: true, reply: 'Test reply', sources: [], warnings: [] }));
    }
    return Promise.resolve(jsonResponse({ message: `unstubbed ${path}` }, 404));
  }) as typeof fetch;
}

let rtl: typeof import('@testing-library/react');
let AiIntegration: (typeof import('./AiIntegration.tsx'))['AiIntegration'];
let RoleProvider: (typeof import('../components/RoleProvider.tsx'))['RoleProvider'];
let ToastProvider: (typeof import('../components/Toast.tsx'))['ToastProvider'];
let queryClient: QueryClient | undefined;

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  installFetchStub();
  window.sessionStorage.setItem('openwa_user_role', 'admin');
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ RoleProvider } = await import('../components/RoleProvider.tsx'));
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ AiIntegration } = await import('./AiIntegration.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  queryClient?.clear();
  queryClient = undefined;
  llmList = [];
  chatbotList = [];
  ragList = [];
  mcpList = [];
  sessionList = [];
  aiStatus = 200;
  window.sessionStorage.setItem('openwa_user_role', 'admin');
});

function renderPage(): void {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(RoleProvider, null, createElement(ToastProvider, null, createElement(AiIntegration))),
    ),
  );
}

const llmRow = {
  id: 'm1',
  name: 'OpenAI production',
  endpointUrl: 'https://api.openai.com/v1',
  hasApiKey: true,
  apiKeyMasked: 'sk-p…3f2a',
  model: 'gpt-4o-mini',
  persona: null,
  parameters: null,
  hasHeaders: false,
  enabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

test('the page renders its five tabs', async () => {
  renderPage();
  await rtl.screen.findByRole('tab', { name: 'Chatbot' });
  rtl.screen.getByRole('tab', { name: 'AI LLM' });
  rtl.screen.getByRole('tab', { name: 'RAG Vectorless' });
  rtl.screen.getByRole('tab', { name: 'MCP Server' });
  rtl.screen.getByRole('tab', { name: 'Playground' });
});

test('an empty chatbot list shows the empty state, and the add action opens the create modal', async () => {
  renderPage();
  await rtl.screen.findByText('No chatbots yet');
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Add chatbot' }));
  // The modal is the only place the session field exists.
  await rtl.screen.findByLabelText('Session');
  rtl.screen.getByLabelText('LLM model');
});

test('the LLM tab lists a connection with its masked key and endpoint', async () => {
  llmList = [llmRow];
  renderPage();
  await rtl.screen.findByText('No chatbots yet');
  rtl.fireEvent.click(rtl.screen.getByRole('tab', { name: 'AI LLM' }));
  await rtl.screen.findByText('OpenAI production');
  rtl.screen.getByText('https://api.openai.com/v1');
  rtl.screen.getByText('sk-p…3f2a');
});

test('a RAG model without an index says so', async () => {
  ragList = [
    {
      id: 'r1',
      name: 'Product FAQ',
      sessionScope: 'all',
      sessionIds: null,
      llmModelId: null,
      enabled: true,
      topK: 4,
      maxContextChars: 4000,
      hasIndex: false,
      indexedAt: null,
      lastIndexError: null,
      documentCount: 0,
      indexPreview: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ];
  renderPage();
  await rtl.screen.findByText('No chatbots yet');
  rtl.fireEvent.click(rtl.screen.getByRole('tab', { name: 'RAG Vectorless' }));
  await rtl.screen.findByText('Product FAQ');
  rtl.screen.getByText('Not indexed');
});

test('a 403 on the AI reads shows the permission banner', async () => {
  aiStatus = 403;
  renderPage();
  await rtl.screen.findByRole('alert');
  rtl.screen.getByText(/no access to the AI Integration surface/);
});

test('chatbot and LLM cards carry the green/red enable dot', async () => {
  chatbotList = [chatbotRow({ enabled: true })];
  llmList = [{ ...llmRow, enabled: false }];
  renderPage();
  await rtl.screen.findByText('Support bot');
  const okDots = rtl.screen.getAllByRole('img').filter(dot => dot.className.includes('ok'));
  assert.equal(okDots.length, 1);
  assert.equal(okDots[0].getAttribute('aria-label'), 'Enabled');

  rtl.fireEvent.click(rtl.screen.getByRole('tab', { name: 'AI LLM' }));
  await rtl.screen.findByText('OpenAI production');
  const failDots = rtl.screen.getAllByRole('img').filter(dot => dot.className.includes('fail'));
  assert.equal(failDots.length, 1);
  assert.equal(failDots[0].getAttribute('aria-label'), 'Disabled');
});

test('the playground sends a message and renders the answer without WhatsApp', async () => {
  chatbotList = [chatbotRow({ enabled: true })];
  llmList = [llmRow];
  renderPage();
  await rtl.screen.findByText('No chatbots yet');
  rtl.fireEvent.click(rtl.screen.getByRole('tab', { name: 'Playground' }));

  const input = await rtl.screen.findByLabelText('Message');
  rtl.fireEvent.change(input, { target: { value: 'Hello bot' } });
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Send' }));

  await rtl.screen.findByText('Test reply');
  rtl.screen.getByText('Hello bot');
});

function chatbotRow(overrides: { enabled: boolean }) {
  return {
    id: 'bot-1',
    sessionId: 's1',
    name: 'Support bot',
    llmModelId: 'm1',
    ragModelId: null,
    persona: null,
    replyGroups: false,
    lastRepliedAt: null,
    lastError: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}
