// The role is kept per tab in sessionStorage, next to the API key. Older builds kept it in
// localStorage, so the first load after an upgrade must adopt that copy, or a signed-in tab starts
// with no role until /auth/validate answers. Every tab signed in before the upgrade needs it, so
// the first tab to load must not consume it.
import '../test-helpers/register-hooks.ts';
import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';

let rtl: typeof import('@testing-library/react');
let RoleProvider: (typeof import('./RoleProvider.tsx'))['RoleProvider'];
let useRole: (typeof import('../hooks/useRole.tsx'))['useRole'];

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  rtl = await import('@testing-library/react');
  ({ RoleProvider } = await import('./RoleProvider.tsx'));
  ({ useRole } = await import('../hooks/useRole.tsx'));
});

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => rtl.cleanup());

/** The role and account the first render sees: a later correction would still flash the wrong UI. */
function firstRender(): { role: string | null; accountId: string | null } {
  const seen: Array<{ role: string | null; accountId: string | null }> = [];
  function Probe() {
    const { role, accountId } = useRole();
    seen.push({ role, accountId });
    return null;
  }
  rtl.render(createElement(RoleProvider, null, createElement(Probe)));
  return seen[0];
}

function firstRenderedRole(): string | null {
  return firstRender().role;
}

test('a signed-in tab adopts the role an older build left in localStorage', () => {
  sessionStorage.setItem('openwa_api_key', 'key');
  localStorage.setItem('openwa_user_role', 'admin');

  assert.equal(firstRenderedRole(), 'admin');
  assert.equal(sessionStorage.getItem('openwa_user_role'), 'admin');
  assert.equal(localStorage.getItem('openwa_user_role'), 'admin', 'the other signed-in tabs lost the shared copy');
});

test("the tab's own role wins over the shared copy", () => {
  sessionStorage.setItem('openwa_api_key', 'key');
  sessionStorage.setItem('openwa_user_role', 'viewer');
  localStorage.setItem('openwa_user_role', 'admin');

  assert.equal(firstRenderedRole(), 'viewer');
  assert.equal(sessionStorage.getItem('openwa_user_role'), 'viewer');
});

test('a tab without an API key does not take the shared role', () => {
  localStorage.setItem('openwa_user_role', 'admin');

  assert.equal(firstRenderedRole(), null);
  assert.equal(sessionStorage.getItem('openwa_user_role'), null);
  // A key-less tab (the sign-in page) must not consume the copy the signed-in tabs still need.
  assert.equal(localStorage.getItem('openwa_user_role'), 'admin');
});

test('every signed-in tab adopts the shared role, not only the first to reload', () => {
  localStorage.setItem('openwa_user_role', 'admin');
  // Two tabs share localStorage; each has its own sessionStorage holding only its key.
  for (const tab of ['first', 'second']) {
    sessionStorage.clear();
    sessionStorage.setItem('openwa_api_key', `${tab}-key`);
    assert.equal(firstRenderedRole(), 'admin', `the ${tab} tab lost its role`);
    rtl.cleanup();
  }
});

// A SaaS tab holds a session token and its user, never an API key, so deriving the role from the key
// alone left the first render after a reload role-less and hid every ADMIN page until /auth/me answered.
test('a SaaS tab derives its role and account from the stored user', () => {
  sessionStorage.setItem('openwa_saas_token', 'token');
  sessionStorage.setItem(
    'openwa_saas_user',
    JSON.stringify({ id: 'u1', email: 'a@b.c', name: 'A', role: 'account_admin', accountId: 'acc-1' }),
  );

  assert.deepEqual(firstRender(), { role: 'admin', accountId: 'acc-1' });
});

test('a member signs in as an operator and a platform admin as an admin', () => {
  sessionStorage.setItem('openwa_saas_token', 'token');
  const as = (role: string) => {
    sessionStorage.setItem('openwa_saas_user', JSON.stringify({ role, accountId: null }));
    const first = firstRender();
    rtl.cleanup();
    return first.role;
  };

  assert.equal(as('account_member'), 'operator');
  assert.equal(as('platform_admin'), 'admin');
  assert.equal(as('nonsense'), 'viewer');
});
