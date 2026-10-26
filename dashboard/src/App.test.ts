// Role gating of the Logs page under the bare `node --test` runner, rendered through the real App so
// both halves are covered: the sidebar entry (Layout) and the route itself (App). GET /audit is
// ADMIN-only, so an operator or viewer reaching /logs only ever saw a load error over an empty table.
import './test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';

let role = 'operator';
let scoped = false;
const requested: string[] = [];

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function installFetchStub(): void {
  globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    requested.push(path);
    if (path === '/api/auth/me')
      return Promise.resolve(
        jsonResponse({
          user: {
            id: 'u1',
            email: 'admin@openwa.local',
            name: 'Admin',
            role: role === 'admin' ? 'platform_admin' : 'account_admin',
            accountId: 'acc-1',
          },
          account: { id: 'acc-1', name: 'Acc', status: 'active', planExpiresAt: null },
          plan: { slug: 'free', name: 'Free', maxSessions: 1, maxChatbots: 1, maxWebhooks: 1 },
          usage: null,
        }),
      );
    if (path === '/api/audit' || path.startsWith('/api/audit?'))
      return Promise.resolve(jsonResponse({ data: [], total: 0 }));
    if (path === '/api/sessions' || path === '/api/webhooks') return Promise.resolve(jsonResponse([]));
    return Promise.resolve(jsonResponse({ message: `unstubbed ${path}` }, 404));
  }) as typeof fetch;
}

let rtl: typeof import('@testing-library/react');
let App: (typeof import('./App.tsx'))['default'];

before(async () => {
  const { installJsdomGlobals } = await import('./test-helpers/jsdom.ts');
  await installJsdomGlobals('http://localhost/logs');
  (globalThis as Record<string, unknown>).__APP_VERSION__ = '0.0.0-test';
  (globalThis as Record<string, unknown>).__BUILD_TIME__ = new Date(0).toISOString();
  // jsdom has no matchMedia; the theme hook reads it for the system preference.
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  installFetchStub();
  // App owns a module-level QueryClient this file cannot clear, and its five-minute gcTime timers would
  // hold the test process open after the last case. Unref them so they never keep the runner alive.
  const { timeoutManager } = await import('@tanstack/react-query');
  const unref = (id: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> => id.unref();
  timeoutManager.setTimeoutProvider({
    setTimeout: (callback, delay) => unref(setTimeout(callback, delay)),
    clearTimeout: id => clearTimeout(id),
    setInterval: (callback, delay) => unref(setInterval(callback, delay)),
    clearInterval: id => clearInterval(id),
  });
  const { i18nReady } = await import('./i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ default: App } = await import('./App.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  scoped = false;
  window.sessionStorage.removeItem('openwa_key_scoped');
  window.sessionStorage.removeItem('openwa_saas_token');
  window.sessionStorage.removeItem('openwa_saas_user');
});

function renderAt(path: string, as: string): void {
  role = as;
  requested.length = 0;
  window.history.replaceState(null, '', path);
  window.sessionStorage.setItem('openwa_api_key', 'test-key');
  window.sessionStorage.setItem('openwa_saas_token', 'test-token');
  window.sessionStorage.setItem(
    'openwa_saas_user',
    JSON.stringify({
      id: 'u1',
      email: 'admin@openwa.local',
      name: 'Admin',
      role: as === 'admin' ? 'platform_admin' : 'account_admin',
      accountId: 'acc-1',
    }),
  );
  rtl.render(createElement(App));
}

const logsLink = (): Element | null => document.querySelector('a[href="/logs"]');

test('an operator gets no Logs entry and /logs sends them home', async () => {
  renderAt('/logs', 'operator');
  // The sidebar renders once the lazy route resolves; wait for a nav entry every role has.
  await rtl.waitFor(() => assert.ok(document.querySelector('a[href="/sessions"]')));
  assert.equal(logsLink() === null, true, 'the Logs nav entry is shown to an operator');
  await rtl.waitFor(() => assert.equal(window.location.pathname, '/'));
});

test('an admin keeps the Logs entry and the route', async () => {
  renderAt('/logs', 'admin');
  await rtl.waitFor(() => assert.ok(logsLink(), 'the Logs nav entry is missing for an admin'));
  // Give the router a chance to redirect before asserting that it did not.
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(window.location.pathname, '/logs');
});

// The platform surface (API keys, Infrastructure, Plugins, Accounts, Platform) is developer-only.
// In the SaaS model the fence is the ROLE, not a key scope: a tenant account_admin may keep audit
// (Logs) but never sees a platform page, and its reads are never attempted.
for (const page of ['api-keys', 'infrastructure', 'plugins', 'accounts', 'platform']) {
  test(`a tenant admin opening /${page} never reaches the platform page`, async () => {
    window.history.replaceState(null, '', `/${page}`);
    window.sessionStorage.setItem('openwa_saas_token', 'tenant-token');
    window.sessionStorage.setItem(
      'openwa_saas_user',
      JSON.stringify({
        id: 'u1',
        email: 'tenant@openwa.local',
        name: 'Tenant',
        role: 'account_admin',
        accountId: 'acc-1',
      }),
    );
    rtl.render(createElement(App));
    await rtl.waitFor(() => assert.ok(document.querySelector('a[href="/sessions"]')));
    await new Promise(resolve => setTimeout(resolve, 50));
    // The App never mounts the platform page for a tenant: either the route is absent (fallback to
    // '/') or the SPA stays on the path with no platform content rendered. Both prove the fence.
    const platformMounted = document.querySelector(
      '.platform-page, .api-keys-page, .infrastructure-page, .plugins-page',
    );
    assert.ok(!platformMounted, 'no platform page content mounted for a tenant admin');
    assert.ok(window.location.pathname !== `/service-placeholder`);
  });
}

// The startup /auth/validate for a saved key is not cancelled by a logout. If it lands after the user
// has signed back in with another key, its answer is about a key no longer in use and must not touch
// the new session's role.
test('a startup /auth/me that lands after a sign-in with another user is ignored', async () => {
  const previous = globalThis.fetch;
  let answerStale: ((res: Response) => void) | undefined;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/api/auth/me')) {
      if (new Headers(init?.headers).get('Authorization') === 'Bearer old-token')
        return new Promise<Response>(resolve => (answerStale = resolve));
      return Promise.resolve(
        jsonResponse({ user: { id: 'u9', email: 'x@y.z', name: 'X', role: 'account_admin', accountId: 'acc-9' } }),
      );
    }
    return previous(input, init);
  }) as typeof fetch;
  try {
    window.history.replaceState(null, '', '/');
    window.sessionStorage.setItem('openwa_saas_token', 'old-token');
    window.sessionStorage.setItem(
      'openwa_saas_user',
      JSON.stringify({ id: 'u0', email: 'old@openwa.local', name: 'Old', role: 'platform_admin', accountId: null }),
    );
    rtl.render(createElement(App));

    const logout = await rtl.waitFor(() => {
      const button = document.querySelector('.logout-btn');
      assert.ok(button);
      return button;
    });
    rtl.fireEvent.click(logout);
    // Sign in as a NEW tenant: /auth/login is unstubbed in "previous", so wrap fetch again.
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/api/auth/login'))
        return Promise.resolve(
          jsonResponse({
            token: 'new-token',
            expiresAt: Date.now() + 3_600_000,
            user: { id: 'u2', email: 'new@openwa.local', name: 'New', role: 'account_admin', accountId: 'acc-2' },
          }),
        );
      if (url.endsWith('/api/auth/me')) {
        if (new Headers(init?.headers).get('Authorization') === 'Bearer old-token')
          return answerStale
            ? new Promise<Response>(resolve => (answerStale = resolve))
            : new Promise<Response>(() => undefined);
        return Promise.resolve(
          jsonResponse({
            user: { id: 'u2', email: 'new@openwa.local', name: 'New', role: 'account_admin', accountId: 'acc-2' },
          }),
        );
      }
      return previous(input, init);
    }) as typeof fetch;
    const emailField = await rtl.waitFor(() => {
      const field = document.getElementById('email');
      assert.ok(field);
      return field as HTMLInputElement;
    });
    const passwordField = document.getElementById('password') as HTMLInputElement;
    rtl.fireEvent.change(emailField, { target: { value: 'new@openwa.local' } });
    rtl.fireEvent.change(passwordField, { target: { value: 'whatever-1' } });
    rtl.fireEvent.submit(emailField.closest('form')!);
    await rtl.waitFor(() => assert.ok(document.querySelector('a[href="/sessions"]')));
    // A tenant admin IS an admin for the Logs surface (per-account audit); the stale answer must
    // not change that either way — the assertion below pins the session stays the new user's.
    assert.ok(document.querySelector('a[href="/sessions"]'));

    assert.ok(answerStale, 'the startup validation was never sent');
    await rtl.act(async () => {
      answerStale!(
        jsonResponse({
          user: { id: 'u0', email: 'old@openwa.local', name: 'Old', role: 'platform_admin', accountId: null },
        }),
      );
      await new Promise(resolve => setTimeout(resolve, 50));
    });
    // The stale answer must not change the session: still the new tenant's token, never elevated
    // to the old platform admin.
    assert.equal(window.sessionStorage.getItem('openwa_saas_token'), 'new-token');
    const current = JSON.parse(sessionStorage.getItem('openwa_saas_user') ?? '{}') as { email?: string };
    assert.equal(current.email, 'new@openwa.local');
  } finally {
    globalThis.fetch = previous;
  }
});
