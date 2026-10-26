import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient } from '@tanstack/react-query';
import type { installJsdomGlobals as installJsdomGlobalsFn } from '../test-helpers/jsdom.ts';
import { clearActorState, isKeyUnusable, isUserRole, resolveStartupValidation } from './authLifecycle.ts';

test('logout cleanup wipes the React Query cache (no cross-actor residue)', () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(['sessions'], [{ id: 's1' }]);
  queryClient.setQueryData(['apiKeys'], [{ id: 'k1' }]);
  queryClient.setQueryData(['logs', { page: 1 }], [{ id: 'a1' }]);

  clearActorState(queryClient);

  assert.equal(queryClient.getQueryData(['sessions']), undefined);
  assert.equal(queryClient.getQueryData(['apiKeys']), undefined);
  assert.equal(queryClient.getQueryCache().getAll().length, 0);
});

test('logout cleanup calls clear() on every provided cache', () => {
  const calls: string[] = [];
  const cache = (name: string) => ({ clear: () => calls.push(name) });
  clearActorState(cache('a'), cache('b'));
  assert.deepEqual(calls, ['a', 'b']);
});

test('startup validation: 401/403 (revoked/demoted/restricted key) → logout', () => {
  assert.deepEqual(resolveStartupValidation(401, null), { action: 'logout' });
  assert.deepEqual(resolveStartupValidation(401, { valid: true, role: 'admin' }), { action: 'logout' });
  assert.deepEqual(resolveStartupValidation(403, null), { action: 'logout' });
});

test('startup validation: 429/5xx keeps the cached role (transient failure, not a revoked key)', () => {
  for (const status of [429, 500, 502, 503]) {
    assert.deepEqual(resolveStartupValidation(status, null), { action: 'keep' }, `status ${status}`);
    // Even a stray valid-looking body cannot upgrade a non-ok answer to a role refresh.
    assert.deepEqual(resolveStartupValidation(status, { valid: true, role: 'admin' }), { action: 'keep' });
  }
});

test('startup validation: ok + role refreshes the cached role from the server', () => {
  assert.deepEqual(resolveStartupValidation(200, { valid: true, role: 'viewer' }), {
    action: 'role',
    accountId: null,
    role: 'viewer',
    scoped: false,
  });
});

test('startup validation: ok + role also carries the engine the server reports', () => {
  assert.deepEqual(resolveStartupValidation(200, { valid: true, role: 'operator', engineType: 'baileys' }), {
    action: 'role',
    accountId: null,
    role: 'operator',
    scoped: false,
    engineType: 'baileys',
  });
});

test('startup validation: ok + role carries whether the key is session-scoped', () => {
  assert.deepEqual(resolveStartupValidation(200, { valid: true, role: 'admin', scoped: true }), {
    action: 'role',
    accountId: null,
    role: 'admin',
    scoped: true,
  });
  // Anything but a literal true is unscoped.
  assert.deepEqual(resolveStartupValidation(200, { valid: true, role: 'admin', scoped: 'yes' }), {
    action: 'role',
    accountId: null,
    role: 'admin',
    scoped: false,
  });
});

test('startup validation: ok without a usable role keeps the cached role', () => {
  assert.deepEqual(resolveStartupValidation(200, { valid: false }), { action: 'keep' });
  assert.deepEqual(resolveStartupValidation(200, { valid: true, role: 'superuser' }), { action: 'keep' });
  assert.deepEqual(resolveStartupValidation(200, null), { action: 'keep' });
});

test('isUserRole accepts exactly the three known roles', () => {
  assert.deepEqual(['admin', 'operator', 'viewer'].filter(isUserRole), ['admin', 'operator', 'viewer']);
  for (const value of ['superuser', '', undefined, null, 42, 'ADMIN']) {
    assert.equal(isUserRole(value), false, `expected ${String(value)} to be rejected`);
  }
});

// ── App-level auth flow: exactly one /auth/validate per sign-in ──────────────
// Render smoke tests of the full App for the two entry paths (fresh sign-in, page reload with a
// saved key). Harness mirrors Infrastructure.test.ts: jsdom globals, a fetch stub recording every
// call, i18n catalogues awaited before render. App brings its own providers, so no wrapper here.

const LOGIN_KEY = 'openwa_saas_token';
const USER_KEY = 'openwa_saas_user';
const ENGINE_KEY = 'openwa_engine_type';
const SCOPED_KEY = 'openwa_key_scoped';

interface FetchCall {
  method: string;
  path: string;
}

const fetchCalls: FetchCall[] = [];

// Per-test answers for the SaaS endpoints. The home page's stats endpoints need their object shapes
// ([] would crash Dashboard's overview render); every other request gets an empty list.
type SessionUser = { id: string; email: string; name: string; role: string; accountId: string | null };
let loginAnswer: { token: string; expiresAt: number; user: SessionUser } | null = null;
let meAnswer: { user: SessionUser } = {
  user: { id: 'u1', email: 'op@openwa.local', name: 'Operator', role: 'account_member', accountId: 'acc-1' },
};

function installFetchStub(): void {
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    fetchCalls.push({ method, path });

    let body: unknown = [];
    if (method === 'POST' && path === '/api/auth/login') {
      if (!loginAnswer)
        return Promise.resolve(
          new Response(JSON.stringify({ message: 'Invalid email or password' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      body = loginAnswer;
    } else if (method === 'POST' && path === '/api/auth/me') body = meAnswer;
    else if (path === '/api/stats/overview')
      body = {
        sessions: { active: 0, total: 0, byStatus: {} },
        messages: { sent: 0, received: 0, failed: 0, today: { sent: 0, received: 0 } },
      };
    else if (path.startsWith('/api/stats/messages')) body = { timeSeries: [], byType: {}, bySession: [], topChats: [] };
    return Promise.resolve(
      new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
  };
}

function loginCallCount(): number {
  return fetchCalls.filter(c => c.method === 'POST' && c.path === '/api/auth/login').length;
}

function meCallCount(): number {
  return fetchCalls.filter(c => c.method === 'POST' && c.path === '/api/auth/me').length;
}

type RTL = typeof import('@testing-library/react');
type AppModule = typeof import('../App.tsx');

let rtl: RTL;
let App: AppModule['default'];
let installJsdomGlobals: typeof installJsdomGlobalsFn;

before(async () => {
  ({ installJsdomGlobals } = await import('../test-helpers/jsdom.ts'));
  await installJsdomGlobals();
  installFetchStub();
  // jsdom gaps the authenticated shell hits: useTheme (Layout) reads window.matchMedia, and the
  // lazily-mounted analytics charts construct a ResizeObserver.
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false;
    },
  })) as typeof window.matchMedia;
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;
  window.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;
  // Login.tsx reads these Vite compile-time defines at render time; Node has no define step.
  Object.defineProperty(globalThis, '__APP_VERSION__', { value: '0.0.0-test', configurable: true });
  Object.defineProperty(globalThis, '__BUILD_TIME__', { value: new Date(0).toISOString(), configurable: true });
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ default: App } = await import('../App.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  localStorage.clear();
  sessionStorage.clear();
  fetchCalls.length = 0;
  loginAnswer = null;
  meAnswer = {
    user: { id: 'u1', email: 'op@openwa.local', name: 'Operator', role: 'account_member', accountId: 'acc-1' },
  };
});

// Fills the email + password form and submits, then waits until App has applied the role from the
// login response (the synchronous tail of handleLogin). `meAnswer` drives the follow-up /auth/me.
async function signIn(email: string): Promise<void> {
  const { screen, waitFor, fireEvent } = rtl;
  const emailInput = await screen.findByLabelText('Email');
  const passwordInput = document.getElementById('password') as HTMLInputElement;
  fireEvent.change(emailInput, { target: { value: email } });
  fireEvent.change(passwordInput, { target: { value: 'whatever-1' } });
  fireEvent.submit(emailInput.closest('form')!);
  await waitFor(() => assert.ok(sessionStorage.getItem(USER_KEY), 'expected a user to be stored after sign-in'));
  // Give the post-login render and its effects a macrotask to fire before counting requests.
  await new Promise(resolve => setTimeout(resolve, 50));
}

/** A prepared login body for the given role, bound to the standard test tenant. */
function userFor(role: string): { token: string; expiresAt: number; user: SessionUser } {
  return {
    token: 'test-token',
    expiresAt: Date.now() + 3_600_000,
    user: { id: 'u1', email: 'op@openwa.local', name: 'Operator', role, accountId: 'acc-1' },
  };
}

test('a fresh sign-in makes exactly one /auth/login request, feeding the role from its response', async () => {
  loginAnswer = { ...userFor('account_member'), token: 'tok-member' };
  rtl.render(createElement(App));

  await signIn('op@openwa.local');

  assert.equal(loginCallCount(), 1);
  assert.equal(
    sessionStorage.getItem(USER_KEY) && JSON.parse(sessionStorage.getItem(USER_KEY)!).role,
    'account_member',
  );
  assert.equal(sessionStorage.getItem(LOGIN_KEY), 'tok-member');
});

test('a fresh sign-in whose user lacks admin rights still lands on the member role', async () => {
  loginAnswer = userFor('account_member');
  rtl.render(createElement(App));

  await signIn('op@openwa.local');

  assert.equal(loginCallCount(), 1);
  assert.equal(
    sessionStorage.getItem(USER_KEY) && JSON.parse(sessionStorage.getItem(USER_KEY)!).role,
    'account_member',
  );
});

test('a page reload with a saved session re-validates via /auth/me and refreshes the stored user', async () => {
  sessionStorage.setItem(LOGIN_KEY, 'saved-token');
  sessionStorage.setItem(
    USER_KEY,
    JSON.stringify({
      id: 'u1',
      email: 'op@openwa.local',
      name: 'Operator',
      role: 'account_member',
      accountId: 'acc-1',
    }),
  );
  meAnswer = {
    user: { id: 'u1', email: 'admin@openwa.local', name: 'Upgraded', role: 'account_admin', accountId: 'acc-1' },
  };
  rtl.render(createElement(App));

  await rtl.waitFor(() => {
    const stored = sessionStorage.getItem(USER_KEY);
    assert.ok(stored && JSON.parse(stored).role === 'account_admin');
  });
  await new Promise(resolve => setTimeout(resolve, 50));

  assert.equal(meCallCount(), 1);
});

test('a 401, or a 403 from allowedIps refusing this client, makes the key unusable', () => {
  assert.equal(isKeyUnusable(401, undefined), true);
  assert.equal(isKeyUnusable(401, 'Invalid API key'), true);
  assert.equal(isKeyUnusable(403, 'IP address not allowed'), true);
  assert.equal(isKeyUnusable(403, 'Client IP could not be determined'), true);
});

test('a role or scope 403 and other failures keep the key', () => {
  assert.equal(isKeyUnusable(403, 'Insufficient permissions'), false);
  assert.equal(isKeyUnusable(403, undefined), false);
  assert.equal(isKeyUnusable(403, ['IP address not allowed']), false);
  assert.equal(isKeyUnusable(400, 'IP address not allowed'), false);
  assert.equal(isKeyUnusable(429, undefined), false);
  assert.equal(isKeyUnusable(500, undefined), false);
});

test('a fresh sign-in as a platform_admin stores the admin session', async () => {
  loginAnswer = {
    token: 'tok-plat',
    expiresAt: Date.now() + 3_600_000,
    user: { id: 'u0', email: 'dev@openwa.local', name: 'Dev', role: 'platform_admin', accountId: null },
  };
  rtl.render(createElement(App));

  await signIn('dev@openwa.local');

  assert.equal(loginCallCount(), 1);
  const stored = JSON.parse(sessionStorage.getItem(USER_KEY)!);
  assert.equal(stored.role, 'platform_admin');
  assert.equal(stored.accountId, null);
});

test('a page reload refreshes the cached user role from /auth/me', async () => {
  sessionStorage.setItem(LOGIN_KEY, 'saved-token');
  sessionStorage.setItem(
    USER_KEY,
    JSON.stringify({ id: 'u1', email: 'a@b.c', name: 'A', role: 'account_admin', accountId: 'acc' }),
  );
  meAnswer = { user: { id: 'u1', email: 'a@b.c', name: 'A', role: 'account_member', accountId: 'acc' } };
  rtl.render(createElement(App));

  await rtl.waitFor(() => {
    const stored = sessionStorage.getItem(USER_KEY);
    assert.ok(stored && JSON.parse(stored).role === 'account_member');
  });
});

test('a startup 401 on /auth/me logs the user out', async () => {
  sessionStorage.setItem(LOGIN_KEY, 'revoked-token');
  sessionStorage.setItem(
    USER_KEY,
    JSON.stringify({ id: 'u1', email: 'a@b.c', name: 'A', role: 'account_admin', accountId: 'acc' }),
  );
  const stub = globalThis.fetch;
  // Only the /auth/me answer is refused: a 401 on any other read sends the page back to '/' first.
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) =>
    String(input).endsWith('/auth/me') ? Promise.resolve(new Response('{}', { status: 401 })) : stub(input, init);
  try {
    rtl.render(createElement(App));
    await rtl.waitFor(() => assert.equal(sessionStorage.getItem(USER_KEY), null));
    assert.equal(sessionStorage.getItem(LOGIN_KEY), null);
  } finally {
    globalThis.fetch = stub;
  }
});
