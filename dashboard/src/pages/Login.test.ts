// Login page under the bare `node --test` runner, on the jsdom harness the other page tests use.
// The SaaS gate takes email + password: the form must trim what the user pasted, a sign-in failure
// must surface the gateway's reason verbatim, a network/5xx failure must read as a connection error
// (never "invalid credentials"), and the form's alignment must follow the document direction.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';

let sentBody: { email?: string; password?: string } | null = null;
let reply: () => Response = okReply;

function okReply(): Response {
  return new Response(
    JSON.stringify({
      token: 'tok-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u1', email: 'owner@toko.id', name: 'Owner', role: 'account_admin', accountId: 'acc-1' },
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
}

function installFetchStub(): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/api/auth/login')) {
      sentBody = JSON.parse(String(init?.body ?? '{}')) as { email?: string; password?: string };
      return Promise.resolve(reply());
    }
    return Promise.resolve(new Response('[]', { headers: { 'Content-Type': 'application/json' } }));
  }) as typeof fetch;
}

let rtl: typeof import('@testing-library/react');
let Login: (typeof import('./Login.tsx'))['Login'];

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  (globalThis as Record<string, unknown>).__APP_VERSION__ = '0.0.0-test';
  (globalThis as Record<string, unknown>).__BUILD_TIME__ = new Date(0).toISOString();
  installFetchStub();
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ Login } = await import('./Login.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  sessionStorage.clear();
  sentBody = null;
  reply = okReply;
});

async function submitLogin(email: string, password: string): Promise<void> {
  const { fireEvent, waitFor } = rtl;
  let loggedIn: { token: string; email: string } | null = null;
  rtl.render(
    createElement(Login, {
      onLogin: (token: string, user: { email: string }) => (loggedIn = { token, email: user.email }),
    }),
  );
  const emailInput = await waitFor(() => {
    const field = document.getElementById('email');
    assert.ok(field, 'the email field rendered');
    return field as HTMLInputElement;
  });
  const passwordInput = document.getElementById('password') as HTMLInputElement;
  fireEvent.change(emailInput, { target: { value: email } });
  fireEvent.change(passwordInput, { target: { value: password } });
  fireEvent.submit(emailInput.closest('form')!);
  return waitFor(() => assert.ok(loggedIn, 'onLogin was not called')).then(() => undefined);
}

test('the email pasted with surrounding whitespace is sent trimmed and lowercased', async () => {
  await submitLogin('  Owner@Toko.ID  ', 'secret-pass');
  assert.equal(sentBody?.email, 'owner@toko.id');
  assert.equal(sentBody?.password, 'secret-pass');
});

test('a proxy error page while the gateway is down is a connection error, not an invalid login', async () => {
  reply = () => new Response('<html>502 Bad Gateway</html>', { status: 502, headers: { 'Content-Type': 'text/html' } });
  const { fireEvent, waitFor } = rtl;
  rtl.render(createElement(Login, { onLogin: () => assert.fail('must not sign in') }));
  const emailInput = await waitFor(() => {
    const field = document.getElementById('email');
    assert.ok(field);
    return field as HTMLInputElement;
  });
  fireEvent.change(emailInput, { target: { value: 'a@b.c' } });
  fireEvent.change(document.getElementById('password')!, { target: { value: 'whatever-1' } });
  fireEvent.submit(emailInput.closest('form')!);
  await waitFor(() => assert.ok(document.querySelector('.error-message'), 'an error is shown'));
  const shown = document.querySelector('.error-message')!.textContent ?? '';
  assert.doesNotMatch(shown, /invalid email or password/i);
});

test('a 5xx with a JSON message still reads as a connection error', async () => {
  reply = () =>
    new Response(JSON.stringify({ message: 'upstream exploded' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  const { fireEvent, waitFor } = rtl;
  rtl.render(createElement(Login, { onLogin: () => assert.fail('must not sign in') }));
  const emailInput = await waitFor(() => {
    const field = document.getElementById('email');
    assert.ok(field);
    return field as HTMLInputElement;
  });
  fireEvent.change(emailInput, { target: { value: 'a@b.c' } });
  fireEvent.change(document.getElementById('password')!, { target: { value: 'whatever-1' } });
  fireEvent.submit(emailInput.closest('form')!);
  await waitFor(() => assert.ok(document.querySelector('.error-message')));
});

test('a refused sign-in keeps the reason the gateway gave', async () => {
  reply = () =>
    new Response(JSON.stringify({ message: 'This account is suspended' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  const { fireEvent, waitFor } = rtl;
  rtl.render(createElement(Login, { onLogin: () => assert.fail('must not sign in') }));
  const emailInput = await waitFor(() => {
    const field = document.getElementById('email');
    assert.ok(field);
    return field as HTMLInputElement;
  });
  fireEvent.change(emailInput, { target: { value: 'a@b.c' } });
  fireEvent.change(document.getElementById('password')!, { target: { value: 'whatever-1' } });
  fireEvent.submit(emailInput.closest('form')!);
  await waitFor(() => assert.match(document.querySelector('.error-message')!.textContent ?? '', /suspended/i));
});

test('the login form direction comes from the document', () => {
  const css = readFileSync(fileURLToPath(new URL('./Login.css', import.meta.url)), 'utf8');
  // The card must not hardcode a direction: the shared layout flips it for RTL locales.
  assert.doesNotMatch(css, /direction:\s*ltr/);
});
